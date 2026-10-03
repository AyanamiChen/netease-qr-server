/**
 * 网易云音乐扫码登录中转服务（N86 J2ME 客户端专用）
 *
 * 为什么需要它：网易云的登录接口走 /weapi/* 路径，要求 AES+RSA 加密请求体。
 * J2ME（CLDC-1.1）上没有 javax.crypto，手写加密又慢又容易错，
 * 所以把这「唯一需要加密」的登录环节放到服务器上，手机只做「请求/展示/轮询」。
 *
 * 手机（N86）直连本服务的 4 个接口，其余功能（搜索/歌单/播放）仍直连网易云老接口。
 *
 * 部署：Vercel（一个 app.js + crypto-js 依赖即可，冷启动快）。
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const QRCode = require('qrcode');

// ---------- 网易云 weapi 加密参数（官方固定值） ----------
const modulus = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const pubKey = '010001';
const nonce = '0CoJUm6Qyw8W8jud';

// ---------- weapi 加密实现 ----------
function aesEncrypt(text, secKey) {
  const key = Buffer.from(secKey, 'utf8');
  const iv = Buffer.from('0102030405060708', 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

function rsaEncrypt(text, pubKeyHex, modulusHex) {
  // 用 node 的 RSA 公钥加密（逆序填充）
  const textReversed = Buffer.from(text).reverse();
  const textHex = textReversed.toString('hex');

  // 用内置 bigint 手动做 RSA（m = c^e mod n）
  const e = BigInt('0x' + pubKeyHex);
  const n = BigInt('0x' + modulusHex);
  const m = BigInt('0x' + textHex);
  const c = modPow(m, e, n);
  let cHex = c.toString(16);
  // 补零到 256 字节（512 hex）
  while (cHex.length < 256) cHex = '0' + cHex;
  return cHex;
}

function modPow(base, exp, mod) {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp = exp >> 1n;
  }
  return result;
}

function weapiEncrypt(object) {
  const text = JSON.stringify(object);
  const secKey = randomKey();
  const encText = aesEncrypt(aesEncrypt(text, nonce), secKey);
  const encSecKey = rsaEncrypt(secKey, pubKey, modulus);
  return {
    params: encText,
    encSecKey: encSecKey,
  };
}

function randomKey() {
  const chars = '0123456789abcdeffedcba';
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// ---------- HTTP 工具：请求网易云 weapi ----------
function requestWeapi(path, data, cookie) {
  return new Promise((resolve, reject) => {
    const enc = weapiEncrypt(data);
    const body = new URLSearchParams(enc).toString();

    const req = http.request({
      hostname: 'music.163.com',
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://music.163.com/',
        'Cookie': cookie || '',
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        resolve({ body: raw, headers: res.headers, statusCode: res.statusCode });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 从响应头里提取 Set-Cookie，拼成 MUSIC_U=xxx; __csrf=xxx 这种格式
function extractCookie(setCookieHeaders) {
  if (!setCookieHeaders) return '';
  const cookies = {};
  for (const h of setCookieHeaders) {
    const m = h.match(/^([^=]+)=([^;]*)/);
    if (m) cookies[m[1].trim()] = m[2].trim();
  }
  return Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; ');
}

// ---------- 核心：二维码登录三接口 ----------

// 1. 生成 unikey
async function qrKey() {
  const r = await requestWeapi('/weapi/login/qrcode/unikey', {
    type: 1,
  });
  return JSON.parse(r.body);
}

// 2. 用 unikey 生成二维码（自己编码二维码内容，绕开网易云已失效的 create 接口）
//    二维码里编码的内容就是官方登录 URL：https://music.163.com/login?codekey=<unikey>
async function qrCreate(key) {
  const loginUrl = 'https://music.163.com/login?codekey=' + key;
  const dataUrl = await QRCode.toDataURL(loginUrl, {
    width: 240,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });
  return { qrimg: dataUrl, qrurl: loginUrl };
}

// 3. 轮询扫码状态（803 时拿 cookie）
async function qrCheck(key, noCookie) {
  const data = { key, type: 1 };
  if (noCookie) data.noCookie = 'true';
  const r = await requestWeapi('/weapi/login/qrcode/client/login', data);
  const parsed = JSON.parse(r.body);
  // 登录成功时，cookie 在响应头 Set-Cookie 里
  if (parsed.code === 803) {
    parsed._cookie = extractCookie(r.headers['set-cookie']);
  }
  return parsed;
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // 允许跨域（Vercel 预览/后续前端调试用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 健康检查
  if (path === '/' || path === '/api/health') {
    return sendJson(res, 200, { code: 200, message: 'netease-qr-server ok' });
  }

  const q = url.searchParams;

  try {
    // 1. 二维码 key
    if (path === '/api/qr/key') {
      const r = await qrKey();
      // 兼容：官方字段是 unikey
      return sendJson(res, 200, { code: 200, unikey: r.unikey, data: r });
    }

    // 2. 二维码图片
    if (path === '/api/qr/create') {
      const key = q.get('key');
      if (!key) return sendJson(res, 400, { code: 400, message: 'missing key' });
      const r = await qrCreate(key);
      return sendJson(res, 200, {
        code: 200,
        qrimg: r.qrimg,           // data:image/png;base64,xxxx 完整 data URL
        qrurl: r.qrurl,
      });
    }

    // 3. 扫码状态轮询
    if (path === '/api/qr/check') {
      const key = q.get('key');
      if (!key) return sendJson(res, 400, { code: 400, message: 'missing key' });
      const noCookie = q.get('noCookie') === 'true';
      const r = await qrCheck(key, noCookie);
      // 把 cookie 一并放回顶层，方便 J2ME 简单解析
      return sendJson(res, 200, {
        code: r.code,
        message: r.message,
        cookie: r._cookie || '',
        data: r,
      });
    }

    // 未匹配
    return sendJson(res, 404, { code: 404, message: 'not found: ' + path });
  } catch (e) {
    return sendJson(res, 500, { code: 500, message: String(e && e.message || e) });
  }
});

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('netease-qr-server listening on ' + PORT);
});
