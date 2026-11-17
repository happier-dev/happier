import type { Ref } from 'react';
import type { FindOptions, FindStatus } from '../find/findTypes.js';

export type CodeEditorFindTarget = Readonly<{ line: number; column?: number }>;
export type CodeEditorFindSnapshot = Readonly<{ query: string; options: FindOptions; status: FindStatus }>;
export type CodeEditorFindHandle = Readonly<{
    /** Monaco owns its widget; CodeMirror uses the host's shared bar. */
    presentation: 'native' | 'shared';
    /** Reveal/focus Find without replacing query state owned by the engine. */
    open: () => void;
    seed: (query: string, options: FindOptions, target?: CodeEditorFindTarget) => void;
    set: (query: string, options: FindOptions) => void;
    step: (direction: 1 | -1) => void;
    close: () => void;
    getSnapshot: () => CodeEditorFindSnapshot;
    subscribe: (listener: () => void) => () => void;
    containsFocus: () => boolean;
    isOpen: () => boolean;
    isInputFocused: () => boolean;
}>;

export const CODE_EDITOR_LANGUAGE_COMMANDS = ['suggest', 'acceptCompletion', 'signatureHelp', 'format', 'formatSelection', 'organizeImports', 'expandSelection', 'shrinkSelection', 'peekReferences'] as const;
export type CodeEditorLanguageCommand = typeof CODE_EDITOR_LANGUAGE_COMMANDS[number];
export type CodeEditorCommand = 'indent' | 'outdent' | 'undo' | 'redo' | 'moveLeft' | 'moveRight' | 'nextChange' | 'prevChange' | 'find' | CodeEditorLanguageCommand
    | 'inlineSuggestAccept' | 'inlineSuggestAcceptWord' | 'inlineSuggestDismiss' | 'inlineSuggestTrigger'
    | Readonly<{ insert: string }> | Readonly<{ replaceDocument: string; history?: 'undo' | 'redo' }>;
export type CodeEditorHistory = Readonly<{ canUndo: boolean; canRedo: boolean }>;
/** The document owns undo; engines translate commands and text without owning a second stack. */
export type EditorDocumentHistory = Readonly<{
    getSnapshot(): CodeEditorHistory;
    subscribe(listener: (state: CodeEditorHistory) => void): () => void;
    undo(value: string): string | null;
    redo(value: string): string | null;
}>;
export type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type EditorDecorationLayer = 'change' | 'diagnostic' | 'blame';
/** Lines are 1-based; characters are 0-based UTF-16 offsets. */
export type EditorDecoration =
    | Readonly<{ layer?: 'change'; id: string; key: string; kind: 'added' | 'modified' | 'deleted'; startLine: number; endLine: number; removedLines?: readonly string[]; anchor?: 'before' | 'after' }>
    | Readonly<{ layer?: 'diagnostic'; id: string; severity: 'error' | 'warning' | 'information' | 'hint'; startLine: number; startCharacter: number; endLine: number; endCharacter: number; message: string; code?: string | number; source?: string }>
    /** `tone`: the run's recency, as the View column's edge bar (newer half `recent`); the engines draw it as the run's bar. */
    | Readonly<{ layer?: 'blame'; id: string; startLine: number; lineCount: number; runId: string; tone?: EditorBlameTone }>;
export type EditorBlameTone = 'recent' | 'older';
export type CodeEditorDocumentChange = Readonly<{ history: 'undo' | 'redo' }>;
/** Ordered, zero-based UTF-16 offsets in the original document; equal offsets denote a caret. */
export type CodeEditorSelectionRange = Readonly<{ start: number; end: number }>;
/** Lines are 1-based; characters and document offsets are 0-based UTF-16 code units. */
export type CodeEditorCompletionPosition = Readonly<{ offset: number; line: number; character: number; explicit: boolean }>;
export type CodeEditorCompletionItem = Readonly<{
    label: string;
    insertText?: string;
    detail?: string;
    /** Omit to replace the engine's current word. */
    range?: CodeEditorSelectionRange;
}>;
export type CodeEditorCompletionSource = Readonly<{
    triggerCharacters?: readonly string[];
    complete(position: CodeEditorCompletionPosition, signal: AbortSignal): Promise<readonly CodeEditorCompletionItem[] | null>;
}>;

/** Engine facts only; policy and model requests belong to the shared intelligence controller. */
export type CodeEditorInlineContext = Readonly<{
    line: number; character: number; offset: number; version: number;
    eol?: '\n' | '\r\n' | '\r';
    selectionCount: number; hasSelection: boolean; composing: boolean; suggestWidgetOpen: boolean;
}>;
export type CodeEditorInlineSuggestion = Readonly<{ id: string; text: string; line: number; character: number }>;
export type CodeEditorInlineEvent = Readonly<{
    kind: 'shown' | 'accepted' | 'partiallyAccepted' | 'dismissed' | 'trigger';
    id?: string;
    /** Local controller bookkeeping only; never emitted as telemetry. */
    acceptedText?: string;
}>;
export type CodeEditorInlineSuggestions = Readonly<{
    set: (suggestion: CodeEditorInlineSuggestion | null) => void;
    getSuggestion: () => CodeEditorInlineSuggestion | null;
    getContext: () => CodeEditorInlineContext | null;
    subscribeContext: (listener: () => void) => () => void;
    onEvent: (listener: (event: CodeEditorInlineEvent) => void) => () => void;
    /** Called synchronously immediately before an engine edit. Unbound suggestions cannot be accepted. */
    setAcceptGuard: (guard: ((id: string) => boolean) | null) => void;
}>;

export type CodeEditorProps = Readonly<{
    resetKey: string;
    value: string;
    language: string | null;
    onChange: (value: string, change?: CodeEditorDocumentChange) => void;
    onSelection?: (range: CodeEditorSelectionRange | null) => void;
    completionSource?: CodeEditorCompletionSource;
    history?: EditorDocumentHistory;
    testID?: string;
    readOnly?: boolean;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    changeDebounceMs?: number;
    bridgeMaxChunkBytes?: number;
    onReady?: () => void;
    initialLine?: number;
    lineNumberDigits?: number;
    reviewLaneWidth?: number;
    /**
     * `framed` (default): a bordered inset box, as an editor inside a section. `canvas`: a whole document's
     * source that is the page itself (an Artifact's Markdown): no frame, on the page's own surface.
     */
    presentation?: 'framed' | 'canvas';
    /** Inset of the first line and of the numbers, as the code view's own `contentPadding*` (the page canvas inset). */
    contentPaddingHorizontal?: number;
    contentPaddingVertical?: number;
}>;

export type CodeEditorHandle = Readonly<{
    getValue: () => string;
    /** Publishes confirmed current bytes; rejects if unconfirmed, so callers must retain the outgoing surface. */
    flushPendingChange: () => Promise<void>;
    /** Move editing focus into the incumbent platform surface. */
    focus?: () => void;
    find?: CodeEditorFindHandle;
    inlineSuggestions?: CodeEditorInlineSuggestions;
    /** `top` keeps a reading position instead of centring: that line sits `offset` px below the editor's top edge. */
    revealLine: (line: number, opts?: { focus?: boolean; select?: boolean; behavior?: 'smooth' | 'instant'; top?: Readonly<{ line: number; offset: number }> }) => void;
    runCommand: (command: CodeEditorCommand) => void;
    subscribeHistory: (listener: (state: CodeEditorHistory) => void) => () => void;
    setDecorations: (layer: EditorDecorationLayer, items: readonly EditorDecoration[]) => void;
    /** Retire one tracked item without reseeding the other engine-mapped ranges. */
    removeDecoration: (layer: EditorDecorationLayer, id: string) => void;
    onDecorationPress: (cb: (layer: EditorDecorationLayer, item: EditorDecoration) => void) => () => void;
    /** `collapsed` is a caret: Ask still asks about its line, but no selection toolbar is raised. */
    getSelection?: () => { startLine: number; endLine: number; text: string; rect: Rect | null; collapsed?: boolean; range: CodeEditorSelectionRange } | null;
    subscribeSelection?: (listener: () => void) => () => void;
    getLineRect?: (line: number) => Rect | null;
    /** Where a text position sits (1-based line, 0-based UTF-16 character), in window coordinates; null off screen. */
    getPositionRect?: (line: number, character: number) => Rect | null;
    /**
     * Room in the text for the host's change peek (ade-shell ED3 E1): the lines after `afterLine` (0 = above the
     * first line) move down by `height`, and a newly opened room scrolls just enough to show whole, from the line's
     * first column. When the change from `firstLine` is taller than the editor, the room opens under the last of its
     * lines in view instead. `null` closes it. `getPeekZoneRect` is where the room is, in window coordinates.
     */
    setPeekZone?: (zone: Readonly<{ afterLine: number; firstLine?: number; height: number }> | null) => void;
    getPeekZoneRect?: () => Rect | null;
    onPointerPosition?: (cb: (position: { line: number; character: number; rect: Rect } | null) => void) => () => void;
    onActivatePosition?: (cb: (position: { line: number; character: number }) => void) => () => void;
    getCursorPosition?: () => { line: number; character: number } | null;
    formatDocument?: () => Promise<void>;
}>;


export type HappierCodeEditorRequest = CodeEditorProps & Readonly<{ editorRef?: Ref<CodeEditorHandle> }>;
