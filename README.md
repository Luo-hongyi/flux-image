# Flux Image Generator

基于 Flux API 的图片生成和编辑工具

## 功能特性

- **文本生成图片**: 通过描述文字生成高质量图片
- **图片编辑**: 上传图片并通过提示词进行智能编辑
- **异步处理**: 支持轮询机制，提供良好的用户体验

## 环境配置

1. 复制环境变量模板:
```bash
cp .env.example .env
```

2. 编辑 `.env` 文件，设置你的 Flux API Key:
```bash
FLUX_API_KEY=your_flux_api_key_here
PORT=3000
```

## 运行

```bash
npm install
npm start
```

## 开发运行

```bash
npm install
npm run dev
```

## API 接口

- `POST /api/generate-image` - 生成新图片
- `POST /api/edit-image` - 编辑图片
- `GET /api/poll/:requestId` - 轮询任务状态
