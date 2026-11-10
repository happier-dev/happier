import * as React from 'react';

import { useDestinationFocus } from '@/components/appShell/workspace/destinationInstanceContext';

/** A main screen's create action ("New board", "New discussion"): its header "+" and the phone bar's "+". */
export type PageCreateAction = Readonly<{
  label: string;
  testID: string;
  onPress: () => void;
}>;

/**
 * The phone bar's "+" beside the tabs (owner 11-10): the page in front lends it its create action, the same one its
 * header "+" runs, so every main screen gets Sessions' thumb-reach "+". Publications stack in mount order; the
 * newest page in front wins and the one under it takes the "+" back when it leaves.
 */
const published = new Map<object, PageCreateAction>();
const listeners = new Set<() => void>();
let current: PageCreateAction | null = null;

function publish(): void {
  current = [...published.values()].at(-1) ?? null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = () => current;

/** A page publishes its create action while it is the destination in front; `null` publishes nothing. */
export function usePublishPageCreateAction(
  action: PageCreateAction | null,
): void {
  const focused = useDestinationFocus();
  const latest = React.useRef(action);
  latest.current = action;
  const label = action?.label;
  const testID = action?.testID;
  const active = action !== null && focused;
  React.useLayoutEffect(() => {
    if (!active || label === undefined || testID === undefined) return;
    const token = {};
    published.set(token, {
      label,
      testID,
      onPress: () => latest.current?.onPress(),
    });
    publish();
    return () => {
      published.delete(token);
      publish();
    };
  }, [active, label, testID]);
}

/** The create action the phone bar's "+" runs, or null when the page in front has none. */
export function usePageCreateAction(): PageCreateAction | null {
  return React.useSyncExternalStore(subscribe, read, read);
}
