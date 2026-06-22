# Sketch Mirror

将 Sketch 设计稿实时镜像到手机预览，支持捏合缩放、左右切换 Frame。

---

## 环境要求

- macOS + [Sketch](https://www.sketch.com/)（需开启 MCP 插件）
- [Node.js](https://nodejs.org) LTS
- [Tailscale](https://pkgs.tailscale.com/stable/#macos)（Mac + 手机各装一个，登同一账号）

---

## 安装

1. 前往 [Releases](https://github.com/velyoo/sketch-mirror/releases/latest) 下载 `sketch-mirror.zip`，解压
2. 打开 Sketch → 菜单栏「Sketch」→「设置」→ 打开 MCP 开关
3. 登录 [Tailscale 管理后台](https://login.tailscale.com/admin/dns)，开启「HTTPS Certificates」（每人只需做一次）
4. 手机安装 Tailscale，登录同一账号

---

## 启动

双击解压后文件夹里的 **「启动 Mirror.command」**。

首次运行会自动安装依赖（约 10–30 秒），之后终端显示二维码即表示启动成功。

> 下次可把「启动 Mirror.app」拖到 Dock，一键启动。

---

## 使用

1. 用手机摄像头扫描终端里的二维码
2. 在 Sketch 中点选一个 **Frame**（选整个 Frame，不是子图层）
3. 手机屏幕约 2 秒后自动显示预览

**手势：**

| 手势 | 操作 |
|------|------|
| 左右滑动 | 切换 Frame |
| 单指拖动 | 平移画面 |
| 双指捏合 | 缩放 |
| 单击屏幕 | 显示/隐藏操作按钮 |

---

## 常见问题

**启动报 `Could not connect to Sketch MCP`**
确认 Sketch 已打开，设置里 MCP 开关已打开。尝试关掉开关再重新打开，重启服务器。

**启动报 `EADDRINUSE: address already in use 3000`**
```bash
pkill -f "node server.js"
```
然后重新启动。

**手机扫码后打不开**
确认手机 Tailscale 已连接（图标不是灰色）。

**预览一直空白**
确认在 Sketch 里选中的是整个 Frame，不是子图层。点手机右下角刷新按钮。

**双击「启动 Mirror.app」提示"已损坏"**
先双击「启动 Mirror.command」运行一次，它会自动清除隔离标记。

---

## 自动更新

服务器启动时会自动检查新版本，有更新会自动下载并重启，无需手动操作。
