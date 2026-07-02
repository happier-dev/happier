/**
 * Types for the `MenuTriggerExtension` — the TipTap extension that detects
 * slash-command triggers and emits caret-rect + query state.
 *
 * This file is dependency-free (NO `@tiptap/*`) so the types can be re-exported
 * from `markdownEditorTypes.ts` and consumed by the native graph (R18).
 */

/**
 * State emitted when the slash trigger is active inside the TipTap editor.
 *
 * `kind` is tagged for future extensibility (e.g. `'docLink'` | `'mention'`).
 * `caretRect` is in WebView viewport coordinates — the RN host adds the
 * WebView's `measureInWindow` offset to get screen coordinates (D20).
 */
export type MenuTriggerState = Readonly<{
    kind: 'slash';
    /** The text after the `/` (empty string if just `/` typed). */
    query: string;
    /** ProseMirror doc position of the trigger character (the slash). */
    from: number;
    /** ProseMirror doc position of the current caret. */
    to: number;
    /** Caret rect in WebView (viewport) coordinates. RN host adds WebView offset to get screen coords. */
    caretRect: { left: number; top: number; height: number };
}>;

export type MenuTriggerKey =
    | 'ArrowDown'
    | 'ArrowUp'
    | 'Enter'
    | 'Tab'
    | 'Escape';

/**
 * Key event emitted while a slash trigger is active and the TipTap editor keeps
 * DOM focus. The host owns highlighted-row state and command dispatch; the
 * extension only detects and routes the editor key.
 */
export type MenuTriggerKeyDownEvent = Readonly<{
    key: MenuTriggerKey;
    trigger: MenuTriggerState;
}>;
