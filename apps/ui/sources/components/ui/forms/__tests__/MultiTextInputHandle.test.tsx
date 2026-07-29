/**
 * MultiTextInputHandle — Lane A0 tests.
 *
 * Verifies the measurement/identity helpers added to `MultiTextInputHandle`
 * on both the native and web platform files.
 *
 * Native tests use `react-test-renderer` with `createNodeMock` to provide a
 * mock TextInput instance that exposes `measureInWindow`, `focus`, `blur`, and
 * `setNativeProps`.
 *
 * Web tests import `MultiTextInput.web.tsx` directly and exercise the web
 * handle implementation. Because vitest runs in a Node environment (no real
 * DOM layout), `getBoundingClientRect` returns zeros — we assert only that the
 * callback is invoked with four numeric arguments (pixel correctness is
 * validated by e2e tests per D39).
 */

import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

vi.mock('@/components/ui/text/Text', async () => {
    const ReactRuntime = await import('react');
    const { TextInput } = await import('react-native');
    return {
        TextInput: (props: React.ComponentProps<typeof TextInput>) => ReactRuntime.createElement(TextInput, props),
    };
});

// ---------------------------------------------------------------------------
// Native tests
// ---------------------------------------------------------------------------

describe('MultiTextInputHandle (native)', () => {
    // We need to mock findNodeHandle to return a deterministic tag
    const MOCK_NODE_TAG = 42;
    const findNodeHandleMock = vi.fn(() => MOCK_NODE_TAG);

    beforeEach(() => {
        vi.doMock('react-native', async (importOriginal) => {
            const original = await importOriginal<Record<string, unknown>>();
            return {
                ...original,
                findNodeHandle: findNodeHandleMock,
            };
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
    });

    async function renderNativeWithHandle() {
        // Dynamic import so mocks apply
        const { MultiTextInput } = await import('../MultiTextInput');
        type Handle = import('../MultiTextInput').MultiTextInputHandle;

        const ref = React.createRef<Handle>();

        const mockMeasureInWindow = vi.fn((cb: (x: number, y: number, w: number, h: number) => void) => {
            cb(10, 20, 300, 40);
        });
        const mockFocus = vi.fn();
        const mockBlur = vi.fn();
        const mockSetNativeProps = vi.fn();

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(MultiTextInput, {
                    ref,
                    value: 'hello',
                    onChangeText: () => {},
                } as any),
                {
                    createNodeMock: () => ({
                        measureInWindow: mockMeasureInWindow,
                        focus: mockFocus,
                        blur: mockBlur,
                        setNativeProps: mockSetNativeProps,
                    }),
                },
            );
        });

        return { ref, tree: tree!, mockMeasureInWindow, mockFocus, mockBlur, findNodeHandleMock };
    }

    it('measureInWindow calls the underlying TextInput measureInWindow with 4 numeric arguments', async () => {
        const { ref, mockMeasureInWindow } = await renderNativeWithHandle();
        expect(ref.current).toBeTruthy();

        const cb = vi.fn();
        ref.current!.measureInWindow(cb);

        expect(mockMeasureInWindow).toHaveBeenCalledOnce();
        expect(cb).toHaveBeenCalledOnce();
        expect(cb).toHaveBeenCalledWith(10, 20, 300, 40);
        // Verify all args are numbers
        const [x, y, w, h] = cb.mock.calls[0];
        expect(typeof x).toBe('number');
        expect(typeof y).toBe('number');
        expect(typeof w).toBe('number');
        expect(typeof h).toBe('number');
    });

    it('getReactNodeTag returns the findNodeHandle result', async () => {
        const { ref } = await renderNativeWithHandle();
        expect(ref.current).toBeTruthy();

        const tag = ref.current!.getReactNodeTag();
        expect(tag).toBe(MOCK_NODE_TAG);
        expect(typeof tag).toBe('number');
    });

    it('getInputElement returns null on native', async () => {
        const { ref } = await renderNativeWithHandle();
        expect(ref.current).toBeTruthy();
        expect(ref.current!.getInputElement()).toBeNull();
    });

    it('backwards-compat: focus and blur still work', async () => {
        const { ref, mockFocus, mockBlur } = await renderNativeWithHandle();
        expect(ref.current).toBeTruthy();

        ref.current!.focus();
        expect(mockFocus).toHaveBeenCalledOnce();

        ref.current!.blur();
        expect(mockBlur).toHaveBeenCalledOnce();
    });

    it('backwards-compat: setTextAndSelection still works', async () => {
        const { ref } = await renderNativeWithHandle();
        expect(ref.current).toBeTruthy();

        // Should not throw
        await act(async () => {
            ref.current!.setTextAndSelection('test', { start: 0, end: 4 });
        });
    });
});

// ---------------------------------------------------------------------------
// Web tests
// ---------------------------------------------------------------------------

describe('MultiTextInputHandle (web)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
    });

    async function renderWebWithHandle() {
        // Import the web variant directly
        const { MultiTextInput } = await import('../MultiTextInput.web');
        type Handle = import('../MultiTextInput.web').MultiTextInputHandle;

        const ref = React.createRef<Handle>();

        // In node env, we need to provide a mock textarea via createNodeMock.
        // The web MultiTextInput renders a raw <textarea>.
        const mockTextarea = {
            focus: vi.fn(),
            blur: vi.fn(),
            value: 'hello',
            selectionStart: 0,
            selectionEnd: 0,
            setSelectionRange: vi.fn(),
            dispatchEvent: vi.fn(),
            style: {} as any,
            scrollHeight: 30,
            getBoundingClientRect: vi.fn(() => ({
                left: 5,
                top: 15,
                width: 200,
                height: 30,
                right: 205,
                bottom: 45,
                x: 5,
                y: 15,
                toJSON: () => {},
            })),
            // Mark it as an HTMLTextAreaElement for type checking
            tagName: 'TEXTAREA',
            nodeName: 'TEXTAREA',
        };

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(MultiTextInput, {
                    ref,
                    value: 'hello',
                    onChangeText: () => {},
                } as any),
                {
                    createNodeMock: (element: any) => {
                        // The web file renders a raw <textarea>
                        if (element.type === 'textarea') {
                            return mockTextarea;
                        }
                        return null;
                    },
                },
            );
        });

        return { ref, tree: tree!, mockTextarea };
    }

    it('measureInWindow fires callback with 4 numeric arguments from getBoundingClientRect', async () => {
        const { ref, mockTextarea } = await renderWebWithHandle();
        expect(ref.current).toBeTruthy();

        const cb = vi.fn();
        ref.current!.measureInWindow(cb);

        expect(mockTextarea.getBoundingClientRect).toHaveBeenCalledOnce();
        expect(cb).toHaveBeenCalledOnce();
        // Should use viewport/client coordinates from getBoundingClientRect (D47: no scrollX/Y addition)
        expect(cb).toHaveBeenCalledWith(5, 15, 200, 30);
        // All args are numbers
        const [x, y, w, h] = cb.mock.calls[0];
        expect(typeof x).toBe('number');
        expect(typeof y).toBe('number');
        expect(typeof w).toBe('number');
        expect(typeof h).toBe('number');
    });

    it('getReactNodeTag returns null on web', async () => {
        const { ref } = await renderWebWithHandle();
        expect(ref.current).toBeTruthy();
        expect(ref.current!.getReactNodeTag()).toBeNull();
    });

    it('getInputElement returns the textarea element', async () => {
        const { ref, mockTextarea } = await renderWebWithHandle();
        expect(ref.current).toBeTruthy();

        const element = ref.current!.getInputElement();
        expect(element).toBe(mockTextarea);
    });

    it('backwards-compat: focus and blur still work', async () => {
        const { ref, mockTextarea } = await renderWebWithHandle();
        expect(ref.current).toBeTruthy();

        ref.current!.focus();
        expect(mockTextarea.focus).toHaveBeenCalledOnce();

        ref.current!.blur();
        expect(mockTextarea.blur).toHaveBeenCalledOnce();
    });

    it('backwards-compat: setTextAndSelection still work', async () => {
        const { ref } = await renderWebWithHandle();
        expect(ref.current).toBeTruthy();

        // Should not throw
        await act(async () => {
            ref.current!.setTextAndSelection('test', { start: 0, end: 4 });
        });
    });
});

// ---------------------------------------------------------------------------
// Web setSelection — stale-caller staleness guard (native parity)
// ---------------------------------------------------------------------------

describe('MultiTextInput web setSelection staleness guard', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
    });

    async function renderWebWithHandle(value: string) {
        const { MultiTextInput } = await import('../MultiTextInput.web');
        type Handle = import('../MultiTextInput.web').MultiTextInputHandle;

        const ref = React.createRef<Handle>();
        const onSelectionChange = vi.fn();
        const onStateChange = vi.fn();
        const mockTextarea = {
            focus: vi.fn(),
            blur: vi.fn(),
            value,
            selectionStart: value.length,
            selectionEnd: value.length,
            setSelectionRange: vi.fn(),
            dispatchEvent: vi.fn(),
            style: {} as Record<string, string>,
            scrollHeight: 30,
            getBoundingClientRect: vi.fn(() => ({
                left: 0, top: 0, width: 200, height: 30, right: 200, bottom: 30, x: 0, y: 0,
                toJSON: () => {},
            })),
            tagName: 'TEXTAREA',
            nodeName: 'TEXTAREA',
        };

        await act(async () => {
            renderer.create(
                React.createElement(MultiTextInput, {
                    ref,
                    value,
                    onChangeText: () => {},
                    onSelectionChange,
                    onStateChange,
                } as any),
                {
                    createNodeMock: (element: any) => (element.type === 'textarea' ? mockTextarea : null),
                },
            );
        });

        return { ref, mockTextarea, onSelectionChange, onStateChange };
    }

    /**
     * Live incident (web composer, 2026-07-22): a selection-restore effect fired
     * while the user was typing, carrying a caret position computed against a
     * text snapshot 20-100 characters behind the live textarea. The web handle
     * applied it unconditionally and dragged the user's caret backwards
     * mid-typing. Native already refuses selections whose basis text is stale
     * (`latestNativeTextRef.current !== value`); web must apply the same rule.
     */
    it('drops a selection whose basis is stale (live text ahead of the controlled value)', async () => {
        const { ref, mockTextarea, onSelectionChange, onStateChange } = await renderWebWithHandle('hello');

        // The user typed ahead of the last controlled value round-trip.
        mockTextarea.value = 'hello world';

        ref.current!.setSelection({ start: 2, end: 2 });

        expect(mockTextarea.setSelectionRange).not.toHaveBeenCalled();
        expect(onSelectionChange).not.toHaveBeenCalled();
        expect(onStateChange).not.toHaveBeenCalled();
    });

    it('applies a selection when the live text matches the controlled value', async () => {
        const { ref, mockTextarea, onSelectionChange } = await renderWebWithHandle('hello');

        ref.current!.setSelection({ start: 2, end: 4 });

        expect(mockTextarea.setSelectionRange).toHaveBeenCalledWith(2, 4);
        expect(onSelectionChange).toHaveBeenCalledWith({ start: 2, end: 4 });
    });
});

// ---------------------------------------------------------------------------
// Web autosize measurement — layout-bleed containment
// ---------------------------------------------------------------------------

describe('MultiTextInput web autosize measurement', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
    });

    /**
     * Live capture 2026-07-20 (web): the collapse-to-measure autosize pass set the
     * textarea to `height:auto` and read `scrollHeight`, forcing a synchronous reflow
     * in which the composer row shrank to its collapsed height. The transcript's flex
     * sibling grew by the freed pixels for that reflow, and the browser natively
     * clamped its scrollTop (a 102px tail jump per keystroke/composer scroll event —
     * the typing flicker). The wrapper must be pixel-locked for the whole window in
     * which the textarea's height is non-explicit, so the measurement reflow can
     * never move flex siblings; they only ever see the final measured height.
     */
    it('locks the wrapper height while collapse-measuring so the reflow cannot move flex siblings', async () => {
        const { MultiTextInput } = await import('../MultiTextInput.web');

        let textareaHeight = '';
        let wrapperHeight = '';
        const measurements: Array<{ textareaHeight: string; wrapperHeight: string }> = [];

        const wrapperStyle = {} as Record<string, string>;
        Object.defineProperty(wrapperStyle, 'height', {
            get: () => wrapperHeight,
            set: (value: string) => { wrapperHeight = value; },
        });
        const parentElement = {
            offsetHeight: 120,
            style: wrapperStyle,
        };

        const textareaStyle = {} as Record<string, string>;
        Object.defineProperty(textareaStyle, 'height', {
            get: () => textareaHeight,
            set: (value: string) => { textareaHeight = value; },
        });

        const mockTextarea = {
            focus: vi.fn(),
            blur: vi.fn(),
            value: 'hello',
            selectionStart: 0,
            selectionEnd: 0,
            setSelectionRange: vi.fn(),
            dispatchEvent: vi.fn(),
            style: textareaStyle,
            parentElement,
            get scrollHeight() {
                // The forced-reflow moment: whatever layout state exists here is what
                // flex siblings experience.
                measurements.push({ textareaHeight, wrapperHeight });
                return 96;
            },
            getBoundingClientRect: vi.fn(() => ({
                left: 0, top: 0, width: 200, height: 30, right: 200, bottom: 30, x: 0, y: 0,
                toJSON: () => {},
            })),
            tagName: 'TEXTAREA',
            nodeName: 'TEXTAREA',
        };

        await act(async () => {
            renderer.create(
                React.createElement(MultiTextInput, {
                    value: 'hello',
                    onChangeText: () => {},
                } as any),
                {
                    createNodeMock: (element: any) => (element.type === 'textarea' ? mockTextarea : null),
                },
            );
        });

        expect(measurements.length).toBeGreaterThan(0);
        for (const measurement of measurements) {
            if (measurement.textareaHeight === 'auto') {
                expect(measurement.wrapperHeight).toMatch(/^\d+px$/);
            }
        }
        // The lock is measurement-scoped: once the pass settles, the wrapper's own
        // height is back to its pre-measurement value and the textarea is explicit.
        expect(wrapperHeight).toBe('');
        expect(textareaHeight).toMatch(/^\d+px$/);
    });
});
