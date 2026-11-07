import * as React from 'react';
import { Platform } from 'react-native';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';

/**
 * Under a precise pointer on the web, a summary row a person has not reached is only its words
 * (PERF-WF3B): its ⋯ menu and the Add in the gap before it mount once a pointer or the keyboard
 * reaches the row, so a 500-block document does not hold 500 menus and inserters. Under a finger
 * (and on native) rows keep their controls: there is no hover to reach a row before tapping it.
 */
export function useWorkflowEditorRowsMountOnReach(): boolean {
  const touchPrimaryPointer = useHappierTouchPrimaryPointer(Platform.OS);
  return Platform.OS === 'web' && !touchPrimaryPointer;
}

/**
 * The row of one list a pointer or the keyboard last reached. It stays reached until another row of
 * the same list is, so its menu keeps its popover while the pointer travels onto it and focus never
 * lands on a control that unmounts under it.
 */
export type WorkflowRowEngagement = Readonly<{
  engage: (blockId: string) => void;
  subscribe: (listener: () => void) => () => void;
  current: () => string | null;
}>;

export function createWorkflowRowEngagement(): WorkflowRowEngagement {
  let current: string | null = null;
  const listeners = new Set<() => void>();
  return {
    engage: (blockId) => {
      if (current === blockId) return;
      current = blockId;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    current: () => current,
  };
}

/** Whether this row, or the row before it (whose Add sits in this row's gap), is the reached one. */
export function useWorkflowRowReached(
  engagement: WorkflowRowEngagement,
  blockId: string,
  previousId: string | undefined,
): Readonly<{ row: boolean; previous: boolean }> {
  // One primitive per row, so a new reached row re-renders only the rows it enters and leaves.
  const bits = React.useSyncExternalStore(
    engagement.subscribe,
    () => {
      const reached = engagement.current();
      return (
        (reached === blockId ? 1 : 0) |
        (previousId !== undefined && reached === previousId ? 2 : 0)
      );
    },
    () => 0,
  );
  return { row: (bits & 1) === 1, previous: (bits & 2) === 2 };
}
