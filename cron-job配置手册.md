# cron-job.org 外部踢腿器 · 配置手册

用途：由 cron-job.org 定时调用 GitHub API 触发 workflow，绕开 GitHub 自带调度器
（自带调度器会整窗静默丢弃任务，10-28/29/30 连续三天北京 15:00~16:15 窗口全丢）。

仓库：`c57g7tn8k8-creator/Trading`，分支：`main`

---

## 第 0 步：生成 GitHub 个人令牌（PAT）

用途：让 cron-job.org 有权限调用 GitHub API。

1. GitHub 网页右上角点头像 → **Settings**
2. 左侧栏最底部 → **Developer settings**
3. **Personal access tokens** → **Tokens (classic)**
4. 右上角 **Generate new token** → 选 **Generate new token (classic)**
5. 填写：
   - Note：`cronjob-kicker`
   - Expiration：`1 year`（**必须选！选 No expiration 会被 GitHub 拒绝——2026-11-02 实测：无期限令牌 API 调用一律 401，改 1 年即恢复**；每年10月下旬需 Regenerate 续期并替换 7 个任务的请求头）
   - 勾选权限：**`repo`**（私有仓库必需；公开仓库最小只需 `public_repo`，直接勾 repo 最省事）
     **和 `workflow`**（必须！否则触发 workflow 会 403）
6. 点 **Generate token** → **立刻复制那串 `ghp_...`**（只显示一次，关页面就没了）

> 不要把令牌写进仓库文件、不要发给别人。它只填在 cron-job.org 里。

---

## 第 1 步：注册 cron-job.org

1. 打开 https://console.cron-job.org/signup
2. 填 Email / Username / Password，勾选同意条款 → **Sign up**
3. 去邮箱点激活链接（**找一下垃圾邮件/广告邮件**），激活后登录
   https://console.cron-job.org
4. **设置时区（重要）**：右上角头像 → **Settings** → **Time zone** 选
   `Asia/Shanghai (UTC+08:00)` → Save。
   设好后，任务里填的小时/分钟就是**北京时间**，不用再换算。

---

## 第 2 步：建任务（7 个）

左侧菜单 **Cronjobs** → 右上角 **CREATE CRONJOB**。

每个任务填四块：**Title / URL / Advanced（请求参数）/ Schedule（时间）**。

### 通用填法（所有 7 个任务都一样）

- **Request method**：`POST`（在 Advanced 区块里选，默认是 GET）
- **Headers**（Advanced 区块 → Headers → Add，逐条添加）：

| Header name | Header value |
|---|---|
| `Authorization` | `Bearer ghp_你的令牌` （注意 Bearer 后面一个空格） |
| `Accept` | `application/vnd.github+json` |
| `X-GitHub-Api-Version` | `2022-11-28` |
| `Content-Type` | `application/json` |

- **Body**（Advanced 区块 → Body）：见下表（每个任务不同）
- **Schedule**：选 **Every day**，然后
  - Hours：只勾选下表那个小时
  - Minutes：只勾选下表那个分钟
  - Days：**只勾周一到周五**（周六周日取消勾选）
- **Notifications**：打开 **Notify me on failure**（失败发邮件告警，这是本方案的核心价值）

### 7 个任务一览表

| # | Title | 北京时间 | URL | Body |
|---|---|---|---|---|
| 1 | 信号提醒-早间 | **08:00** | `https://api.github.com/repos/c57g7tn8k8-creator/Trading/actions/workflows/remind.yml/dispatches` | `{"ref":"main","inputs":{"slot":"morning","force":"0"}}` |
| 2 | 盘中扫描-午间 | **11:30** | `https://api.github.com/repos/c57g7tn8k8-creator/Trading/actions/workflows/scan.yml/dispatches` | `{"ref":"main","inputs":{"slot":"noon","force":"0"}}` |
| 3 | 信号提醒-午间 | **11:45** | `https://api.github.com/repos/c57g7tn8k8-creator/Trading/actions/workflows/remind.yml/dispatches` | `{"ref":"main","inputs":{"slot":"noon","force":"0"}}` |
| 4 | 盘中扫描-傍晚 | **15:00** | `.../scan.yml/dispatches` | `{"ref":"main","inputs":{"slot":"evening","force":"0"}}` |
| 5 | 收盘日报 | **15:20** | `https://api.github.com/repos/c57g7tn8k8-creator/Trading/actions/workflows/daily.yml/dispatches` | `{"ref":"main","inputs":{"force":"0"}}` |
| 6 | 信号提醒-晚间 | **20:00** | `.../remind.yml/dispatches` | `{"ref":"main","inputs":{"slot":"evening","force":"0"}}` |
| 7 | 盘中扫描-夜盘 | **23:00** | `.../scan.yml/dispatches` | `{"ref":"main","inputs":{"slot":"night","force":"0"}}` |

（表中 `...` 统一为 `https://api.github.com/repos/c57g7tn8k8-creator/Trading/actions/workflows/`）

说明：
- 扫描必须先于对应提醒（11:30→11:45、15:00→20:00），引擎自带防竞态等待，扫描没跑完提醒会等。
- `force` 一律填 **`0`**：如果 GitHub 自带 cron 已经把这个时段跑过了，踢腿会被幂等守卫拦下，
  **不会重复推送**。只有你在 GitHub 网页手动 Run workflow 时才用 `force=1`。

---

## 第 3 步：逐个测试

每个任务建好后在列表里点 **Execute now**（或 Run now / Test run）：

- 正常：返回 **204 No Content**，同时 GitHub 仓库 Actions 页面出现一条新运行记录。
- 报错 401/403：令牌没勾 `workflow` 权限，或 `Bearer ` 后面漏了空格。
- 报错 404：URL 里的仓库名/分支名写错。

**特别提示（补今天的日报）**：第 5 个任务（收盘日报）第一次测试时，把 Body 里的
`force` 临时改成 `"1"` 再 Execute now —— 这样会真的推送今天（10-30）的收盘日报，
正好补上今天没推的那一期。确认飞书收到后，**把 force 改回 `"0"` 并保存**。

---

## 第 4 步（可选，建议做）

外部踢腿器上线后，可以把 GitHub 仓库里那 40+ 条 cron 精简掉（每个 workflow 只留 1~2 档
作为备份），降低仓库被 GitHub 降权导致整窗丢弃的概率。这一步我可以生成精简版 yml 给你上传。

---

## 日常维护

- 令牌有效期 1 年，到期前 GitHub 会发邮件提醒，重新生成一个替换到 7 个任务的 Header 里。
- 任务失败 cron-job.org 会发邮件，邮件里能看到 GitHub 返回的错误码。
- 连续失败多次的任务，cron-job.org 会自动延迟执行（保护机制），修好后自动恢复。
