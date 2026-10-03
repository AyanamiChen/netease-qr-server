# netease-qr-server

网易云音乐**扫码登录**中转服务，专为 N86（S60v3 J2ME）网易云客户端设计。

## 为什么需要它

网易云登录接口走 `/weapi/*`，要求 **AES+RSA 加密**请求体。J2ME（CLDC-1.1）没有 `javax.crypto`，所以把「唯一需要加密」的登录环节放到服务器上。手机只做「请求 / 展示二维码 / 轮询状态」，其余功能（搜索、歌单、播放）仍然直连网易云老接口，不受影响。

## 接口（手机 J2ME 客户端调用）

| 接口 | 参数 | 返回 |
|------|------|------|
| `GET /api/qr/key` | 无 | `{ code:200, unikey:"..." }` |
| `GET /api/qr/create?key=xxx` | `key` | `{ code:200, qrimg:"base64..." }` |
| `GET /api/qr/check?key=xxx` | `key` | `{ code:800/801/802/803, cookie:"..." }` |

扫码状态码：`800` 过期 · `801` 待扫码 · `802` 已扫待确认 · `803` 登录成功（此时返回 `cookie`）

## 本地运行

```bash
node app.js
# 默认监听 3000 端口
```

## 部署到 Vercel

1. 把本目录上传到 GitHub 仓库
2. Vercel → New Project → Import 该仓库
3. Framework Preset 选 **Other**
4. Deploy，拿到 `https://xxx.vercel.app` 地址
5. 把这个地址配置到 J2ME 客户端（`Api.QR_SERVER`）

## 安全提示

- 扫码成功后 cookie 会短暂经过本服务，建议**自建自用**，不要用他人部署的实例。
- 本服务**不落盘存储任何 cookie**，仅转发，收到即返回。
