import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findAllByType, findFirstByType, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from './panelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPanelCommonModuleMocks();
afterEach(() => vi.unstubAllGlobals());

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

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
        expect(flattenStyle(webHandle!.props.style).zIndex).toBeGreaterThanOrEqual(100);

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

    it('places the resize handle on the pane edge it resizes in reading and focus order', async () => {
        // A modal's initial focus lands on its first focusable element: the handle of a leading pane
        // (resized at its trailing edge) must not come before that pane's own content.
        const { ResizableDockedPane } = await import('./ResizableDockedPane');
        const order = async (resizeEdge: 'left' | 'right') => {
            const tree = (await renderScreen(
                <ResizableDockedPane widthPx={320} minWidthPx={200} maxWidthPx={480} resizeEdge={resizeEdge} onCommitWidthPx={vi.fn()}>
                    <ViewStub />
                </ResizableDockedPane>,
            )).tree;
            const kind = (node: { type: unknown }) => node.type === 'Pressable' ? 'handle' : node.type === 'ViewStub' ? 'content' : null;
            return tree.root.findAll((node) => kind(node) !== null, { deep: true }).map((node) => kind(node));
        };

        expect(await order('right')).toEqual(['content', 'handle']);
        expect(await order('left')).toEqual(['handle', 'content']);
    });

    it('stands for the landmark its host names, so its own resize handle sits inside that landmark', async () => {
        // C77: the column's "Resize panel" slider sat beside the navigation landmark, outside every landmark.
        const { ResizableDockedPane } = await import('./ResizableDockedPane');
        const screen = await renderScreen(
            <ResizableDockedPane testID="pane" widthPx={320} minWidthPx={200} maxWidthPx={480} resizeEdge="right"
                onCommitWidthPx={vi.fn()} landmark={{ role: 'navigation', label: 'Navigation column' }}>
                <ViewStub />
            </ResizableDockedPane>,
        );
        const pane = screen.findHostByTestId('pane')!;
        expect([pane.props.role, pane.props['aria-label']]).toEqual(['navigation', 'Navigation column']);
        expect(pane.findAll(node => node.type === 'Pressable')).toHaveLength(1);
    });

    it('paints the pane above the neighbour its handle\'s target reaches into', async () => {
        // The handle's web target reaches past the pane edge, over the neighbour (the page beside the
        // settings rail). The neighbour comes later and would paint over that part unless the pane is lifted.
        const { ResizableDockedPane } = await import('./ResizableDockedPane');
        const pane = async (resizable: boolean) => {
            const screen = await renderScreen(
                <ResizableDockedPane testID="pane" widthPx={320} minWidthPx={200} maxWidthPx={resizable ? 480 : 200}
                    resizeEdge="right" onCommitWidthPx={vi.fn()}>
                    <ViewStub />
                </ResizableDockedPane>,
            );
            return Number(flattenStyle(screen.findHostByTestId('pane')!.props.style).zIndex ?? 0);
        };
        expect(await pane(true)).toBeGreaterThan(0);
        expect(await pane(false)).toBe(0);
    });

    it('renders the shared column resize handle frame for docked panes', async () => {
        const { ResizableDockedPane } = await import('./ResizableDockedPane');

        const tree = (await renderScreen(
            <ResizableDockedPane
                widthPx={320}
                minWidthPx={200}
                maxWidthPx={480}
                resizeEdge="right"
                onCommitWidthPx={vi.fn()}
            >
                <ViewStub />
            </ResizableDockedPane>,
        )).tree;

        const webHandle = findFirstByType(tree, 'Pressable');
        expect(webHandle).toBeTruthy();
        if (!webHandle) {
            throw new Error('expected resizable docked pane handle');
        }
        expect(webHandle.findAllByType('View')).toHaveLength(0);
        expect(flattenStyle(webHandle.props.style)).toEqual(expect.objectContaining({
            width: 10,
            cursor: 'col-resize',
        }));
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
        let frame: FrameRequestCallback | undefined;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1; });
        vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined; });

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

        expect(frame).toBeDefined();
        await act(async () => { frame?.(0); });

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
