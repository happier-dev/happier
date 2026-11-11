import * as React from 'react';

import {
  sessionAddressKey,
  type SessionAddress,
} from '@/sync/domains/session/sessionAddress';

const pending = new Set<string>();
const listeners = new Set<() => void>();

/**
 * One-shot "show this Session's workflows" request from the Session header (owner 0936 #16): the header opens
 * the Work tab through the pane owner, and the Work tab, mounted now or a moment later, scrolls its Triggers
 * section into view once. Not mode state: the Work tab consumes it.
 */
export function requestSessionWorkTriggersReveal(target: SessionAddress): void {
  pending.add(sessionAddressKey(target));
  listeners.forEach((listener) => listener());
}

/** Whether a reveal waits for this Session's Work tab, and the call that marks it done. */
export function useSessionWorkTriggersReveal(
  target: SessionAddress | null,
): Readonly<{ requested: boolean; consume: () => void }> {
  const key = target ? sessionAddressKey(target) : null;
  const subscribe = React.useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const requested = React.useSyncExternalStore(
    subscribe,
    () => key !== null && pending.has(key),
    () => false,
  );
  const consume = React.useCallback(() => {
    if (key === null || !pending.delete(key)) return;
    listeners.forEach((listener) => listener());
  }, [key]);
  return { requested, consume };
}
