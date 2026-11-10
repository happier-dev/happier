import * as React from 'react';

import type { ArtifactActionsClient } from './artifactActionsClient';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ArtifactRevisionV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';

/** What a held operation is: a person's decision on a proposal, or Undo of an accepted one. */
export type DocEditOperationKind = 'accept' | 'decline' | 'undo';

/** `approvalId` is null while the Action is in flight and set once it is waiting on an approval. */
export type HeldDocEditOperation = Readonly<{ kind: DocEditOperationKind; approvalId: string | null }>;

type DocEditOperation = HeldDocEditOperation | Readonly<{
  kind: 'undo'; approvalId: null; restoredRevision: ArtifactRevisionV1;
}>;

const held = new Map<string, DocEditOperation>();
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

export function readDocEditOperation(key: string): DocEditOperation | null {
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

/** Keep the acknowledged Undo result for the card, its notice and a reopened thread alike. */
export function settleDocEditUndo(key: string, restoredRevision: ArtifactRevisionV1): void {
  held.set(key, { kind: 'undo', approvalId: null, restoredRevision });
  notify();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useDocEditOperation(key: string | null): DocEditOperation | null {
  return React.useSyncExternalStore(subscribe, () => (key === null ? null : held.get(key) ?? null));
}

export function resetDocEditOperationsForTests(): void {
  held.clear();
  notify();
}

/** A restore immediately after acceptance is durable evidence that this edit was undone.
 * Later restores of the same source version do not identify this proposal's Undo. */
export function useDocEditRestoredVersion(client: ArtifactActionsClient, artifactId: string,
  baseBodyVersion: number, acceptedBodyVersion: number | null, currentBodyVersion: number | undefined): number | null {
  const [restored, setRestored] = React.useState<Readonly<{
    client: ArtifactActionsClient; artifactId: string; acceptedBodyVersion: number; bodyVersion: number;
  }> | null>(null);
  const known = restored?.client === client && restored.artifactId === artifactId
    && restored.acceptedBodyVersion === acceptedBodyVersion ? restored.bodyVersion : null;
  React.useEffect(() => {
    if (known !== null || acceptedBodyVersion === null || currentBodyVersion === undefined
      || currentBodyVersion <= acceptedBodyVersion) return;
    let live = true;
    void client.listRevisions(artifactId).then(outcome => {
      if (!live || !outcome.ok) return;
      const revision = outcome.value.revisions.find(row => row.bodyVersion === acceptedBodyVersion + 1
        && row.provenance?.restoredFromBodyVersion === baseBodyVersion);
      if (revision) setRestored({ client, artifactId, acceptedBodyVersion, bodyVersion: revision.bodyVersion });
    });
    return () => { live = false; };
  }, [acceptedBodyVersion, artifactId, baseBodyVersion, client, currentBodyVersion, known]);
  return known;
}
