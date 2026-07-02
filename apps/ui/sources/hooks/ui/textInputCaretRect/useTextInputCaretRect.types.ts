import type * as React from 'react';

/**
 * A caret rectangle in window-relative (native) / viewport-relative (web) coordinates.
 * Used by Popover rect-anchor mode to position menus at the cursor.
 */
export type CaretRect = Readonly<{
    left: number;
    top: number;
    height: number;
}>;

/**
 * Narrow measurement/identity handle that MultiTextInput exposes (Lane A0 / D33).
 * The caret-rect hook consumes this interface — never reaches into platform internals.
 */
export type TextInputCaretRectHandle = Readonly<{
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
    getReactNodeTag: () => number | null;
    getInputElement: () => HTMLTextAreaElement | null;
}>;

/**
 * Input for useTextInputCaretRect.
 */
export type UseTextInputCaretRectInput = Readonly<{
    /** Ref to the narrow measurement/identity handle exposed by MultiTextInput. */
    inputRef: React.RefObject<TextInputCaretRectHandle | null>;
    /** Web-only: the current selection (rendered cursor index in the value). Native ignores. */
    selection?: { start: number; end: number };
    /** When false, the hook returns null and releases native/web tracking. */
    enabled?: boolean;
}>;
