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

// 根据比例生成测试用SVG的函数
function generateTestSVG(aspectRatio, type = 'generate') {
  const ratioMap = {
    '21:9': { width: 420, height: 180 },
    '16:9': { width: 400, height: 225 },
    '4:3': { width: 400, height: 300 },
    '1:1': { width: 400, height: 400 },
    '3:4': { width: 300, height: 400 },
    '9:16': { width: 225, height: 400 },
    '16:21': { width: 190, height: 250 }
  };
  
  const size = ratioMap[aspectRatio] || ratioMap['1:1'];
  const title = type === 'generate' ? 'Test Mode' : 'Edited';
  const subtitle = type === 'generate' ? 'Generated' : 'Result';
  
  const svg = `<svg width="${size.width}" height="${size.height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#4f46e5;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#7c99ff;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#gradient)"/>
  <text x="50%" y="45%" font-family="Arial, sans-serif" font-size="24" fill="white" text-anchor="middle">${title}</text>
  <text x="50%" y="60%" font-family="Arial, sans-serif" font-size="18" fill="rgba(255,255,255,0.8)" text-anchor="middle">${subtitle}</text>
  <text x="50%" y="75%" font-family="Arial, sans-serif" font-size="14" fill="rgba(255,255,255,0.6)" text-anchor="middle">${aspectRatio}</text>
</svg>`;
  
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

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
    const { prompt, aspect_ratio } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: '请提供提示词' });
    }

    if (!aspect_ratio) {
      return res.status(400).json({ error: '请选择图片比例' });
    }

    let data;
    let response;

    if (TEST_MODE) {
      // 测试模式 - 不调用API，直接返回模拟数据
      console.log('测试模式：跳过Flux API调用，返回模拟数据');
      const testId = 'test-' + Date.now();
      
      // 为生成图片也添加时间缓存
      global.testGenerateCache = global.testGenerateCache || {};
      global.testGenerateCache[testId] = {
        startTime: Date.now(),
        minProcessingTime: 2000, // 生成图片模拟2秒处理时间
        aspectRatio: aspect_ratio
      };
      
      res.json({
        success: true,
        request_id: testId,
        poll_url: `/api/poll/${testId}`,
        test_mode: true,
        message: '测试模式：模拟生成请求已提交'
      });
      return;
    }

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
              aspect_ratio: aspect_ratio,
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

    if (response && response.ok && data && data.id) {
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
        error: (data && data.error) || '生成图片请求失败'
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
    const { prompt, aspect_ratio } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: '请上传图片' });
    }

    if (!prompt) {
      return res.status(400).json({ error: '请提供编辑提示' });
    }

    if (!aspect_ratio) {
      return res.status(400).json({ error: '请选择图片比例' });
    }

    // 读取上传的图片文件并转换为base64
    const imageData = fs.readFileSync(file.path);
    const imageBase64 = imageData.toString('base64');

    let data;
    let response;

    if (TEST_MODE) {
      // 测试模式 - 模拟轮询交互，但缓存原图数据
      console.log('测试模式：模拟图片编辑请求，缓存原图数据');
      const testId = 'test-edit-' + Date.now();
      
      // 将原图数据缓存到内存中，供轮询接口使用
      global.testEditCache = global.testEditCache || {};
      global.testEditCache[testId] = {
        originalImage: imageBase64,
        mimeType: file.mimetype || 'image/jpeg',
        startTime: Date.now(),
        minProcessingTime: 3000 // 最少模拟3秒处理时间
      };
      
      // 删除临时文件
      fs.unlink(file.path, () => {});
      
      res.json({
        success: true,
        request_id: testId,
        poll_url: `/api/poll/${testId}`,
        test_mode: true,
        message: '测试模式：模拟编辑请求已提交'
      });
      return;
    }

    // 调用 Flux image editing API (带重试机制)
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
            aspect_ratio: aspect_ratio,
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
      if (pollPath.startsWith('test-edit-')) {
        console.log('测试模式：检查图片编辑处理状态');
        
        // 从缓存中获取原图数据
        const testCache = global.testEditCache && global.testEditCache[pollPath];
        if (testCache) {
          const elapsed = Date.now() - testCache.startTime;
          
          if (elapsed < testCache.minProcessingTime) {
            // 还没到最小处理时间，返回处理中状态
            const remainingTime = Math.ceil((testCache.minProcessingTime - elapsed) / 1000);
            res.json({
              status: 'Processing',
              test_mode: true,
              message: `测试模式：模拟处理中 (还需${remainingTime}秒)`
            });
          } else {
            // 处理时间已够，返回结果
            res.json({
              status: 'Ready',
              result: {
                sample: `data:${testCache.mimeType};base64,${testCache.originalImage}`
              },
              test_mode: true,
              message: '测试模式：返回您上传的原图'
            });
            
            // 清理缓存
            delete global.testEditCache[pollPath];
          }
        } else {
          // 缓存中没有数据，返回占位符
          res.json({
            status: 'Ready',
            result: {
              sample: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjQwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQiIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMTAwJSIgeTI9IjEwMCUiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdHlsZT0ic3RvcC1jb2xvcjojZmY2YjM1O3N0b3Atb3BhY2l0eToxIiAvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0eWxlPSJzdG9wLWNvbG9yOiNmZjljMzU7c3RvcC1vcGFjaXR5OjEiIC8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogIDwvZGVmcz4KICA8cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ1cmwoI2dyYWRpZW50KSIvPgogIDx0ZXh0IHg9IjUwJSIgeT0iNDUlIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjAiIGZpbGw9IndoaXRlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7lm77niYflvZPliLY8L3RleHQ+CiAgPHRleHQgeD0iNTAlIiB5PSI2MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxNiIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjgpIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7muKHmi6XmqKHlvI/vvIjova/lpJblm77niYfvvIk8L3RleHQ+Cjwvc3ZnPgo='
            },
            test_mode: true,
            message: '测试模式：缓存已失效，返回占位符'
          });
        }
      } else {
        console.log('测试模式：检查图片生成处理状态');
        
        // 检查生成图片的时间缓存
        const testCache = global.testGenerateCache && global.testGenerateCache[pollPath];
        if (testCache) {
          const elapsed = Date.now() - testCache.startTime;
          
          if (elapsed < testCache.minProcessingTime) {
            // 还没到最小处理时间，返回处理中状态
            const remainingTime = Math.ceil((testCache.minProcessingTime - elapsed) / 1000);
            res.json({
              status: 'Processing',
              test_mode: true,
              message: `测试模式：模拟生成中 (还需${remainingTime}秒)`
            });
          } else {
            // 处理时间已够，返回结果
            res.json({
              status: 'Ready',
              result: {
                sample: generateTestSVG(testCache.aspectRatio, 'generate')
              },
              test_mode: true,
              message: '测试模式：模拟图片生成完成'
            });
            
            // 清理缓存
            delete global.testGenerateCache[pollPath];
          }
        } else {
          // 缓存中没有数据，返回默认结果
          res.json({
            status: 'Ready',
            result: {
              sample: generateTestSVG('1:1', 'generate')
            },
            test_mode: true,
            message: '测试模式：缓存已失效，返回默认结果'
          });
        }
      }
      return;
    }

    // 获取完整的轮询URL路径
    const pollUrl = req.query.url || `${FLUX_API_BASE}/get_result?id=${pollPath}`;
    console.log(`轮询API: ${pollUrl}`);

    // 调用 Flux API 获取结果
    const response = await fetch(pollUrl, {
      method: 'GET',
      headers: {
        'x-key': apiKey
      }
    });

    const data = await response.json();
    console.log(`轮询响应 (${response.status}):`, JSON.stringify(data, null, 2));

    if (response.ok) {
      res.json(data);
    } else {
      // 根据HTTP状态码提供详细错误信息
      let errorMessage = '';
      let expired = false;

      switch (response.status) {
        case 401:
          errorMessage = 'API密钥无效或已过期';
          break;
        case 402:
          errorMessage = 'API配额不足，请检查账户余额';
          break;
        case 403:
          errorMessage = '访问被拒绝，可能是权限不足或API密钥问题';
          expired = true;
          break;
        case 404:
          errorMessage = '轮询URL已过期（10分钟限制）或任务不存在';
          expired = true;
          break;
        case 429:
          errorMessage = 'API请求频率过高，请稍后重试';
          break;
        case 500:
          errorMessage = 'Flux服务器内部错误';
          break;
        case 502:
        case 503:
        case 504:
          errorMessage = 'Flux服务器暂时不可用，请稍后重试';
          break;
        default:
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }

      res.status(response.status).json({
        ...data,
        expired,
        message: errorMessage,
        httpStatus: response.status
      });
    }

  } catch (error) {
    console.error('轮询结果时出错:', error);
    res.status(500).json({
      error: error.message,
      expired: error.code === 'ECONNRESET' || error.code === 'ENOTFOUND'
    });
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