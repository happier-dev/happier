import type { TranslationKey } from '@/text';

export type KeyboardPlatform = 'macos' | 'ios' | 'windows' | 'linux' | 'android' | 'web';

export type KeyboardCommandId =
    | 'composer.abortConfirm'
    | 'composer.focus'
    | 'composer.sendImmediate'
    | 'composer.sendPending'
    | 'composer.sendInterrupt'
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

export type KeybindingRule = Readonly<{
    binding: string;
    platforms?: readonly KeyboardPlatform[];
    blockedSurfaces?: readonly KeyboardSurface[];
    allowInEditable?: boolean;
}>;

export type KeyboardSurface = 'native' | 'web';

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
    /** Default editable-target policy also applies to custom bindings of unbound commands. */
    allowInEditable?: boolean;
    defaultBinding?: KeybindingRule;
    defaultBindings?: readonly KeybindingRule[];
    settingsTitleKey?: TranslationKey;
    when?: (context: KeyboardContext) => boolean;
}>;
