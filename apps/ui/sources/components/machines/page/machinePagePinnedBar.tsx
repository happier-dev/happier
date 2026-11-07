import * as React from 'react';

import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';

/**
 * The Machine page's one pinned action bar on a phone (MR10): a page's decision (a review's Apply and Cancel, a
 * staged change's Review and Discard) sits above the floating tab bar instead of at the end of the scroll. The
 * page provides the slot only on a phone; elsewhere the decision stays in flow.
 *
 * The decision's owner publishes its element into a small store that only the bar reads, so publishing on each of
 * the owner's renders re-renders the bar alone, never the page that holds both.
 */
export type MachinePagePinnedBarSlot = Readonly<{
  get(): React.ReactNode;
  set(node: React.ReactNode): void;
  subscribe(listener: () => void): () => void;
}>;

export function createMachinePagePinnedBarSlot(): MachinePagePinnedBarSlot {
  let current: React.ReactNode = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (node) => {
      if (Object.is(node, current)) return;
      current = node;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const MachinePagePinnedBarContext =
  React.createContext<MachinePagePinnedBarSlot | null>(null);

/** Draws `children` in the page's pinned bar when the page has one, otherwise in place. */
export function MachinePagePinned(
  props: Readonly<{ children: React.ReactNode }>,
) {
  const slot = React.useContext(MachinePagePinnedBarContext);
  React.useLayoutEffect(() => {
    slot?.set(props.children);
  });
  React.useLayoutEffect(() => () => slot?.set(null), [slot]);
  return slot ? null : <>{props.children}</>;
}

/** The page's bar: rendered by the page beside its one scroller. */
export function MachinePagePinnedBarHost(
  props: Readonly<{ slot: MachinePagePinnedBarSlot }>,
) {
  const node = React.useSyncExternalStore(
    props.slot.subscribe,
    props.slot.get,
    props.slot.get,
  );
  return node ? (
    <PagePinnedBar testID="machine-page-pinned-bar">{node}</PagePinnedBar>
  ) : null;
}
