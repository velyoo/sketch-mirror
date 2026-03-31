#!/bin/bash
cd "$(dirname "$0")"

# Check Node.js
if ! command -v node &>/dev/null; then
  osascript -e 'display dialog "请先安装 Node.js\n\n前往 https://nodejs.org 下载安装后再试" buttons {"好的"} default button 1 with icon stop with title "Sketch Mirror"'
  exit 1
fi

# Install dependencies if needed
if [ ! -d node_modules ]; then
  echo "首次启动，正在安装依赖…"
  npm install
  echo ""
  echo "💡 提示：把「启动 Mirror.command」拖到 Dock，下次一键启动"
  echo ""
fi

# Show startup notification
osascript -e 'display notification "Sketch Mirror 已启动，在手机上打开 Tailscale 地址即可预览" with title "Sketch Mirror"'

# Start server
node server.js