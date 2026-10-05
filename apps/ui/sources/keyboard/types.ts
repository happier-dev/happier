import type { TranslationKeyNoParams } from '@/text';

export type KeyboardPlatform = 'macos' | 'ios' | 'windows' | 'linux' | 'android' | 'web';

export type KeyboardCommandId =
    | 'appearance.theme.toggle'
    | 'browser.address.focus'
    | 'browser.back'
    | 'browser.forward'
    | 'browser.reload'
    | 'composer.abortConfirm'
    | 'composer.focus'
    | 'composer.prompts.open'
    | 'composer.sendImmediate'
    | 'composer.sendPending'
    | 'voice.toggle'
    | 'commandPalette.open'
    | 'search.textInFiles'
    | 'find.open'
    | 'find.next'
    | 'find.previous'
    | 'mode.cycle'
    | 'permission.cycle'
    | 'shortcutsHelp.open'
    | 'session.new'
    | 'session.pending.next'
    | 'session.mru.next'
    | 'session.mru.previous'
    | 'sessions.row.moveDown'
    | 'sessions.row.moveToFolder'
    | 'sessions.row.moveToWorkspaceRoot'
    | 'sessions.row.moveUp'
    | 'sessions.selection.clear'
    | 'sessions.selection.extendDown'
    | 'sessions.selection.extendUp'
    | 'sessions.selection.selectAll'
    | 'sessions.selection.toggleFocused'
    | 'session.visible.next'
    | 'session.visible.previous'
    | 'workspace.closePane'
    | 'workspace.focusDown'
    | 'workspace.focusLeft'
    | 'workspace.focusRight'
    | 'workspace.focusUp'
    | 'workspace.restoreMaximize'
    | 'workspace.splitDown'
    | 'workspace.splitRight'
    | 'workspace.toggleMaximize'
    | 'workspace.tab.new'
    | 'workspace.tab.close'
    | 'workspace.tab.reopen'
    | `workspace.tab.select${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
    | 'terminal.jump'
    | 'terminal.toggle'
    | 'terminal.newShell'
    | 'terminal.split'
    | 'settings.open'
    | 'transcript.message.next'
    | 'transcript.message.previous'
    | 'transcript.selection.cancel'
    | 'transcript.selection.copy'
    | 'transcript.selection.selectAll'
    | 'transcript.selection.sendToSession'
    | 'transcript.scroll.bottom'
    | 'transcript.scroll.pageDown'
    | 'transcript.scroll.pageUp'
    | 'transcript.scroll.top'
    | 'workflow.run'
    | 'workflow.new'
    | 'workflow.createWithAgent'
    | 'workflow.save';

export type KeyboardCommandSettingsTitleKey = Extract<
    TranslationKeyNoParams,
    | 'workflows.newWorkflow'
    | 'workflows.authoring.create'
    | 'settingsAppearance.glassControls.themeCommand'
    | 'settingsKeyboard.commands.browserAddressFocus'
    | 'settingsKeyboard.commands.browserBack'
    | 'settingsKeyboard.commands.browserForward'
    | 'settingsKeyboard.commands.browserReload'
    | 'settingsKeyboard.commands.composerAbortConfirm'
    | 'settingsKeyboard.commands.composerFocus'
    | 'settingsKeyboard.commands.composerPromptsOpen'
    | 'settingsKeyboard.commands.composerSendImmediate'
    | 'settingsKeyboard.commands.composerSendPending'
    | 'settingsKeyboard.commands.voiceToggle'
    | 'settingsKeyboard.commands.commandPaletteOpen'
    | 'settingsKeyboard.commands.searchTextInFiles'
    | 'settingsKeyboard.commands.findOpen'
    | 'settingsKeyboard.commands.findNext'
    | 'settingsKeyboard.commands.findPrevious'
    | 'settingsKeyboard.commands.modeCycle'
    | 'settingsKeyboard.commands.permissionCycle'
    | 'settingsKeyboard.commands.shortcutsHelpOpen'
    | 'settingsKeyboard.commands.sessionNew'
    | 'settingsKeyboard.commands.sessionPendingNext'
    | 'settingsKeyboard.commands.sessionMruNext'
    | 'settingsKeyboard.commands.sessionMruPrevious'
    | 'settingsKeyboard.commands.sessionsRowMoveDown'
    | 'settingsKeyboard.commands.sessionsRowMoveToFolder'
    | 'settingsKeyboard.commands.sessionsRowMoveToWorkspaceRoot'
    | 'settingsKeyboard.commands.sessionsRowMoveUp'
    | 'settingsKeyboard.commands.sessionsSelectionClear'
    | 'settingsKeyboard.commands.sessionsSelectionExtendDown'
    | 'settingsKeyboard.commands.sessionsSelectionExtendUp'
    | 'settingsKeyboard.commands.sessionsSelectionSelectAll'
    | 'settingsKeyboard.commands.sessionsSelectionToggleFocused'
    | 'settingsKeyboard.commands.sessionVisibleNext'
    | 'settingsKeyboard.commands.sessionVisiblePrevious'
    | 'settingsKeyboard.commands.splitCanvasCloseLeaf'
    | 'settingsKeyboard.commands.splitCanvasFocusDown'
    | 'settingsKeyboard.commands.splitCanvasFocusLeft'
    | 'settingsKeyboard.commands.splitCanvasFocusRight'
    | 'settingsKeyboard.commands.splitCanvasFocusUp'
    | 'settingsKeyboard.commands.splitCanvasRestoreMaximize'
    | 'settingsKeyboard.commands.splitCanvasSplitDown'
    | 'settingsKeyboard.commands.splitCanvasSplitRight'
    | 'settingsKeyboard.commands.splitCanvasToggleMaximize'
    | 'settingsKeyboard.commands.settingsOpen'
    | 'settingsKeyboard.commands.transcriptMessageNext'
    | 'settingsKeyboard.commands.transcriptMessagePrevious'
    | 'settingsKeyboard.commands.transcriptSelectionCancel'
    | 'settingsKeyboard.commands.transcriptSelectionCopy'
    | 'settingsKeyboard.commands.transcriptSelectionSelectAll'
    | 'settingsKeyboard.commands.transcriptSelectionSendToSession'
    | 'settingsKeyboard.commands.transcriptScrollBottom'
    | 'settingsKeyboard.commands.transcriptScrollPageDown'
    | 'settingsKeyboard.commands.transcriptScrollPageUp'
    | 'settingsKeyboard.commands.transcriptScrollTop'
    | 'settingsKeyboard.commands.workflowRun'
    | 'settingsKeyboard.commands.workflowSave'
    | 'settingsKeyboard.commands.workspaceTabNew'
    | 'settingsKeyboard.commands.workspaceTabClose'
    | 'settingsKeyboard.commands.workspaceTabReopen'
    | `settingsKeyboard.commands.workspaceTabSelect${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
    | 'settingsKeyboard.commands.terminalJump'
    | 'settingsKeyboard.commands.terminalToggle'
    | 'settingsKeyboard.commands.terminalNewShell'
    | 'settingsKeyboard.commands.terminalSplit'
>;

export type KeyboardContext = Readonly<{
    isEditableTarget: boolean;
    isComposing: boolean;
    findInputFocused?: boolean;
}>;

export type NormalizedKeyboardEvent = Readonly<{
    key: string;
    code: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
    isComposing: boolean;
}>;

export type KeyboardSurface = 'native' | 'web';
export type KeyboardWebHost = 'browser' | 'desktop';

export type KeybindingRule = Readonly<{
    binding: string;
    platforms?: readonly KeyboardPlatform[];
    blockedSurfaces?: readonly KeyboardSurface[];
    /** Select a web host without changing existing browser shortcut policies. */
    webHost?: KeyboardWebHost;
    allowInEditable?: boolean;
    nativeConsumable?: boolean;
    conflictScope?: string;
}>;

export type ParsedKeybindingRule = KeybindingRule & Readonly<{
    key?: string;
    code?: string;
    mod?: boolean;
    alt?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
}>;

export type KeyboardCommand = Readonly<{
    id: KeyboardCommandId;
    settingsTitleKey: KeyboardCommandSettingsTitleKey;
    defaultBinding?: KeybindingRule;
    defaultBindings?: readonly KeybindingRule[];
    when?: (context: KeyboardContext) => boolean;
}>;
