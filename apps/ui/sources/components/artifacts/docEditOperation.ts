import * as React from 'react';

import type { ArtifactActionsClient } from './artifactActionsClient';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ArtifactRevisionV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { ArtifactRevisionProvenanceV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';

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
function restoredDocEditVersion(base: number, accepted: number | null,
  bodyVersion: number | undefined, restoredFromBodyVersion: number | undefined): number | null {
  return accepted !== null && bodyVersion === accepted + 1 && restoredFromBodyVersion === base
    ? bodyVersion : null;
}

export function useDocEditRestoredVersion(client: ArtifactActionsClient, artifactId: string,
  baseBodyVersion: number, acceptedBodyVersion: number | null,
  currentArtifact: Readonly<{ revision: ArtifactRevisionV1; provenance?: ArtifactRevisionProvenanceV1 }> | null): number | null {
  const [restored, setRestored] = React.useState<Readonly<{
    client: ArtifactActionsClient; artifactId: string; acceptedBodyVersion: number; bodyVersion: number;
  }> | null>(null);
  const known = restored?.client === client && restored.artifactId === artifactId
    && restored.acceptedBodyVersion === acceptedBodyVersion ? restored.bodyVersion : null;
  // History archives superseded bodies only. Until another edit, the restore fact belongs to the head.
  const restoredHead = restoredDocEditVersion(baseBodyVersion, acceptedBodyVersion,
    currentArtifact?.revision.bodyVersion, currentArtifact?.provenance?.restoredFromBodyVersion);
  const admittedBodyVersion = currentArtifact?.revision.bodyVersion;
  React.useEffect(() => {
    if (known !== null || acceptedBodyVersion === null || admittedBodyVersion === undefined) return;
    if (restoredHead !== null) {
      setRestored({ client, artifactId, acceptedBodyVersion, bodyVersion: restoredHead });
      return;
    }
    // Undo can only be body accepted+1. While that body is still the head, its admitted
    // provenance already answers the question; history contains only superseded bodies.
    if (admittedBodyVersion <= acceptedBodyVersion + 1) return;
    let live = true;
    void client.listRevisions(artifactId).then(outcome => {
      if (!live || !outcome.ok) return;
      const revision = outcome.value.revisions.find(row => restoredDocEditVersion(baseBodyVersion,
        acceptedBodyVersion, row.bodyVersion, row.provenance?.restoredFromBodyVersion) !== null);
      if (revision) setRestored({ client, artifactId, acceptedBodyVersion, bodyVersion: revision.bodyVersion });
    });
    return () => { live = false; };
  }, [acceptedBodyVersion, admittedBodyVersion, artifactId, baseBodyVersion, client, known, restoredHead]);
  return restoredHead ?? known;
}
