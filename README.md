# dsh-selection-quote-auto

**选中即复制 + 「注释」浮框** —— [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的划词引用与批注增强插件，基于 [xt765/dsh-selection-quote](https://github.com/xt765/dsh-selection-quote) 0.2.0 的本地增强版（MIT）。

选一段助手回复里的文字，原文自动进剪贴板，选区上方直接弹出「注释」小胶囊；点它才展开原来的评论输入框。右键菜单和 `⌘L` 全部保留。

> A fork of [dsh-selection-quote](https://github.com/xt765/dsh-selection-quote) for DeepSeek Harness: selecting text in an assistant message copies it and shows a small **Comment** chip; clicking the chip opens the inline comment box. Right-click menu and `⌘L` still work. Web profile only (`dsh.client.platform = "web"`).

## 和上游的区别

| | 上游 0.2.0 | 本插件 |
| --- | --- | --- |
| 触发 | 选中后右键，或按 `⌘L` | 选中即**自动复制原文**，并在选区上方弹「注释」胶囊；右键 / `⌘L` 仍可用 |
| 复制 | 右键菜单里的「拷贝」 | 选中即复制，浮框右侧短暂显示「已复制」 |
| 标记 | 蓝色背景高亮 | 暖色波浪下划线（待确认）/ 点线（已进队列），不遮挡正文 |
| 深色模式 | 跟随系统 `prefers-color-scheme`，与 DSH 主题可能不一致 | 跟随 DSH 的 `body[data-ds-dark-theme]` |
| 外观 | 深色胶囊/卡片 | 白色液态玻璃（浅色主题）/ 烟熏玻璃（深色主题） |
| 角标 | 滚动时靠 React 重渲染，惯性滚动会拖影 | rAF 直接同步坐标，滚动时贴在文字旁；越界自动隐藏 |
| 范围 | 会话内任意消息 | 默认仅助手消息（`AUTO_TRIGGER_SCOPE` 可切换） |

![液态玻璃（浅色）](./assets/glass-light.png)
![标记样式](./assets/highlight-preview.png)

## 安装

### 方式一：市场索引源（Discover，无需 npm）

```text
https://cdn.jsdelivr.net/gh/prettyfox/dsh-selection-quote-auto@main/index.json
```

在 DSH 的 **插件 → 发现（Discover）→ 索引源** 里添加该 URL 后即可搜索安装（该功能由实验性 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 提供，需在 profile 的 `dsh.profile.bundles` 里启用并重启一次 `dsh web`）。

> 索引按 `@main` 分支提供（首次冷启动最快）。需要钉死不可变版本时用 `@ee4d69273c1187c2dc72f652385a3fb1ea53788d` 代替 `@main`。

### 方式二：预构建 tarball / 源码

```sh
# 预构建 tarball（推荐，免构建）
dsh plugin --profile web add https://github.com/prettyfox/dsh-selection-quote-auto/releases/download/v0.2.0/dsh-selection-quote-auto-0.2.0.tgz

# 或直接从 GitHub 源码（等价于 git clone 后安装）
dsh plugin --profile web add git+https://github.com/prettyfox/dsh-selection-quote-auto.git
```

### 方式三：本仓库

```sh
git clone https://github.com/prettyfox/dsh-selection-quote-auto.git
dsh plugin --profile web add ./dsh-selection-quote-auto
```


```sh
dsh plugin --profile web add dsh-selection-quote-auto
```

装完刷新页面（新 bundle 通常需要重启一次 `dsh web`）。也可以在 DSH 的插件市场/发现页里搜索 `dsh-selection-quote-auto`。

> ⚠️ **先卸载或停用上游 `dsh-selection-quote`**，两者会往同一个位置渲染浮框，同时启用会重复出现两套 UI。

## 使用

1. 在助手回复里选中 ≥2 个字 → 原文自动复制，选区上方出现「注释」；
2. 点「注释」→ 评论输入框出现（自动聚焦），可写批注，留空也行；
3. `Enter` 或 ✓ → 底部输入框出现 `💬 N 条注释 ×`，`Enter` 发送；
4. 右键菜单（拷贝 / 添加到对话 `⌘L`）、序号角标、已发送消息的 `N 条注释` 胶囊都保持原样。

## 配置

插件本身读取宿主配置 `enabled` / `addToChatMode` / `commentLabel`；行为常量在 `lib/client.js` 顶部（改动后刷新页面即生效）：

```js
const AUTO_COPY_ON_SELECT = true;       // 选中即复制原文
const AUTO_TRIGGER_ON_SELECT = true;    // 选中即显示「注释」胶囊
const AUTO_TRIGGER_SCOPE = "assistant"; // "assistant" 仅助手消息；"any" 所有会话消息
const COPIED_HINT_MS = 1600;            // 「已复制」提示时长
```

## 兼容

- DSH `0.2.x` web profile（`dsh web`），Chromium 内核浏览器；持久下划线依赖 CSS Custom Highlight API（Chrome/Edge 105+、Safari 17.2+），不支持时优雅降级。
- 宿主侧只注入 `conversation.input.overlay` / `conversation.input.dock` / `conversation.user.text.node` 三个既有插槽，不改 DSH 核心。

## 开发与回归

```sh
node --test test/index.test.js
```

`test/dom-harness.html`（Range 失效重定位）、`test/pin-scroll-harness.html`（滚动跟随）可用 headless Chrome 打开查看 OK/FAIL 输出。

## 更新日志

### 0.2.1

- 修复：`lib/client.js` 里 `MODULE_ID` 仍是上游的 `dsh-selection-quote`，宿主按包名 `dsh-selection-quote-auto` 取模块时拿不到注册，报
  `client-modules: could not load "dsh-selection-quote-auto" … loaded without registering`，插件页整页变成 `Failed to load plugins`。现改为 `dsh-selection-quote-auto`。

## 来源与许可

- 上游：[xt765/dsh-selection-quote](https://github.com/xt765/dsh-selection-quote) 0.2.0（MIT，© 2026 xt765）
- 本仓库的修改（自动复制、注释浮框、标记样式、深色主题修正、角标滚动跟随、液态玻璃外观）© 2026 prettyfox，同样以 MIT 发布，见 [LICENSE](./LICENSE)。

本插件是独立分叉，与上游作者无隶属关系；安装即运行第三方代码，请自行检查源码。
