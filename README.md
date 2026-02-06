# 域名连通率检测（Vercel 版）

功能：上传 `txt` → 批量检测 → 下载输出 `txt`（保持原格式，并替换/补充每行的 `连通率XX%`）。

默认参数（可在页面改）：
- 探测次数：2
- 并发：8
- 超时：8000ms
- 成功判定：`mode=1`（2xx/3xx 视为成功；更接近“能正常打开”的感觉）

## 部署到 Vercel

方式 1：GitHub 导入（推荐）
1. 把本目录推到一个 GitHub 仓库
2. Vercel 新建项目 → Import Git Repository → Deploy

方式 2：Vercel CLI
1. 安装：`npm i -g vercel`
2. 在本目录执行：`vercel`（按提示登录/创建项目）
3. 上线：`vercel --prod`

## 说明
- 这是“从 Vercel 机房视角”去请求网址的可达性检测，不是 itdog 多节点。
- 结果可能受目标站对机房 IP 限制/风控影响。
