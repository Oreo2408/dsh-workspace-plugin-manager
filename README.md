# DSH 工作区插件管理 / Workspace Plugin Manager

给 DeepSeek Harness 的每个工作区单独配一套插件。像游戏 mod 管理器：每个工作区一张插件表，切换工作区时按表开关插件。

Per-workspace plugin sets for DeepSeek Harness. Each workspace keeps its own table of plugins; switching workspaces applies it.

## 功能 / Features

- **工作区 ⋯ 菜单入口**：右击工作区标题或点 ⋯ →「插件管理」，菜单里直接显示 `开/总数`。
- **浮窗管理**：可拖动、可缩放，记住位置和大小。
- **表 + 未启用池**：表里是本工作区要用的插件；左下角「未启用插件」池子，双击加入。
- **文件夹**：新建 / 重命名 / 删除 / 整组开关；支持剪切、复制、粘贴、删除（剪切/复制可跨工作区）。
- **新插件黄条**：安装了新插件后打开某个工作区，顶部提示是否加入本工作区 / 加入所有工作区 / 加入文件夹；可折叠，可忽略。
- **切换工作区提示**：表与当前实际状态不同时，弹窗询问 应用 / 这次不换；如果别的工区正在跑，改成顶部黄条（按钮 2 秒冷却，可在设置里关）。
- **重启提示**：插件返回 `restart-required` 时弹窗说明；设置页可预览。
- **模板 / 备份**：把某个工作区的表设为模板；导出/导入 JSON。
- **依赖标记**：标记 A 依赖 B，删除 B 时提醒，应用时缺依赖给黄色提示。
- **描述**：插件市场里写过的备注优先，否则用插件自带说明。
- **本机文件存储**：表存在 profile 目录下的 `workspace-plugin-manager.json`，刷新、重启、换窗口都不丢。

## 安装 / Install

需要 DSH 0.2.2-rc.1 或更新版本。

1. 把本目录放到任意本地路径（例如 `F:\plugins\dsh-workspace-plugin-manager`）。
2. 用 DSH 的插件管理器安装本地包：

   ```
   dsh plugin --profile <你的 profile> add link:<上面那个路径>
   ```

   或者打开 Web GUI 侧边栏「插件」→「添加插件」，填入 `link:<路径>` 后启用。

   Host 半边需要重启一次插件行（或重启 DSH）才会注册状态文件路由；之后只改 `client.js` 时刷新页面即可。

## 使用 / Usage

1. 右击左侧任务栏里的工作区标题（或点 ⋯）。
2. 选「插件管理」。
3. 第一次打开先选择：从空表开始 / 放进当前已启用的插件 / 套用模板。
4. 左下角「未启用插件」双击加入；表里用工具栏管理文件夹与剪贴板。
5. 点「保存并应用」把表同步到实际插件状态。

数据文件：`<DSH profile 目录>/workspace-plugin-manager.json`（例如 `%USERPROFILE%\.dsh\profiles\<profile>\workspace-plugin-manager.json`）。

## 已知限制 / Limitations

- 插件树是整个 Host 进程一份，所以同一时刻只有一套插件生效；同时打开两个不同工作区的会话时它们共用当前这套。
- 切工作区会实时卸载/挂载插件，MCP 会重连，通常几秒。
- 开关大多靠 HMR 即时生效；只有插件管理器返回 `restart-required` 时才需要重启。
- 目前在 Windows + DSH Desktop 上验证。

## 开发 / Development

- `client.js`：浏览器半边（`window.__ModuleLoader__.load` 工厂），界面与逻辑都在这。
- `index.js`：宿主半边，提供 `GET/PUT /dsh-workspace-plugin-manager/state`，只接受本机回环请求，原子写状态文件。
- `cordis.patch.yml`：bundle 行。
- `locale/*.json`：插件卡片标题与描述。

## License

MIT
