/**
 * 前端配置
 * 部署后将 BACKEND_URL 改为你的 Render 服务地址
 */
window.APP_CONFIG = {
  // 后端服务地址（Render 部署后填入）
  BACKEND_URL: 'https://my-backend-1-vqf2.onrender.com',

  // 轮询间隔（毫秒）
  POLL_INTERVAL: 3000,

  // 最大等待时间（毫秒）默认 10 分钟
  MAX_WAIT_TIME: 600000,

  // 二维码超时提醒（毫秒）
  QR_EXPIRE_WARNING: 300000,
};
