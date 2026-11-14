import { useCallback, useSyncExternalStore } from 'react';

import type { HappierCollectionKey } from './collectionModel.js';

/** One expanded-set owner: the model reads the set; rows subscribe only to their key. */
export function createCollectionExpansion() {
  let expanded: ReadonlySet<HappierCollectionKey> = new Set();
  const listeners = new Set<() => void>();
  const rowListeners = new Map<HappierCollectionKey, Set<() => void>>();
  const getSnapshot = () => expanded;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  return {
    getSnapshot,
    subscribe,
    toggle: (key: HappierCollectionKey) => {
      const next = new Set(expanded);
      if (!next.delete(key)) next.add(key);
      expanded = next;
      for (const listener of listeners) listener();
      for (const listener of rowListeners.get(key) ?? []) listener();
    },
    useExpanded: (key: HappierCollectionKey): boolean => {
      const subscribeRow = useCallback((listener: () => void) => {
        let current = rowListeners.get(key);
        if (current === undefined) { current = new Set(); rowListeners.set(key, current); }
        current.add(listener);
        return () => {
          current.delete(listener);
          if (current.size === 0) rowListeners.delete(key);
        };
      }, [key, rowListeners]);
      const read = useCallback(() => getSnapshot().has(key), [key, getSnapshot]);
      return useSyncExternalStore(subscribeRow, read, read);
    },
  };
}
