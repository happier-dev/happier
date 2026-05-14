/**
 * R14 — `SelectionListKeyboardInput` extraction.
 *
 * Wraps the per-event keyboard dispatch the orchestrator hands to the search
 * header's `<TextInput onKeyPress>`. Owns the IME composition guard (web/native
 * shape normalisation), the stale-closure bypass for "compositionend → Enter",
 * and the Escape-to-close branch when the step stack is at the root and the
 * input is empty.
 *
 * The handler delegates the canonical key dispatch to
 * `useSelectionListKeyboardNav`'s `keyboard.handleKey`. Everything in this
 * module is the orchestrator-side bridge between the raw input event and the
 * hook's pure dispatcher.
 */

import type { SelectionListKeyboardNavApi } from './useSelectionListKeyboardNav';

/**
 * Loose shape used by both web (`KeyboardEvent`-like via rn-web's
 * `onKeyPress`) and native (`NativeSyntheticEvent<TextInputKeyPressEventData>`).
 * Modeled here as a type (no `any`) so we can share one handler for both
 * platforms without losing type safety.
 */
export type SelectionListKeyPressEvent = {
    key?: string;
    isComposing?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    preventDefault?: () => void;
    stopPropagation?: () => void;
    nativeEvent?: {
        key?: string;
        isComposing?: boolean;
        metaKey?: boolean;
        ctrlKey?: boolean;
        shiftKey?: boolean;
    };
};

export type SelectionListKeyPressHandlerArgs = Readonly<{
    keyboard: SelectionListKeyboardNavApi;
    isComposing: boolean;
    focusedOptionId: string | null;
    onActivate: (optionId: string) => void;
    canPopStep: boolean;
    inputValue: string;
    onRequestClose: () => void;
}>;

/**
 * Build the per-event key handler the orchestrator wires into the search
 * header's `<TextInput onKeyPress>`.
 *
 * Steps (in order):
 *   1. Normalise the key from `event.key` / `event.nativeEvent.key`. Bail
 *      silently when the event has no key string.
 *   2. Trust the event's `isComposing` flag for THIS keystroke (state lags
 *      events by one render). When composing, the IME owns Enter / Tab /
 *      Backspace / ArrowRight — return early without dispatching to the hook.
 *   3. Stale-closure guard: when the event says composing=false but the
 *      mirrored React state still says true, Enter on a focused row would be
 *      refused by the hook. Override locally for the canonical activation
 *      path so a quick "compositionend → Enter" is not dropped on the floor.
 *   4. Delegate everything else to `keyboard.handleKey`.
 *   5. When the dispatch consumed an Escape AND the stack is at root with an
 *      empty input, escalate to `onRequestClose`.
 */
export function createSelectionListKeyPressHandler(
    args: SelectionListKeyPressHandlerArgs,
): (event: SelectionListKeyPressEvent) => void {
    const {
        keyboard,
        isComposing,
        focusedOptionId,
        onActivate,
        canPopStep,
        inputValue,
        onRequestClose,
    } = args;
    return (event: SelectionListKeyPressEvent) => {
        // RN web TextInput passes `nativeEvent.key`. Native passes a similar shape.
        const nativeKey = event?.nativeEvent?.key ?? event?.key;
        if (typeof nativeKey !== 'string') return;
        // Trust the event's composing flag for THIS keystroke. Web sets
        // `event.isComposing` on the synthetic KeyboardEvent; rn-web forwards
        // the same on `nativeEvent.isComposing`. State (and the captured
        // `keyboard` closure) lag the event by one render, so we short-circuit
        // IME-suppressed keys here BEFORE delegating to the hook.
        const eventComposing = Boolean(
            event?.isComposing ?? event?.nativeEvent?.isComposing,
        );
        if (eventComposing) {
            // Mirrors the hook's IME guard — Enter / plain Tab / Backspace /
            // ArrowRight are NOT consumed while composing so the IME machinery
            // can process them (text commit, autocomplete acceptance, segment
            // walk-up).
            //
            // FR3-7: Shift+Tab is EXEMPT from the IME guard because it does
            // NOT commit text. It is reserved for the back/up shortcut and
            // must remain available while CJK/IME composition is in progress.
            // We let the dispatcher decide whether to consume it (pop step /
            // walk up the input) or let it fall through to native traversal.
            const shiftHeld = Boolean(event?.shiftKey ?? event?.nativeEvent?.shiftKey);
            const isShiftTab = nativeKey === 'Tab' && shiftHeld;
            if (
                !isShiftTab
                && (
                    nativeKey === 'Enter'
                    || nativeKey === 'Tab'
                    || nativeKey === 'Backspace'
                    || nativeKey === 'ArrowRight'
                )
            ) {
                return;
            }
        }
        // Stale-closure guard: if the event says composing=false but state
        // (and the captured `keyboard` closure) still says true, the hook
        // would refuse to consume Enter/Tab/etc. Override locally for the
        // canonical activation path so a quick "compositionend → Enter"
        // sequence isn't dropped on the floor.
        if (
            !eventComposing
            && isComposing
            && nativeKey === 'Enter'
            && focusedOptionId !== null
        ) {
            onActivate(focusedOptionId);
            event?.preventDefault?.();
            event?.stopPropagation?.();
            return;
        }
        const consumed = keyboard.handleKey({
            key: nativeKey,
            metaKey: Boolean(event?.metaKey ?? event?.nativeEvent?.metaKey),
            ctrlKey: Boolean(event?.ctrlKey ?? event?.nativeEvent?.ctrlKey),
            shiftKey: Boolean(event?.shiftKey ?? event?.nativeEvent?.shiftKey),
            preventDefault: () => event?.preventDefault?.(),
            stopPropagation: () => event?.stopPropagation?.(),
        });
        if (consumed && nativeKey === 'Escape') {
            if (!canPopStep && inputValue.length === 0) {
                onRequestClose();
            }
        }
    };
}
