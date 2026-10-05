import type { KeyboardCommand, KeyboardCommandId, KeyboardCommandSettingsTitleKey, KeybindingRule } from './types';

export const defaultKeyboardCommands: readonly KeyboardCommand[] = [
    {
        id: 'appearance.theme.toggle',
        settingsTitleKey: 'settingsAppearance.glassControls.themeCommand',
        // Safari reserves Cmd+Shift+L for its sidebar; desktop webviews keep the normal chord.
        get defaultBindings(): readonly KeybindingRule[] {
            const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
            const safari = /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|Edg|OPR|FxiOS)\//.test(ua);
            return [
                { binding: 'Mod+Shift+L', platforms: ['web'], webHost: 'desktop', nativeConsumable: true },
                { binding: safari ? 'Mod+Alt+L' : 'Mod+Shift+L', platforms: ['web'], webHost: 'browser' },
                { binding: 'Mod+Shift+L', blockedSurfaces: ['web'], nativeConsumable: true },
            ];
        },
        when: context => !context.isEditableTarget,
    },
    // Browser chrome (UB-6). Guest<->host policy: these are HOST shortcuts and fire only while the
    // app chrome owns the keyboard. A page loaded in the in-app browser lives in a separate frame
    // or a native child webview, so its key events never reach this document's listener and it can
    // never be hijacked by them; equally, none of these steal a key from the page while it is
    // focused. `when: !isEditableTarget` keeps them out of the address bar and any other field.
    //
    // On the `web` surface (which includes the Tauri desktop app, whose bundle is the web bundle)
    // Mod+L / Mod+R / Mod+[ / Mod+] belong to the HOST browser and are listed in
    // `browserShortcutConflicts`, so the web bindings use Alt like the other web-surface commands.
    {
        id: 'browser.address.focus',
        settingsTitleKey: 'settingsKeyboard.commands.browserAddressFocus',
        defaultBindings: [
            { binding: 'Alt+L', platforms: ['web'] },
            { binding: 'Mod+L', blockedSurfaces: ['web'] },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'browser.back',
        settingsTitleKey: 'settingsKeyboard.commands.browserBack',
        defaultBindings: [
            { binding: 'Alt+[', platforms: ['web'] },
            { binding: 'Mod+[', blockedSurfaces: ['web'] },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'browser.forward',
        settingsTitleKey: 'settingsKeyboard.commands.browserForward',
        defaultBindings: [
            { binding: 'Alt+]', platforms: ['web'] },
            { binding: 'Mod+]', blockedSurfaces: ['web'] },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'browser.reload',
        settingsTitleKey: 'settingsKeyboard.commands.browserReload',
        defaultBindings: [
            { binding: 'Alt+R', platforms: ['web'] },
            { binding: 'Mod+R', blockedSurfaces: ['web'] },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'composer.abortConfirm',
        settingsTitleKey: 'settingsKeyboard.commands.composerAbortConfirm',
        defaultBindings: [
            { binding: 'Mod+.', allowInEditable: true, platforms: ['web'] },
            { binding: 'Shift+Escape', allowInEditable: true, nativeConsumable: true, blockedSurfaces: ['web'] },
        ],
    },
    {
        id: 'composer.focus',
        settingsTitleKey: 'settingsKeyboard.commands.composerFocus',
        defaultBinding: { binding: 'Mod+I' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'composer.prompts.open',
        settingsTitleKey: 'settingsKeyboard.commands.composerPromptsOpen',
        defaultBindings: [
            { binding: 'Ctrl+R', platforms: ['macos'], webHost: 'browser', allowInEditable: true, nativeConsumable: true },
            { binding: 'Ctrl+R', webHost: 'desktop', allowInEditable: true, nativeConsumable: true },
        ],
    },
    {
        id: 'voice.toggle',
        settingsTitleKey: 'settingsKeyboard.commands.voiceToggle',
        defaultBinding: { binding: 'Mod+Alt+V', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'composer.sendImmediate',
        settingsTitleKey: 'settingsKeyboard.commands.composerSendImmediate',
        defaultBinding: { binding: 'Mod+Enter', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'composer.sendPending',
        settingsTitleKey: 'settingsKeyboard.commands.composerSendPending',
        defaultBinding: { binding: 'Mod+Shift+Enter', allowInEditable: true },
    },
    {
        id: 'commandPalette.open',
        settingsTitleKey: 'settingsKeyboard.commands.commandPaletteOpen',
        defaultBindings: [
            { binding: 'Alt+K', platforms: ['web'] },
            { binding: 'Mod+K', nativeConsumable: true, blockedSurfaces: ['web'] },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'mode.cycle',
        settingsTitleKey: 'settingsKeyboard.commands.modeCycle',
        defaultBinding: { binding: 'Alt+Shift+M', allowInEditable: true },
    },
    {
        id: 'search.textInFiles',
        settingsTitleKey: 'settingsKeyboard.commands.searchTextInFiles',
        defaultBinding: { binding: 'Mod+Shift+F', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'find.open', settingsTitleKey: 'settingsKeyboard.commands.findOpen',
        defaultBinding: { binding: 'Mod+F', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'find.next', settingsTitleKey: 'settingsKeyboard.commands.findNext',
        defaultBindings: [
            { binding: 'Mod+G', allowInEditable: true, nativeConsumable: true },
            { binding: 'Enter', allowInEditable: true, nativeConsumable: true, conflictScope: 'findInput' },
        ],
    },
    {
        id: 'find.previous', settingsTitleKey: 'settingsKeyboard.commands.findPrevious',
        defaultBindings: [
            { binding: 'Mod+Shift+G', allowInEditable: true, nativeConsumable: true },
            { binding: 'Shift+Enter', allowInEditable: true, nativeConsumable: true, conflictScope: 'findInput' },
        ],
    },
    {
        id: 'permission.cycle',
        settingsTitleKey: 'settingsKeyboard.commands.permissionCycle',
    },
    {
        id: 'shortcutsHelp.open',
        settingsTitleKey: 'settingsKeyboard.commands.shortcutsHelpOpen',
        defaultBinding: { binding: '?' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'session.new',
        settingsTitleKey: 'settingsKeyboard.commands.sessionNew',
        defaultBindings: [
            { binding: 'Alt+N', platforms: ['web'] },
            { binding: 'Mod+Shift+N', blockedSurfaces: ['web'] },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'session.mru.next',
        settingsTitleKey: 'settingsKeyboard.commands.sessionMruNext',
        defaultBindings: [
            { binding: 'Alt+PageDown', platforms: ['web'] },
            { binding: 'Ctrl+Tab', blockedSurfaces: ['web'] },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'session.pending.next',
        settingsTitleKey: 'settingsKeyboard.commands.sessionPendingNext',
        defaultBindings: [
            { binding: 'Alt+Shift+J', platforms: ['web'], webHost: 'browser', allowInEditable: true },
            { binding: 'Mod+Shift+J', webHost: 'desktop', allowInEditable: true, nativeConsumable: true },
        ],
    },
    {
        id: 'session.mru.previous',
        settingsTitleKey: 'settingsKeyboard.commands.sessionMruPrevious',
        defaultBindings: [
            { binding: 'Alt+PageUp', platforms: ['web'] },
            { binding: 'Ctrl+Shift+Tab', blockedSurfaces: ['web'] },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'sessions.row.moveUp',
        settingsTitleKey: 'settingsKeyboard.commands.sessionsRowMoveUp',
        defaultBinding: { binding: 'Alt+Shift+ArrowUp' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'sessions.row.moveDown',
        settingsTitleKey: 'settingsKeyboard.commands.sessionsRowMoveDown',
        defaultBinding: { binding: 'Alt+Shift+ArrowDown' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'sessions.row.moveToFolder',
        settingsTitleKey: 'settingsKeyboard.commands.sessionsRowMoveToFolder',
        defaultBinding: { binding: 'Alt+Shift+F' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'sessions.row.moveToWorkspaceRoot',
        settingsTitleKey: 'settingsKeyboard.commands.sessionsRowMoveToWorkspaceRoot',
        defaultBinding: { binding: 'Alt+Shift+R' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'sessions.selection.toggleFocused',
        settingsTitleKey: 'settingsKeyboard.commands.sessionsSelectionToggleFocused',
        defaultBinding: { binding: 'x', platforms: ['web'], conflictScope: 'sessionListSelection' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'sessions.selection.extendUp',
        settingsTitleKey: 'settingsKeyboard.commands.sessionsSelectionExtendUp',
        defaultBinding: { binding: 'Shift+ArrowUp', platforms: ['web'], conflictScope: 'sessionListSelection' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'sessions.selection.extendDown',
        settingsTitleKey: 'settingsKeyboard.commands.sessionsSelectionExtendDown',
        defaultBinding: { binding: 'Shift+ArrowDown', platforms: ['web'], conflictScope: 'sessionListSelection' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'sessions.selection.selectAll',
        settingsTitleKey: 'settingsKeyboard.commands.sessionsSelectionSelectAll',
        defaultBinding: { binding: 'Mod+A', platforms: ['web'], conflictScope: 'sessionListSelection' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'sessions.selection.clear',
        settingsTitleKey: 'settingsKeyboard.commands.sessionsSelectionClear',
        defaultBinding: { binding: 'Escape', platforms: ['web'], conflictScope: 'sessionListSelection' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'workspace.closePane',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasCloseLeaf',
        defaultBinding: { binding: 'Alt+Backspace' },
        when: (context) => !context.isEditableTarget,
    },
    // These tab commands also work while editing. Browser-reserved chords remain visible in the
    // shared conflict diagnostics; dispatch can only act on events the host delivers to the app.
    {
        id: 'workspace.tab.new',
        settingsTitleKey: 'settingsKeyboard.commands.workspaceTabNew',
        defaultBinding: { binding: 'Mod+T', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'workspace.tab.close',
        settingsTitleKey: 'settingsKeyboard.commands.workspaceTabClose',
        defaultBinding: { binding: 'Mod+W', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'workspace.tab.reopen',
        settingsTitleKey: 'settingsKeyboard.commands.workspaceTabReopen',
        defaultBinding: { binding: 'Mod+Shift+T', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'workspace.tab.select1',
        settingsTitleKey: 'settingsKeyboard.commands.workspaceTabSelect1',
        defaultBinding: { binding: 'Mod+1', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'workspace.tab.select2',
        settingsTitleKey: 'settingsKeyboard.commands.workspaceTabSelect2',
        defaultBinding: { binding: 'Mod+2', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'workspace.tab.select3',
        settingsTitleKey: 'settingsKeyboard.commands.workspaceTabSelect3',
        defaultBinding: { binding: 'Mod+3', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'workspace.tab.select4',
        settingsTitleKey: 'settingsKeyboard.commands.workspaceTabSelect4',
        defaultBinding: { binding: 'Mod+4', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'workspace.tab.select5',
        settingsTitleKey: 'settingsKeyboard.commands.workspaceTabSelect5',
        defaultBinding: { binding: 'Mod+5', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'workspace.tab.select6',
        settingsTitleKey: 'settingsKeyboard.commands.workspaceTabSelect6',
        defaultBinding: { binding: 'Mod+6', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'workspace.tab.select7',
        settingsTitleKey: 'settingsKeyboard.commands.workspaceTabSelect7',
        defaultBinding: { binding: 'Mod+7', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'workspace.tab.select8',
        settingsTitleKey: 'settingsKeyboard.commands.workspaceTabSelect8',
        defaultBinding: { binding: 'Mod+8', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'workspace.tab.select9',
        settingsTitleKey: 'settingsKeyboard.commands.workspaceTabSelect9',
        defaultBinding: { binding: 'Mod+9', allowInEditable: true, nativeConsumable: true },
    },
    // Jump to a terminal (terminal lab B4): the command palette in its Terminals scope. Like the
    // palette itself, the web surface (which includes the desktop app) uses Alt because the host
    // browser keeps Mod+J for its downloads view.
    {
        id: 'terminal.jump',
        settingsTitleKey: 'settingsKeyboard.commands.terminalJump',
        defaultBindings: [
            { binding: 'Alt+J', platforms: ['web'] },
            { binding: 'Mod+J', nativeConsumable: true, blockedSurfaces: ['web'] },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'terminal.toggle',
        settingsTitleKey: 'settingsKeyboard.commands.terminalToggle',
        defaultBinding: { binding: 'Ctrl+`', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'terminal.newShell',
        settingsTitleKey: 'settingsKeyboard.commands.terminalNewShell',
        defaultBinding: { binding: 'Ctrl+Shift+`', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'terminal.split',
        settingsTitleKey: 'settingsKeyboard.commands.terminalSplit',
        defaultBinding: { binding: 'Mod+\\', allowInEditable: true, nativeConsumable: true },
    },
    {
        id: 'workspace.focusDown',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasFocusDown',
        defaultBindings: [
            { binding: 'Ctrl+Alt+ArrowDown', platforms: ['web'], conflictScope: 'workspace' },
            { binding: 'Mod+Alt+ArrowDown', blockedSurfaces: ['web'], conflictScope: 'workspace' },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'workspace.focusLeft',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasFocusLeft',
        defaultBindings: [
            { binding: 'Ctrl+Alt+ArrowLeft', platforms: ['web'], conflictScope: 'workspace' },
            { binding: 'Mod+Alt+ArrowLeft', blockedSurfaces: ['web'], conflictScope: 'workspace' },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'workspace.focusRight',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasFocusRight',
        defaultBindings: [
            { binding: 'Ctrl+Alt+ArrowRight', platforms: ['web'], conflictScope: 'workspace' },
            { binding: 'Mod+Alt+ArrowRight', blockedSurfaces: ['web'], conflictScope: 'workspace' },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'workspace.focusUp',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasFocusUp',
        defaultBindings: [
            { binding: 'Ctrl+Alt+ArrowUp', platforms: ['web'], conflictScope: 'workspace' },
            { binding: 'Mod+Alt+ArrowUp', blockedSurfaces: ['web'], conflictScope: 'workspace' },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'workspace.restoreMaximize',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasRestoreMaximize',
        defaultBinding: { binding: 'Escape', conflictScope: 'workspace' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'workspace.splitDown',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasSplitDown',
        defaultBindings: [
            { binding: 'Alt+Shift+Backslash', platforms: ['web'], conflictScope: 'workspace' },
            { binding: 'Mod+Shift+Backslash', blockedSurfaces: ['web'], conflictScope: 'workspace' },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'workspace.splitRight',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasSplitRight',
        defaultBindings: [
            { binding: 'Alt+Backslash', platforms: ['web'], conflictScope: 'workspace' },
            { binding: 'Mod+Backslash', blockedSurfaces: ['web'], conflictScope: 'workspace' },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'workspace.toggleMaximize',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasToggleMaximize',
        defaultBinding: { binding: 'Alt+M', conflictScope: 'workspace' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'session.visible.next',
        settingsTitleKey: 'settingsKeyboard.commands.sessionVisibleNext',
        defaultBinding: { binding: 'Alt+ArrowDown', conflictScope: 'sessionNavigation' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'session.visible.previous',
        settingsTitleKey: 'settingsKeyboard.commands.sessionVisiblePrevious',
        defaultBinding: { binding: 'Alt+ArrowUp', conflictScope: 'sessionNavigation' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'settings.open',
        settingsTitleKey: 'settingsKeyboard.commands.settingsOpen',
        // The platform's preferences shortcut; a browser keeps it for its own preferences.
        defaultBindings: [{ binding: 'Mod+,', blockedSurfaces: ['web'] }],
    },
    {
        id: 'transcript.message.next',
        settingsTitleKey: 'settingsKeyboard.commands.transcriptMessageNext',
    },
    {
        id: 'transcript.message.previous',
        settingsTitleKey: 'settingsKeyboard.commands.transcriptMessagePrevious',
    },
    {
        id: 'transcript.selection.cancel',
        settingsTitleKey: 'settingsKeyboard.commands.transcriptSelectionCancel',
        defaultBinding: { binding: 'Escape' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'transcript.selection.copy',
        settingsTitleKey: 'settingsKeyboard.commands.transcriptSelectionCopy',
        defaultBinding: { binding: 'Alt+Shift+C' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'transcript.selection.selectAll',
        settingsTitleKey: 'settingsKeyboard.commands.transcriptSelectionSelectAll',
        defaultBinding: { binding: 'Alt+Shift+A' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'transcript.selection.sendToSession',
        settingsTitleKey: 'settingsKeyboard.commands.transcriptSelectionSendToSession',
        defaultBinding: { binding: 'Alt+Shift+S' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'transcript.scroll.bottom',
        settingsTitleKey: 'settingsKeyboard.commands.transcriptScrollBottom',
        defaultBinding: { binding: 'End' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'transcript.scroll.pageDown',
        settingsTitleKey: 'settingsKeyboard.commands.transcriptScrollPageDown',
        defaultBinding: { binding: 'PageDown' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'transcript.scroll.pageUp',
        settingsTitleKey: 'settingsKeyboard.commands.transcriptScrollPageUp',
        defaultBinding: { binding: 'PageUp' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'transcript.scroll.top',
        settingsTitleKey: 'settingsKeyboard.commands.transcriptScrollTop',
        defaultBinding: { binding: 'Home' },
        when: (context) => !context.isEditableTarget,
    },
    { id: 'workflow.new', settingsTitleKey: 'workflows.newWorkflow' },
    { id: 'workflow.createWithAgent', settingsTitleKey: 'workflows.authoring.create' },
    // Workflow authoring. Both commands fire while the caret is inside the workflow editor's own
    // fields, so they are `allowInEditable`; save/run are exactly the actions an author reaches for
    // mid-edit and there is no competing text-field meaning for either chord.
    //
    // Mod+S is Save Page on the `web` surface (which includes the Tauri desktop app, whose bundle is
    // the web bundle), so save follows the same per-surface split as `browser.*` and `session.new`
    // and binds Alt+S there instead.
    {
        id: 'workflow.save',
        settingsTitleKey: 'settingsKeyboard.commands.workflowSave',
        defaultBindings: [
            { binding: 'Alt+S', allowInEditable: true, platforms: ['web'] },
            { binding: 'Mod+S', allowInEditable: true, nativeConsumable: true, blockedSurfaces: ['web'] },
        ],
    },
    // Mod+Enter is also `composer.sendImmediate`'s default. The two are never reachable together —
    // the workflow authoring composer has no send action and the Session composer is not on the
    // workflow page — so this sits in its own conflict scope. Scopes are namespaces in
    // `buildDuplicateBindingConflicts`: a distinct scope keeps the settings duplicate report honest
    // (compare `splitCanvas` vs `sessionNavigation`, which share Alt+ArrowUp/Down the same way).
    {
        id: 'workflow.run',
        settingsTitleKey: 'settingsKeyboard.commands.workflowRun',
        defaultBinding: {
            binding: 'Mod+Enter',
            allowInEditable: true,
            nativeConsumable: true,
            conflictScope: 'workflowEditor',
        },
    },
];

export function getDefaultKeybinding(commandId: KeyboardCommandId): KeybindingRule | undefined {
    const command = defaultKeyboardCommands.find((entry) => entry.id === commandId);
    return command?.defaultBindings?.[0] ?? command?.defaultBinding;
}

export function getKeyboardCommandSettingsTitleKey(commandId: KeyboardCommandId): KeyboardCommandSettingsTitleKey {
    const titleKey = defaultKeyboardCommands.find((command) => command.id === commandId)?.settingsTitleKey;
    if (!titleKey) {
        throw new Error(`Keyboard command ${commandId} is missing settings title metadata.`);
    }
    return titleKey;
}
