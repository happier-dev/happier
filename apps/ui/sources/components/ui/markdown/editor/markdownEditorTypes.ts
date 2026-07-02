/**
 * Public contract for the unified `MarkdownEditor` surface.
 *
 * The handle shape mirrors `CodeEditorHandle` verbatim so the rich editor can
 * be dropped into the existing `useSessionFileEditorState` machinery unchanged
 * (it consumes `getValue()` + `flushPendingChange()` via an optional-chained ref).
 *
 * NOTE: this file is dependency-free (NO `@tiptap/*`) so it is safe to import
 * from the native graph (R18).
 */

// Re-export the `MenuTriggerState` type from the types-only file so all
// consumers (native + web) can import from a single location. The types file
// itself is dependency-free (no `@tiptap/*`).
export type { MenuTriggerKeyDownEvent, MenuTriggerState } from './core/tiptap/menuTriggerExtensionTypes';

/**
 * State emitted when the caret is inside a link mark (Lane H, D4).
 *
 * `href` is the active link's URL; `caretRect` is in WebView viewport
 * coordinates on native (the RN host adds the editor viewport's window
 * offset to translate to screen coordinates — D20, D40). On the web direct
 * surface, `caretRect` is already in window/viewport coordinates so no
 * translation is needed.
 *
 * Carried on its own envelope (`linkBubbleChanged`) rather than ride along on
 * `selectionState` to keep selectionState lean (D8).
 */
export type LinkBubbleState = Readonly<{
    href: string;
    caretRect: { left: number; top: number; height: number };
}>;

/**
 * Window-coordinate rectangle for the editor viewport (WebView host or web
 * editor root). Used by the RN host to translate caret rects emitted in WebView
 * viewport coordinates to screen coordinates (D20, D40).
 */
export type EditorViewportWindowRect = Readonly<{
    left: number;
    top: number;
    width: number;
    height: number;
}>;

/** Raw (markdown source) vs Rich (WYSIWYG) editing mode for a markdown file. */
export type MarkdownEditMode = 'raw' | 'rich';

/**
 * Imperative handle the editor exposes to its host (file-edit machine + toolbar).
 *
 * Identical to `CodeEditorHandle`:
 * - `getValue()` returns the current markdown synchronously (a mirror on native).
 * - `flushPendingChange()` resolves once any debounced edit has been committed
 *   to the host (always `await` it before persisting — on native it round-trips
 *   the WebView, see R5).
 */
export type MarkdownEditorHandle = Readonly<{
    getValue: () => string;
    flushPendingChange: () => Promise<void>;
}>;

/**
 * Props for the platform-resolved `MarkdownEditor`.
 *
 * Mirrors the editing-relevant subset of `CodeEditorProps`. There is NO
 * `placeholder` prop in Phase 1 (it would require `@tiptap/extension-placeholder`,
 * deferred — R-A20).
 */
export type MarkdownEditorProps = Readonly<{
    /** Bumping this remounts/reseeds the surface (mirrors `CodeEditorProps.resetKey`). */
    resetKey: string;
    /** Markdown to seed the editor with (frontmatter already stripped by the host). */
    value: string;
    /** Emits the full markdown document on debounced edits (suppressed on initial seed — R-A7). */
    onChange: (value: string) => void;
    /** Disables editing while still rendering the document. */
    readOnly?: boolean;
    /** Debounce window for `onChange`/`selectionState` (defaults applied per-surface). */
    changeDebounceMs?: number;
    /** Max chunk size for the native chunked postMessage bridge. */
    bridgeMaxChunkBytes?: number;
    /**
     * Native-only escape hatch (R-A17): on bundle/`error` failure the surface
     * hands the freshest markdown directly to the parent so it can seed raw mode
     * synchronously (a separate batched `onChange` would be unreliable).
     */
    onUnavailable?: (latestMarkdown: string) => void;
    testID?: string;
}>;

/**
 * Phase-1 formatting commands (R-A9), including the slash-formatting menu.
 * Tables/math/mermaid/images and slash-driven insert-link/image dialogs remain
 * deferred. Link creation is still primarily autolink/linkOnPaste; the link
 * bubble uses `setLink`/`unlink`/`openLink` when the caret is inside a link.
 */
export type MarkdownEditorCommand =
    | { kind: 'toggleBold' }
    | { kind: 'toggleItalic' }
    | { kind: 'toggleStrike' }
    | { kind: 'toggleCode' }
    | { kind: 'setHeading'; level: 1 | 2 | 3 }
    | { kind: 'toggleBulletList' }
    | { kind: 'toggleOrderedList' }
    | { kind: 'toggleTaskList' }
    | { kind: 'toggleBlockquote' }
    | { kind: 'toggleCodeBlock' }
    | { kind: 'setHorizontalRule' }
    | { kind: 'setLink'; href: string }
    | { kind: 'unlink' }
    | { kind: 'openLink' };

export function isMutatingMarkdownEditorCommand(command: MarkdownEditorCommand): boolean {
    return command.kind !== 'openLink';
}

/**
 * Block type the current selection sits in (drives the toolbar's active state).
 */
export type MarkdownBlockType =
    | 'paragraph'
    | 'heading1'
    | 'heading2'
    | 'heading3'
    | 'bulletList'
    | 'orderedList'
    | 'taskList'
    | 'blockquote'
    | 'codeBlock';

/**
 * Active marks/state for the current selection, emitted up to the chrome so the
 * toolbar can reflect active formatting and offer open/unlink for links (R-A18).
 */
export type MarkdownSelectionState = Readonly<{
    marks: Readonly<{
        bold: boolean;
        italic: boolean;
        strike: boolean;
        code: boolean;
    }>;
    blockType: MarkdownBlockType;
    isLinkActive: boolean;
    linkHref?: string;
    canUndo: boolean;
    canRedo: boolean;
}>;

/**
 * Platform-agnostic command/selection bridge the RN chrome talks to.
 *
 * On web this calls the live TipTap `Editor` directly; on native it posts/receives
 * bridge envelopes. Either way the chrome code is identical.
 */
export type MarkdownEditorController = Readonly<{
    /** Run a Phase-1 formatting command against the current selection. */
    runCommand: (command: MarkdownEditorCommand) => void;
    /**
     * Subscribe to selection-state changes. Returns an unsubscribe function.
     */
    subscribeSelection: (callback: (state: MarkdownSelectionState) => void) => () => void;

    // --- Lane F additions (slash trigger / menu) --------------------------------

    /**
     * Subscribe to menu-trigger state changes (slash menu). Returns an
     * unsubscribe function. The callback fires with `MenuTriggerState` when the
     * slash trigger is active, `null` when dismissed.
     *
     * Optional at the controller level: not all hosts wire the slash menu
     * (e.g. the toolbar-only controller in `RichMarkdownEditorPanel` doesn't).
     * The surfaces always provide it. Lane G wires the host integration.
     */
    subscribeMenuTrigger?: (
        callback: (state: import('./core/tiptap/menuTriggerExtensionTypes').MenuTriggerState | null) => void,
    ) => () => void;

    /**
     * Subscribe to slash-menu key events routed from the editor while the
     * contenteditable/WebView keeps focus. The callback returns true when the
     * host consumed the key (move highlight, commit, or dismiss).
     */
    subscribeMenuKeyDown?: (
        callback: (event: import('./core/tiptap/menuTriggerExtensionTypes').MenuTriggerKeyDownEvent) => boolean,
    ) => () => void;

    /**
     * Run a formatting command triggered by the slash menu. When `deleteRange`
     * is provided, the editor deletes the trigger range (`/query`) before
     * running the command — so a single undo step covers both.
     *
     * Optional at the controller level: not all hosts wire the slash menu.
     * The surfaces always provide it. Lane G wires the host integration.
     */
    runMenuCommand?: (
        command: MarkdownEditorCommand,
        deleteRange?: { from: number; to: number },
    ) => void;

    /**
     * Subscribe to editor viewport layout changes (D40). Fires whenever the
     * WebView / editor host window rect changes (e.g. keyboard animation,
     * orientation change). The RN host uses this to translate caret rects from
     * viewport coordinates to screen coordinates.
     *
     * Optional: web direct surface may no-op or report its editor-root rect.
     */
    subscribeEditorViewportLayout?: (
        callback: (rect: EditorViewportWindowRect | null) => void,
    ) => () => void;

    /**
     * One-shot measurement of the editor viewport in window coordinates (D40).
     * Resolves `null` when the surface is not mounted or measurement fails.
     *
     * Optional: web direct surface may no-op.
     */
    measureEditorViewportInWindow?: () => Promise<EditorViewportWindowRect | null>;

    // --- Lane H additions (link bubble) -----------------------------------------

    /**
     * Subscribe to link-bubble state changes (Lane H). The callback fires with
     * `LinkBubbleState` when the caret is inside a link mark and `null` when it
     * leaves. Returns an unsubscribe function.
     *
     * Optional at the controller level: not all hosts wire the link bubble.
     * The surfaces always provide it.
     */
    subscribeLinkBubble?: (
        callback: (state: LinkBubbleState | null) => void,
    ) => () => void;
}>;
