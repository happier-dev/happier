import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { findAllByType, findFirstByType, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from './panelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPanelCommonModuleMocks();

describe('ResizableDockedPane (web pointer drag)', () => {
    it('commits width as the user drags (resizeEdge=right)', async () => {
        const events: string[] = [];
        const onCommitWidthPx = vi.fn(() => {
            events.push('commit');
        });
        const onDragWidthPx = vi.fn((value: any) => {
            if (value === null) events.push('dragEnd');
        });

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).PointerEvent = class PointerEvent extends Event {
            clientX: number;
            constructor(type: string, init: { clientX: number }) {
                super(type);
                this.clientX = init.clientX;
            }
        };

        const { ResizableDockedPane } = await import('./ResizableDockedPane');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ResizableDockedPane
                    widthPx={320}
                    minWidthPx={200}
                    maxWidthPx={480}
                    resizeEdge="right"
                    onCommitWidthPx={onCommitWidthPx}
                    onDragWidthPx={onDragWidthPx}
                >
                    <ViewStub />
                </ResizableDockedPane>)).tree;

        const webHandle = findFirstByType(tree!, 'Pressable');
        expect(webHandle).toBeTruthy();
        expect(typeof webHandle!.props.onPressIn).toBe('function');
        expect(webHandle!.props.style?.zIndex).toBeGreaterThanOrEqual(100);

        await act(async () => {
            invokeTestInstanceHandler(webHandle!, 'onPressIn', {
                clientX: 100,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointermove', { clientX: 160 }));
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointerup', { clientX: 160 }));
        });

        expect(onCommitWidthPx).toHaveBeenCalledTimes(1);
        // dx=+60, start width=320 -> 380
        expect(onCommitWidthPx).toHaveBeenLastCalledWith(
            380,
            expect.objectContaining({
                clampedSizePx: 380,
                exceededMinPx: false,
                exceededMaxPx: false,
            })
        );
        expect(onDragWidthPx).toHaveBeenLastCalledWith(null, null);
        expect(events).toEqual(['commit', 'dragEnd']);
    });

    it('inverts delta when resizeEdge=left', async () => {
        const onCommitWidthPx = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).PointerEvent = class PointerEvent extends Event {
            clientX: number;
            constructor(type: string, init: { clientX: number }) {
                super(type);
                this.clientX = init.clientX;
            }
        };

        const { ResizableDockedPane } = await import('./ResizableDockedPane');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ResizableDockedPane
                    widthPx={360}
                    minWidthPx={200}
                    maxWidthPx={480}
                    resizeEdge="left"
                    onCommitWidthPx={onCommitWidthPx}
                >
                    <ViewStub />
                </ResizableDockedPane>)).tree;

        await act(async () => {
            const webHandle = findFirstByType(tree!, 'Pressable');
            expect(webHandle).toBeTruthy();
            invokeTestInstanceHandler(webHandle!, 'onPressIn', {
                clientX: 100,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });
        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointermove', { clientX: 150 }));
        });
        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointerup', { clientX: 150 }));
        });

        // dx=+50, left edge means delta=-50; 360-50=310
        expect(onCommitWidthPx).toHaveBeenLastCalledWith(
            310,
            expect.objectContaining({
                clampedSizePx: 310,
                exceededMinPx: false,
                exceededMaxPx: false,
            })
        );
    });

    it('falls back to locationX + target rect when clientX is unavailable', async () => {
        const onCommitWidthPx = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).PointerEvent = class PointerEvent extends Event {
            clientX: number;
            constructor(type: string, init: { clientX: number }) {
                super(type);
                this.clientX = init.clientX;
            }
        };

        const { ResizableDockedPane } = await import('./ResizableDockedPane');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ResizableDockedPane
                    widthPx={320}
                    minWidthPx={200}
                    maxWidthPx={480}
                    resizeEdge="right"
                    onCommitWidthPx={onCommitWidthPx}
                >
                    <ViewStub />
                </ResizableDockedPane>)).tree;

        await act(async () => {
            const webHandle = findFirstByType(tree!, 'Pressable');
            expect(webHandle).toBeTruthy();
            invokeTestInstanceHandler(webHandle!, 'onPressIn', {
                nativeEvent: { locationX: 5 },
                target: { getBoundingClientRect: () => ({ left: 200 }) },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointermove', { clientX: 250 }));
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointerup', { clientX: 250 }));
        });

        // startX=205, dx=45, 320+45=365
        expect(onCommitWidthPx).toHaveBeenLastCalledWith(
            365,
            expect.objectContaining({
                clampedSizePx: 365,
                exceededMinPx: false,
                exceededMaxPx: false,
            })
        );
    });

    it('falls back to locationX + currentTarget rect when clientX is unavailable', async () => {
        const onCommitWidthPx = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).PointerEvent = class PointerEvent extends Event {
            clientX: number;
            constructor(type: string, init: { clientX: number }) {
                super(type);
                this.clientX = init.clientX;
            }
        };

        const { ResizableDockedPane } = await import('./ResizableDockedPane');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ResizableDockedPane
                    widthPx={320}
                    minWidthPx={200}
                    maxWidthPx={480}
                    resizeEdge="right"
                    onCommitWidthPx={onCommitWidthPx}
                >
                    <ViewStub />
                </ResizableDockedPane>)).tree;

        await act(async () => {
            const webHandle = findFirstByType(tree!, 'Pressable');
            expect(webHandle).toBeTruthy();
            invokeTestInstanceHandler(webHandle!, 'onPressIn', {
                nativeEvent: { locationX: 5 },
                currentTarget: { getBoundingClientRect: () => ({ left: 200 }) },
                // Simulate RN Web: the event target can be a nested element that lacks a rect helper.
                target: {},
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointermove', { clientX: 250 }));
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointerup', { clientX: 250 }));
        });

        // startX=205, dx=45, 320+45=365
        expect(onCommitWidthPx).toHaveBeenLastCalledWith(
            365,
            expect.objectContaining({
                clampedSizePx: 365,
                exceededMinPx: false,
                exceededMaxPx: false,
            })
        );
    });

    it('does not render a resize handle when min/max widths are equal', async () => {
        const { ResizableDockedPane } = await import('./ResizableDockedPane');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ResizableDockedPane
                    widthPx={320}
                    minWidthPx={320}
                    maxWidthPx={320}
                    onCommitWidthPx={vi.fn()}
                >
                    <ViewStub />
                </ResizableDockedPane>)).tree;

        expect(findAllByType(tree!, 'Pressable')).toHaveLength(0);
        expect(findAllByType(tree!, 'ViewStub')).toHaveLength(1);
    });

    it('still supports dragging when the web press event lacks coordinates', async () => {
        const onCommitWidthPx = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).PointerEvent = class PointerEvent extends Event {
            clientX: number;
            constructor(type: string, init: { clientX: number }) {
                super(type);
                this.clientX = init.clientX;
            }
        };

        const { ResizableDockedPane } = await import('./ResizableDockedPane');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ResizableDockedPane
                    widthPx={320}
                    minWidthPx={200}
                    maxWidthPx={480}
                    resizeEdge="right"
                    onCommitWidthPx={onCommitWidthPx}
                >
                    <ViewStub />
                </ResizableDockedPane>)).tree;

        await act(async () => {
            const webHandle = findFirstByType(tree!, 'Pressable');
            expect(webHandle).toBeTruthy();
            // Some RN Web builds pass a press event without `clientX` / `pageX` on onPressIn.
            invokeTestInstanceHandler(webHandle!, 'onPressIn', { preventDefault: vi.fn(), stopPropagation: vi.fn() });
        });

        await act(async () => {
            // First move establishes the start X, second move creates a delta.
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointermove', { clientX: 100 }));
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointermove', { clientX: 160 }));
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointerup', { clientX: 160 }));
        });

        expect(onCommitWidthPx).toHaveBeenCalledTimes(1);
        expect(onCommitWidthPx).toHaveBeenLastCalledWith(
            380,
            expect.objectContaining({
                clampedSizePx: 380,
                exceededMinPx: false,
                exceededMaxPx: false,
            })
        );
    });

    it('reports when a single drag gesture overshoots the minimum width', async () => {
        const onCommitWidthPx = vi.fn();
        const onDragWidthPx = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).PointerEvent = class PointerEvent extends Event {
            clientX: number;
            constructor(type: string, init: { clientX: number }) {
                super(type);
                this.clientX = init.clientX;
            }
        };

        const { ResizableDockedPane } = await import('./ResizableDockedPane');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ResizableDockedPane
                    widthPx={320}
                    minWidthPx={250}
                    maxWidthPx={480}
                    resizeEdge="right"
                    onCommitWidthPx={onCommitWidthPx}
                    onDragWidthPx={onDragWidthPx}
                >
                    <ViewStub />
                </ResizableDockedPane>)).tree;

        await act(async () => {
            const webHandle = findFirstByType(tree!, 'Pressable');
            expect(webHandle).toBeTruthy();
            invokeTestInstanceHandler(webHandle!, 'onPressIn', {
                clientX: 320,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointermove', { clientX: 100 }));
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointerup', { clientX: 100 }));
        });

        expect(onDragWidthPx).toHaveBeenCalledWith(
            250,
            expect.objectContaining({
                clampedSizePx: 250,
                exceededMinPx: true,
                exceededMaxPx: false,
            })
        );
        expect(onCommitWidthPx).toHaveBeenCalledTimes(1);
        expect(onCommitWidthPx).toHaveBeenLastCalledWith(
            250,
            expect.objectContaining({
                clampedSizePx: 250,
                exceededMinPx: true,
                exceededMaxPx: false,
            })
        );
    });

    it('notifies drag end when the pane unmounts during an active drag', async () => {
        const onDragWidthPx = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).PointerEvent = class PointerEvent extends Event {
            clientX: number;
            constructor(type: string, init: { clientX: number }) {
                super(type);
                this.clientX = init.clientX;
            }
        };

        const { ResizableDockedPane } = await import('./ResizableDockedPane');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ResizableDockedPane
                    widthPx={320}
                    minWidthPx={250}
                    maxWidthPx={480}
                    resizeEdge="right"
                    onCommitWidthPx={vi.fn()}
                    onDragWidthPx={onDragWidthPx}
                >
                    <ViewStub />
                </ResizableDockedPane>)).tree;

        await act(async () => {
            const webHandle = findFirstByType(tree!, 'Pressable');
            expect(webHandle).toBeTruthy();
            invokeTestInstanceHandler(webHandle!, 'onPressIn', {
                clientX: 320,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointermove', { clientX: 100 }));
        });

        await act(async () => {
            tree.unmount();
        });

        expect(onDragWidthPx).toHaveBeenLastCalledWith(null, null);
    });
});

function ViewStub() {
    return React.createElement('ViewStub');
}
