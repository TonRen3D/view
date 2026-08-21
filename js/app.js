/**
 * 前端主逻辑（双平台：Fansky微信 + 爱赞助支付宝）
 *
 * 功能：
 * 1. 支付渠道选择（微信/Fansky | 支付宝/爱赞助）
 * 2. 从后端加载对应平台的可用价格档位
 * 3. 点击价格档位 → 创建订单 → 显示支付二维码
 * 4. 轮询订单支付状态
 * 5. 支付成功 → 显示交付弹窗（下载链接 + 提取码 + 截图提醒）
 */
const { BACKEND_URL, POLL_INTERVAL, MAX_WAIT_TIME } = window.APP_CONFIG;

// 全局状态
let pollTimer = null;
let pollStartTime = null;
let currentOrderId = null;
let currentTier = null;
let currentChannel = 'fansky'; // 'fansky' | 'azz'

// ============================================================
//  支付渠道切换
// ============================================================
function selectChannel(channel) {
  currentChannel = channel;
  // 更新 Tab 样式
  document.querySelectorAll('.channel-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.channel === channel);
  });
  // 重新加载价格档位
  loadPriceTiers();
  console.log('[App] 切换支付渠道:', channel === 'fansky' ? '微信支付(Fansky)' : '支付宝(爱赞助)');
}

// ============================================================
//  价格档位加载与渲染
// ============================================================
async function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loadPriceTiers() {
  console.log('[App] 正在加载价格档位，渠道:', currentChannel, '后端:', BACKEND_URL);

  if (!BACKEND_URL || BACKEND_URL.includes('your-fansky-gateway') || BACKEND_URL.includes('your-')) {
    console.warn('[App] BACKEND_URL 未配置:', BACKEND_URL);
    renderPriceTiers(getDefaultTiers(currentChannel));
    showToast('后端地址未配置！请编辑 js/config.js 填入 Render 地址', 'error');
    return;
  }

  // 根据渠道选择 API
  const apiPath = currentChannel === 'azz' ? '/api/azz/products' : currentChannel === 'afdian' ? '/api/afdian/products' : '/api/products';

  try {
    const res = await fetchWithTimeout(`${BACKEND_URL}${apiPath}`, {}, 10000);
    const data = await res.json();
    if (data.code === 0 && data.data && data.data.length > 0) {
      renderPriceTiers(data.data);
      console.log('[App] 价格档位加载成功:', data.data.length, '个');
    } else {
      renderPriceTiers(getDefaultTiers(currentChannel));
      showToast('后端未配置商品，显示示例价格档位', 'warning');
    }
  } catch (err) {
    console.error('加载价格档位失败:', err);
    renderPriceTiers(getDefaultTiers(currentChannel));
    if (err.name === 'AbortError') {
      showToast('连接后端超时，请检查后端地址或 Render 是否休眠', 'error');
    } else {
      showToast('无法连接服务器，显示示例档位。按 F12 查看控制台', 'error');
    }
  }
}

function getDefaultTiers(channel) {
  if (channel === 'azz') {
    return [
      { price: 59, label: '¥59', displayName: '精选合集', icon: '🎁', productCount: 0, sellerCount: 0 },
      { price: 69, label: '¥69', displayName: '完整资源包', icon: '📦', productCount: 0, sellerCount: 0 },
      { price: 99, label: '¥99', displayName: '高级会员', icon: '💎', productCount: 0, sellerCount: 0 },
    ];
  }
  return [
    { price: 10, label: '¥10', displayName: '基础资源', icon: '📦', productCount: 0, sellerCount: 0 },
    { price: 20, label: '¥20', displayName: '精选套餐', icon: '🎁', productCount: 0, sellerCount: 0 },
    { price: 30, label: '¥30', displayName: '高级服务', icon: '⭐', productCount: 0, sellerCount: 0 },
    { price: 60, label: '¥60', displayName: '专业版', icon: '💎', productCount: 0, sellerCount: 0 },
  ];
}

function renderPriceTiers(tiers) {
  const grid = document.getElementById('price-tier-grid');
  grid.innerHTML = tiers.map(t => `
    <div class="tier-card" data-price="${t.price}">
      <div class="tier-icon">${t.icon || '📦'}</div>
      <h3>${escapeHtml(t.displayName || `¥${t.price} 商品`)}</h3>
      <div class="tier-price">¥${Number(t.price).toFixed(2)}</div>
      <p class="tier-desc">随机分配该价位商品，付款后自动发货</p>
      <button class="buy-btn" onclick="handleBuyTier(${t.price}, '${escapeHtml(t.displayName || `¥${t.price} 商品`)}', '${t.icon || '📦'}')">
        立即购买
      </button>
    </div>
  `).join('');
}

// ============================================================
//  统一购买流程（支持 Fansky / 爱赞助 / 爱发电）
// ============================================================
async function handleBuyTier(price, displayName, icon) {
  currentTier = { price, displayName, icon };
  const isAzz = currentChannel === 'azz';
  const isAfdian = currentChannel === 'afdian';

  // 显示支付弹窗
  openPaymentModal(displayName, price, isAzz);

  // 统一后端下单模式
  try {
    const apiPath = isAzz ? '/api/azz/orders' : isAfdian ? '/api/afdian/orders' : '/api/orders';
    const res = await fetchWithTimeout(BACKEND_URL + apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price }),
    }, 15000);
    const data = await res.json();

    if (data.code !== 0 || !data.data) {
      showPaymentError(data.error || '创建订单失败，请稍后重试');
      return;
    }

    const order = data.data;
    currentOrderId = order.internalOrderId;

    document.getElementById('order-info').style.display = 'block';
    // 订单号显示：爱赞助用 azzOrderId，爱发电用 outTradeNo，Fansky 用 fanskyTradeNo
    const orderNo = order.azzOrderId || order.outTradeNo || order.fanskyTradeNo || order.orderId || '';
    document.getElementById('order-no').textContent = orderNo;

    if (order.productName) {
      document.getElementById('payment-product-name').textContent = order.productName;
    }

    // 统一渲染二维码 + 点击跳转按钮
    // 检查是否有可用的二维码信息
    const hasQR = order.qrCodeDataUrl || order.qrCodeUrl || order.instructionsUrl || order.redirectUrl;
    if (!hasQR) {
      const errMsg = order.stripeError || '获取支付二维码失败';
      showPaymentError(errMsg + '（订单已创建，可稍后重试）');
      return;
    }
    renderPaymentQR(order, isAzz);

    startPolling(order.internalOrderId, isAzz, isAfdian);
  } catch (err) {
    console.error('下单失败:', err);
    showPaymentError('无法连接到服务器。如果是首次访问，Render 免费版可能正在唤醒（需 30-60 秒），请稍后重试。');
  }
}

// ============================================================
//  二维码生成工具（使用 qrcode-generator 库）
// ============================================================
function generateQRCodeImage(text, size = 200) {
  try {
    if (typeof qrcode === 'undefined') {
      console.warn('[QR] qrcode-generator 库未加载');
      return null;
    }
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(size, size);
  } catch (err) {
    console.error('[QR] 生成二维码失败:', err);
    return null;
  }
}

// ============================================================

function renderPaymentQR(order, isAlipay) {
  const container = document.getElementById('qr-container');
  const platform = isAlipay ? 'alipay' : 'wechat';
  const platformName = isAlipay ? '支付宝' : '微信';
  const jumpText = `点击自动打开${platformName}完成支付`;

  // 确定跳转链接（也是二维码编码的内容）
  let jumpUrl = '';
  if (isAlipay) {
    jumpUrl = order.qrCodeUrl || '';
  } else {
    jumpUrl = order.instructionsUrl || order.hostedInstructionsUrl || order.wechatProtocolUrl || order.qrCodeUrl || '';
  }

  // 确定二维码图片
  let qrImageHtml = '';
  const needGenerateQR = !order.qrCodeDataUrl && (!order.qrCodeUrl || order.qrIsPage || order.qrIsProtocol);

  if (order.qrCodeDataUrl) {
    // 后端已返回 base64 图片
    qrImageHtml = `<img src="${order.qrCodeDataUrl}" alt="${platformName}二维码" class="qr-image" />`;
  } else if (order.qrCodeUrl && !order.qrIsPage) {
    // 后端返回直接图片 URL
    qrImageHtml = `<img src="${order.qrCodeUrl}" alt="${platformName}二维码" class="qr-image" onerror="this.parentElement.innerHTML='<div class=\'qr-placeholder qr-placeholder-${platform}\'><div class=\'qr-placeholder-icon\'>${isAlipay ? '💙' : '💚'}</div><div class=\'qr-placeholder-text\'>${platformName}支付</div><div class=\'qr-placeholder-hint\'>点击下方按钮打开${platformName}</div></div>'" />`;
  } else if (needGenerateQR && jumpUrl) {
    // 页面模式：先用占位图，然后异步生成二维码图片
    qrImageHtml = `
      <div class="qr-placeholder qr-placeholder-${platform}" id="qr-placeholder">
        <div class="qr-placeholder-icon">${isAlipay ? '💙' : '💚'}</div>
        <div class="qr-placeholder-text">正在生成二维码...</div>
        <div class="qr-placeholder-hint">请稍候</div>
      </div>
    `;
  } else {
    // 无链接，显示占位图
    qrImageHtml = `
      <div class="qr-placeholder qr-placeholder-${platform}">
        <div class="qr-placeholder-icon">${isAlipay ? '💙' : '💚'}</div>
        <div class="qr-placeholder-text">${platformName}支付</div>
        <div class="qr-placeholder-hint">点击下方按钮打开${platformName}</div>
      </div>
    `;
  }

  // 跳转链接 HTML（放在二维码下方，不挡住二维码）
  let jumpHtml = '';
  if (jumpUrl) {
    jumpHtml = `
      <a href="${jumpUrl}" target="_blank" rel="noopener noreferrer" class="payment-jump-btn payment-jump-${platform}">
        <span class="jump-icon">${isAlipay ? '💙' : '💚'}</span>
        <span class="jump-text">${jumpText}</span>
      </a>
    `;
  }

  container.innerHTML = `
    <div class="qr-image-wrapper">
      ${qrImageHtml}
    </div>
    ${jumpHtml}
  `;

  // 异步生成二维码图片（页面模式）
  if (needGenerateQR && jumpUrl) {
    setTimeout(() => {
      const dataUrl = generateQRCodeImage(jumpUrl, 200);
      const placeholder = document.getElementById('qr-placeholder');
      if (dataUrl && placeholder) {
        placeholder.outerHTML = `<img src="${dataUrl}" alt="${platformName}二维码" class="qr-image" />`;
        console.log('[QR] 二维码图片生成成功');
      } else if (placeholder) {
        // 生成失败，更新占位图提示
        placeholder.querySelector('.qr-placeholder-text').textContent = `${platformName}支付`;
        placeholder.querySelector('.qr-placeholder-hint').textContent = `点击下方按钮打开${platformName}`;
      }
    }, 100);
  }
}

// ============================================================
//  支付弹窗控制
// ============================================================
function openPaymentModal(productName, price, isAlipay) {
  document.getElementById('payment-product-name').textContent = productName;
  document.getElementById('payment-product-price').textContent = `¥${Number(price).toFixed(2)}`;
  document.getElementById('qr-tip-text').textContent = isAlipay ? '请使用支付宝扫码支付' : '请使用微信扫码支付';
  document.getElementById('qr-container').innerHTML = '<div class="loading">正在生成付款码...</div>';
  document.getElementById('payment-status').style.display = 'flex';
  document.getElementById('status-text').textContent = '等待付款...';
  document.querySelector('#payment-status .status-dot').className = 'status-dot';
  document.getElementById('order-info').style.display = 'none';
  document.getElementById('payment-modal').style.display = 'flex';
}

/**
 * 取消当前订单（通知后端删除平台订单）
 */
async function cancelCurrentOrder() {
  if (!currentOrderId) return;
  const orderId = currentOrderId;
  const isAzz = currentChannel === 'azz';
  const isAfdian = currentChannel === 'afdian';
  const apiPath = isAzz ? `/api/azz/orders/${orderId}/cancel` : isAfdian ? `/api/afdian/orders/${orderId}/cancel` : `/api/orders/${orderId}/cancel`;
  try {
    await fetch(`${BACKEND_URL}${apiPath}`, { method: 'POST' });
    console.log('[App] 订单已取消:', orderId);
  } catch (err) {
    console.warn('[App] 取消订单失败:', err.message);
  }
}

function closePaymentModal() {
  document.getElementById('payment-modal').style.display = 'none';
  stopPolling();
  // 通知后端取消订单（异步，不阻塞UI）
  cancelCurrentOrder();
  currentOrderId = null;
}

function showPaymentError(msg) {
  document.getElementById('qr-container').innerHTML = `<div class="payment-error">${msg}</div>`;
  document.getElementById('status-text').textContent = '出错了';
  document.querySelector('#payment-status .status-dot').className = 'status-dot error';
}

// ============================================================
//  订单状态轮询
// ============================================================
function startPolling(orderId, isAzz, isAfdian = false) {
  pollStartTime = Date.now();
  const apiPath = isAzz ? `/api/azz/orders/${orderId}/status` : isAfdian ? `/api/afdian/orders/${orderId}/status` : `/api/orders/${orderId}/status`;

  pollTimer = setInterval(async () => {
    if (Date.now() - pollStartTime > MAX_WAIT_TIME) {
      stopPolling();
      showPaymentError('等待超时，请重新发起购买');
      // 通知后端取消订单
      cancelCurrentOrder();
      currentOrderId = null;
      return;
    }
    try {
      const res = await fetch(`${BACKEND_URL}${apiPath}`);
      const data = await res.json();
      if (data.code !== 0) return;
      const status = data.data.status;
      if (status === 'paid') {
        stopPolling();
        handlePaymentSuccess(data.data);
      } else if (status === 'cancelled' || status === 'expired' || status === 'failed') {
        stopPolling();
        showPaymentError(`订单${status === 'cancelled' ? '已取消' : status === 'expired' ? '已过期' : '失败'}，请重新购买`);
      }
    } catch (err) {
      console.error('查询状态失败:', err);
    }
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ============================================================
function handlePaymentSuccess(orderData) {
  closePaymentModal();
  openDeliveryModal(orderData);
}

function openDeliveryModal(orderData) {
  document.getElementById('delivery-product-name').textContent = orderData.productName || currentTier?.displayName || '商品';
  document.getElementById('delivery-product-price').textContent = `¥${Number(orderData.amount || currentTier?.price || 0).toFixed(2)}`;
  document.getElementById('delivery-order-no').textContent = orderData.fanskyTradeNo || orderData.azzOrderId || '-';

  const downloadUrl = orderData.downloadUrl || 'https://example.com/download';
  document.getElementById('download-link-input').value = downloadUrl;
  document.getElementById('download-link-btn').href = downloadUrl;

  const extractCode = orderData.extractCode;
  if (extractCode) {
    document.getElementById('extract-code-section').style.display = 'block';
    document.getElementById('extract-code-input').value = extractCode;
  } else {
    document.getElementById('extract-code-section').style.display = 'none';
  }

  document.getElementById('delivery-modal').style.display = 'flex';
  setTimeout(() => showScreenshotWarning(), 1000);
}

function closeDeliveryModal() {
  document.getElementById('delivery-modal').style.display = 'none';
  closeScreenshotOverlay();
}

// ============================================================
//  截图提醒机制
// ============================================================
function showScreenshotWarning() {
  const warning = document.querySelector('.screenshot-warning');
  if (warning) {
    warning.classList.add('pulse-warning');
    setTimeout(() => warning.classList.remove('pulse-warning'), 2000);
  }
}

function triggerScreenshot() {
  document.getElementById('screenshot-overlay').style.display = 'flex';
}

function closeScreenshotOverlay() {
  document.getElementById('screenshot-overlay').style.display = 'none';
}

// ============================================================
//  工具函数
// ============================================================
function copyToClipboard(inputId) {
  const input = document.getElementById(inputId);
  input.select();
  input.setSelectionRange(0, 99999);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(input.value).then(() => {
      showToast('已复制到剪贴板', 'success');
    }).catch(() => {
      document.execCommand('copy');
      showToast('已复制', 'success');
    });
  } else {
    document.execCommand('copy');
    showToast('已复制', 'success');
  }
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast toast-${type}`;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
//  初始化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  console.log('[App] 当前后端地址:', BACKEND_URL);
  console.log('[App] 默认支付渠道: 微信支付(Fansky)');

  const footer = document.querySelector('.footer-contact');
  if (footer) {
    footer.innerHTML += ' | 后端: <code style="font-size:11px;opacity:0.6;">' + BACKEND_URL + '</code>';
  }

  loadPriceTiers();

  document.getElementById('payment-modal').addEventListener('click', (e) => {
    if (e.target.id === 'payment-modal') closePaymentModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('payment-modal').style.display === 'flex') {
        closePaymentModal();
      }
    }
  });
});
