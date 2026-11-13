import type { ActionExecutorDeps, TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { resolveApprovalExecutor } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { settleApprovalRequestReplayInputs } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { targetActionOutcomeUnknown } from './targetActionSettlement';

/** Exclusive daemon startup retires only this daemon's previous execution claims. */
export async function recoverExecutingApprovals(input: Readonly<{
  machineId: string;
  accountArtifactStore: Pick<ReturnType<typeof createAccountArtifactStore>, 'list'>;
  approvalsUpdate: NonNullable<ActionExecutorDeps['approvalsUpdate']>;
  targetActionApprovalsUpdate(args: Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>): Promise<Readonly<{ ok: boolean }>>;
}>) {
  // One Account/Home-scoped selection; hydrate only this Machine's claims.
  const selected = await input.accountArtifactStore.list({
    kinds: [APPROVAL_ARTIFACT_KINDS_V1.targetAction, APPROVAL_ARTIFACT_KINDS_V1.builtIn],
    approvalStates: ['executing'], includeBody: true,
    headerFilter: header => header.machineId === input.machineId,
  });
  let settled = 0;
  let failed = 0;
  for (const artifact of selected.items) {
    const parsed = typeof artifact.body === 'string'
      ? approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body) : null;
    if (!parsed || parsed.family === 'execution_run_host_action') { failed++; continue; }
    // Only current (v2) built-in requests resolve to a daemon executor; legacy rows are never replay claims.
    if (parsed.family === 'built_in' && parsed.request.v !== 2) continue;
    const executor = resolveApprovalExecutor(parsed.request);
    // A restart cannot retire an app or original Session/CLI invocation.
    if (parsed.request.status !== 'executing' || executor.kind !== 'daemon'
      || executor.machineId !== input.machineId) continue;
    try {
      const executedAtMs = Math.max(Date.now(), parsed.request.updatedAtMs);
      const result = parsed.family === 'target_action'
        ? await input.targetActionApprovalsUpdate({ artifactId: artifact.artifactId,
          request: targetActionOutcomeUnknown(parsed.request, executedAtMs) })
        : await input.approvalsUpdate({ artifactId: artifact.artifactId, serverId: null, expectedStatus: 'executing',
          request: { ...settleApprovalRequestReplayInputs(parsed.request), status: 'outcome_unknown', updatedAtMs: executedAtMs,
            execution: { executedAtMs, ok: false,
              errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' } } });
      if (result.ok) settled++;
      else failed++;
    } catch { failed++; }
  }
  return { settled, failed, coverage: selected.coverage };
}
