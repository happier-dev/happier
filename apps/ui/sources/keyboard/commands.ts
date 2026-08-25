import type { KeyboardCommand, KeyboardCommandId, KeyboardCommandSettingsTitleKey, KeybindingRule } from './types';

export const defaultKeyboardCommands: readonly KeyboardCommand[] = [
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
            { binding: 'Mod+K', blockedSurfaces: ['web'] },
        ],
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'mode.cycle',
        settingsTitleKey: 'settingsKeyboard.commands.modeCycle',
        defaultBinding: { binding: 'Alt+Shift+M', allowInEditable: true },
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
        defaultBinding: { binding: 'Space', platforms: ['web'], conflictScope: 'sessionListSelection' },
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
        id: 'splitCanvas.closeLeaf',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasCloseLeaf',
        defaultBinding: { binding: 'Alt+Backspace' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'splitCanvas.focusDown',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasFocusDown',
        defaultBinding: { binding: 'Alt+ArrowDown', conflictScope: 'splitCanvas' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'splitCanvas.focusLeft',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasFocusLeft',
        defaultBinding: { binding: 'Alt+ArrowLeft', conflictScope: 'splitCanvas' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'splitCanvas.focusRight',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasFocusRight',
        defaultBinding: { binding: 'Alt+ArrowRight', conflictScope: 'splitCanvas' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'splitCanvas.focusUp',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasFocusUp',
        defaultBinding: { binding: 'Alt+ArrowUp', conflictScope: 'splitCanvas' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'splitCanvas.restoreMaximize',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasRestoreMaximize',
        defaultBinding: { binding: 'Escape', conflictScope: 'splitCanvas' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'splitCanvas.splitDown',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasSplitDown',
        defaultBinding: { binding: 'Alt+Shift+ArrowDown', conflictScope: 'splitCanvas' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'splitCanvas.splitRight',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasSplitRight',
        defaultBinding: { binding: 'Alt+Shift+Enter', conflictScope: 'splitCanvas' },
        when: (context) => !context.isEditableTarget,
    },
    {
        id: 'splitCanvas.toggleMaximize',
        settingsTitleKey: 'settingsKeyboard.commands.splitCanvasToggleMaximize',
        defaultBinding: { binding: 'Alt+M', conflictScope: 'splitCanvas' },
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
