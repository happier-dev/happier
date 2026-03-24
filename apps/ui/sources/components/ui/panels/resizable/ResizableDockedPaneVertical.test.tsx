import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { findFirstByType, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '../panelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPanelCommonModuleMocks();

describe('ResizableDockedPaneVertical (web pointer drag)', () => {
    it('commits height as the user drags (resizeEdge=bottom)', async () => {
        const onCommitHeightPx = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).PointerEvent = class PointerEvent extends Event {
            clientY: number;
            constructor(type: string, init: { clientY: number }) {
                super(type);
                this.clientY = init.clientY;
            }
        };

        const { ResizableDockedPaneVertical } = await import('./ResizableDockedPaneVertical');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ResizableDockedPaneVertical
                    heightPx={320}
                    minHeightPx={200}
                    maxHeightPx={480}
                    resizeEdge="bottom"
                    onCommitHeightPx={onCommitHeightPx}
                >
                    <ViewStub />
                </ResizableDockedPaneVertical>)).tree;

        const webHandle = findFirstByType(tree!, 'Pressable');
        await act(async () => {
            invokeTestInstanceHandler(webHandle, 'onPressIn', {
                clientY: 100,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointermove', { clientY: 160 }));
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointerup', { clientY: 160 }));
        });

        expect(onCommitHeightPx).toHaveBeenCalledTimes(1);
        // dy=+60, start height=320 -> 380
        expect(onCommitHeightPx).toHaveBeenLastCalledWith(
            380,
            expect.objectContaining({
                attemptedSizePx: 380,
                clampedSizePx: 380,
                exceededMinPx: false,
                exceededMaxPx: false,
            }),
        );
    });

    it('inverts delta when resizeEdge=top', async () => {
        const onCommitHeightPx = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).PointerEvent = class PointerEvent extends Event {
            clientY: number;
            constructor(type: string, init: { clientY: number }) {
                super(type);
                this.clientY = init.clientY;
            }
        };

        const { ResizableDockedPaneVertical } = await import('./ResizableDockedPaneVertical');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ResizableDockedPaneVertical
                    heightPx={360}
                    minHeightPx={200}
                    maxHeightPx={480}
                    resizeEdge="top"
                    onCommitHeightPx={onCommitHeightPx}
                >
                    <ViewStub />
                </ResizableDockedPaneVertical>)).tree;

        const webHandle = findFirstByType(tree!, 'Pressable');
        await act(async () => {
            invokeTestInstanceHandler(webHandle, 'onPressIn', {
                clientY: 100,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });
        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointermove', { clientY: 150 }));
        });
        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointerup', { clientY: 150 }));
        });

        // dy=+50, top edge means delta=-50; 360-50=310
        expect(onCommitHeightPx).toHaveBeenLastCalledWith(
            310,
            expect.objectContaining({
                attemptedSizePx: 310,
                clampedSizePx: 310,
                exceededMinPx: false,
                exceededMaxPx: false,
            }),
        );
    });

    it('uses updated maxHeightPx while an active drag is still in progress', async () => {
        const onCommitHeightPx = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).PointerEvent = class PointerEvent extends Event {
            clientY: number;
            constructor(type: string, init: { clientY: number }) {
                super(type);
                this.clientY = init.clientY;
            }
        };

        const { ResizableDockedPaneVertical } = await import('./ResizableDockedPaneVertical');

        function TestHarness() {
            const [maxHeightPx, setMaxHeightPx] = React.useState(484);

            return (
                <ResizableDockedPaneVertical
                    heightPx={320}
                    minHeightPx={200}
                    maxHeightPx={maxHeightPx}
                    resizeEdge="top"
                    onCommitHeightPx={onCommitHeightPx}
                    onDragHeightPx={(nextHeightPx) => {
                        if (typeof nextHeightPx === 'number' && nextHeightPx >= 420) {
                            setMaxHeightPx(900);
                        }
                    }}
                >
                    <ViewStub />
                </ResizableDockedPaneVertical>
            );
        }

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<TestHarness />)).tree;

        const webHandle = findFirstByType(tree!, 'Pressable');
        await act(async () => {
            invokeTestInstanceHandler(webHandle, 'onPressIn', {
                clientY: 100,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointermove', { clientY: 0 }));
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointermove', { clientY: -140 }));
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointerup', { clientY: -140 }));
        });

        expect(onCommitHeightPx).toHaveBeenLastCalledWith(
            560,
            expect.objectContaining({
                attemptedSizePx: 560,
                clampedSizePx: 560,
                exceededMinPx: false,
                exceededMaxPx: false,
            }),
        );
    });
});

function ViewStub() {
    return React.createElement('ViewStub');
}
