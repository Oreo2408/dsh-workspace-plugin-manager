/* eslint-disable */
/**
 * Workspace plugin manager — browser half.
 *
 * Each workspace keeps its own table of plugins. The table is what this
 * workspace runs: plugins not in the table are listed under "not added yet"
 * and are switched off when the table is applied.
 *
 * Rows are file-manager entries: folders group plugins, and cut / copy /
 * paste / delete move them inside the table or to another workspace's table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-plugin-manager',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useState, useEffect, useRef, useSyncExternalStore } = React

    const STORAGE_KEY = 'dsh-workspace-plugin-manager.v2'

    /** Bundles the shipped Plugins page also hides; showing them here would invite damage. */
    const HIDDEN_BUNDLES = new Set([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-headless',
      '@deepseek-ai/dsh-sdk-app',
      '@deepseek-ai/dsh-acp-app',
      '@deepseek-ai/dsh-sdk-minimal',
      '@deepseek-ai/dsh-experimental-terminal-bundle',
      '@deepseek-ai/dsh-experimental-tool-worktree',
    ])

    /** Bundles this manager must never switch off, or it removes its own lever. */
    const PROTECTED = new Set(['dsh-workspace-plugin-manager', '@deepseek-ai/dsh-plugin-manager'])

    const RESTART_REASONS = {
      'no-hmr': '这个 profile 没有开热更新，改动只能重启后生效',
      'package-moved': '插件包的位置变了，运行中的进程还指着旧位置',
      'host-module': '有宿主模块没法热替换',
      'unmanaged-plugin': '有插件不归插件管理器管',
      'module-comparison': '模块比对认为必须重启',
    }

    // ---------------------------------------------------------------- store

    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...patch, version: (state.version ?? 0) + 1 }
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function readPersisted() {
      const fallback = {
        version: 2,
        sets: {},
        settings: { autoApply: false, applyCooldown: true, restartMode: 'conservative', template: null, dependencies: {} },
        geometry: null,
      }
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        return {
          ...fallback,
          ...parsed,
          sets: parsed.sets ?? {},
          settings: { ...fallback.settings, ...(parsed.settings ?? {}) },
        }
      } catch {
        return fallback
      }
    }

    function writePersisted(persisted) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
      } catch {
        /* storage full or blocked: keep the page usable */
      }
    }

    // --------------------------------------------------------------- helpers

    function bundleKey(name) {
      return `b:${name}`
    }

    function localize(value) {
      if (value === undefined || value === null) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'object') {
        return value.zh ?? value['zh-CN'] ?? value.en ?? Object.values(value)[0] ?? ''
      }
      return String(value)
    }

    function visibleBundles(bundles) {
      return bundles.filter((bundle) => {
        if (HIDDEN_BUNDLES.has(bundle.name)) return false
        // The manager itself is not a mod: it cannot be removed from the running
        // page, so listing it would only invite a pointless switch.
        if (bundle.name === 'dsh-workspace-plugin-manager') return false
        const code = bundle.error?.code
        if (code === 'not-bundle' || code === 'unknown-plugin') return false
        if (!bundle.enabled && !bundle.installed && bundle.availability !== 'profile') return false
        return (bundle.rows?.length ?? 0) > 0 || !bundle.enabled
      })
    }

    function liveOf(bundles) {
      const map = {}
      for (const bundle of visibleBundles(bundles)) map[bundleKey(bundle.name)] = Boolean(bundle.enabled)
      return map
    }

    function sameValues(a, b, keys) {
      for (const key of keys) if (Boolean(a[key]) !== Boolean(b[key])) return false
      return true
    }

    function shortText(text, max) {
      const value = String(text ?? '').replace(/\s+/g, ' ').trim()
      return value.length > max ? `${value.slice(0, max - 1)}…` : value
    }

    function newId() {
      return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    }

    // ------------------------------------------------------------ components

    function Portal(props) {
      return ReactDOM.createPortal(props.children, document.body)
    }

    function Toggle(props) {      const { checked, disabled, onChange, label } = props
      return h(
        'button',
        {
          type: 'button',
          className: `wspm-toggle${checked ? ' is-on' : ''}`,
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          disabled,
          onClick: (event) => {
            event.stopPropagation()
            if (!disabled) onChange(!checked)
          },
        },
        h('span', { className: 'wspm-toggle-knob' }),
      )
    }

    function Icon(props) {
      const size = props?.size ?? 16
      return h(
        'svg',
        { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
        h('rect', { x: 4, y: 4, width: 56, height: 56, rx: 14, fill: '#2f6fe0' }),
        h(
          'g',
          { fill: 'none', stroke: '#fff', strokeWidth: 4, strokeLinecap: 'round' },
          h('path', { d: 'M18 23h28M18 32h28M18 41h28' }),
          h('circle', { cx: 27, cy: 23, r: 4.2, fill: '#fff', stroke: 'none' }),
          h('circle', { cx: 39, cy: 32, r: 4.2, fill: '#fff', stroke: 'none' }),
          h('circle', { cx: 24, cy: 41, r: 4.2, fill: '#fff', stroke: 'none' }),
        ),
      )
    }

    function ItemRow(props) {
      const { bundle, id, checked, selected, locked, description, onToggle, onSelect, onAdd } = props
      return h(
        'div',
        {
          className: `wspm-item${selected ? ' is-selected' : ''}${locked ? ' is-locked' : ''}`,
          onClick: (event) => onSelect(event, id),
          onDoubleClick: onAdd,
          title: bundle.name,
        },
        h('span', { className: 'wspm-item-name' }, localize(bundle.meta?.title) || bundle.name),
        description ? h('span', { className: 'wspm-item-desc' }, description) : null,
        locked
          ? h('span', { className: 'wspm-lock', title: '受保护，不能关闭' }, '锁')
          : h(Toggle, {
              checked,
              disabled: false,
              label: localize(bundle.meta?.title) || bundle.name,
              onChange: () => onToggle(bundle),
            }),
      )
    }

    function FolderRow(props) {
      const { folder, count, on, expanded, selected, onToggleExpand, onSelect, onToggleFolder, onRename, onDelete } = props
      return h(
        'div',
        {
          className: `wspm-folder${selected ? ' is-selected' : ''}`,
          onClick: (event) => onSelect(event, folder.id),
          onDoubleClick: onToggleExpand,
        },
        h('span', { className: `wspm-caret${expanded ? ' is-open' : ''}`, 'aria-hidden': 'true' }, '▸'),
        h('span', { className: 'wspm-folder-name' }, folder.name),
        h('span', { className: 'wspm-folder-count' }, `${count}`),
        h(
          'span',
          { className: 'wspm-folder-actions' },
          h('button', {
            type: 'button',
            className: 'wspm-iconbtn',
            title: '重命名文件夹',
            onClick: (event) => {
              event.stopPropagation()
              onRename(folder)
            },
          }, '✎'),
          h('button', {
            type: 'button',
            className: 'wspm-iconbtn',
            title: '删除文件夹（里面的插件留在表中）',
            onClick: (event) => {
              event.stopPropagation()
              onDelete(folder)
            },
          }, '×'),
        ),
        h(Toggle, {
          checked: on,
          disabled: false,
          label: folder.name,
          onChange: () => onToggleFolder(folder),
        }),
      )
    }

    function NewBars(props) {
      const { state, actions, titleOf } = props
      const [open, setOpen] = useState(false)
      const keys = state.newKeys
      if (keys.length === 0) return null
      if (keys.length === 1) {
        const key = keys[0]
        return h(
          'div',
          { className: 'wspm-newbar' },
          h('span', { className: 'wspm-newbar-text' }, `发现新插件：${titleOf(key)}`),
          h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.addNew([key]) }, '加入'),
          h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.addEverywhere([key]) }, '加入到所有工作区'),
          h('button', { type: 'button', className: 'wspm-iconbtn', title: '忽略', onClick: () => actions.dismissNew(key) }, '×'),
        )
      }
      return h(
        'div',
        { className: 'wspm-newblock' },
        h(
          'div',
          { className: 'wspm-newbar is-top' },
          h(
            'button',
            { type: 'button', className: `wspm-caret${open ? ' is-open' : ''}`, title: open ? '收起' : '展开', onClick: () => setOpen(!open) },
            '▸',
          ),
          h('span', { className: 'wspm-newbar-text', title: keys.map(titleOf).join('、') }, `发现 ${keys.length} 个新插件：${keys.map(titleOf).join('、')}`),
          h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.addNew(keys) }, '添加'),
          h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.addEverywhere(keys) }, '添加到所有工作区'),
          h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.openFolderForNew(keys) }, '添加到文件夹'),
        ),
        open
          ? keys.map((key) =>
              h(
                'div',
                { key, className: 'wspm-newbar is-sub' },
                h('span', { className: 'wspm-newbar-text' }, titleOf(key)),
                h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.addNew([key]) }, '加入'),
                h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.addEverywhere([key]) }, '加入到所有工作区'),
                h('button', { type: 'button', className: 'wspm-iconbtn', title: '忽略', onClick: () => actions.dismissNew(key) }, '×'),
              ),
            )
          : null,
      )
    }

    function FolderPickModal(props) {
      const { state, actions } = props
      const pick = state.folderPick
      const folders = (state.folderOrder ?? []).map((id) => state.folders[id]).filter(Boolean)
      return h(
        'div',
        { className: 'wspm-modal' },
        h(
          'div',
          { className: 'wspm-modal-card' },
          h('h3', { className: 'wspm-modal-title' }, '加入哪个文件夹？'),
          h('p', { className: 'wspm-modal-text' }, `将 ${pick?.keys.length ?? 0} 个插件加入：`),
          h(
            'div',
            { className: 'wspm-folderpick' },
            folders.map((folder) =>
              h('button', { key: folder.id, type: 'button', className: 'wspm-btn', onClick: () => actions.pickFolderForNew(folder.id) }, folder.name),
            ),
          ),
          h(
            'div',
            { className: 'wspm-modal-actions' },
            h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.newFolderForNew() }, '新建文件夹'),
            h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.cancelFolderPick() }, '取消'),
          ),
        ),
      )
    }

    function Window(props) {
      const { state, store, actions } = props
      const open = state.open
      const geometry = state.geometry
      const bundles = visibleBundles(state.bundles)
      const byName = new Map(bundles.map((bundle) => [bundle.name, bundle]))
      const draft = state.draft
      const folders = state.folders
      const folderOrder = state.folderOrder
      const selected = new Set(state.selected)
      const [query, setQuery] = useState('')
      const [expanded, setExpanded] = useState({})
      const trimmed = query.trim().toLowerCase()

      const rootKeys = Object.keys(draft).filter(
        (key) => !folderOrder.some((id) => (folders[id]?.members ?? []).includes(key)),
      )
      const matches = (bundle) =>
        trimmed === '' ||
        bundle.name.toLowerCase().includes(trimmed) ||
        (localize(bundle.meta?.title) || '').toLowerCase().includes(trimmed)
      const rootItems = rootKeys.filter((key) => byName.has(key.slice(2)) && matches(byName.get(key.slice(2))))
      const poolItems = bundles.filter((bundle) => !(bundleKey(bundle.name) in draft))
      const poolFiltered = poolItems.filter(matches)
      const folderList = folderOrder.map((id) => ({ id, folder: folders[id] })).filter((entry) => entry.folder)
      const visiblePool = state.poolOpen

      const descriptionFor = (bundle) =>
        state.marketNotes[bundle.name] ||
        localize(bundle.meta?.description) ||
        bundle.description ||
        ''

      const rowFor = (key) => {
        const bundle = byName.get(key.slice(2))
        if (!bundle) return null
        return h(ItemRow, {
          key,
          id: key,
          bundle,
          checked: Boolean(draft[key]),
          selected: selected.has(key),
          locked: PROTECTED.has(bundle.name) || Boolean(bundle.readOnlyReason),
          description: descriptionFor(bundle),
          onToggle: (target) => actions.toggleItem(target),
          onSelect: (event, id) => actions.select(event, id),
        })
      }

      return h(
        'div',
        { className: 'wspm-win', style: { left: geometry.x, top: geometry.y, width: geometry.w, height: geometry.h } },
        h(
          'header',
          { className: 'wspm-head', onPointerDown: (event) => actions.startDrag(event) },
          h('span', { className: 'wspm-head-icon', 'aria-hidden': 'true' }, h(Icon, { size: 18 })),
          h(
            'div',
            { className: 'wspm-head-text' },
            h('span', { className: 'wspm-head-title' }, '插件管理'),
            h('span', { className: 'wspm-head-sub' }, `工作区「${open.title}」${open.active ? ' · 当前工作区' : ' · 非当前工作区'}`),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wspm-close',
              title: '关闭',
              'aria-label': '关闭',
              onPointerDown: (event) => event.stopPropagation(),
              onClick: () => actions.close(),
            },
            '×',
          ),
        ),
        h(
          'div',
          { className: 'wspm-toolbar' },
          h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.newFolder() }, '新建文件夹'),
          h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.deleteSelection() }, '删除'),
          h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.cut() }, '剪切'),
          h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.copy() }, '复制'),
          h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.paste() }, '粘贴'),
          h('span', { className: 'wspm-spacer' }),
          h('input', {
            className: 'wspm-search',
            placeholder: '搜索表中的插件',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('span', { className: 'wspm-count' }, state.changeCount === 0 ? '没有改动' : `${state.changeCount} 处改动`),
        ),
        h(NewBars, {
          state,
          actions,
          titleOf: (key) => {
            const bundle = byName.get(key.slice(2))
            return bundle ? localize(bundle.meta?.title) || bundle.name : key.slice(2)
          },
        }),
        h(
          'div',
          { className: 'wspm-main' },
          visiblePool
            ? h(
                'aside',
                { className: 'wspm-pool' },
                h(
                  'div',
                  { className: 'wspm-pool-head' },
                  h('span', null, `未启用插件 · ${poolItems.length}`),
                  h('button', { type: 'button', className: 'wspm-iconbtn', title: '收起', onClick: () => actions.closePool() }, '×'),
                ),
                h(
                  'div',
                  { className: 'wspm-pool-list' },
                  poolFiltered.length === 0
                    ? h('div', { className: 'wspm-empty' }, '没有可加的插件')
                    : poolFiltered.map((bundle) =>
                        h(
                          'div',
                          {
                            key: bundle.name,
                            className: 'wspm-pool-row',
                            title: '双击加入本工作区',
                            onDoubleClick: () => actions.addFromPool(bundle.name),
                          },
                          h('span', { className: 'wspm-pool-name' }, localize(bundle.meta?.title) || bundle.name),
                          h('span', { className: 'wspm-pool-desc' }, shortText(descriptionFor(bundle), 60)),
                          h('span', { className: 'wspm-pool-hint' }, '双击加入'),
                        ),
                      ),
                ),
              )
            : null,
          h(
            'section',
            { className: 'wspm-table' },
            h(
              'div',
              { className: 'wspm-path' },
              state.targetFolder ? `粘贴目标：${folders[state.targetFolder]?.name ?? '文件夹'}` : '粘贴目标：根目录',
              h('span', { className: 'wspm-muted' }, ` · 表中 ${Object.keys(draft).length} 个，已选 ${selected.size} 个`),
            ),
            h(
              'div',
              { className: 'wspm-list-scroll' },
              state.error
              ? h('div', { className: 'wspm-error' }, state.error)
              : state.loading
                ? h('div', { className: 'wspm-empty' }, '正在读取插件…')
                : h(
                    React.Fragment,
                    null,
                    folderList.map(({ id, folder }) => {
                      const members = (folder.members ?? []).filter((key) => key in draft && byName.has(key.slice(2)))
                      const onCount = members.filter((key) => draft[key]).length
                      const isExpanded = expanded[id] !== false
                      return h(
                        React.Fragment,
                        { key: id },
                        h(FolderRow, {
                          folder,
                          count: `${onCount}/${members.length}`,
                          on: members.length > 0 && onCount === members.length,
                          expanded: isExpanded,
                          selected: selected.has(id),
                          onSelect: (event, folderId) => {
                            actions.select(event, folderId)
                            actions.setTarget(folderId)
                          },
                          onToggleExpand: () => setExpanded((prev) => ({ ...prev, [id]: !isExpanded })),
                          onToggleFolder: (target) => actions.toggleFolder(target),
                          onRename: (target) => actions.renameFolder(target),
                          onDelete: (target) => actions.deleteFolder(target),
                        }),
                        isExpanded
                          ? h(
                              'div',
                              { className: 'wspm-folder-items' },
                              members.length === 0
                                ? h('div', { className: 'wspm-empty' }, '空文件夹：把插件剪切后粘贴到这里')
                                : members
                                    .filter((key) => matches(byName.get(key.slice(2))))
                                    .map((key) => rowFor(key)),
                            )
                          : null,
                      )
                    }),
                    rootItems.length > 0
                      ? h(
                          'div',
                          { className: 'wspm-root' },
                          h('div', { className: 'wspm-root-title' }, '根目录'),
                          rootItems.map((key) => rowFor(key)),
                        )
                      : null,
                    Object.keys(draft).length === 0
                      ? h(
                          'div',
                          { className: 'wspm-empty' },
                          '这张表还是空的。从左下角「未启用插件」里双击插件加入。',
                        )
                      : null,
                  ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'wspm-pool-btn',
                onClick: () => actions.openPool(),
              },
              `未启用插件 · ${poolItems.length}`,
            ),
          ),
        ),
        h(
          'footer',
          { className: 'wspm-foot' },
          h('button', { type: 'button', className: 'wspm-btn', disabled: state.busy, onClick: () => actions.undo() }, '撤销'),
          h('button', { type: 'button', className: 'wspm-btn', disabled: state.busy, onClick: () => actions.sync() }, '同步'),
          h('span', { className: 'wspm-foot-hint' }, open.active ? '不在表里的插件，应用后会被关闭。' : '当前不在这个工作区，只能保存。'),
          h('button', { type: 'button', className: 'wspm-btn', disabled: state.busy, onClick: () => actions.save(false) }, '保存'),
          open.active
            ? h('button', { type: 'button', className: 'wspm-btn', disabled: state.busy, onClick: () => actions.apply(true) }, '保存并应用')
            : null,
          open.active
            ? h('button', { type: 'button', className: 'wspm-btn', disabled: state.busy, onClick: () => actions.apply(false) }, '仅本次应用')
            : null,
          !open.active
            ? h('button', { type: 'button', className: 'wspm-btn is-primary', disabled: state.busy, onClick: () => actions.saveAndSwitch() }, '保存并切换过去')
            : null,
        ),
        h('div', { className: 'wspm-resize', onPointerDown: (event) => actions.startResize(event) }),
      )
    }

    function SetupDialog(props) {
      const { state, actions } = props
      const template = state.settings.template
      const templateSet = template ? state.sets[template] : undefined
      return h(
        'div',
        { className: 'wspm-modal' },
        h(
          'div',
          { className: 'wspm-modal-card' },
          h('h3', { className: 'wspm-modal-title' }, '这个工作区还没有插件表'),
          h('p', { className: 'wspm-modal-text' }, '插件表决定这个工作区用哪些插件。你可以从空表开始，也可以把现在开着的插件先都放进来。'),
          h(
            'div',
            { className: 'wspm-modal-actions' },
            templateSet ? h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.setup('template') }, '套用模板') : null,
            h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.setup('live') }, '放进当前已启用的'),
            h('button', { type: 'button', className: 'wspm-btn is-primary', onClick: () => actions.setup('empty') }, '从空表开始'),
          ),
        ),
      )
    }

    function PromptModal(props) {
      const { state, actions } = props
      const prompt = state.prompt
      const [value, setValue] = useState(prompt.value ?? '')
      const inputRef = useRef(null)
      useEffect(() => {
        if (prompt.kind !== 'confirm' && inputRef.current) {
          inputRef.current.focus()
          inputRef.current.select()
        }
      }, [prompt])
      const submit = () => actions.submitPrompt(value)
      return h(
        'div',
        { className: 'wspm-modal' },
        h(
          'div',
          { className: 'wspm-modal-card' },
          h('h3', { className: 'wspm-modal-title' }, prompt.title ?? '新建文件夹'),
          prompt.kind === 'confirm'
            ? h('p', { className: 'wspm-modal-text' }, prompt.body)
            : h('input', {
                ref: inputRef,
                className: 'wspm-input',
                value,
                onChange: (event) => setValue(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submit()
                  if (event.key === 'Escape') actions.cancelPrompt()
                },
              }),
          h(
            'div',
            { className: 'wspm-modal-actions' },
            h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.cancelPrompt() }, '取消'),
            h('button', { type: 'button', className: 'wspm-btn is-primary', onClick: submit }, '确定'),
          ),
        ),
      )
    }

    function SwitchDialog(props) {
      const { state, actions } = props
      const info = state.dialogInfo
      return h(
        'div',
        { className: 'wspm-modal' },
        h(
          'div',
          { className: 'wspm-modal-card' },
          h('h3', { className: 'wspm-modal-title' }, '切换插件集？'),
          h(
            'p',
            { className: 'wspm-modal-text' },
            `工作区「${state.dialog.title}」的插件表和当前不同：将开启 ${info.on} 个、关闭 ${info.off} 个。`,
          ),
          info.running ? h('p', { className: 'wspm-modal-warn' }, '另一个工作区正在运行，切换插件集可能打断它。') : null,
          h(
            'div',
            { className: 'wspm-modal-actions' },
            h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.dismissDialog() }, '这次不换'),
            h('button', { type: 'button', className: 'wspm-btn is-primary', disabled: state.busy, onClick: () => actions.confirmSwitch() }, '应用'),
          ),
        ),
      )
    }

    function RestartDialog(props) {
      const { state, actions } = props
      const reasons = state.dialog.reasons ?? []
      return h(
        'div',
        { className: 'wspm-modal' },
        h(
          'div',
          { className: 'wspm-modal-card' },
          h('h3', { className: 'wspm-modal-title' }, '需要重启 DSH'),
          h('p', { className: 'wspm-modal-text' }, '这些改动已经保存，但只有重启后才能生效：'),
          h('ul', { className: 'wspm-modal-list' }, reasons.map((reason, index) => h('li', { key: index }, RESTART_REASONS[reason] ?? reason))),
          h('p', { className: 'wspm-modal-text' }, '请完全退出 DSH 后重新打开。'),
          h('div', { className: 'wspm-modal-actions' }, h('button', { type: 'button', className: 'wspm-btn is-primary', onClick: () => actions.dismissDialog() }, '知道了')),
        ),
      )
    }

    function Banner(props) {
      const { state, actions } = props
      const [seconds, setSeconds] = useState(state.settings.applyCooldown ? 2 : 0)
      useEffect(() => {
        if (!state.settings.applyCooldown) return undefined
        setSeconds(2)
        const timer = window.setInterval(() => setSeconds((value) => (value > 0 ? value - 1 : 0)), 1000)
        return () => window.clearInterval(timer)
      }, [state.banner?.workspaceId, state.settings.applyCooldown])
      const disabled = seconds > 0
      return h(
        'div',
        { className: 'wspm-banner' },
        h('span', { className: 'wspm-banner-text' }, `另一个工作区在运行，插件集暂未切换${state.banner?.title ? `（目标：${state.banner.title}）` : ''}。`),
        h('span', { className: 'wspm-banner-hint' }, state.settings.applyCooldown ? '这 2 秒等待可在设置中关闭' : ''),
        h(
          'button',
          { type: 'button', className: 'wspm-btn is-primary', disabled, title: disabled ? '请稍候' : '立即切换插件集', onClick: () => actions.applyBanner() },
          disabled ? `现在应用 (${seconds})` : '现在应用',
        ),
        h('button', { type: 'button', className: 'wspm-btn', onClick: () => actions.dismissBanner() }, '稍后'),
      )
    }

    function Toasts(props) {
      return h(
        'div',
        { className: 'wspm-toasts' },
        props.toasts.map((toast) => h('div', { key: toast.id, className: `wspm-toast ${toast.kind ?? ''}` }, toast.text)),
      )
    }

    function SettingsPanel(props) {
      const { state, store } = props
      const settings = state.settings
      const fileRef = useRef(null)
      const [depA, setDepA] = useState('')
      const [depB, setDepB] = useState('')
      const dependencies = settings.dependencies ?? {}
      const options = []
      for (const bundle of visibleBundles(state.bundles)) {
        options.push({ key: bundleKey(bundle.name), title: localize(bundle.meta?.title) || bundle.name })
      }
      const titleOf = (key) => options.find((option) => option.key === key)?.title ?? key.slice(2)
      const change = (patch) => {
        store.set({ settings: { ...store.get().settings, ...patch } })
        props.actions.persistAll()
      }
      const row = (title, hint, control) =>
        h(
          'div',
          { className: 'wspm-setrow' },
          h('div', { className: 'wspm-setrow-text' }, h('div', { className: 'wspm-setrow-title' }, title), h('div', { className: 'wspm-setrow-hint' }, hint)),
          control,
        )
      return h(
        'div',
        { className: 'wspm-settings' },
        h('h2', { className: 'wspm-settings-title' }, '工作区插件管理'),
        h('p', { className: 'wspm-settings-lead' }, '从工作区标题的「⋯ → 插件管理」打开浮窗。每个工作区存一张插件表；表里没有的插件会在应用时关闭。'),
        row(
          '切换工作区时',
          '手动：弹出小窗确认后再应用。',
          h(Toggle, {
            checked: Boolean(settings.autoApply),
            label: '切换时自动应用',
            onChange: (next) => change({ autoApply: next }),
          }),
        ),
        row(
          '黄条「现在应用」的等待',
          '开启时按钮要等 2 秒才能点，避免手滑。',
          h(Toggle, {
            checked: Boolean(settings.applyCooldown),
            label: '黄条应用按钮冷却 2 秒',
            onChange: (next) => change({ applyCooldown: next }),
          }),
        ),
        row(
          '需要重启时',
          '默认只提示手动重启；由插件代你重启会在后续版本提供。',
          h(
            'div',
            { className: 'wspm-inline' },
            h('span', { className: 'wspm-muted' }, settings.restartMode === 'auto' ? '插件代我重启' : '提示我手动重启'),
            h('button', { type: 'button', className: 'wspm-btn', onClick: () => props.actions.previewRestart() }, '预览提示'),
          ),
        ),
        h(
          'div',
          { className: 'wspm-setrow is-block' },
          h(
            'div',
            { className: 'wspm-setrow-text' },
            h('div', { className: 'wspm-setrow-title' }, '依赖标记'),
            h('div', { className: 'wspm-setrow-hint' }, '删除被依赖的插件时会提醒；应用时缺依赖会给黄色提示。'),
          ),
          h(
            'div',
            { className: 'wspm-inline is-wrap' },
            h(
              'select',
              { className: 'wspm-select', value: depA, onChange: (event) => setDepA(event.target.value) },
              h('option', { value: '' }, '选择插件'),
              options.map((option) => h('option', { key: option.key, value: option.key }, option.title)),
            ),
            h('span', { className: 'wspm-muted' }, '依赖'),
            h(
              'select',
              { className: 'wspm-select', value: depB, onChange: (event) => setDepB(event.target.value) },
              h('option', { value: '' }, '选择被依赖的插件'),
              options.map((option) => h('option', { key: option.key, value: option.key }, option.title)),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'wspm-btn',
                onClick: () => {
                  props.actions.addDependency(depA, depB)
                  setDepA('')
                  setDepB('')
                },
              },
              '添加',
            ),
          ),
        ),
        h(
          'div',
          { className: 'wspm-deplist' },
          Object.keys(dependencies).length === 0
            ? h('span', { className: 'wspm-muted' }, '还没有依赖标记')
            : Object.entries(dependencies).flatMap(([dependent, needs]) =>
                needs.map((need) =>
                  h(
                    'div',
                    { key: `${dependent}|${need}`, className: 'wspm-deprow' },
                    h('span', null, `${titleOf(dependent)} → ${titleOf(need)}`),
                    h(
                      'button',
                      { type: 'button', className: 'wspm-iconbtn', title: '删除这条依赖', onClick: () => props.actions.removeDependency(dependent, need) },
                      '×',
                    ),
                  ),
                ),
              ),
        ),
        row(
          '工作区模板',
          '新工作区的提示里可以一键套用这份表。',
          h(
            'div',
            { className: 'wspm-inline' },
            h(
              'select',
              {
                className: 'wspm-select',
                value: settings.template ?? '',
                onChange: (event) => props.actions.setTemplate(event.target.value),
              },
              h('option', { value: '' }, '不设模板'),
              props.actions.choices().map((choice) => h('option', { key: choice.id, value: choice.id }, choice.title)),
            ),
          ),
        ),
        row(
          '备份',
          '导出所有工作区的插件表，或从导出文件导入（同名工作区会被覆盖）。',
          h(
            'div',
            { className: 'wspm-inline' },
            h('button', { type: 'button', className: 'wspm-btn', onClick: () => props.actions.exportState() }, '导出 JSON'),
            h('button', { type: 'button', className: 'wspm-btn', onClick: () => fileRef.current?.click() }, '导入…'),
            h('input', {
              ref: fileRef,
              type: 'file',
              accept: '.json,application/json',
              style: { display: 'none' },
              onChange: (event) => {
                const file = event.target.files?.[0]
                if (file) props.actions.importState(file)
                event.target.value = ''
              },
            }),
          ),
        ),
        h(
          'div',
          { className: 'wspm-settings-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'wspm-btn is-danger',
              onClick: () =>
                props.actions.requestConfirm('清空所有工作区的插件表', '此操作不能撤销。', () => {
                  store.set({ sets: {} })
                  props.actions.persistAll()
                }),
            },
            '清空所有工作区的插件表',
          ),
          h('span', { className: 'wspm-muted' }, '插件表存在本机文件 workspace-plugin-manager.json，浏览器缓存只做兜底。'),
        ),
      )
    }

    const STYLES = `
      .wspm-win, .wspm-win * { box-sizing: border-box; }
      .wspm-win {
        position: fixed; display: flex; flex-direction: column; min-width: 620px; min-height: 400px;
        background: var(--dsw-alias-bg-layer-1, #1d1f24); color: var(--dsw-alias-label-primary, #eee);
        border: 1px solid var(--dsw-alias-border-l2, #3a3f46); border-radius: 12px; overflow: hidden;
        box-shadow: 0 18px 60px rgba(0,0,0,.45); pointer-events: auto; z-index: 60;
        font: 13px/1.45 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      .wspm-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: move; user-select: none;
        background: var(--dsw-alias-bg-layer-2, #24272d); border-bottom: 1px solid var(--dsw-alias-border-l1, #33383f); }
      .wspm-head-icon { display: inline-flex; }
      .wspm-head-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
      .wspm-head-title { font-weight: 600; font-size: 14px; }
      .wspm-head-sub { color: var(--dsw-alias-label-secondary, #9aa3ad); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .wspm-close { border: 0; background: transparent; color: inherit; font-size: 20px; line-height: 1; width: 28px; height: 28px; border-radius: 6px; cursor: pointer; }
      .wspm-close:hover { background: var(--dsw-alias-bg-base, #2b2f36); }
      .wspm-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #33383f); flex-wrap: wrap; }
      .wspm-newblock { background: rgba(232,179,75,.10); border-bottom: 1px solid var(--dsw-alias-border-l1, #33383f); }
      .wspm-newbar { display: flex; align-items: center; gap: 6px; padding: 6px 12px; font-size: 12px; background: rgba(232,179,75,.10); border-bottom: 1px solid var(--dsw-alias-border-l1, #33383f); }
      .wspm-newbar.is-top { border-bottom: 1px dashed rgba(232,179,75,.4); }
      .wspm-newbar.is-sub { padding-left: 28px; background: rgba(232,179,75,.06); }
      .wspm-newbar-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wspm-folderpick { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
      .wspm-search { flex: 0 1 190px; min-width: 120px; background: var(--dsw-alias-bg-base, #17191d); color: inherit;
        border: 1px solid var(--dsw-alias-border-l1, #33383f); border-radius: 7px; padding: 5px 9px; font: inherit; outline: none; }
      .wspm-search:focus { border-color: #3f7aec; }
      .wspm-spacer { flex: 1; }
      .wspm-count { color: var(--dsw-alias-label-secondary, #9aa3ad); font-size: 12px; }
      .wspm-btn { border: 1px solid var(--dsw-alias-border-l2, #3a3f46); background: var(--dsw-alias-bg-layer-2, #24272d);
        color: inherit; border-radius: 7px; padding: 5px 10px; font: inherit; cursor: pointer; white-space: nowrap; }
      .wspm-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-base, #17191d); }
      .wspm-btn:disabled { opacity: .45; cursor: not-allowed; }
      .wspm-btn.is-primary { background: #3f7aec; border-color: #3f7aec; color: #fff; }
      .wspm-btn.is-primary:hover:not(:disabled) { background: #346bda; }
      .wspm-btn.is-danger { color: var(--dsw-alias-state-error-primary, #f06a6a); }
      .wspm-main { flex: 1; display: flex; min-height: 0; }
      .wspm-pool { width: 250px; border-right: 1px solid var(--dsw-alias-border-l1, #33383f); display: flex; flex-direction: column; background: var(--dsw-alias-bg-base, #17191d); }
      .wspm-pool-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #9aa3ad); }
      .wspm-pool-list { flex: 1; overflow: auto; padding: 0 6px 8px; }
      .wspm-pool-row { padding: 6px 8px; border-radius: 7px; cursor: default; display: flex; flex-direction: column; gap: 1px; }
      .wspm-pool-row:hover { background: var(--dsw-alias-bg-layer-2, #24272d); }
      .wspm-pool-name { font-size: 12px; }
      .wspm-pool-desc { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa3ad); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wspm-pool-hint { font-size: 10px; color: var(--dsw-alias-label-secondary, #9aa3ad); opacity: 0; }
      .wspm-pool-row:hover .wspm-pool-hint { opacity: 1; }
      .wspm-table { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .wspm-path { padding: 6px 12px; font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa3ad); border-bottom: 1px solid var(--dsw-alias-border-l1, #33383f); }
      .wspm-muted { color: var(--dsw-alias-label-secondary, #9aa3ad); font-size: 11px; }
      .wspm-inline { display: flex; align-items: center; gap: 6px; }
      .wspm-inline.is-wrap { flex-wrap: wrap; }
      .wspm-setrow.is-block { flex-direction: column; align-items: stretch; gap: 8px; }
      .wspm-select { background: var(--dsw-alias-bg-base, #17191d); color: inherit; border: 1px solid var(--dsw-alias-border-l2, #3a3f46);
        border-radius: 7px; padding: 5px 8px; font: inherit; min-width: 140px; max-width: 210px; outline: none; }
      .wspm-select:focus { border-color: #3f7aec; }
      .wspm-deplist { display: flex; flex-direction: column; gap: 2px; padding: 4px 0 0; }
      .wspm-deprow { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 10px;
        border-top: 1px dashed var(--dsw-alias-border-l1, #33383f); font-size: 12px; }
      .wspm-list-scroll { flex: 1; overflow: auto; padding: 6px 10px 14px; }
      .wspm-item { display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto; column-gap: 10px; align-items: center;
        padding: 6px 10px; border-radius: 7px; cursor: default; }
      .wspm-item:hover { background: var(--dsw-alias-bg-layer-2, #24272d); }
      .wspm-item.is-selected { background: rgba(63,122,236,.18); outline: 1px solid rgba(63,122,236,.5); }
      .wspm-item-name { grid-column: 1; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .wspm-item-desc { grid-column: 1; font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa3ad);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
      .wspm-item .wspm-toggle { grid-column: 2; grid-row: 1 / span 2; }
      .wspm-lock { grid-column: 2; grid-row: 1 / span 2; font-size: 10px; color: var(--dsw-alias-label-secondary, #9aa3ad); border: 1px solid var(--dsw-alias-border-l2, #3a3f46); border-radius: 5px; padding: 1px 5px; }
      .wspm-folder { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 7px; cursor: default; font-weight: 600; }
      .wspm-folder:hover { background: var(--dsw-alias-bg-layer-2, #24272d); }
      .wspm-folder.is-selected { background: rgba(63,122,236,.18); outline: 1px solid rgba(63,122,236,.5); }
      .wspm-caret { display: inline-block; transition: transform .12s ease; color: var(--dsw-alias-label-secondary, #9aa3ad); }
      .wspm-caret.is-open { transform: rotate(90deg); }
      .wspm-folder-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wspm-folder-count { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa3ad); font-weight: 400; }
      .wspm-folder-actions { display: none; gap: 2px; }
      .wspm-folder:hover .wspm-folder-actions { display: inline-flex; }
      .wspm-iconbtn { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 14px; line-height: 1; width: 22px; height: 22px; border-radius: 5px; }
      .wspm-iconbtn:hover { background: var(--dsw-alias-bg-base, #17191d); }
      .wspm-folder-items { padding-left: 18px; }
      .wspm-root { margin-top: 8px; }
      .wspm-root-title { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa3ad); padding: 4px 10px; }
      .wspm-toggle { position: relative; width: 34px; height: 19px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #3a3f46);
        background: var(--dsw-alias-bg-base, #17191d); cursor: pointer; flex: none; padding: 0; }
      .wspm-toggle.is-on { background: #3f7aec; border-color: transparent; }
      .wspm-toggle:disabled { opacity: .4; cursor: not-allowed; }
      .wspm-toggle-knob { position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #fff; transition: transform .12s ease; }
      .wspm-toggle.is-on .wspm-toggle-knob { transform: translateX(15px); }
      .wspm-empty { padding: 18px; text-align: center; color: var(--dsw-alias-label-secondary, #9aa3ad); font-size: 12px; }
      .wspm-error { margin: 12px; padding: 12px; border-radius: 8px; background: rgba(240,106,106,.12); color: var(--dsw-alias-state-error-primary, #f06a6a); }
      .wspm-pool-btn { margin: 8px 12px 12px; align-self: flex-start; border: 1px solid var(--dsw-alias-border-l2, #3a3f46);
        background: var(--dsw-alias-bg-layer-2, #24272d); color: var(--dsw-alias-label-secondary, #9aa3ad); border-radius: 7px; padding: 6px 10px; cursor: pointer; }
      .wspm-pool-btn:hover { color: var(--dsw-alias-label-primary, #eee); }
      .wspm-foot { display: flex; align-items: center; gap: 6px; padding: 9px 12px; border-top: 1px solid var(--dsw-alias-border-l1, #33383f); background: var(--dsw-alias-bg-layer-2, #24272d); }
      .wspm-foot-hint { flex: 1; color: var(--dsw-alias-label-secondary, #9aa3ad); font-size: 11px; }
      .wspm-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; }
      .wspm-resize::after { content: ''; position: absolute; right: 3px; bottom: 3px; width: 8px; height: 8px; border-right: 2px solid var(--dsw-alias-border-l2, #4a4f57); border-bottom: 2px solid var(--dsw-alias-border-l2, #4a4f57); }
      .wspm-modal { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 2147483000; pointer-events: auto; }
      .wspm-modal-card { width: min(460px, 92vw); background: var(--dsw-alias-bg-layer-1, #1d1f24); color: var(--dsw-alias-label-primary, #eee);
        border: 1px solid var(--dsw-alias-border-l2, #3a3f46); border-radius: 12px; padding: 18px 18px 14px; box-shadow: 0 18px 60px rgba(0,0,0,.5); }
      .wspm-modal-title { margin: 0 0 10px; font-size: 16px; }
      .wspm-modal-text { margin: 0 0 10px; color: var(--dsw-alias-label-secondary, #c3c9d1); font-size: 13px; }
      .wspm-modal-warn { margin: 0 0 10px; color: var(--dsw-alias-state-warn-primary, #e8b34b); font-size: 12px; }
      .wspm-modal-list { margin: 0 0 10px; padding-left: 18px; color: var(--dsw-alias-label-secondary, #c3c9d1); font-size: 12px; }
      .wspm-input { width: 100%; background: var(--dsw-alias-bg-base, #17191d); color: inherit; border: 1px solid var(--dsw-alias-border-l2, #3a3f46);
        border-radius: 7px; padding: 7px 10px; font: inherit; outline: none; }
      .wspm-input:focus { border-color: #3f7aec; }
      .wspm-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
      .wspm-banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
        padding: 8px 12px; border-radius: 10px; background: var(--dsw-alias-bg-overlay, #2a2d34); border: 1px solid var(--dsw-alias-state-warn-primary, #e8b34b);
        color: var(--dsw-alias-label-primary, #eee); box-shadow: 0 10px 30px rgba(0,0,0,.35); z-index: 65; pointer-events: auto; font-size: 12px; }
      .wspm-banner-text { max-width: 460px; }
      .wspm-banner-hint { color: var(--dsw-alias-label-secondary, #9aa3ad); font-size: 11px; }
      .wspm-toasts { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; z-index: 68; pointer-events: none; }
      .wspm-toast { padding: 8px 14px; border-radius: 8px; background: var(--dsw-alias-bg-overlay, #2a2d34); color: var(--dsw-alias-label-primary, #eee);
        border: 1px solid var(--dsw-alias-border-l2, #3a3f46); box-shadow: 0 10px 30px rgba(0,0,0,.35); font-size: 12px; }
      .wspm-toast.is-error { border-color: var(--dsw-alias-state-error-primary, #f06a6a); color: var(--dsw-alias-state-error-primary, #f06a6a); }
      .wspm-toast.is-warn { border-color: var(--dsw-alias-state-warn-primary, #e8b34b); }
      .wspm-settings { max-width: 720px; padding: 8px 4px 24px; color: var(--dsw-alias-label-primary, #eee); }
      .wspm-settings-title { font-size: 16px; margin: 0 0 6px; }
      .wspm-settings-lead { color: var(--dsw-alias-label-secondary, #9aa3ad); margin: 0 0 16px; font-size: 12px; }
      .wspm-setrow { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--dsw-alias-border-l1, #33383f); }
      .wspm-setrow-text { flex: 1; }
      .wspm-setrow-title { font-weight: 600; font-size: 13px; }
      .wspm-setrow-hint { color: var(--dsw-alias-label-secondary, #9aa3ad); font-size: 12px; margin-top: 2px; }
      .wspm-settings-foot { display: flex; align-items: center; gap: 12px; padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l1, #33383f); }
    `

    // ------------------------------------------------------------------ apply

    return {
      inject: ['slots', 'contextMenus', 'remote', 'remote.pluginManager', 'workspaces', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        const persisted = readPersisted()
        const STATE_URL = '/dsh-workspace-plugin-manager/state'
        const store = createStore({
          version: 0,
          hydrated: false,
          bundles: [],
          loading: false,
          error: null,
          marketNotes: {},
          open: null,
          draft: {},
          baseDraft: {},
          folders: {},
          folderOrder: [],
          selected: [],
          clipboard: null,
          targetFolder: null,
          poolOpen: false,
          setup: null,
          prompt: null,
          newKeys: [],
          folderPick: null,
          savedSnapshot: null,
          busy: false,
          dialog: null,
          dialogInfo: { on: 0, off: 0, running: false },
          banner: null,
          toasts: [],
          sets: persisted.sets,
          settings: persisted.settings,
          geometry: persisted.geometry ?? null,
          changeCount: 0,
        })

        const toasts = []
        function toast(text, kind) {
          const id = Math.random().toString(36).slice(2)
          toasts.push({ id, text, kind })
          store.set({ toasts: toasts.slice() })
          window.setTimeout(() => {
            const index = toasts.findIndex((item) => item.id === id)
            if (index >= 0) toasts.splice(index, 1)
            store.set({ toasts: toasts.slice() })
          }, kind === 'is-error' ? 6000 : 3500)
        }

        function statePayload() {
          const state = store.get()
          return {
            version: 2,
            sets: state.sets,
            settings: state.settings,
            geometry: state.geometry,
          }
        }

        let pushTimer
        function schedulePush() {
          if (pushTimer !== undefined) window.clearTimeout(pushTimer)
          pushTimer = window.setTimeout(() => {
            pushTimer = undefined
            void pushState()
          }, 400)
        }

        async function pushState() {
          try {
            await window.fetch(STATE_URL, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(statePayload()),
            })
          } catch {
            /* the localStorage copy below is the fallback for this page */
          }
        }

        /** The profile file is the source of truth; the localStorage copy is a cache. */
        async function hydrate() {
          try {
            const response = await window.fetch(STATE_URL, { cache: 'no-store', headers: { accept: 'application/json' } })
            if (response.ok) {
              const data = await response.json()
              if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
                const current = store.get()
                store.set({
                  sets: data.sets ?? {},
                  settings: { ...current.settings, ...(data.settings ?? {}) },
                  geometry: data.geometry ?? current.geometry,
                  hydrated: true,
                })
                return
              }
            }
          } catch {
            /* no Host route: fall back to the cache below */
          }
          const state = store.get()
          store.set({ hydrated: true })
          if (Object.keys(state.sets).length > 0 || state.geometry) schedulePush()
        }

        const hydration = hydrate()

        function persistAll() {
          writePersisted(statePayload())
          schedulePush()
        }

        function manager() {
          const remote = ctx.get('remote')
          const ns = remote && remote.pluginManager
          if (!ns) throw new Error('插件管理器不可用：页面没有挂载 pluginManager 远程接口')
          return ns
        }

        async function loadMarketNotes() {
          try {
            const response = await window.fetch('/dsh-market/installed', { headers: { accept: 'application/json' } })
            if (!response.ok) return
            const payload = await response.json()
            store.set({ marketNotes: payload?.notes ?? {} })
          } catch {
            /* no market: descriptions still come from the manifests */
          }
        }

        async function refreshInventory() {
          store.set({ loading: true, error: null })
          try {
            const api = manager()
            const [bundlesRes, pluginsRes] = await Promise.all([api.listBundles(), api.listPlugins()])
            const bundles = Array.isArray(bundlesRes?.value) ? bundlesRes.value : undefined
            if (bundles === undefined) {
              const reason = bundlesRes?.error?.message ?? '远程接口没有返回列表'
              throw new Error(`读取插件列表失败：${reason}`)
            }
            store.set({ bundles, loading: false })
            void pluginsRes
            recompute()
          } catch (error) {
            store.set({ loading: false, error: String(error?.message ?? error) })
          }
        }

        function liveMap() {
          return liveOf(store.get().bundles)
        }

        function computeChange(draft, live) {
          let count = 0
          for (const key of Object.keys(live)) {
            const desired = key in draft ? Boolean(draft[key]) : false
            if (desired !== Boolean(live[key])) count += 1
          }
          return count
        }

        function currentWorkspaceId() {
          try {
            const sessions = ctx.sessions.list.getSnapshot()
            const byId = sessions?.byId ?? {}
            let sessionId
            for (const row of Object.values(byId)) {
              if (row && (row.retainedBy?.mainView ?? 0) > 0) {
                sessionId = row.id ?? row.sessionId
                break
              }
            }
            if (!sessionId) return undefined
            const workspaces = ctx.workspaces.list.getSnapshot()
            const items = workspaces?.items ?? []
            return items.find((item) => (item.sessionIds ?? []).includes(sessionId))?.workspaceId
          } catch {
            return undefined
          }
        }

        function workspaceTitle(workspaceId) {
          try {
            const items = ctx.workspaces.list.getSnapshot()?.items ?? []
            const hit = items.find((item) => item.workspaceId === workspaceId)
            return hit?.title || hit?.path || workspaceId
          } catch {
            return workspaceId
          }
        }

        function otherWorkspaceRunning(targetWorkspaceId) {
          try {
            const byId = ctx.sessions.list.getSnapshot()?.byId ?? {}
            const workspaces = ctx.workspaces.list.getSnapshot()?.items ?? []
            for (const row of Object.values(byId)) {
              if (!row || row.archived) continue
              const running = Boolean(row.running) || row.pendingInteraction !== undefined
              if (!running) continue
              const sessionId = row.id ?? row.sessionId
              const workspace = workspaces.find((item) => (item.sessionIds ?? []).includes(sessionId))
              if (workspace && workspace.workspaceId !== targetWorkspaceId) return true
            }
            return false
          } catch {
            return false
          }
        }

        function markApplied(workspaceId) {
          store.set({ banner: null })
          persistAll()
          void workspaceId
        }

        function recompute() {
          const state = store.get()
          const live = liveMap()
          store.set({ changeCount: computeChange(state.draft, live) })
        }

        async function openManager(request) {
          await hydration
          const workspaceId = request.workspaceId
          const geometry = store.get().geometry ?? defaultGeometry()
          store.set({
            open: {
              workspaceId,
              title: request.displayTitle || workspaceTitle(workspaceId),
              path: request.path,
              active: currentWorkspaceId() === workspaceId,
            },
            geometry,
            error: null,
            selected: [],
            clipboard: null,
            targetFolder: null,
            poolOpen: false,
          })
          void (async () => {
            if (store.get().bundles.length === 0) await refreshInventory()
            if (Object.keys(store.get().marketNotes).length === 0) void loadMarketNotes()
            const state = store.get()
            const set = state.sets[workspaceId]
            if (set) {
              const inventory = Object.keys(liveMap())
              const notified = Array.isArray(set.notified) ? set.notified : inventory
              if (!Array.isArray(set.notified)) {
                store.set({ sets: { ...state.sets, [workspaceId]: { ...set, notified } } })
              }
              const newKeys = inventory.filter((key) => !(key in set.entries) && !notified.includes(key))
              store.set({
                draft: { ...set.entries },
                folders: { ...set.folders },
                folderOrder: [...set.folderOrder],
                baseDraft: { ...set.entries },
                savedSnapshot: { ...set.entries },
                setup: null,
                newKeys,
              })
              recompute()
            } else {
              store.set({ draft: {}, folders: {}, folderOrder: [], baseDraft: {}, savedSnapshot: {}, setup: { workspaceId }, newKeys: [] })
              recompute()
            }
          })()
        }

        function defaultGeometry() {
          const width = Math.min(820, Math.max(620, window.innerWidth * 0.58))
          const height = Math.min(640, Math.max(420, window.innerHeight * 0.72))
          return {
            x: Math.round((window.innerWidth - width) / 2),
            y: Math.round(Math.max(44, (window.innerHeight - height) / 2 - 24)),
            w: Math.round(width),
            h: Math.round(height),
          }
        }

        function startDrag(event) {
          if (event.button !== 0) return
          event.preventDefault()
          const startX = event.clientX
          const startY = event.clientY
          const base = { ...(store.get().geometry ?? defaultGeometry()) }
          const move = (moveEvent) => {
            store.set({
              geometry: {
                ...base,
                x: Math.max(0, Math.min(window.innerWidth - 120, base.x + moveEvent.clientX - startX)),
                y: Math.max(0, Math.min(window.innerHeight - 60, base.y + moveEvent.clientY - startY)),
              },
            })
          }
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            persistAll()
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }

        function startResize(event) {
          if (event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          const startX = event.clientX
          const startY = event.clientY
          const base = { ...(store.get().geometry ?? defaultGeometry()) }
          const move = (moveEvent) => {
            store.set({
              geometry: {
                ...base,
                w: Math.max(620, base.w + moveEvent.clientX - startX),
                h: Math.max(400, base.h + moveEvent.clientY - startY),
              },
            })
          }
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            persistAll()
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }

        function bundleOf(key) {
          const name = key.slice(2)
          return store.get().bundles.find((bundle) => bundle.name === name)
        }

        function setDraft(next) {
          const state = store.get()
          store.set({ draft: next, changeCount: computeChange(next, liveMap()) })
          void state
        }

        function setup(mode) {
          const state = store.get()
          const workspaceId = state.setup?.workspaceId
          if (!workspaceId) return
          let draft = mode === 'live' ? { ...liveMap() } : {}
          let folders = {}
          let folderOrder = []
          if (mode === 'template') {
            const template = state.settings.template ? state.sets[state.settings.template] : undefined
            if (!template) return
            draft = { ...template.entries }
            folders = JSON.parse(JSON.stringify(template.folders ?? {}))
            folderOrder = [...(template.folderOrder ?? [])]
          }
          store.set({ draft, folders, folderOrder, baseDraft: { ...draft }, savedSnapshot: { ...draft }, setup: null, newKeys: Object.keys(liveMap()).filter((key) => !(key in draft)) })
          const sets = { ...state.sets, [workspaceId]: { entries: draft, folders, folderOrder, notified: [], updatedAt: Date.now() } }
          store.set({ sets })
          persistAll()
          recompute()
        }

        function addFromPool(name) {
          const state = store.get()
          const key = bundleKey(name)
          if (key in state.draft) return
          const draft = { ...state.draft, [key]: true }
          const folderId = state.targetFolder
          let folders = state.folders
          if (folderId && folders[folderId]) {
            folders = {
              ...folders,
              [folderId]: { ...folders[folderId], members: [...folders[folderId].members.filter((m) => m !== key), key] },
            }
          }
          store.set({ draft, folders })
          recompute()
        }

        function toggleItem(bundle) {
          const state = store.get()
          const key = bundleKey(bundle.name)
          if (PROTECTED.has(bundle.name) || bundle.readOnlyReason) {
            toast('这个插件受保护，不能关闭', 'is-warn')
            return
          }
          setDraft({ ...state.draft, [key]: !Boolean(state.draft[key]) })
        }

        function toggleFolder(folder) {
          const state = store.get()
          const members = (folder.members ?? []).filter((key) => key in state.draft)
          if (members.length === 0) return
          const allOn = members.every((key) => Boolean(state.draft[key]))
          const draft = { ...state.draft }
          for (const key of members) draft[key] = !allOn
          setDraft(draft)
        }

        function select(event, id) {
          const state = store.get()
          const additive = event.ctrlKey || event.metaKey || event.shiftKey
          let selected
          if (additive) {
            selected = state.selected.includes(id) ? state.selected.filter((item) => item !== id) : [...state.selected, id]
          } else {
            selected = [id]
          }
          store.set({ selected })
        }

        function setTarget(folderId) {
          store.set({ targetFolder: folderId })
        }

        function newFolder() {
          store.set({ prompt: { kind: 'folder', title: '新建文件夹', value: '新文件夹' } })
        }

        function renameFolder(folder) {
          store.set({ prompt: { kind: 'rename', title: '重命名文件夹', value: folder.name, folderId: folder.id } })
        }

        function requestConfirm(title, body, onOk) {
          store.set({ prompt: { kind: 'confirm', title, body, onOk } })
        }

        function deleteFolder(folder) {
          requestConfirm('删除文件夹', `删除文件夹「${folder.name}」？里面的插件会留在表中。`, () => {
            const state = store.get()
            const folders = { ...state.folders }
            delete folders[folder.id]
            store.set({
              folders,
              folderOrder: state.folderOrder.filter((id) => id !== folder.id),
              selected: state.selected.filter((id) => id !== folder.id),
              targetFolder: state.targetFolder === folder.id ? null : state.targetFolder,
            })
          })
        }

        function cancelPrompt() {
          store.set({ prompt: null })
        }

        function submitPrompt(value) {
          const state = store.get()
          const prompt = state.prompt
          if (!prompt) return
          if (prompt.kind === 'confirm') {
            store.set({ prompt: null })
            if (typeof prompt.onOk === 'function') prompt.onOk()
            return
          }
          const name = String(value ?? '').trim() || '新文件夹'
          if (prompt.kind === 'folder') {
            const id = newId()
            store.set({
              prompt: null,
              folders: { ...state.folders, [id]: { id, name, members: [] } },
              folderOrder: [...state.folderOrder, id],
              selected: [id],
              targetFolder: id,
            })
            return
          }
          if (prompt.kind === 'rename' && prompt.folderId) {
            const folder = state.folders[prompt.folderId]
            if (folder) {
              store.set({
                prompt: null,
                folders: { ...state.folders, [prompt.folderId]: { ...folder, name } },
              })
              return
            }
          }
          if (prompt.kind === 'folderAdd') {
            const keys = prompt.keys ?? []
            const id = newId()
            const folders = { ...state.folders, [id]: { id, name, members: keys.slice() } }
            const draft = { ...state.draft }
            for (const key of keys) draft[key] = true
            store.set({ prompt: null, folders, folderOrder: [...state.folderOrder, id], draft, selected: [id], targetFolder: id })
            markNotified(keys)
            recompute()
            return
          }
          store.set({ prompt: null })
        }

        function deleteSelection() {
          const state = store.get()
          if (state.selected.length === 0) return
          const dependencies = state.settings.dependencies ?? {}
          const warning = []
          for (const [dependent, needs] of Object.entries(dependencies)) {
            if (!state.selected.includes(dependent) && state.draft[dependent] && needs.some((key) => state.selected.includes(key))) {
              const name = bundleOf(dependent)?.name ?? dependent
              const target = needs.find((key) => state.selected.includes(key))
              warning.push(`${name} 依赖 ${bundleOf(target)?.name ?? target}`)
            }
          }
          if (warning.length > 0) {
            requestConfirm('有插件依赖要删的东西', `${warning.join('；')}。仍然删除？`, () => removeSelection())
            return
          }
          removeSelection()
        }

        function removeSelection() {
          const state = store.get()
          if (state.selected.length === 0) return
          const draft = { ...state.draft }
          let folders = {}
          for (const [id, folder] of Object.entries(state.folders)) {
            folders[id] = { ...folder, members: folder.members.filter((key) => !state.selected.includes(key)) }
          }
          for (const id of state.selected) {
            if (id.startsWith('b:')) delete draft[id]
          }
          const folderOrder = state.folderOrder.filter((id) => !state.selected.includes(id))
          for (const id of state.selected) delete folders[id]
          const removed = state.selected.filter((id) => id.startsWith('b:'))
          store.set({ draft, folders, folderOrder, selected: [], targetFolder: null })
          recompute()
          if (removed.length > 0) markNotified(removed)
        }

        function cut() {
          const state = store.get()
          const keys = state.selected.filter((id) => id.startsWith('b:'))
          if (keys.length === 0) {
            toast('先选中要剪切的插件', 'is-warn')
            return
          }
          store.set({ clipboard: { mode: 'cut', keys } })
          toast(`已剪切 ${keys.length} 个插件`)
        }

        function copy() {
          const state = store.get()
          const keys = state.selected.filter((id) => id.startsWith('b:'))
          if (keys.length === 0) {
            toast('先选中要复制的插件', 'is-warn')
            return
          }
          store.set({ clipboard: { mode: 'copy', keys } })
          toast(`已复制 ${keys.length} 个插件`)
        }

        function paste() {
          const state = store.get()
          const clipboard = state.clipboard
          if (!clipboard || clipboard.keys.length === 0) {
            toast('剪贴板是空的', 'is-warn')
            return
          }
          const draft = { ...state.draft }
          const folders = {}
          for (const [id, folder] of Object.entries(state.folders)) {
            folders[id] = { ...folder, members: folder.members.filter((key) => !clipboard.keys.includes(key)) }
          }
          for (const key of clipboard.keys) {
            if (!(key in draft)) draft[key] = true
          }
          const folderId = state.targetFolder
          if (folderId && folders[folderId]) {
            folders[folderId] = { ...folders[folderId], members: [...folders[folderId].members, ...clipboard.keys] }
          }
          store.set({ draft, folders, clipboard: clipboard.mode === 'cut' ? null : clipboard })
          recompute()
          toast(`已粘贴 ${clipboard.keys.length} 个插件`)
        }

        function openPool() {
          store.set({ poolOpen: true, selected: [] })
        }

        function closePool() {
          store.set({ poolOpen: false })
        }

        function save() {
          const state = store.get()
          const workspaceId = state.open?.workspaceId
          if (!workspaceId) return
          const known = new Set(Object.keys(liveMap()))
          const entries = {}
          for (const [key, value] of Object.entries(state.draft)) if (known.has(key)) entries[key] = Boolean(value)
          const folders = {}
          for (const [id, folder] of Object.entries(state.folders)) {
            folders[id] = { ...folder, members: folder.members.filter((key) => key in entries) }
          }
          const sets = { ...state.sets, [workspaceId]: { entries, folders, folderOrder: state.folderOrder, notified: state.sets[workspaceId]?.notified ?? [], updatedAt: Date.now() } }
          store.set({ sets, savedSnapshot: { ...entries } })
          persistAll()
          toast('已保存本工作区的插件表')
          return { entries, folders }
        }

        async function apply(persist) {
          const state = store.get()
          const workspaceId = state.open?.workspaceId
          if (!workspaceId) return
          if (!state.open.active) {
            toast('当前不在这个工作区，只能保存；切过去时再应用', 'is-warn')
            return
          }
          if (persist) save()
          const latest = store.get()
          await applyEntries(latest.draft, persist ? workspaceId : null)
        }

        async function applyEntries(entries, persistWorkspaceId) {
          const state = store.get()
          const dependencies = state.settings.dependencies ?? {}
          const missing = []
          for (const [dependent, needs] of Object.entries(dependencies)) {
            if (!(dependent in entries) || !entries[dependent]) continue
            for (const need of needs) {
              if (!(need in entries) || !entries[need]) missing.push(`${bundleOf(dependent)?.name ?? dependent} 需要 ${bundleOf(need)?.name ?? need}`)
            }
          }
          if (missing.length > 0) toast(`缺少依赖：${missing.join('；')}`, 'is-warn')
          const bundles = visibleBundles(state.bundles)
          const live = liveOf(state.bundles)
          const results = []
          const api = manager()
          store.set({ busy: true })
          try {
            for (const bundle of bundles) {
              const key = bundleKey(bundle.name)
              const desired = key in entries ? Boolean(entries[key]) : false
              const current = Boolean(live[key])
              if (desired === current) continue
              if (PROTECTED.has(bundle.name) || bundle.readOnlyReason) {
                if (desired !== current) results.push({ application: 'failed', target: bundle.name, error: { code: 'read-only' } })
                continue
              }
              const res = await api.setBundleEnabled(bundle.name, desired)
              if (res && res.ok === false) {
                results.push({ application: 'failed', target: bundle.name, error: res.error ?? { code: 'remote-error' } })
              } else {
                results.push(res?.value ?? res)
              }
            }
          } catch (error) {
            results.push({ application: 'failed', target: 'apply', error: { code: 'operation-error', diagnostic: String(error?.message ?? error) } })
          }
          store.set({ busy: false })
          if (persistWorkspaceId) {
            const stateAfter = store.get()
            const sets = { ...stateAfter.sets, [persistWorkspaceId]: { entries: { ...entries }, folders: stateAfter.folders, folderOrder: stateAfter.folderOrder, updatedAt: Date.now() } }
            store.set({ sets, savedSnapshot: { ...entries } })
            persistAll()
            markApplied(persistWorkspaceId)
          }
          await refreshInventory()
          store.set({ changeCount: computeChange(entries, liveOf(store.get().bundles)) })
          reportResults(results)
          return results
        }

        function reportResults(results) {
          const failed = results.filter((result) => result.application === 'failed')
          const restart = results.filter((result) => result.application === 'restart-required')
          const overridden = results.filter((result) => result.application === 'overridden')
          const applied = results.filter((result) => result.application === 'applied')
          if (failed.length > 0) {
            toast(`${failed.length} 个插件没能改：${failed.map((result) => `${result.target}（${result.error?.code ?? 'unknown'}）`).join('、')}`, 'is-error')
          }
          if (overridden.length > 0) toast(`${overridden.length} 个改动被更高层的配置覆盖了`, 'is-warn')
          if (applied.length > 0 && failed.length === 0) toast(`已应用 ${applied.length} 处改动`)
          if (restart.length > 0) {
            const reasons = []
            for (const result of restart) {
              const reason = result.restartReason ?? 'module-comparison'
              if (!reasons.includes(reason)) reasons.push(reason)
            }
            store.set({ dialog: { kind: 'restart', reasons } })
          }
        }

        function saveAndSwitch() {
          save()
          const workspaceId = store.get().open?.workspaceId
          if (!workspaceId) return
          close()
          try {
            ctx.uiWorkspace.openWorkspace(workspaceId)
          } catch (error) {
            toast(`切换失败：${String(error?.message ?? error)}`, 'is-error')
          }
        }

        function close() {
          store.set({ open: null, dialog: null })
        }

        function undo() {
          const state = store.get()
          setDraft({ ...state.baseDraft })
          toast('已回到打开时的表')
        }

        function sync() {
          const state = store.get()
          const live = liveOf(state.bundles)
          const draft = {}
          for (const [key, value] of Object.entries(live)) if (value) draft[key] = true
          store.set({ draft, baseDraft: { ...draft }, savedSnapshot: { ...draft } })
          const workspaceId = state.open?.workspaceId
          if (workspaceId) {
            const sets = { ...state.sets, [workspaceId]: { entries: { ...draft }, folders: state.folders, folderOrder: state.folderOrder, updatedAt: Date.now() } }
            store.set({ sets })
            persistAll()
          }
          recompute()
          toast('已按插件当前实际状态同步')
        }

        function diffCounts(entries, live) {
          let on = 0
          let off = 0
          for (const key of Object.keys(live)) {
            const desired = key in entries ? Boolean(entries[key]) : false
            const current = Boolean(live[key])
            if (desired === current) continue
            if (desired) on += 1
            else off += 1
          }
          return { on, off }
        }

        function handleWorkspaceSwitch(workspaceId) {
          const state = store.get()
          if (state.bundles.length === 0) return
          const set = state.sets[workspaceId]
          const live = liveOf(state.bundles)
          if (!set) {
            markApplied(workspaceId)
            return
          }
          if (sameValues(set.entries, live, Object.keys(live))) {
            markApplied(workspaceId)
            return
          }
          if (otherWorkspaceRunning(workspaceId)) {
            store.set({ banner: { workspaceId, title: workspaceTitle(workspaceId) } })
            return
          }
          if (state.settings.autoApply) {
            void applyEntries(set.entries, null).then(() => markApplied(workspaceId))
            return
          }
          store.set({ dialog: { kind: 'switch', workspaceId, title: workspaceTitle(workspaceId) }, dialogInfo: { ...diffCounts(set.entries, live), running: false } })
        }

        function confirmSwitch() {
          const state = store.get()
          const dialog = state.dialog
          if (!dialog || dialog.kind !== 'switch') return
          const set = state.sets[dialog.workspaceId]
          store.set({ dialog: null })
          if (!set) {
            markApplied(dialog.workspaceId)
            return
          }
          void applyEntries(set.entries, null).then(() => markApplied(dialog.workspaceId))
        }

        function dismissDialog() {
          store.set({ dialog: null })
        }

        function dismissBanner() {
          store.set({ banner: null })
        }

        function applyBanner() {
          const state = store.get()
          const workspaceId = state.banner?.workspaceId
          if (!workspaceId) return
          const set = state.sets[workspaceId]
          store.set({ banner: null })
          if (!set) {
            markApplied(workspaceId)
            return
          }
          void applyEntries(set.entries, null).then(() => markApplied(workspaceId))
        }

        function choices() {
          try {
            const items = ctx.workspaces.list.getSnapshot()?.items ?? []
            const state = store.get()
            return items
              .filter((item) => state.sets[item.workspaceId])
              .map((item) => ({ id: item.workspaceId, title: item.title || item.path || item.workspaceId }))
          } catch {
            return []
          }
        }

        function setTemplate(workspaceId) {
          const state = store.get()
          store.set({ settings: { ...state.settings, template: workspaceId || null } })
          persistAll()
          toast(workspaceId ? '已设为新工作区模板' : '已清除模板')
        }

        function addDependency(dependent, dependency) {
          if (!dependent || !dependency || dependent === dependency) return
          const state = store.get()
          const dependencies = { ...(state.settings.dependencies ?? {}) }
          dependencies[dependent] = [...new Set([...(dependencies[dependent] ?? []), dependency])]
          store.set({ settings: { ...state.settings, dependencies } })
          persistAll()
          toast('已记录依赖')
        }

        function removeDependency(dependent, dependency) {
          const state = store.get()
          const dependencies = { ...(state.settings.dependencies ?? {}) }
          const next = (dependencies[dependent] ?? []).filter((key) => key !== dependency)
          if (next.length === 0) delete dependencies[dependent]
          else dependencies[dependent] = next
          store.set({ settings: { ...state.settings, dependencies } })
          persistAll()
        }

        function previewRestart() {
          store.set({ dialog: { kind: 'restart', reasons: ['no-hmr', 'host-module'] } })
        }

        function exportState() {
          const payload = JSON.stringify(statePayload(), null, 2)
          try {
            const blob = new Blob([payload], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = `dsh-workspace-plugins-${new Date().toISOString().slice(0, 10)}.json`
            document.body.appendChild(anchor)
            anchor.click()
            anchor.remove()
            window.setTimeout(() => URL.revokeObjectURL(url), 1000)
            toast('已导出 JSON 文件')
          } catch (error) {
            toast(`导出失败：${String(error?.message ?? error)}`, 'is-error')
          }
        }

        async function importState(file) {
          try {
            const text = await file.text()
            const data = JSON.parse(text)
            if (!data || typeof data !== 'object' || Array.isArray(data) || !data.sets || typeof data.sets !== 'object') {
              toast('这不是本插件的导出文件', 'is-error')
              return
            }
            const state = store.get()
            const sets = { ...state.sets }
            let count = 0
            for (const [id, set] of Object.entries(data.sets)) {
              if (!set || typeof set !== 'object' || !set.entries || typeof set.entries !== 'object') continue
              sets[id] = {
                entries: set.entries,
                folders: set.folders && typeof set.folders === 'object' ? set.folders : {},
                folderOrder: Array.isArray(set.folderOrder) ? set.folderOrder : [],
                updatedAt: Date.now(),
              }
              count += 1
            }
            store.set({ sets, settings: { ...state.settings, ...(data.settings ?? {}) } })
            persistAll()
            toast(`已导入 ${count} 个工作区的插件表`)
          } catch (error) {
            toast(`导入失败：${String(error?.message ?? error)}`, 'is-error')
          }
        }

        function markNotified(keys) {
          const state = store.get()
          const workspaceId = state.open?.workspaceId
          const set = workspaceId ? state.sets[workspaceId] : undefined
          if (!workspaceId || !set) return
          const notified = [...new Set([...(set.notified ?? []), ...keys])]
          store.set({
            sets: { ...state.sets, [workspaceId]: { ...set, notified } },
            newKeys: state.newKeys.filter((key) => !keys.includes(key)),
          })
          persistAll()
        }

        function addNew(keys) {
          const state = store.get()
          if (keys.length === 0) return
          const draft = { ...state.draft }
          for (const key of keys) draft[key] = true
          store.set({ draft })
          markNotified(keys)
          recompute()
        }

        function addNewToFolder(keys, folderId) {
          const state = store.get()
          if (keys.length === 0) return
          const draft = { ...state.draft }
          for (const key of keys) draft[key] = true
          let folders = state.folders
          if (folderId && folders[folderId]) {
            folders = {
              ...folders,
              [folderId]: {
                ...folders[folderId],
                members: [...folders[folderId].members.filter((member) => !keys.includes(member)), ...keys],
              },
            }
          }
          store.set({ draft, folders })
          markNotified(keys)
          recompute()
        }

        function addEverywhere(keys) {
          const state = store.get()
          if (keys.length === 0) return
          const sets = { ...state.sets }
          for (const [id, set] of Object.entries(sets)) {
            const entries = { ...set.entries }
            for (const key of keys) entries[key] = true
            sets[id] = { ...set, entries, notified: [...new Set([...(set.notified ?? []), ...keys])], updatedAt: Date.now() }
          }
          const draft = { ...state.draft }
          for (const key of keys) draft[key] = true
          store.set({ sets, draft, newKeys: state.newKeys.filter((key) => !keys.includes(key)) })
          recompute()
          persistAll()
          toast(`已加入所有工作区（${keys.length} 个）`)
        }

        function openFolderForNew(keys) {
          const state = store.get()
          if (keys.length === 0) return
          if (state.folderOrder.length === 0) {
            store.set({ prompt: { kind: 'folderAdd', title: '新建文件夹并加入', value: '新文件夹', keys } })
            return
          }
          store.set({ folderPick: { keys } })
        }

        function pickFolderForNew(folderId) {
          const state = store.get()
          const pick = state.folderPick
          store.set({ folderPick: null })
          if (pick) addNewToFolder(pick.keys, folderId)
        }

        function cancelFolderPick() {
          store.set({ folderPick: null })
        }

        function newFolderForNew() {
          const state = store.get()
          const pick = state.folderPick
          store.set({ folderPick: null, prompt: { kind: 'folderAdd', title: '新建文件夹并加入', value: '新文件夹', keys: pick?.keys ?? state.newKeys.slice() } })
        }

        const actions = {
          close,
          startDrag,
          startResize,
          toggleItem,
          toggleFolder,
          select,
          setTarget,
          newFolder,
          renameFolder,
          deleteFolder,
          requestConfirm,
          submitPrompt,
          cancelPrompt,
          deleteSelection,
          cut,
          copy,
          paste,
          addFromPool,
          openPool,
          closePool,
          setup,
          save: () => save(),
          apply: (persist) => void apply(persist),
          saveAndSwitch,
          undo,
          sync,
          confirmSwitch,
          dismissDialog,
          dismissBanner,
          applyBanner,
          persistAll,
          refresh: () => void refreshInventory(),
          choices,
          setTemplate,
          addDependency,
          removeDependency,
          previewRestart,
          addNew,
          addEverywhere,
          openFolderForNew,
          pickFolderForNew,
          cancelFolderPick,
          newFolderForNew,
          dismissNew: (key) => markNotified([key]),
          exportState,
          importState,
        }

        function Overlay() {
          const state = useSyncExternalStore(store.subscribe, store.get)
          if (!state.hydrated) return null
          return h(
            'div',
            { className: 'wspm-layer', style: { pointerEvents: 'none' } },
            h('style', null, STYLES),
            state.banner ? h(Banner, { state, actions }) : null,
            state.open ? h(Window, { state, store, ctx, actions }) : null,
            state.setup ? h(Portal, null, h(SetupDialog, { state, actions })) : null,
            state.prompt ? h(Portal, null, h(PromptModal, { state, actions })) : null,
            state.dialog?.kind === 'switch' ? h(Portal, null, h(SwitchDialog, { state, actions })) : null,
            state.dialog?.kind === 'restart' ? h(Portal, null, h(RestartDialog, { state, actions })) : null,
            state.folderPick ? h(Portal, null, h(FolderPickModal, { state, actions })) : null,
            h(Toasts, { toasts: state.toasts }),
          )
        }

        function SettingsEntry() {
          const state = useSyncExternalStore(store.subscribe, store.get)
          return h('div', null, h('style', null, STYLES), h(SettingsPanel, { state, store, actions }))
        }

        ctx.effect(
          () => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'workspace-plugin-manager', order: 20 }, Overlay)),
          'workspace-plugin-manager: floating window',
        )

        ctx.effect(
          () =>
            ctx.slots.inject('settings.plugins.tab', () =>
              ctx.slots.register({ name: 'settings.plugins.tab', id: 'workspace-plugin-manager', order: 70, label: '工作区插件管理' }, SettingsEntry),
            ),
          'workspace-plugin-manager: settings tab',
        )

        ctx.effect(
          () => ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({ name: 'contextMenu.icon', key: 'workspace.plugin-manager' }, Icon)),
          'workspace-plugin-manager: menu icon',
        )

        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: 'workspace.plugin-manager',
              target: 'workspace',
              order: 200,
              resolve: ({ workspaceId, path, displayTitle }) => {
                if (store.get().bundles.length === 0 && !store.get().loading) void refreshInventory()
                return [
                  {
                    id: 'open-plugin-manager',
                    label: menuLabel(workspaceId),
                    icon: { key: 'workspace.plugin-manager' },
                    run: () => openManager({ workspaceId, path, displayTitle }),
                  },
                ]
              },
            }),
          'workspace-plugin-manager: menu action',
        )

        function menuLabel(workspaceId) {
          const state = store.get()
          const set = state.sets[workspaceId]
          if (!set) return '插件管理'
          const entries = Object.values(set.entries)
          const on = entries.filter(Boolean).length
          return `插件管理 · ${on}/${entries.length}`
        }

        let lastWorkspaceId
        const checkSwitch = () => {
          const workspaceId = currentWorkspaceId()
          if (!workspaceId) return
          if (lastWorkspaceId === undefined) {
            lastWorkspaceId = workspaceId
            if (store.get().bundles.length === 0) void refreshInventory()
            return
          }
          if (workspaceId === lastWorkspaceId) return
          lastWorkspaceId = workspaceId
          if (store.get().bundles.length === 0) {
            void refreshInventory().then(() => handleWorkspaceSwitch(workspaceId))
          } else {
            handleWorkspaceSwitch(workspaceId)
          }
        }

        ctx.effect(() => {
          const offSessions = ctx.sessions.list.subscribe(checkSwitch)
          const offWorkspaces = ctx.workspaces.list.subscribe(checkSwitch)
          checkSwitch()
          return () => {
            offSessions()
            offWorkspaces()
          }
        }, 'workspace-plugin-manager: workspace switch watch')
      },
    }
  },
})
