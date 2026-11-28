import type { TranslationKeyNoParams } from '@/text';
import type { DerivedKeyboardCommandId } from '@happier-dev/protocol/actions/settings/keyboardCommandMetadata';
import type { SESSION_ACTION_METADATA } from '@happier-dev/protocol/sessions/actions/sessionActionMetadata';

export type KeyboardPlatform = 'macos' | 'ios' | 'windows' | 'linux' | 'android' | 'web';

export type KeyboardCommandId =
    | DerivedKeyboardCommandId
    | 'code.goToDefinition'
    | 'code.findReferences'
    | 'code.goToTypeDefinition' | 'code.goToImplementation' | 'code.peekReferences'
    | 'code.suggest' | 'code.signatureHelp' | 'code.format' | 'code.formatSelection' | 'code.organizeImports'
    | 'code.expandSelection' | 'code.shrinkSelection'
    | 'code.showInfo'
    | 'code.problem.next'
    | 'code.problem.previous'
    | 'code.showProblems'
    | 'code.checkProjectProblems'
    | 'code.restart'
    | 'code.rename'
    | 'code.quickFix'
    | 'media.previous'
    | 'media.next'
    | 'media.zoomIn'
    | 'media.zoomOut'
    | 'media.fit'
    | 'media.actualSize'
    | 'media.playPause'
    | 'media.annotate'
    | 'screenCapture.chooseSession'
    | 'screenCapture.copy'
    | 'screenCapture.recording.playPause'
    | 'annotation.select' | 'annotation.arrow' | 'annotation.rectangle' | 'annotation.text' | 'annotation.blur'
    | 'annotation.undo' | 'annotation.redo'
    | 'annotation.ellipse' | 'annotation.freehand' | 'annotation.highlighter' | 'annotation.step' | 'annotation.element' | 'annotation.crop'
    | 'annotation.delete' | 'annotation.duplicate' | 'annotation.nextMark' | 'annotation.previousMark'
    | 'annotation.cropApply'
    | `annotation.nudge${'Left' | 'Right' | 'Up' | 'Down'}${'' | 'Large'}`
    | 'shell.column.toggle'
    | `session.panel.${'git' | 'review' | 'files' | 'navigation' | 'agents'}.open`
    | 'sessionList.source.toggle'
    | 'panes.main.toggle'
    | 'panes.side.toggle'
    | 'panes.arrangement.toggle'
    | 'panes.region.next'
    | 'panes.region.previous'
    | 'review.change.next'
    | 'review.change.previous'
    | 'review.change.keep'
    | 'review.change.discard'
    | 'review.change.ask'
    | 'review.file.next'
    | 'review.file.previous'
    | 'review.undo'
    | 'editor.selection.ask'
    | 'files.track.toggle'
    | 'file.blame.toggle'
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
    | 'composer.sendInterrupt'
    | 'composer.sendAlternateAfterSend'
    | 'voice.toggle'
    | 'commandPalette.open'
    | 'search.textInFiles'
    | 'search.replaceInFiles'
    | 'search.replace.apply'
    | 'search.files'
    | 'search.symbols'
    | 'find.open'
    | 'find.next'
    | 'find.previous'
    | 'mode.cycle'
    | 'permission.cycle'
    | 'permission.open'
    | 'session.model.choose'
    | 'composer.attachFile'
    | 'shortcutsHelp.open'
    | 'inbox.item.next'
    | 'inbox.item.previous'
    | 'inbox.item.open'
    | 'inbox.item.close'
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
    | 'sessionList.filter.open'
    | `sessionList.space.select${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
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
    | 'workspace.tab.closeAll'
    | 'workspace.tab.reopen'
    | `workspace.tab.select${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
    | 'terminal.jump'
    | 'terminal.toggle'
    | 'terminal.newShell'
    | 'terminal.split'
    | 'settings.open'
    | 'transcript.message.focusLast'
    | 'transcript.message.next'
    | 'transcript.message.previous'
    | 'transcript.message.exit'
    | `transcript.message.${'copy' | 'pin' | 'select' | 'fork' | 'rollback' | 'readAloud' | 'savePrompt' | 'saveDecision' | 'discuss' | 'secondOpinion' | 'makeRepeatable'}`
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
    | 'workflow.save'
    | 'files.editor.save'
    | 'files.editor.change.next'
    | 'files.editor.change.previous';

type SessionKeyboardCommandTitleKey = Extract<
    (typeof SESSION_ACTION_METADATA)[keyof typeof SESSION_ACTION_METADATA]['titleKey'],
    TranslationKeyNoParams
>;

export type KeyboardCommandSettingsTitleKey = SessionKeyboardCommandTitleKey | 'settingsKeyboard.groupApp' | Extract<
    TranslationKeyNoParams,
    | 'actionPresentation.titles.code_definition_get'
    | 'actionPresentation.titles.code_references_list'
    | 'actionPresentation.titles.code_hover_get'
    | 'actionPresentation.titles.code_diagnostics_list'
    | 'files.pane.intelligence.checkWholeProject'
    | 'actionPresentation.titles.code_restart'
    | 'files.pane.menu.renameSymbol'
    | 'files.pane.menu.quickFix'
    | `files.pane.menu.${'goToTypeDefinition' | 'goToImplementation' | 'peekReferences' | 'suggest' | 'signatureHelp' | 'formatDocument' | 'formatSelection' | 'organizeImports' | 'expandSelection' | 'shrinkSelection'}`
    | 'settingsKeyboard.commands.codeProblemNext'
    | 'settingsKeyboard.commands.codeProblemPrevious'
    | `settingsKeyboard.commands.media${'Previous' | 'Next' | 'ZoomIn' | 'ZoomOut' | 'Fit' | 'ActualSize' | 'PlayPause' | 'Annotate'}`
    | 'screenCapture.window.copy'
    | 'screenCapture.window.chooseSession'
    | `settingsKeyboard.commands.annotation${'Select' | 'Arrow' | 'Rectangle' | 'Text' | 'Blur' | 'Undo' | 'Redo' | 'Ellipse' | 'Freehand' | 'Highlighter' | 'Step' | 'Element' | 'Crop' | 'Delete' | 'Duplicate' | 'NextMark' | 'PreviousMark' | 'Nudge'}`
    | 'settingsKeyboard.commands.shellColumnToggle'
    | 'session.rightPanel.tabs.git'
    | 'files.toolbar.review'
    | 'common.files'
    | 'session.transcriptNavigation.title'
    | 'sessionWork.title'
    | 'settingsKeyboard.commands.sessionListSourceToggle'
    | 'settingsKeyboard.commands.panesMainToggle'
    | 'settingsKeyboard.commands.panesSideToggle'
    | 'settingsKeyboard.commands.panesArrangementToggle'
    | 'settingsKeyboard.commands.panesRegionNext'
    | 'settingsKeyboard.commands.panesRegionPrevious'
    | 'settingsKeyboard.commands.reviewChangeNext'
    | 'settingsKeyboard.commands.reviewChangePrevious'
    | 'settingsKeyboard.commands.reviewChangeKeep'
    | 'settingsKeyboard.commands.reviewChangeDiscard'
    | 'settingsKeyboard.commands.reviewChangeAsk'
    | 'settingsKeyboard.commands.reviewFileNext'
    | 'settingsKeyboard.commands.reviewFilePrevious'
    | 'settingsKeyboard.commands.reviewUndo'
    | 'settingsKeyboard.commands.editorSelectionAsk'
    | 'settingsKeyboard.commands.filesTrackToggle'
    | 'settingsKeyboard.commands.fileBlameToggle'
    | 'workflows.newWorkflow'
    | 'common.next'
    | 'common.previous'
    | 'common.open'
    | 'common.close'
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
    | 'settingsKeyboard.commands.composerSendInterrupt'
    | 'settingsKeyboard.commands.composerSendAlternateAfterSend'
    | 'settingsKeyboard.commands.voiceToggle'
    | 'settingsKeyboard.commands.commandPaletteOpen'
    | 'settingsKeyboard.commands.searchTextInFiles'
    | 'settingsKeyboard.commands.searchReplaceInFiles'
    | 'settingsKeyboard.commands.searchReplaceApply'
    | 'settingsKeyboard.commands.searchFiles'
    | 'settingsKeyboard.commands.searchSymbols'
    | 'settingsKeyboard.commands.findOpen'
    | 'settingsKeyboard.commands.findNext'
    | 'settingsKeyboard.commands.findPrevious'
    | 'settingsKeyboard.commands.modeCycle'
    | 'settingsKeyboard.commands.permissionCycle'
    | 'settingsKeyboard.commands.permissionOpen'
    | 'settingsKeyboard.commands.sessionModelChoose'
    | 'settingsKeyboard.commands.composerAttachFile'
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
    | 'settingsKeyboard.commands.sessionListFilterOpen'
    | `settingsKeyboard.commands.sessionListSpaceSelect${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
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
    | `settingsKeyboard.commands.transcriptMessage${'FocusLast' | 'Next' | 'Previous' | 'Exit' | 'Copy' | 'Pin' | 'Select' | 'Fork' | 'Rollback' | 'ReadAloud' | 'SavePrompt' | 'SaveDecision' | 'Discuss' | 'SecondOpinion' | 'MakeRepeatable'}`
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
    | 'settingsKeyboard.commands.filesEditorSave'
    | 'settingsKeyboard.commands.workspaceTabNew'
    | 'settingsKeyboard.commands.workspaceTabClose'
    | 'settingsKeyboard.commands.workspaceTabCloseAll'
    | 'settingsKeyboard.commands.workspaceTabReopen'
    | `settingsKeyboard.commands.workspaceTabSelect${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
    | 'settingsKeyboard.commands.terminalJump'
    | 'settingsKeyboard.commands.terminalToggle'
    | 'settingsKeyboard.commands.terminalNewShell'
    | 'settingsKeyboard.commands.terminalSplit'
>;

export type KeyboardContext = Readonly<{
    isEditableTarget: boolean;
    isComposerTarget?: boolean;
    isInteractiveTarget?: boolean;
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
    /** Catalog Actions already own their display title; do not translate an Action id. */
    settingsTitle?: string;
    /** Consume an explicitly configured chord through the existing native keyboard bridge. */
    nativeConsumable?: boolean;
    /** A registered focused editor owns these keys, independent of app-wide shortcut opt-ins. */
    singleKeyScope?: 'focused';
    allowInEditable?: boolean;
    defaultBinding?: KeybindingRule;
    defaultBindings?: readonly KeybindingRule[];
    when?: (context: KeyboardContext) => boolean;
}>;
