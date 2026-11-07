import { useCallback, useSyncExternalStore } from 'react';

/** A controlled map selection; only the old and new node's subscribers are notified. */
export function createMapSelection(selectedNodeId: string | null) {
  let selected = selectedNodeId;
  const listeners = new Map<string, Set<() => void>>();
  return {
    isSelected: (nodeId: string) => selected === nodeId,
    subscribe(nodeId: string, listener: () => void) {
      let nodeListeners = listeners.get(nodeId);
      if (!nodeListeners) listeners.set(nodeId, nodeListeners = new Set());
      nodeListeners.add(listener);
      return () => {
        nodeListeners.delete(listener);
        if (nodeListeners.size === 0) listeners.delete(nodeId);
      };
    },
    select(nodeId: string | null) {
      if (selected === nodeId) return;
      const previous = selected;
      selected = nodeId;
      if (previous !== null) listeners.get(previous)?.forEach(listener => listener());
      if (nodeId !== null) listeners.get(nodeId)?.forEach(listener => listener());
    },
  };
}

export type MapSelection = ReturnType<typeof createMapSelection>;

export function useMapNodeSelected(selection: MapSelection, nodeId: string): boolean {
  const subscribe = useCallback((listener: () => void) => selection.subscribe(nodeId, listener), [selection, nodeId]);
  const read = useCallback(() => selection.isSelected(nodeId), [selection, nodeId]);
  return useSyncExternalStore(subscribe, read, read);
}
