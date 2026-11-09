import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { APPROVAL_ARTIFACT_KINDS_V1, type ApprovalArtifactStateV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { settleApprovalRequestReplayInputs } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { deriveRetainedPluginObligationDuplicateKey, RETAINED_PLUGIN_OBLIGATION_ACTION_IDS } from '@happier-dev/protocol/approvals/creation';
import { readApprovalPassFailure, type ApprovalPassFailure } from './passFailure';

type Header = Readonly<Record<string, unknown>>;

/** The Account Artifact selection plus the canonical approval transition writer this pass uses. */
export type DuplicateOpenApprovalStore = Readonly<{
  list(options: Readonly<{ kinds: readonly string[]; approvalStates: readonly ApprovalArtifactStateV1[]; includeBody: true; headerFilter(header: Header): boolean }>):
    Promise<Readonly<{ items: readonly Readonly<{ artifactId: string; header: Header; body?: unknown }>[]; coverage: 'complete' | 'partial' }>>;
  approvalsUpdate: NonNullable<ActionExecutorDeps['approvalsUpdate']>;
}>;

/**
 * One-time owner settlement of open plugin Asks that a retried obligation filed once per attempt
 * before its approval identity was retained. Duplicates share the creation owner's retained
 * identity (`deriveRetainedPluginObligationDuplicateKey`); the newest of each group stays open and
 * the older ones are canceled through the approval transition owner (expected `open`, so a decision
 * that won the race is kept). Rows the owner cannot classify stay open. Canceled rows leave the
 * open selection, so a later run writes nothing.
 */
export async function cancelDuplicateOpenApprovals(input: Readonly<{ accountArtifactStore: DuplicateOpenApprovalStore }>) {
  const selected = await input.accountArtifactStore.list({ kinds: [APPROVAL_ARTIFACT_KINDS_V1.builtIn], approvalStates: ['open'],
    includeBody: true, headerFilter: header => (RETAINED_PLUGIN_OBLIGATION_ACTION_IDS as readonly unknown[]).includes(header.actionId) });
  const groups = new Map<string, Array<Readonly<{ artifactId: string; request: ApprovalRequest }>>>();
  let unclassified = 0;
  for (const listed of selected.items) {
    const parsed = typeof listed.body === 'string' ? approvalArtifactBodyMatchesHeaderV1(listed.header, listed.body) : null;
    const key = parsed?.family === 'built_in' && parsed.request.status === 'open'
      ? deriveRetainedPluginObligationDuplicateKey(parsed.request) : null;
    if (!parsed || parsed.family !== 'built_in' || key === null) { unclassified++; continue; }
    const group = groups.get(key) ?? [];
    group.push({ artifactId: listed.artifactId, request: parsed.request });
    groups.set(key, group);
  }
  let duplicateGroups = 0;
  let canceled = 0;
  let alreadySettled = 0;
  const failures = new Map<string, ApprovalPassFailure & { count: number }>();
  const fail = (failure: ApprovalPassFailure) => {
    const key = JSON.stringify([failure.errorClass, failure.errorCode ?? null, failure.status ?? null]);
    const entry = failures.get(key) ?? { ...failure, count: 0 };
    entry.count++;
    failures.set(key, entry);
  };
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    duplicateGroups++;
    const [, ...older] = [...group].sort((a, b) => b.request.createdAtMs - a.request.createdAtMs
      || (a.artifactId < b.artifactId ? 1 : a.artifactId > b.artifactId ? -1 : 0));
    for (const { artifactId, request } of older) {
      try {
        const updated = await input.accountArtifactStore.approvalsUpdate({ artifactId, serverId: null, expectedStatus: 'open',
          request: { ...settleApprovalRequestReplayInputs(request), status: 'canceled', updatedAtMs: Math.max(Date.now(), request.updatedAtMs) } });
        if (updated.ok) canceled++;
        // The transition owner refused because the row is no longer open: another daemon of the
        // Account canceled it first, or a person decided it. Nothing is left for this pass to do.
        else if (updated.errorCode === 'invalid_transition') alreadySettled++;
        else fail({ errorClass: 'ApprovalUpdateRefused', errorCode: updated.errorCode });
      } catch (error) { fail(readApprovalPassFailure(error)); }
    }
  }
  const failed = [...failures.values()].reduce((sum, entry) => sum + entry.count, 0);
  return { groups: duplicateGroups, canceled, alreadySettled, unclassified, failed, coverage: selected.coverage,
    ...(failed ? { failures: [...failures.values()] } : {}) };
}
