import * as React from 'react';

import { areReactNodesStructurallyEqual } from '@/utils/react/areReactNodesStructurallyEqual';

/**
 * What a mounted transcript cell draws from. A new row renderer, new data or a new key reader is a
 * new source; each mounted cell then re-reads its own element and redraws only when it changed.
 */
export type TranscriptCellSource<TItem> = Readonly<{
    data: readonly TItem[];
    keyExtractor: (item: TItem, index: number) => string;
    renderCell: (item: TItem, sourceIndex: number, itemKey: string) => React.ReactElement;
    /** Every other input `renderCell` closes over; a change publishes like a new renderer. */
    inputs: readonly unknown[];
}>;

type CellEntry = { version: number; sourceIndex: number | undefined; element: React.ReactElement | null };

/**
 * Per-cell subscription for the Legend transcript renderer. Legend redraws every mounted container
 * whenever its list-wide `extraData` changes; the row renderer changes on each new row and turn end,
 * so carrying it there redrew every mounted cell's Container and PositionView. Instead the renderer
 * publishes its source here and each cell subscribes to its own element.
 */
export type TranscriptCellStore<TItem> = Readonly<{
    /** During render: adopts a new source (only when an input changed). */
    update: (source: TranscriptCellSource<TItem>) => void;
    /** After commit: tells mounted cells that the source changed since the last publication. */
    publish: () => void;
    /** Legend's latest index for a key, so the common read resolves without a pass over the data. */
    noteIndex: (itemKey: string, sourceIndex: number) => void;
    subscribe: (itemKey: string, listener: () => void) => () => void;
    read: (itemKey: string) => React.ReactElement | null;
}>;

function sameInputs(left: readonly unknown[], right: readonly unknown[]): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) if (!Object.is(left[index], right[index])) return false;
    return true;
}

export function createTranscriptCellStore<TItem>(): TranscriptCellStore<TItem> {
    let source: TranscriptCellSource<TItem> | null = null;
    let version = 0;
    let publishedVersion = 0;
    let keyIndex: { data: readonly TItem[]; byKey: Map<string, number> } | null = null;
    const entries = new Map<string, CellEntry>();
    const listeners = new Set<() => void>();
    const subscribersByKey = new Map<string, number>();

    const resolveIndex = (current: TranscriptCellSource<TItem>, itemKey: string, guess: number | undefined) => {
        if (guess !== undefined && guess < current.data.length
            && current.keyExtractor(current.data[guess] as TItem, guess) === itemKey) return guess;
        // A prepend shifts every index: index the data once for all cells re-reading it.
        if (keyIndex?.data !== current.data) {
            const byKey = new Map<string, number>();
            current.data.forEach((item, index) => byKey.set(current.keyExtractor(item, index), index));
            keyIndex = { data: current.data, byKey };
        }
        return keyIndex.byKey.get(itemKey);
    };

    return {
        update(next) {
            // The renderCell closure is rebuilt every render; only data, the key reader and its declared
            // inputs make a new source.
            const changed = source === null || source.data !== next.data || source.keyExtractor !== next.keyExtractor
                || !sameInputs(source.inputs, next.inputs);
            source = next;
            if (changed) version += 1;
        },
        publish() {
            if (publishedVersion === version) return;
            publishedVersion = version;
            for (const listener of [...listeners]) listener();
        },
        noteIndex(itemKey, sourceIndex) {
            const entry = entries.get(itemKey);
            if (entry) entry.sourceIndex = sourceIndex;
            else entries.set(itemKey, { version: -1, sourceIndex, element: null });
        },
        subscribe(itemKey, listener) {
            listeners.add(listener);
            subscribersByKey.set(itemKey, (subscribersByKey.get(itemKey) ?? 0) + 1);
            return () => {
                listeners.delete(listener);
                const remaining = (subscribersByKey.get(itemKey) ?? 1) - 1;
                if (remaining > 0) {
                    subscribersByKey.set(itemKey, remaining);
                    return;
                }
                // An unmounted cell keeps nothing: Legend asks for it again when it scrolls back in.
                subscribersByKey.delete(itemKey);
                entries.delete(itemKey);
            };
        },
        read(itemKey) {
            const current = source;
            const entry = entries.get(itemKey);
            if (!current) return entry?.element ?? null;
            if (entry && entry.version === version && entry.element !== null) return entry.element;
            const sourceIndex = resolveIndex(current, itemKey, entry?.sourceIndex);
            // A removed item's cell is about to unmount: it keeps what it drew.
            if (sourceIndex === undefined) return entry?.element ?? null;
            const next = current.renderCell(current.data[sourceIndex] as TItem, sourceIndex, itemKey);
            const previous = entry?.element ?? null;
            const element = previous !== null && areReactNodesStructurallyEqual(previous, next) ? previous : next;
            entries.set(itemKey, { version, sourceIndex, element });
            return element;
        },
    };
}

type TranscriptLegendCellProps = Readonly<{ store: Pick<TranscriptCellStore<unknown>, 'subscribe' | 'read'>; itemKey: string }>;

/** One mounted transcript cell: it redraws only when its own element changes. */
export const TranscriptLegendCell = React.memo(function TranscriptLegendCell(props: TranscriptLegendCellProps) {
    const { store, itemKey } = props;
    const subscribe = React.useCallback((listener: () => void) => store.subscribe(itemKey, listener), [store, itemKey]);
    const read = React.useCallback(() => store.read(itemKey), [store, itemKey]);
    return React.useSyncExternalStore(subscribe, read, read);
});
