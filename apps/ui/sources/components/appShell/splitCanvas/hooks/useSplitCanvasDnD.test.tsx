import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';

installPanelCommonModuleMocks();

type FakeRect = Readonly<{
    left: number;
    top: number;
    width: number;
    height: number;
}>;

function createHostElement(rect: FakeRect) {
    return {
        getBoundingClientRect: () => rect,
    };
}

function createDragEvent(clientX: number, clientY: number) {
    return {
        clientX,
        clientY,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        currentTarget: {
            getBoundingClientRect: () => ({
                left: 0,
                top: 0,
                width: 800,
                height: 600,
            }),
        },
        dataTransfer: {
            getData: () => JSON.stringify({ sessionId: 'sess_nested' }),
        },
    };
}

describe('useSplitCanvasDnD', () => {
    it('prefers actual leaf host geometry for nested split targeting', async () => {
        const onActiveDropTargetChange = vi.fn();

        const { useSplitCanvasDnD } = await import('./useSplitCanvasDnD');
        const hook = await renderHook(() => useSplitCanvasDnD({
            enabled: true,
            onActiveDropTargetChange,
            onLeafDrop: vi.fn(),
        }));

        act(() => {
            hook.getCurrent().registerLeafHost('leaf-a', createHostElement({
                left: 0,
                top: 0,
                width: 400,
                height: 600,
            }));
            hook.getCurrent().registerLeafHost('leaf-b', createHostElement({
                left: 400,
                top: 0,
                width: 400,
                height: 300,
            }));
            hook.getCurrent().registerLeafHost('leaf-c', createHostElement({
                left: 400,
                top: 300,
                width: 400,
                height: 300,
            }));
        });

        act(() => {
            hook.getCurrent().hostDropTargetProps.onDragOver?.(createDragEvent(412, 420));
        });

        expect(onActiveDropTargetChange).toHaveBeenCalledWith({
            leafId: 'leaf-c',
            placement: 'left',
        });
    });

    it('cleans removed leaf geometry so stale targets do not survive post-close layouts', async () => {
        const onActiveDropTargetChange = vi.fn();

        const { useSplitCanvasDnD } = await import('./useSplitCanvasDnD');
        const hook = await renderHook(() => useSplitCanvasDnD({
            enabled: true,
            onActiveDropTargetChange,
            onLeafDrop: vi.fn(),
        }));

        act(() => {
            hook.getCurrent().onLeafLayout('leaf-a', {
                nativeEvent: {
                    layout: {
                        x: 0,
                        y: 0,
                        width: 400,
                        height: 600,
                    },
                },
            });
            hook.getCurrent().onLeafLayout('leaf-b', {
                nativeEvent: {
                    layout: {
                        x: 400,
                        y: 0,
                        width: 400,
                        height: 600,
                    },
                },
            });
            hook.getCurrent().registerLeafHost('leaf-b', null);
            hook.getCurrent().onLeafLayout('leaf-a', {
                nativeEvent: {
                    layout: {
                        x: 0,
                        y: 0,
                        width: 800,
                        height: 600,
                    },
                },
            });
        });

        act(() => {
            hook.getCurrent().hostDropTargetProps.onDragOver?.(createDragEvent(760, 120));
        });

        expect(onActiveDropTargetChange).toHaveBeenCalledWith({
            leafId: 'leaf-a',
            placement: 'right',
        });
    });
});
