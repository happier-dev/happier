import * as React from 'react';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** What a held operation is: a person's decision on a proposal, or Undo of an accepted one. */
export type DocEditOperationKind = 'accept' | 'decline' | 'undo';

/** `approvalId` is null while the Action is in flight and set once it is waiting on an approval. */
export type HeldDocEditOperation = Readonly<{ kind: DocEditOperationKind; approvalId: string | null }>;

const held = new Map<string, HeldDocEditOperation>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** One proposal, one Home Account: a card, its compact notice and a remounted card share this key. */
export const docEditOperationKey = (scope: ServerAccountScope, proposalMessageId: string) =>
  `${scope.serverId}:${scope.accountId}:${proposalMessageId}`;

/**
 * The one admission for a proposal's Accept, Decline and Undo. Custody is held (process-local, like the
 * approval continuation it feeds) from the press until the Action settles, so a second entry point, a Back
 * to the same card or a remounted card cannot create a second request for the same intent.
 */
export function admitDocEditOperation(key: string, kind: DocEditOperationKind): boolean {
  if (held.has(key)) return false;
  held.set(key, { kind, approvalId: null });
  notify();
  return true;
}

export function readDocEditOperation(key: string): HeldDocEditOperation | null {
  return held.get(key) ?? null;
}

/** The Action is waiting on this approval; the mounted card observes it through the approval continuation. */
export function holdDocEditApproval(key: string, approvalId: string): void {
  const current = held.get(key);
  if (!current) return;
  held.set(key, { ...current, approvalId });
  notify();
}

export function releaseDocEditOperation(key: string): void {
  if (held.delete(key)) notify();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useDocEditOperation(key: string | null): HeldDocEditOperation | null {
  return React.useSyncExternalStore(subscribe, () => (key === null ? null : held.get(key) ?? null));
}

export function resetDocEditOperationsForTests(): void {
  held.clear();
  notify();
}
