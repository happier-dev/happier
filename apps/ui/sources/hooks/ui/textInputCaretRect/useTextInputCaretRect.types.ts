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
    /**
     * The input's own content scroll offset. Required on both platforms because the
     * native caret payload is content-relative: without it the caret anchor drifts
     * down by the scroll amount once the composer clamps at max height.
     */
    getScrollOffset: () => Readonly<{ x: number; y: number }>;
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
    /**
     * Whether a consumer currently needs the rect (defaults to true). Web measures — a forced
     * mirror-div layout that grows with the text — only while `enabled && demanded`, in a layout
     * effect, so the commit that turns demand on already paints with the caret rect. Native
     * ignores it: its selection subscription stays focus-scoped (D38) because the trigger
     * keystroke's selection event arrives before the consumer knows it needs the rect.
     */
    demanded?: boolean;
}>;
