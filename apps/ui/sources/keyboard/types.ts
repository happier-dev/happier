import type { TranslationKeyNoParams } from '@/text';

export type KeyboardPlatform = 'macos' | 'ios' | 'windows' | 'linux' | 'android' | 'web';

export type KeyboardCommandId =
    | 'composer.abortConfirm'
    | 'composer.focus'
    | 'composer.sendImmediate'
    | 'composer.sendPending'
    | 'commandPalette.open'
    | 'mode.cycle'
    | 'permission.cycle'
    | 'shortcutsHelp.open'
    | 'session.new'
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
    | 'splitCanvas.closeLeaf'
    | 'splitCanvas.focusDown'
    | 'splitCanvas.focusLeft'
    | 'splitCanvas.focusRight'
    | 'splitCanvas.focusUp'
    | 'splitCanvas.restoreMaximize'
    | 'splitCanvas.splitDown'
    | 'splitCanvas.splitRight'
    | 'splitCanvas.toggleMaximize'
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
    | 'transcript.scroll.top';

export type KeyboardCommandSettingsTitleKey = Extract<
    TranslationKeyNoParams,
    | 'settingsKeyboard.commands.composerAbortConfirm'
    | 'settingsKeyboard.commands.composerFocus'
    | 'settingsKeyboard.commands.composerSendImmediate'
    | 'settingsKeyboard.commands.composerSendPending'
    | 'settingsKeyboard.commands.commandPaletteOpen'
    | 'settingsKeyboard.commands.modeCycle'
    | 'settingsKeyboard.commands.permissionCycle'
    | 'settingsKeyboard.commands.shortcutsHelpOpen'
    | 'settingsKeyboard.commands.sessionNew'
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
>;

export type KeyboardContext = Readonly<{
    isEditableTarget: boolean;
    isComposing: boolean;
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

export type KeybindingRule = Readonly<{
    binding: string;
    platforms?: readonly KeyboardPlatform[];
    blockedSurfaces?: readonly KeyboardSurface[];
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
