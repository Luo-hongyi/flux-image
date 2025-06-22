const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const multer = require('multer');
const fs = require('fs');
const os = require('os');

// 加载环境变量
dotenv.config();

// 初始化 Express
const app = express();
const port = process.env.PORT || 3000;

// API密钥
const apiKey = process.env.FLUX_API_KEY;
if (!apiKey) {
  console.error("FLUX_API_KEY 未在环境变量中设置");
  process.exit(1);
}

// Flux API 基础URL
const FLUX_API_BASE = 'https://api.bfl.ai/v1';

// 测试模式 - 如果无法连接到Flux API则启用
const TEST_MODE = process.env.TEST_MODE === 'true';

// 配置 multer 用于处理文件上传
const upload = multer({ dest: os.tmpdir() });

// CORS支持
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 生成新图片的API端点
app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: '请提供提示词' });
    }

    let data;
    let response;

    if (TEST_MODE) {
      // 测试模式 - 返回模拟数据
      console.log('测试模式：模拟生成图片请求');
      data = {
        id: 'test-' + Date.now(),
        polling_url: `/api/poll/test-${Date.now()}`
      };
      response = { ok: true };
    } else {
      // 调用 Flux text-to-image API (带重试机制)
      let retries = 3;
      let lastError;
      
      for (let i = 0; i < retries; i++) {
        try {
          console.log(`尝试调用Flux API (第${i + 1}次)`);
          
          // 创建AbortController用于超时控制
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);
          
          response = await fetch(`${FLUX_API_BASE}/flux-kontext-pro`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-key': apiKey
            },
            body: JSON.stringify({
              prompt: prompt,
              aspect_ratio: '1:1',
              safety_tolerance: 2
            }),
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);

          if (!response.ok) {
            // 尝试读取错误响应体
            let errorBody;
            try {
              errorBody = await response.text();
              console.log('API错误响应体:', errorBody);
            } catch (e) {
              errorBody = response.statusText;
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}. 响应: ${errorBody}`);
          }

          data = await response.json();
          console.log('API响应数据:', JSON.stringify(data, null, 2));
          console.log('Flux API 调用成功');
          break; // 成功则跳出循环
          
        } catch (fetchError) {
          lastError = fetchError;
          console.error(`第${i + 1}次尝试失败:`, fetchError.message);
          
          if (i < retries - 1) {
            // 不是最后一次，等待后重试
            console.log(`等待2秒后重试...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }
      
      // 如果所有重试都失败
      if (lastError) {
        console.error('所有重试均失败:', lastError.message);
        return res.status(500).json({ 
          success: false, 
          error: `Flux API连接失败，已重试${retries}次`, 
          details: {
            errorType: lastError.name,
            errorMessage: lastError.message,
            errorCode: lastError.cause?.code || 'UNKNOWN',
            host: lastError.cause?.host || 'api.bfl.ai',
            retryCount: retries,
            timestamp: new Date().toISOString()
          }
        });
      }
    }

    if (response.ok && data.id) {
      // 返回请求ID和轮询URL
      res.json({
        success: true,
        request_id: data.id,
        poll_url: data.polling_url || `/api/poll/${data.id}`
      });
    } else {
      console.error('Flux API 错误:', data);
      res.status(500).json({ 
        success: false, 
        error: data.error || '生成图片请求失败' 
      });
    }

  } catch (error) {
    console.error('生成图片时出错:', error);
    console.error('错误堆栈:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: `服务器内部错误: ${error.message}`,
      timestamp: new Date().toISOString()
    });
  }
});

// 编辑图片的API端点
app.post('/api/edit-image', upload.single('image'), async (req, res) => {
  try {
    const { prompt } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: '请上传图片' });
    }

    if (!prompt) {
      return res.status(400).json({ error: '请提供编辑提示' });
    }

    // 读取上传的图片文件并转换为base64
    const imageData = fs.readFileSync(file.path);
    const imageBase64 = imageData.toString('base64');

    // 调用 Flux image editing API (带重试机制)
    let data;
    let response;
    let retries = 3;
    let lastError;
    
    for (let i = 0; i < retries; i++) {
      try {
        console.log(`尝试调用Flux编辑API (第${i + 1}次)`);
        
        // 创建AbortController用于超时控制
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        response = await fetch(`${FLUX_API_BASE}/flux-kontext-pro`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-key': apiKey
          },
          body: JSON.stringify({
            prompt: prompt,
            input_image: imageBase64,
            aspect_ratio: '1:1',
            safety_tolerance: 2
          }),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) {
          // 尝试读取错误响应体
          let errorBody;
          try {
            errorBody = await response.text();
            console.log('编辑API错误响应体:', errorBody);
          } catch (e) {
            errorBody = response.statusText;
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}. 响应: ${errorBody}`);
        }

        data = await response.json();
        console.log('编辑API响应数据:', JSON.stringify(data, null, 2));
        console.log('Flux编辑API 调用成功');
        break; // 成功则跳出循环
        
      } catch (fetchError) {
        lastError = fetchError;
        console.error(`编辑API第${i + 1}次尝试失败:`, fetchError.message);
        
        if (i < retries - 1) {
          // 不是最后一次，等待后重试
          console.log(`等待2秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    // 如果所有重试都失败
    if (lastError) {
      console.error('编辑API所有重试均失败:', lastError.message);
      // 删除临时文件
      fs.unlink(file.path, () => {});
      
      return res.status(500).json({ 
        success: false, 
        error: `Flux编辑API连接失败，已重试${retries}次`, 
        details: {
          errorType: lastError.name,
          errorMessage: lastError.message,
          errorCode: lastError.cause?.code || 'UNKNOWN',
          host: lastError.cause?.host || 'api.bfl.ai',
          retryCount: retries,
          timestamp: new Date().toISOString()
        }
      });
    }

    // 删除临时文件
    fs.unlink(file.path, () => {});

    if (response.ok && data.id) {
      // 返回请求ID和轮询URL
      res.json({
        success: true,
        request_id: data.id,
        poll_url: data.polling_url || `/api/poll/${data.id}`
      });
    } else {
      console.error('Flux API 错误:', data);
      res.status(500).json({ 
        success: false, 
        error: data.error || '编辑图片请求失败' 
      });
    }

  } catch (error) {
    console.error('编辑图片时出错:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 轮询任务状态的API端点 - 代理Flux API调用
app.get('/api/poll/*', async (req, res) => {
  try {
    const pollPath = req.params[0];
    
    if (TEST_MODE || pollPath.startsWith('test-')) {
      // 测试模式 - 返回模拟成功结果
      console.log('测试模式：返回模拟图片结果');
      res.json({
        status: 'Ready',
        result: {
          sample: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjQwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQiIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMTAwJSIgeTI9IjEwMCUiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdHlsZT0ic3RvcC1jb2xvcjojNGY0NmU1O3N0b3Atb3BhY2l0eToxIiAvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0eWxlPSJzdG9wLWNvbG9yOiM3Yzk5ZmY7c3RvcC1vcGFjaXR5OjEiIC8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogIDwvZGVmcz4KICA8cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ1cmwoI2dyYWRpZW50KSIvPgogIDx0ZXh0IHg9IjUwJSIgeT0iNDUlIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjQiIGZpbGw9IndoaXRlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5GbHV4IFRlc3Q8L3RleHQ+CiAgPHRleHQgeD0iNTAlIiB5PSI2MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxOCIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjgpIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7muKHmi6XmqKHlvI88L3RleHQ+Cjwvc3ZnPgo='
        }
      });
      return;
    }

    // 获取完整的轮询URL路径
    const pollUrl = req.query.url || `${FLUX_API_BASE}/get_result?id=${pollPath}`;

    // 调用 Flux API 获取结果
    const response = await fetch(pollUrl, {
      method: 'GET',
      headers: {
        'x-key': apiKey
      }
    });

    const data = await response.json();

    if (response.ok) {
      res.json(data);
    } else {
      res.status(response.status).json(data);
    }

  } catch (error) {
    console.error('轮询结果时出错:', error);
    res.status(500).json({ error: error.message });
  }
});

// 主页路由
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动服务器
app.listen(port, () => {
  console.log(`服务器运行在 http://localhost:${port}`);
});