import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';

import type { TextInputCaretRectHandle } from '../useTextInputCaretRect.types';

type SelectionEvent = {
    target: number;
    selection: {
        start: { x: number; y: number; position: number };
        end: { x: number; y: number; position: number };
    };
};

type HandlerMap = {
    onSelectionChange?: (e: SelectionEvent) => void;
};

/**
 * We capture the handler map that the hook registers with useFocusedInputHandler
 * so we can simulate selection events in tests.
 */
let capturedHandler: HandlerMap = {};

vi.mock('react-native-keyboard-controller', () => ({
    useFocusedInputHandler: vi.fn((handlers: HandlerMap) => {
        capturedHandler = handlers;
    }),
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    KeyboardProvider: ({ children }: { children: unknown }) => children,
    useKeyboardState: () => ({ height: 0, isVisible: false, progress: 0 }),
}));

function createMockHandle(overrides?: Partial<TextInputCaretRectHandle>): TextInputCaretRectHandle {
    return {
        measureInWindow: overrides?.measureInWindow ?? vi.fn((cb) => cb(100, 200, 300, 100)),
        getReactNodeTag: overrides?.getReactNodeTag ?? (() => 42),
        getInputElement: overrides?.getInputElement ?? (() => null),
    };
}

function createInputRef(handle: TextInputCaretRectHandle | null = createMockHandle()) {
    return { current: handle };
}

describe('useTextInputCaretRect (native)', () => {
    beforeEach(() => {
        standardCleanup();
        capturedHandler = {};
    });

    it('returns null before any selection event', async () => {
        const inputRef = createInputRef();
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.native');

        const hook = await renderHook(() =>
            useTextInputCaretRect({ inputRef, enabled: true }),
        );

        expect(hook.getCurrent()).toBeNull();
    });

    it('returns a CaretRect after a selection event fires', async () => {
        const inputRef = createInputRef();
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.native');

        const hook = await renderHook(() =>
            useTextInputCaretRect({ inputRef, enabled: true }),
        );

        // Simulate a selection event from keyboard-controller (wrapped in act for state update)
        await act(async () => {
            capturedHandler.onSelectionChange?.({
                target: 42,
                selection: {
                    start: { x: 50, y: 10, position: 5 },
                    end: { x: 50, y: 10, position: 5 },
                },
            });
        });

        expect(hook.getCurrent()).toEqual({
            left: 150,
            top: 210,
            height: 16,
        });
    });

    it('filters events from different inputs (D37: multi-input filter)', async () => {
        const inputRef = createInputRef();
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.native');

        const hook = await renderHook(() =>
            useTextInputCaretRect({ inputRef, enabled: true }),
        );

        // Event from a different input (target 999, our tag is 42)
        await act(async () => {
            capturedHandler.onSelectionChange?.({
                target: 999,
                selection: {
                    start: { x: 50, y: 10, position: 5 },
                    end: { x: 50, y: 10, position: 5 },
                },
            });
        });

        expect(hook.getCurrent()).toBeNull();
    });

    it('returns null when enabled is false', async () => {
        const inputRef = createInputRef();
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.native');

        const hook = await renderHook(() =>
            useTextInputCaretRect({ inputRef, enabled: false }),
        );

        expect(hook.getCurrent()).toBeNull();
    });

    it('registers empty handler map when disabled (D38)', async () => {
        const inputRef = createInputRef();
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.native');

        await renderHook(() =>
            useTextInputCaretRect({ inputRef, enabled: false }),
        );

        // When disabled, handler map should be empty (no onSelectionChange)
        expect(capturedHandler.onSelectionChange).toBeUndefined();
    });

    it('registers onSelectionChange when enabled', async () => {
        const inputRef = createInputRef();
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.native');

        await renderHook(() =>
            useTextInputCaretRect({ inputRef, enabled: true }),
        );

        expect(capturedHandler.onSelectionChange).toBeDefined();
    });

    it('clears rect when enabled transitions from true to false', async () => {
        const inputRef = createInputRef();
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.native');

        const hook = await renderHook(
            (props: { enabled: boolean }) =>
                useTextInputCaretRect({ inputRef, enabled: props.enabled }),
            { initialProps: { enabled: true } },
        );

        // Fire a selection event while enabled
        await act(async () => {
            capturedHandler.onSelectionChange?.({
                target: 42,
                selection: {
                    start: { x: 50, y: 10, position: 5 },
                    end: { x: 50, y: 10, position: 5 },
                },
            });
        });

        expect(hook.getCurrent()).not.toBeNull();

        // Disable
        await hook.rerender({ enabled: false });

        expect(hook.getCurrent()).toBeNull();
    });

    it('does not update state from stale measureInWindow callback after disable', async () => {
        let pendingCallback: ((x: number, y: number, w: number, h: number) => void) | null = null;
        const mockHandle = createMockHandle({
            measureInWindow: vi.fn((cb) => {
                // Store the callback instead of calling it immediately
                pendingCallback = cb;
            }),
        });
        const inputRef = createInputRef(mockHandle);
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.native');

        const hook = await renderHook(
            (props: { enabled: boolean }) =>
                useTextInputCaretRect({ inputRef, enabled: props.enabled }),
            { initialProps: { enabled: true } },
        );

        // Fire event (callback is now pending, not yet executed)
        await act(async () => {
            capturedHandler.onSelectionChange?.({
                target: 42,
                selection: {
                    start: { x: 50, y: 10, position: 5 },
                    end: { x: 50, y: 10, position: 5 },
                },
            });
        });

        // Disable before the callback fires (bumps generation)
        await hook.rerender({ enabled: false });

        // Now execute the stale callback
        await act(async () => {
            pendingCallback?.(100, 200, 300, 100);
        });

        // Should still be null (stale callback was ignored)
        expect(hook.getCurrent()).toBeNull();
    });

    it('ignores event when handle ref is null', async () => {
        const inputRef = createInputRef(null);
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.native');

        const hook = await renderHook(() =>
            useTextInputCaretRect({ inputRef, enabled: true }),
        );

        await act(async () => {
            capturedHandler.onSelectionChange?.({
                target: 42,
                selection: {
                    start: { x: 50, y: 10, position: 5 },
                    end: { x: 50, y: 10, position: 5 },
                },
            });
        });

        expect(hook.getCurrent()).toBeNull();
    });

    it('ignores event when getReactNodeTag returns null', async () => {
        const mockHandle = createMockHandle({
            getReactNodeTag: () => null,
        });
        const inputRef = createInputRef(mockHandle);
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.native');

        const hook = await renderHook(() =>
            useTextInputCaretRect({ inputRef, enabled: true }),
        );

        await act(async () => {
            capturedHandler.onSelectionChange?.({
                target: 42,
                selection: {
                    start: { x: 50, y: 10, position: 5 },
                    end: { x: 50, y: 10, position: 5 },
                },
            });
        });

        expect(hook.getCurrent()).toBeNull();
    });

    it('defaults enabled to true when not provided', async () => {
        const inputRef = createInputRef();
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.native');

        await renderHook(() =>
            useTextInputCaretRect({ inputRef }),
        );

        // Should have registered an onSelectionChange handler
        expect(capturedHandler.onSelectionChange).toBeDefined();
    });
});
