import { describe, expect, it, vi } from 'vitest';

import { createSelectionListKeyPressHandler } from '../SelectionListKeyboardInput';
import type { SelectionListKeyboardNavApi } from '../useSelectionListKeyboardNav';

/**
 * R14 — unit coverage for the per-event key dispatch extracted from the
 * orchestrator. The handler is the bridge between the raw rn-web /
 * native input event and the pure `useSelectionListKeyboardNav.handleKey`
 * dispatcher. It owns the IME composition guard, the stale-closure
 * "compositionend → Enter" bypass, and the Escape-to-close escalation when
 * the stack is at root with an empty input.
 */
describe('SelectionListKeyboardInput (R14 extracted)', () => {
    function makeKeyboardStub(consumed: boolean): SelectionListKeyboardNavApi {
        return {
            focusedIndex: 0,
            setFocusedIndex: vi.fn(),
            handleKey: vi.fn(() => consumed),
            handleEscape: vi.fn(() => 'close' as const),
        };
    }

    it('returns silently when the event has no key string', () => {
        const keyboard = makeKeyboardStub(false);
        const handler = createSelectionListKeyPressHandler({
            keyboard,
            isComposing: false,
            focusedOptionId: null,
            onActivate: vi.fn(),
            canPopStep: false,
            inputValue: '',
            onRequestClose: vi.fn(),
        });
        handler({} as never);
        expect(keyboard.handleKey).not.toHaveBeenCalled();
    });

    it('does NOT dispatch Enter while the event reports composing=true (IME guard)', () => {
        const keyboard = makeKeyboardStub(false);
        const onActivate = vi.fn();
        const handler = createSelectionListKeyPressHandler({
            keyboard,
            isComposing: false,
            focusedOptionId: 'opt',
            onActivate,
            canPopStep: false,
            inputValue: '',
            onRequestClose: vi.fn(),
        });
        handler({ key: 'Enter', isComposing: true });
        expect(keyboard.handleKey).not.toHaveBeenCalled();
        expect(onActivate).not.toHaveBeenCalled();
    });

    it('honors the stale-closure bypass when event=composing-false but state=composing-true and key is Enter on a focused option', () => {
        const keyboard = makeKeyboardStub(false);
        const onActivate = vi.fn();
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        const handler = createSelectionListKeyPressHandler({
            keyboard,
            isComposing: true,
            focusedOptionId: 'opt-42',
            onActivate,
            canPopStep: false,
            inputValue: '',
            onRequestClose: vi.fn(),
        });
        handler({ key: 'Enter', isComposing: false, preventDefault, stopPropagation });
        expect(onActivate).toHaveBeenCalledWith('opt-42');
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(stopPropagation).toHaveBeenCalledTimes(1);
        // Does NOT also delegate to the hook for the same keystroke.
        expect(keyboard.handleKey).not.toHaveBeenCalled();
    });

    it('delegates non-composing keystrokes to the hook with normalised modifiers', () => {
        const keyboard = makeKeyboardStub(true);
        const handler = createSelectionListKeyPressHandler({
            keyboard,
            isComposing: false,
            focusedOptionId: null,
            onActivate: vi.fn(),
            canPopStep: false,
            inputValue: '',
            onRequestClose: vi.fn(),
        });
        handler({ key: 'ArrowDown', metaKey: true, shiftKey: true });
        expect(keyboard.handleKey).toHaveBeenCalledTimes(1);
        const dispatched = (keyboard.handleKey as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
            key: string;
            metaKey: boolean;
            ctrlKey: boolean;
            shiftKey: boolean;
        };
        expect(dispatched.key).toBe('ArrowDown');
        expect(dispatched.metaKey).toBe(true);
        expect(dispatched.ctrlKey).toBe(false);
        expect(dispatched.shiftKey).toBe(true);
    });

    it('escalates to onRequestClose when Escape is consumed AND stack is at root AND input is empty', () => {
        const keyboard = makeKeyboardStub(true);
        const onRequestClose = vi.fn();
        const handler = createSelectionListKeyPressHandler({
            keyboard,
            isComposing: false,
            focusedOptionId: null,
            onActivate: vi.fn(),
            canPopStep: false,
            inputValue: '',
            onRequestClose,
        });
        handler({ key: 'Escape' });
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });

    it('does NOT escalate Escape to onRequestClose while the stack can still pop', () => {
        const keyboard = makeKeyboardStub(true);
        const onRequestClose = vi.fn();
        const handler = createSelectionListKeyPressHandler({
            keyboard,
            isComposing: false,
            focusedOptionId: null,
            onActivate: vi.fn(),
            canPopStep: true,
            inputValue: '',
            onRequestClose,
        });
        handler({ key: 'Escape' });
        expect(onRequestClose).not.toHaveBeenCalled();
    });

    it('does NOT escalate Escape to onRequestClose while the input still has a value to clear', () => {
        const keyboard = makeKeyboardStub(true);
        const onRequestClose = vi.fn();
        const handler = createSelectionListKeyPressHandler({
            keyboard,
            isComposing: false,
            focusedOptionId: null,
            onActivate: vi.fn(),
            canPopStep: false,
            inputValue: 'pending',
            onRequestClose,
        });
        handler({ key: 'Escape' });
        expect(onRequestClose).not.toHaveBeenCalled();
    });

    it('FR3-7: dispatches Shift+Tab to the hook even while the event reports composing=true (IME-exempt)', () => {
        // Shift+Tab does not commit text, so the IME guard must NOT block it.
        // The composing-suppressed list is Enter / Tab / Backspace / ArrowRight.
        const keyboard = makeKeyboardStub(true);
        const handler = createSelectionListKeyPressHandler({
            keyboard,
            isComposing: false,
            focusedOptionId: null,
            onActivate: vi.fn(),
            canPopStep: true,
            inputValue: '~/Documents',
            onRequestClose: vi.fn(),
        });
        handler({ key: 'Tab', shiftKey: true, isComposing: true });
        expect(keyboard.handleKey).toHaveBeenCalledTimes(1);
        const dispatched = (keyboard.handleKey as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
            key: string;
            shiftKey: boolean;
        };
        expect(dispatched.key).toBe('Tab');
        expect(dispatched.shiftKey).toBe(true);
    });

    it('FR3-7: plain Tab remains suppressed while composing (IME owns autocomplete-acceptance keys)', () => {
        const keyboard = makeKeyboardStub(false);
        const handler = createSelectionListKeyPressHandler({
            keyboard,
            isComposing: false,
            focusedOptionId: null,
            onActivate: vi.fn(),
            canPopStep: false,
            inputValue: '',
            onRequestClose: vi.fn(),
        });
        handler({ key: 'Tab', shiftKey: false, isComposing: true });
        expect(keyboard.handleKey).not.toHaveBeenCalled();
    });

    it('reads the key from nativeEvent when the synthetic top-level key is undefined', () => {
        const keyboard = makeKeyboardStub(true);
        const handler = createSelectionListKeyPressHandler({
            keyboard,
            isComposing: false,
            focusedOptionId: null,
            onActivate: vi.fn(),
            canPopStep: false,
            inputValue: '',
            onRequestClose: vi.fn(),
        });
        handler({ nativeEvent: { key: 'ArrowUp', metaKey: true } });
        expect(keyboard.handleKey).toHaveBeenCalledTimes(1);
        const dispatched = (keyboard.handleKey as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
            key: string;
            metaKey: boolean;
        };
        expect(dispatched.key).toBe('ArrowUp');
        expect(dispatched.metaKey).toBe(true);
    });
});
