import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';

import { TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT } from '@/components/ui/forms/largeTextInputPolicy';
import type { TextInputCaretRectHandle } from '../useTextInputCaretRect.types';

/**
 * Mock textarea-caret to return known stub values (D39: no jsdom layout dependency).
 * The real textarea-caret is Playwright-validated in Lane I.
 */
const mockedGetCaretCoordinates = vi.fn(() => ({ top: 20, left: 30, height: 18 }));

vi.mock('textarea-caret', () => ({
    default: mockedGetCaretCoordinates,
}));

/**
 * Creates a minimal mock that satisfies the HTMLTextAreaElement shape the hook needs,
 * without requiring a real DOM environment (runs in node, not jsdom).
 */
function createMockTextarea(overrides?: {
    scrollLeft?: number;
    scrollTop?: number;
    value?: string;
    boundingRect?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
}): HTMLTextAreaElement {
    const scrollListeners: Array<EventListenerOrEventListenerObject> = [];

    const mock = {
        getBoundingClientRect: vi.fn(() => ({
            left: overrides?.boundingRect?.left ?? 100,
            top: overrides?.boundingRect?.top ?? 200,
            right: overrides?.boundingRect?.right ?? 400,
            bottom: overrides?.boundingRect?.bottom ?? 300,
            width: overrides?.boundingRect?.width ?? 300,
            height: overrides?.boundingRect?.height ?? 100,
            x: overrides?.boundingRect?.left ?? 100,
            y: overrides?.boundingRect?.top ?? 200,
            toJSON: () => ({}),
        })),
        scrollLeft: overrides?.scrollLeft ?? 0,
        scrollTop: overrides?.scrollTop ?? 0,
        value: overrides?.value ?? '',
        addEventListener: vi.fn((event: string, handler: EventListenerOrEventListenerObject) => {
            if (event === 'scroll') scrollListeners.push(handler);
        }),
        removeEventListener: vi.fn((event: string, handler: EventListenerOrEventListenerObject) => {
            if (event === 'scroll') {
                const idx = scrollListeners.indexOf(handler);
                if (idx >= 0) scrollListeners.splice(idx, 1);
            }
        }),
        // Simulate scroll events for testing.
        _triggerScroll: () => {
            for (const listener of scrollListeners) {
                if (typeof listener === 'function') listener(new Event('scroll'));
                else listener.handleEvent(new Event('scroll'));
            }
        },
    };

    // Cast to HTMLTextAreaElement since our mock only implements the subset the hook uses.
    return mock as unknown as HTMLTextAreaElement;
}

function createMockHandle(
    textarea: HTMLTextAreaElement | null = createMockTextarea(),
): TextInputCaretRectHandle {
    return {
        measureInWindow: vi.fn((cb) => cb(100, 200, 300, 100)),
        getReactNodeTag: () => null,
        getInputElement: () => textarea,
        getScrollOffset: () => ({ x: textarea?.scrollLeft ?? 0, y: textarea?.scrollTop ?? 0 }),
    };
}

function createInputRef(handle: TextInputCaretRectHandle | null = createMockHandle()) {
    return { current: handle };
}

describe('useTextInputCaretRect (web)', () => {
    beforeEach(() => {
        standardCleanup();
        mockedGetCaretCoordinates.mockClear();
        mockedGetCaretCoordinates.mockReturnValue({ top: 20, left: 30, height: 18 });
    });

    it('returns a computed CaretRect from textarea-caret output', async () => {
        const textarea = createMockTextarea();
        const inputRef = createInputRef(createMockHandle(textarea));
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');

        const hook = await renderHook(() =>
            useTextInputCaretRect({
                inputRef,
                selection: { start: 5, end: 5 },
                enabled: true,
            }),
        );

        // computeWebCaretRect: elRect(100,200) + caret(30,20) - scroll(0,0)
        expect(hook.getCurrent()).toEqual({
            left: 130,
            top: 220,
            height: 18,
        });
    });

    it('calls getCaretCoordinates with the textarea element and selection.start', async () => {
        const textarea = createMockTextarea();
        const inputRef = createInputRef(createMockHandle(textarea));
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');

        await renderHook(() =>
            useTextInputCaretRect({
                inputRef,
                selection: { start: 7, end: 7 },
                enabled: true,
            }),
        );

        expect(mockedGetCaretCoordinates).toHaveBeenCalledWith(textarea, 7);
    });

    it('measures caret position for oversized textarea values when enabled', async () => {
        const textarea = createMockTextarea();
        const inputRef = createInputRef(createMockHandle(textarea));
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');
        const caretPosition = TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1;

        const hook = await renderHook(() =>
            useTextInputCaretRect({
                inputRef,
                selection: { start: caretPosition, end: caretPosition },
                enabled: true,
            }),
        );

        expect(hook.getCurrent()).toEqual({
            left: 130,
            top: 220,
            height: 18,
        });
        expect(mockedGetCaretCoordinates).toHaveBeenCalledWith(textarea, caretPosition);
    });

    it('measures caret when the DOM textarea is oversized even if React passes a render-safe value projection', async () => {
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');
        const caretPosition = TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1;
        const textarea = createMockTextarea({ value: 'x'.repeat(caretPosition) });
        const inputRef = createInputRef(createMockHandle(textarea));

        const hook = await renderHook(() =>
            useTextInputCaretRect({
                inputRef,
                selection: { start: caretPosition, end: caretPosition },
                enabled: true,
            }),
        );

        expect(hook.getCurrent()).toEqual({
            left: 130,
            top: 220,
            height: 18,
        });
        expect(mockedGetCaretCoordinates).toHaveBeenCalledWith(textarea, caretPosition);
    });

    it('returns null when enabled is false', async () => {
        const inputRef = createInputRef();
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');

        const hook = await renderHook(() =>
            useTextInputCaretRect({
                inputRef,
                selection: { start: 0, end: 0 },
                enabled: false,
            }),
        );

        expect(hook.getCurrent()).toBeNull();
    });

    it('returns null when ref is null', async () => {
        const inputRef = createInputRef(null);
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');

        const hook = await renderHook(() =>
            useTextInputCaretRect({
                inputRef,
                selection: { start: 0, end: 0 },
                enabled: true,
            }),
        );

        expect(hook.getCurrent()).toBeNull();
    });

    it('returns null when getInputElement returns null', async () => {
        const mockHandle = createMockHandle(null);
        const inputRef = createInputRef(mockHandle);
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');

        const hook = await renderHook(() =>
            useTextInputCaretRect({
                inputRef,
                selection: { start: 0, end: 0 },
                enabled: true,
            }),
        );

        expect(hook.getCurrent()).toBeNull();
    });

    it('recomputes when selection changes', async () => {
        const textarea = createMockTextarea();
        const inputRef = createInputRef(createMockHandle(textarea));

        mockedGetCaretCoordinates
            .mockReturnValueOnce({ top: 20, left: 30, height: 18 })
            .mockReturnValueOnce({ top: 20, left: 80, height: 18 });

        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');

        const hook = await renderHook(
            (props: { start: number }) =>
                useTextInputCaretRect({
                    inputRef,
                    selection: { start: props.start, end: props.start },
                    enabled: true,
                }),
            { initialProps: { start: 5 } },
        );

        expect(hook.getCurrent()?.left).toBe(130);

        await hook.rerender({ start: 10 });

        expect(hook.getCurrent()?.left).toBe(180);
    });

    it('clears rect when enabled transitions to false', async () => {
        const textarea = createMockTextarea();
        const inputRef = createInputRef(createMockHandle(textarea));
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');

        const hook = await renderHook(
            (props: { enabled: boolean }) =>
                useTextInputCaretRect({
                    inputRef,
                    selection: { start: 5, end: 5 },
                    enabled: props.enabled,
                }),
            { initialProps: { enabled: true } },
        );

        expect(hook.getCurrent()).not.toBeNull();

        await hook.rerender({ enabled: false });

        expect(hook.getCurrent()).toBeNull();
    });

    it('removes scroll listener on unmount', async () => {
        const textarea = createMockTextarea();
        const inputRef = createInputRef(createMockHandle(textarea));
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');

        const hook = await renderHook(() =>
            useTextInputCaretRect({
                inputRef,
                selection: { start: 0, end: 0 },
                enabled: true,
            }),
        );

        await hook.unmount();

        expect(textarea.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
    });

    it('removes scroll listener when disabled', async () => {
        const textarea = createMockTextarea();
        const inputRef = createInputRef(createMockHandle(textarea));
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');

        const hook = await renderHook(
            (props: { enabled: boolean }) =>
                useTextInputCaretRect({
                    inputRef,
                    selection: { start: 0, end: 0 },
                    enabled: props.enabled,
                }),
            { initialProps: { enabled: true } },
        );

        await hook.rerender({ enabled: false });

        expect(textarea.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
    });

    it('accounts for textarea scroll offset in computation', async () => {
        const textarea = createMockTextarea({ scrollTop: 15, scrollLeft: 5 });

        mockedGetCaretCoordinates.mockReturnValue({ top: 50, left: 40, height: 18 });

        const inputRef = createInputRef(createMockHandle(textarea));
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');

        const hook = await renderHook(() =>
            useTextInputCaretRect({
                inputRef,
                selection: { start: 10, end: 10 },
                enabled: true,
            }),
        );

        // elRect(100,200) + caret(40,50) - scroll(5,15)
        expect(hook.getCurrent()).toEqual({
            left: 135,
            top: 235,
            height: 18,
        });
    });

    it('does not measure the caret while no consumer demands the rect', async () => {
        const textarea = createMockTextarea();
        const inputRef = createInputRef(createMockHandle(textarea));
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');

        const hook = await renderHook(
            (props: { start: number }) =>
                useTextInputCaretRect({
                    inputRef,
                    selection: { start: props.start, end: props.start },
                    enabled: true,
                    demanded: false,
                }),
            { initialProps: { start: 1 } },
        );
        await hook.rerender({ start: 2 });

        expect(hook.getCurrent()).toBeNull();
        expect(mockedGetCaretCoordinates).not.toHaveBeenCalled();
        expect(textarea.addEventListener).not.toHaveBeenCalled();
    });

    it('measures in the layout phase of the commit that turns demand on, before paint', async () => {
        const textarea = createMockTextarea();
        const inputRef = createInputRef(createMockHandle(textarea));
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');
        const phases: string[] = [];
        mockedGetCaretCoordinates.mockImplementation(() => {
            phases.push('measure');
            return { top: 20, left: 30, height: 18 };
        });

        const hook = await renderHook(
            (props: { demanded: boolean }) => {
                const rect = useTextInputCaretRect({
                    inputRef,
                    selection: { start: 4, end: 4 },
                    enabled: true,
                    demanded: props.demanded,
                });
                // Declared after the hook: runs after its layout effect in the same commit.
                React.useLayoutEffect(() => {
                    phases.push('layout');
                });
                React.useEffect(() => {
                    phases.push('passive');
                });
                return rect;
            },
            { initialProps: { demanded: false } },
        );
        phases.length = 0;

        await hook.rerender({ demanded: true });

        expect(phases.slice(0, 2)).toEqual(['measure', 'layout']);
        expect(hook.getCurrent()).toEqual({ left: 130, top: 220, height: 18 });
    });

    it('keeps the rect identity when a remeasure yields the same geometry', async () => {
        const textarea = createMockTextarea();
        const inputRef = createInputRef(createMockHandle(textarea));
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');
        let renders = 0;

        const hook = await renderHook(
            (props: { start: number }) => {
                renders += 1;
                return useTextInputCaretRect({
                    inputRef,
                    selection: { start: props.start, end: props.start },
                    enabled: true,
                });
            },
            { initialProps: { start: 5 } },
        );
        const first = hook.getCurrent();
        const rendersBefore = renders;

        // e.g. a character typed over a selection leaves the caret on the same pixel.
        await hook.rerender({ start: 6 });

        expect(mockedGetCaretCoordinates).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent()).toBe(first);
        // Only the caller's own rerender: an equal measurement must not schedule another render.
        expect(renders - rendersBefore).toBe(1);
    });

    it('subscribes to textarea scroll once per demanded period, not once per caret move', async () => {
        const textarea = createMockTextarea();
        const inputRef = createInputRef(createMockHandle(textarea));
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');

        const hook = await renderHook(
            (props: { start: number }) =>
                useTextInputCaretRect({
                    inputRef,
                    selection: { start: props.start, end: props.start },
                    enabled: true,
                }),
            { initialProps: { start: 1 } },
        );
        await hook.rerender({ start: 2 });
        await hook.rerender({ start: 3 });

        expect(textarea.addEventListener).toHaveBeenCalledTimes(1);

        // Scrolling remeasures against the latest caret position.
        mockedGetCaretCoordinates.mockClear();
        (textarea as unknown as { _triggerScroll: () => void })._triggerScroll();
        expect(mockedGetCaretCoordinates).toHaveBeenCalledWith(textarea, 3);
    });

    it('defaults enabled to true when not specified', async () => {
        const textarea = createMockTextarea();
        const inputRef = createInputRef(createMockHandle(textarea));
        const { useTextInputCaretRect } = await import('../useTextInputCaretRect.web');

        const hook = await renderHook(() =>
            useTextInputCaretRect({
                inputRef,
                selection: { start: 0, end: 0 },
            }),
        );

        // Should compute a rect (enabled defaults to true)
        expect(hook.getCurrent()).not.toBeNull();
    });
});
