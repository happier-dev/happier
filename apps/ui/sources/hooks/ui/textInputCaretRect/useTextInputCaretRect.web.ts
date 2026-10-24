import * as React from 'react';
import getCaretCoordinates from 'textarea-caret';

import type {
    CaretRect,
    UseTextInputCaretRectInput,
} from './useTextInputCaretRect.types';

export type { CaretRect, TextInputCaretRectHandle, UseTextInputCaretRectInput } from './useTextInputCaretRect.types';

/**
 * Pure, unit-testable math: transforms textarea-local caret coordinates
 * into viewport-relative coordinates using the element's bounding rect
 * and scroll offsets.
 *
 * Per D47: uses viewport/client coordinates (no window.scrollX/Y addition).
 * Per D39: this is the jsdom-safe test target; real textarea-caret is Playwright-validated.
 */
export function computeWebCaretRect(
    elRect: Readonly<{ left: number; top: number }>,
    elScroll: Readonly<{ left: number; top: number }>,
    caret: Readonly<{ left: number; top: number; height: number }>,
): CaretRect {
    return {
        left: elRect.left + caret.left - elScroll.left,
        top: elRect.top + caret.top - elScroll.top,
        height: caret.height,
    };
}

function isSameCaretRect(a: CaretRect, b: CaretRect): boolean {
    return a.left === b.left && a.top === b.top && a.height === b.height;
}

/**
 * Cross-platform caret-rect hook (web implementation).
 *
 * Uses `textarea-caret` to measure caret position in a `<textarea>` element,
 * then transforms to viewport-relative coordinates.
 *
 * Returns `null` while disabled or undemanded, before first measurement, or when
 * the textarea ref is unavailable.
 */
export function useTextInputCaretRect(input: UseTextInputCaretRectInput): CaretRect | null {
    const { inputRef, selection, enabled = true, demanded = true } = input;
    const active = enabled && demanded;
    const selectionStart = selection?.start ?? 0;

    const [rect, setRect] = React.useState<CaretRect | null>(null);
    const selectionStartRef = React.useRef(selectionStart);

    const measure = React.useCallback((el: HTMLTextAreaElement) => {
        const caretCoords = getCaretCoordinates(el, selectionStartRef.current);
        const elRect = el.getBoundingClientRect();
        const next = computeWebCaretRect(
            { left: elRect.left, top: elRect.top },
            { left: el.scrollLeft, top: el.scrollTop },
            caretCoords,
        );
        // Equal geometry keeps the previous identity so the consumer does not re-render.
        setRect((previous) => (previous !== null && isSameCaretRect(previous, next) ? previous : next));
    }, []);

    // Layout phase: the update is flushed synchronously before paint, so the commit that
    // turns demand on (or moves the caret) never paints a menu anchored to a stale rect.
    React.useLayoutEffect(() => {
        selectionStartRef.current = selectionStart;
        if (!active) {
            setRect(null);
            return;
        }
        const el = inputRef.current?.getInputElement();
        if (el == null) {
            setRect(null);
            return;
        }
        measure(el);
    }, [active, inputRef, measure, selectionStart]);

    // Scroll tracking (D18): one listener per demanded period; it reads the latest caret
    // position from the ref instead of resubscribing on every caret move.
    React.useEffect(() => {
        if (!active) return;
        const el = inputRef.current?.getInputElement();
        if (el == null) return;
        const handleScroll = () => measure(el);
        el.addEventListener('scroll', handleScroll);
        return () => {
            el.removeEventListener('scroll', handleScroll);
        };
    }, [active, inputRef, measure]);

    if (!active) return null;

    return rect;
}
