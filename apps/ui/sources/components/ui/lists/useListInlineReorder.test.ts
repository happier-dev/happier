import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import {
    TREE_DROP_OVERLAY_KIND_LINE,
    TREE_DROP_OVERLAY_KIND_NONE,
    type TreeDropOverlayKind,
    type TreeDropOverlaySharedValues,
} from '@/components/ui/treeDragDrop';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => fn(...args),
}));

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

type TestGesture = Readonly<{ __kind: string; __handlers: Record<string, (...args: any[]) => void> }>;

function overlayShared(): TreeDropOverlaySharedValues {
    return {
        overlayVisible: { value: 0 },
        overlayKind: { value: TREE_DROP_OVERLAY_KIND_NONE as TreeDropOverlayKind },
        overlayTop: { value: 0 },
        overlayHeight: { value: 0 },
        overlayLeft: { value: 0 },
        overlayRight: { value: 0 },
        overlayDepth: { value: 0 },
    };
}

function layoutEvent(width: number, height: number) {
    return { nativeEvent: { layout: { x: 0, y: 0, width, height } } } as any;
}

describe('reorderFlatIds', () => {
    it('moves an id to the given insertion index', async () => {
        const { reorderFlatIds } = await import('./useListInlineReorder');
        expect(reorderFlatIds(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
        expect(reorderFlatIds(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
        expect(reorderFlatIds(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
    });

    it('clamps out-of-range indices', async () => {
        const { reorderFlatIds } = await import('./useListInlineReorder');
        expect(reorderFlatIds(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
        expect(reorderFlatIds(['a', 'b', 'c'], 'c', -5)).toEqual(['c', 'a', 'b']);
    });
});

describe('resolveFlatReorderTargetIndex', () => {
    it('computes the insertion index from translation with uniform heights', async () => {
        const { resolveFlatReorderTargetIndex } = await import('./useListInlineReorder');
        const rowHeights = new Map([['a', 56], ['b', 56], ['c', 56]]);

        // Dragging 'a' (center 28) down by 120 → center 148; b(84) & c(140) above → 2.
        expect(
            resolveFlatReorderTargetIndex({ orderedIds: ['a', 'b', 'c'], draggedId: 'a', rowHeights, translationY: 120 }),
        ).toBe(2);
        // No movement → stays at index 0.
        expect(
            resolveFlatReorderTargetIndex({ orderedIds: ['a', 'b', 'c'], draggedId: 'a', rowHeights, translationY: 0 }),
        ).toBe(0);
        // Dragging 'c' (center 140) up by -120 → center 20; none above → 0.
        expect(
            resolveFlatReorderTargetIndex({ orderedIds: ['a', 'b', 'c'], draggedId: 'c', rowHeights, translationY: -120 }),
        ).toBe(0);
    });

    it('uses the fallback height for unmeasured rows', async () => {
        const { resolveFlatReorderTargetIndex } = await import('./useListInlineReorder');
        const rowHeights = new Map<string, number>();
        expect(
            resolveFlatReorderTargetIndex({
                orderedIds: ['a', 'b', 'c'],
                draggedId: 'a',
                rowHeights,
                translationY: 0,
                fallbackRowHeight: 40,
            }),
        ).toBe(0);
    });
});

describe('useListInlineReorder', () => {
    type Row = { id: string };

    function reportLayouts(result: any, rows: Row[]) {
        for (const row of rows) result.onRowLayout(row.id, layoutEvent(300, 56));
    }

    it('freezes the order during a drag and commits the reordered ids on drop', async () => {
        const { useListInlineReorder } = await import('./useListInlineReorder');
        const overlay = overlayShared();
        const onCommitOrder = vi.fn();
        const rows: Row[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

        const hook = await renderHook(
            (items: ReadonlyArray<Row>) => useListInlineReorder({ items, overlayShared: overlay, onCommitOrder }),
            { initialProps: rows },
        );

        reportLayouts(hook.getCurrent(), rows);

        const gesture = hook.getCurrent().gestureForRow('a') as unknown as TestGesture;

        await act(async () => {
            gesture.__handlers.onStart?.();
        });
        // Drag start freezes the snapshot and marks 'a' as dragging.
        expect(hook.getCurrent().draggingId).toBe('a');
        expect(hook.getCurrent().frozenItems.map((r) => r.id)).toEqual(['a', 'b', 'c']);

        await act(async () => {
            gesture.__handlers.onUpdate?.({ translationY: 120 });
        });
        expect(overlay.overlayVisible.value).toBe(1);
        expect(overlay.overlayKind.value).toBe(TREE_DROP_OVERLAY_KIND_LINE);
        expect(overlay.overlayDepth.value).toBe(0);

        await act(async () => {
            gesture.__handlers.onEnd?.();
        });

        expect(onCommitOrder).toHaveBeenCalledTimes(1);
        expect(onCommitOrder).toHaveBeenCalledWith(['b', 'c', 'a']);
        // Drag end clears state + overlay.
        expect(hook.getCurrent().draggingId).toBeNull();
        expect(overlay.overlayVisible.value).toBe(0);
        expect(overlay.overlayKind.value).toBe(TREE_DROP_OVERLAY_KIND_NONE);

        await hook.unmount();
    });

    it('keeps the frozen snapshot stable when background items change mid-drag', async () => {
        const { useListInlineReorder } = await import('./useListInlineReorder');
        const overlay = overlayShared();
        const rows: Row[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

        const hook = await renderHook(
            (items: ReadonlyArray<Row>) => useListInlineReorder({ items, overlayShared: overlay, onCommitOrder: vi.fn() }),
            { initialProps: rows },
        );
        reportLayouts(hook.getCurrent(), rows);

        const gesture = hook.getCurrent().gestureForRow('a') as unknown as TestGesture;
        await act(async () => {
            gesture.__handlers.onStart?.();
        });

        // Background reorder arrives while dragging.
        await hook.rerender([{ id: 'c' }, { id: 'b' }, { id: 'a' }]);
        expect(hook.getCurrent().frozenItems.map((r) => r.id)).toEqual(['a', 'b', 'c']);

        await hook.unmount();
    });

    it('does not commit when the drag is cancelled', async () => {
        const { useListInlineReorder } = await import('./useListInlineReorder');
        const overlay = overlayShared();
        const onCommitOrder = vi.fn();
        const rows: Row[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

        const hook = await renderHook(
            (items: ReadonlyArray<Row>) => useListInlineReorder({ items, overlayShared: overlay, onCommitOrder }),
            { initialProps: rows },
        );
        reportLayouts(hook.getCurrent(), rows);

        const gesture = hook.getCurrent().gestureForRow('a') as unknown as TestGesture;
        await act(async () => {
            gesture.__handlers.onStart?.();
            gesture.__handlers.onUpdate?.({ translationY: 120 });
        });
        expect(overlay.overlayVisible.value).toBe(1);

        await act(async () => {
            gesture.__handlers.onFinalize?.();
        });

        expect(onCommitOrder).not.toHaveBeenCalled();
        expect(hook.getCurrent().draggingId).toBeNull();
        expect(overlay.overlayVisible.value).toBe(0);

        await hook.unmount();
    });

    it('does not commit when dropped without movement (seeded by the row index)', async () => {
        const { useListInlineReorder } = await import('./useListInlineReorder');
        const overlay = overlayShared();
        const onCommitOrder = vi.fn();
        const rows: Row[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

        const hook = await renderHook(
            (items: ReadonlyArray<Row>) => useListInlineReorder({ items, overlayShared: overlay, onCommitOrder }),
            { initialProps: rows },
        );
        reportLayouts(hook.getCurrent(), rows);

        // Drag the middle row but release immediately (no onUpdate).
        const gesture = hook.getCurrent().gestureForRow('b', 1) as unknown as TestGesture;
        await act(async () => {
            gesture.__handlers.onStart?.();
            gesture.__handlers.onEnd?.();
        });

        expect(onCommitOrder).not.toHaveBeenCalled();
        expect(hook.getCurrent().draggingId).toBeNull();

        await hook.unmount();
    });

    it('returns no gesture when disabled', async () => {
        const { useListInlineReorder } = await import('./useListInlineReorder');
        const overlay = overlayShared();

        const hook = await renderHook(() =>
            useListInlineReorder({ items: [{ id: 'a' }], enabled: false, overlayShared: overlay, onCommitOrder: vi.fn() }),
        );
        expect(hook.getCurrent().gestureForRow('a')).toBeUndefined();

        await hook.unmount();
    });
});
