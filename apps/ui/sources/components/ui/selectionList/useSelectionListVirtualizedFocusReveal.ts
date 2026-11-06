import * as React from 'react';
import { Platform } from 'react-native';

import type {
    VirtualizedListProps,
    VirtualizedListRef,
} from '@/components/ui/lists/virtualized/virtualizedListTypes';
import type { SelectionListRegisterScrollItemLayout } from './SelectionListScrollIntoViewContext';

type ViewportSize = Readonly<{ width: number; height: number }>;

/**
 * Keeps the focused virtual row visible when focus moves to another row or the viewport changes size.
 * Keyboard and layout changes can shrink the recycler without changing the focused option, so the
 * viewport is a reveal trigger too. A live data update that only moves rows (a machine changes state
 * and re-sorts) is not: the reader stays where they are instead of jumping back to the focused row.
 */
export function useSelectionListVirtualizedFocusReveal(args: Readonly<{
    listRef: React.RefObject<VirtualizedListRef | null>;
    focusedItemIndex: number;
    /** The focused row's identity; a reveal follows a change of identity, not of index. */
    focusedKey: string | null;
    /**
     * The focused card's DOM id when its virtual row is a column block. A block can be taller than
     * the viewport, so centring the block would not show the card: a mounted card is revealed itself.
     */
    focusedCellDomId?: string | null;
    /** A data projection change alone must not start another focus reveal. */
    cellLayoutItems?: readonly unknown[];
    /** Existing positions let the layout owner discard offsets for options removed from the body. */
    optionPositions?: ReadonlyMap<string, number>;
    reducedMotion: boolean;
}>): Readonly<{
    onViewportLayout: NonNullable<VirtualizedListProps<unknown>['onLayout']>;
    registerCellLayout: SelectionListRegisterScrollItemLayout | null;
}> {
    const focusedItemIndexRef = React.useRef(args.focusedItemIndex);
    focusedItemIndexRef.current = args.focusedItemIndex;
    const focusedCellDomIdRef = React.useRef(args.focusedCellDomId ?? null);
    focusedCellDomIdRef.current = args.focusedCellDomId ?? null;
    const focusedKeyRef = React.useRef(args.focusedKey);
    focusedKeyRef.current = args.focusedKey;
    const cellLayoutsRef = React.useRef({ items: args.cellLayoutItems, offsets: new Map<string, number>() });
    if (cellLayoutsRef.current.items !== args.cellLayoutItems) {
        const offsets = cellLayoutsRef.current.offsets;
        for (const optionId of offsets.keys()) {
            if (!args.optionPositions?.has(optionId)) offsets.delete(optionId);
        }
        cellLayoutsRef.current = { items: args.cellLayoutItems, offsets };
    }
    const cellLayouts = cellLayoutsRef.current;
    const revealedCellLayoutsRef = React.useRef(cellLayouts);
    const revealFocusedItem = React.useCallback(() => {
        const index = focusedItemIndexRef.current;
        if (index < 0) return;
        const cell = Platform.OS === 'web' && focusedCellDomIdRef.current !== null
            ? document.getElementById(focusedCellDomIdRef.current)
            : null;
        if (cell) {
            cell.scrollIntoView({ block: 'nearest' });
            return;
        }
        const ref = args.listRef.current;
        if (!ref || typeof ref.scrollToIndex !== 'function') return;
        if (Platform.OS !== 'web' && focusedCellDomIdRef.current !== null) {
            // Legend subtracts viewOffset from the row's position. A negative offset reaches
            // the actual cell within a tall block; before layout, the block top mounts its cells.
            const cellY = cellLayoutsRef.current.offsets.get(focusedKeyRef.current ?? '') ?? 0;
            ref.scrollToIndex({ index, viewPosition: 0, viewOffset: 0 - cellY, animated: !args.reducedMotion });
            return;
        }
        ref.scrollToIndex({
            index,
            viewPosition: 0.5,
            animated: !args.reducedMotion,
        });
    }, [args.listRef, args.reducedMotion]);

    const registerCellLayout = React.useCallback<SelectionListRegisterScrollItemLayout>((optionId) => (event) => {
        const y = event.nativeEvent?.layout?.y;
        if (typeof y !== 'number' || cellLayouts.offsets.get(optionId) === y) return;
        cellLayouts.offsets.set(optionId, y);
        // Parent frames can report after their children. Finish that focus reveal using their
        // rebased geometry, while data-only reorders retain the reader's current scroll position.
        if (optionId === focusedKeyRef.current
            && cellLayouts === cellLayoutsRef.current && cellLayouts === revealedCellLayoutsRef.current) {
            revealFocusedItem();
        }
    }, [cellLayouts, revealFocusedItem]);

    const revealedKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (args.focusedKey === null || args.focusedItemIndex < 0) {
            // Nothing focused here (or the row is not in this list): the next focus reveals.
            revealedKeyRef.current = null;
            return;
        }
        if (revealedKeyRef.current === args.focusedKey) return;
        revealedKeyRef.current = args.focusedKey;
        revealedCellLayoutsRef.current = cellLayoutsRef.current;
        revealFocusedItem();
    }, [args.focusedKey, args.focusedItemIndex, revealFocusedItem]);

    const previousViewportSizeRef = React.useRef<ViewportSize | null>(null);
    const onViewportLayout = React.useCallback<NonNullable<VirtualizedListProps<unknown>['onLayout']>>(
        (event) => {
            const { width, height } = event.nativeEvent.layout;
            const previous = previousViewportSizeRef.current;
            previousViewportSizeRef.current = { width, height };
            if (previous === null) return;
            if (previous.width === width && previous.height === height) return;
            revealedCellLayoutsRef.current = cellLayoutsRef.current;
            revealFocusedItem();
        },
        [revealFocusedItem],
    );

    return { onViewportLayout, registerCellLayout: Platform.OS === 'web' ? null : registerCellLayout };
}
