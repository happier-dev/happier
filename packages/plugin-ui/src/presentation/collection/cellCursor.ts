import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from 'react';

import type { HappierCollectionKey } from './collectionModel.js';

/** The drawn selected cell: the row it stands on and its column (null = the title column). */
export type HappierCollectionCellCursor = Readonly<{
  rowKey: HappierCollectionKey;
  columnKey: string | null;
}>;

/**
 * Where the table draws its selected cell. The author owns the selection; this only lets each row redraw when the
 * cell arrives on or leaves it, so moving the cell repaints two rows, never the table.
 */
export function createCollectionCellCursor() {
  let cursor: HappierCollectionCellCursor | null = null;
  let onSelect: ((cell: HappierCollectionCellCursor) => void) | null = null;
  const rowListeners = new Map<HappierCollectionKey, Set<() => void>>();
  const notify = (key: HappierCollectionKey | undefined) => {
    if (key === undefined) return;
    for (const listener of rowListeners.get(key) ?? []) listener();
  };
  return {
    set(next: HappierCollectionCellCursor | null) {
      if (
        next?.rowKey === cursor?.rowKey &&
        next?.columnKey === cursor?.columnKey
      )
        return;
      const previous = cursor?.rowKey;
      cursor = next;
      notify(previous);
      if (next !== null && next.rowKey !== previous) notify(next.rowKey);
    },
    /** The author's selection intent, which a pressed cell reports to. */
    setOnSelect(next: ((cell: HappierCollectionCellCursor) => void) | null) {
      onSelect = next;
    },
    select(cell: HappierCollectionCellCursor) {
      onSelect?.(cell);
    },
    selectable(): boolean {
      return onSelect !== null;
    },
    subscribeRow(key: HappierCollectionKey, listener: () => void) {
      let current = rowListeners.get(key);
      if (current === undefined) {
        current = new Set();
        rowListeners.set(key, current);
      }
      current.add(listener);
      return () => {
        current.delete(listener);
        if (current.size === 0) rowListeners.delete(key);
      };
    },
    /** The column drawn on this row: a field key, null for the title, undefined when the cell is elsewhere. */
    read(key: HappierCollectionKey): string | null | undefined {
      return cursor?.rowKey === key ? cursor.columnKey : undefined;
    },
  };
}

export type HappierCollectionCellCursorStore = ReturnType<
  typeof createCollectionCellCursor
>;

export const HappierCollectionCellCursorContext =
  createContext<HappierCollectionCellCursorStore | null>(null);

export function useHappierCollectionCellCursorColumn(
  key: HappierCollectionKey,
): string | null | undefined {
  const store = useContext(HappierCollectionCellCursorContext);
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribeRow(key, listener) ?? (() => {}),
    [key, store],
  );
  const read = useCallback(() => store?.read(key), [key, store]);
  return useSyncExternalStore(subscribe, read, read);
}
