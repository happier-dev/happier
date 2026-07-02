import * as React from 'react';
import { useFocusedInputHandler } from 'react-native-keyboard-controller';
import { runOnJS } from 'react-native-reanimated';

import type {
    CaretRect,
    UseTextInputCaretRectInput,
} from './useTextInputCaretRect.types';

export type { CaretRect, TextInputCaretRectHandle, UseTextInputCaretRectInput } from './useTextInputCaretRect.types';

/** Minimum caret height fallback (single cursor with no measurable span). */
const MIN_CARET_HEIGHT = 16;

/**
 * Pure, unit-testable math: transforms input-local selection coordinates
 * into a window-relative CaretRect using the input's window offset.
 */
export function computeNativeCaretRect(
    inputOffset: Readonly<{ x: number; y: number }>,
    selection: Readonly<{
        start: Readonly<{ x: number; y: number }>;
        end: Readonly<{ x: number; y: number }>;
    }>,
): CaretRect {
    const rawHeight = selection.end.y - selection.start.y;
    return {
        left: inputOffset.x + selection.start.x,
        top: inputOffset.y + selection.start.y,
        height: Math.max(MIN_CARET_HEIGHT, rawHeight),
    };
}

/**
 * Cross-platform caret-rect hook (native implementation).
 *
 * Uses `react-native-keyboard-controller`'s `useFocusedInputHandler` to track
 * selection changes on the focused TextInput, then adds the input's
 * `measureInWindow` offset to produce window-relative coordinates.
 *
 * Returns `null` while disabled, before the first event, or when no input is focused.
 */
export function useTextInputCaretRect(input: UseTextInputCaretRectInput): CaretRect | null {
    const { inputRef, enabled = true } = input;

    const [rect, setRect] = React.useState<CaretRect | null>(null);

    // Generation counter to guard against stale async measureInWindow callbacks.
    const generationRef = React.useRef(0);

    // Callback that runs on the JS thread (forwarded from the worklet via runOnJS).
    const forwardEvent = React.useCallback(
        (
            target: number,
            selection: Readonly<{
                start: Readonly<{ x: number; y: number }>;
                end: Readonly<{ x: number; y: number }>;
            }>,
        ) => {
            const handle = inputRef.current;
            if (handle == null) return;

            // Multi-input filter (D37): only respond to events from our input.
            const nodeTag = handle.getReactNodeTag();
            if (nodeTag == null || target !== nodeTag) return;

            // Capture the current generation before the async call.
            const gen = generationRef.current;

            handle.measureInWindow((ax, ay, _w, _h) => {
                // Stale callback guard: if generation has changed, discard.
                if (gen !== generationRef.current) return;

                setRect(computeNativeCaretRect(
                    { x: ax, y: ay },
                    selection,
                ));
            });
        },
        [inputRef],
    );

    // Register or deregister the selection handler based on enabled state (D38).
    // When disabled, pass an empty handler map so the hook releases its subscription.
    useFocusedInputHandler(
        enabled
            ? {
                onSelectionChange: (e) => {
                    'worklet';
                    runOnJS(forwardEvent)(e.target, e.selection);
                },
            }
            : {},
        [enabled, forwardEvent],
    );

    // When disabled or unmounted, clear cached rect and bump generation.
    React.useEffect(() => {
        if (!enabled) {
            generationRef.current += 1;
            setRect(null);
        }

        return () => {
            generationRef.current += 1;
        };
    }, [enabled]);

    // Return null while disabled or before first event (D17).
    if (!enabled) return null;

    return rect;
}
