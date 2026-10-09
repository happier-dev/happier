import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { normalizeWorkspaceRootPathV1, resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import {
  ProjectTrustOperationError,
  readProjectTrust,
  rememberReviewedProjectEffect,
} from '@/sync/api/account/apiProjectTrust';
import { storage } from '@/sync/domains/state/storage';
import { readCurrentProjectAccountRows } from '@/sync/store/domains/projectAccountRows';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { publishActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationRuntime';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';

export type ProjectSetupConsentDecisionResult =
  | Readonly<{ kind: 'remembered' }>
  | Readonly<{ kind: 'changed' }>
  | Readonly<{ kind: 'unavailable'; code: string }>;

/**
 * "Until it changes" (D18): the reviewing person's own grant for this Project's exact reviewed setup
 * effect, written through the approving Account's Project Trust row. It is the only producer of that
 * grant on the client; a held original invocation resumes from the daemon's own trust read, never from
 * this call's result. The Project is the checkout's accepted Project association, never a Machine.
 */
export async function rememberProjectSetupConsent(
  input: Readonly<{
    scope: ServerAccountScope;
    workspace: WorkspaceAddressV1;
    reviewedEffectDigest: string;
    operation?: QualifiedActionOperation;
    signal?: AbortSignal;
  }>,
): Promise<ProjectSetupConsentDecisionResult> {
  const projectId = resolveProjectSetupProjectId(input.scope, input.workspace);
  if (!projectId) return { kind: 'unavailable', code: 'project_unavailable' };
  const retained = input.operation;
  if (!retained) return { kind: 'unavailable', code: 'project_setup_requester_review_unavailable' };
  if (retained.serverId !== input.scope.serverId || !matchesRetainedCheckout(retained.snapshot, retained.snapshot, input.scope, input.workspace)) {
    return { kind: 'unavailable', code: 'project_setup_review_unavailable' };
  }
  const project = { serverId: input.workspace.serverId, projectId };
  const refresh = async () => {
    if (input.signal?.aborted) throw new ProjectTrustOperationError('cancelled');
    const response = await getActionOperation({ serverId: retained.serverId, accountId: input.scope.accountId,
      machineId: retained.snapshot.scope.machineId, operationId: retained.snapshot.operationId, requireCurrentDomainFacts: true });
    if (input.signal?.aborted) throw new ProjectTrustOperationError('cancelled');
    if (response.kind !== 'found' || !matchesRetainedCheckout(response.operation, retained.snapshot, input.scope, input.workspace)) return null;
    publishActionOperationObservation({ serverId: retained.serverId, machineId: retained.snapshot.scope.machineId,
      observation: 'available', snapshots: [response.operation] });
    return response.operation;
  };
  try {
    // The retained producer remeasures the actual target's review before any Trust read or CAS.
    // A displayed digest (or an already matching grant) is not current review evidence.
    const before = await refresh();
    if (!before?.setupReview) return { kind: 'unavailable', code: before?.error?.errorCode ?? 'project_setup_review_unavailable' };
    const currentEffectDigest = before.setupReview.reviewedEffectDigest;
    if (currentEffectDigest !== input.reviewedEffectDigest) return { kind: 'changed' };
    const current = await readProjectTrust(input.scope, project, input.signal);
    if (!(
      current.status === 'present' &&
      current.value.reviewedEffectDigest === input.reviewedEffectDigest
    )) {
      const response = await rememberReviewedProjectEffect(
        input.scope,
        {
          project,
          reviewedEffectDigest: input.reviewedEffectDigest,
          currentEffectDigest,
          approvedAtMs: Date.now(),
          expectedRevision:
            current.status === 'absent' ? 'absent' : current.revision,
        },
        input.signal,
      );
      if (response.status !== 'updated') return { kind: 'changed' };
    }
    // Reading the same retained owner wakes its original wait only if canonical review now consents.
    // A changed effect can rehold after the Trust write and must never become a local Allowed line.
    const resumed = await refresh();
    if (!resumed) return { kind: 'unavailable', code: 'project_setup_review_unavailable' };
    if (resumed.setupReview) return resumed.setupReview.reviewedEffectDigest !== input.reviewedEffectDigest
      ? { kind: 'changed' } : { kind: 'unavailable', code: resumed.setupReview.code };
    if (resumed.state === 'failed' || resumed.state === 'cancelled') {
      return { kind: 'unavailable', code: resumed.error?.errorCode ?? 'cancelled' };
    }
    return { kind: 'remembered' };
  } catch (error) {
    if (error instanceof ProjectTrustOperationError) {
      return error.code === 'project_setup_effect_changed'
        ? { kind: 'changed' }
        : { kind: 'unavailable', code: error.code };
    }
    return { kind: 'unavailable', code: readRpcErrorCode(error) ?? 'project_setup_requester_review_unavailable' };
  }
}

/** Bind the current target review to the same retained invocation and its original Source checkout. */
function matchesRetainedCheckout(
  current: ActionOperationSnapshotV1,
  retained: ActionOperationSnapshotV1,
  scope: ServerAccountScope,
  workspace: WorkspaceAddressV1,
): boolean {
  const target = current.domainRef;
  const original = retained.domainRef;
  if (target?.kind !== 'projectCommand' || original?.kind !== 'projectCommand') return false;
  const source = target.sourceWorkspace;
  return current.operationId === retained.operationId && current.actionId === retained.actionId
    && current.scope.accountId === scope.accountId && current.scope.machineId === retained.scope.machineId
    && target.serverId === scope.serverId && target.machineId === current.scope.machineId
    && target.workspaceRefId === original.workspaceRefId
    && (!current.setupReview || normalizeWorkspaceRootPathV1(target.cwd) === normalizeWorkspaceRootPathV1(original.cwd))
    && source !== undefined && source.serverId === scope.serverId && source.serverId === workspace.serverId
    && source.machineId === workspace.machineId && source.workspaceId === workspace.workspaceId
    && normalizeWorkspaceRootPathV1(source.rootPath) === normalizeWorkspaceRootPathV1(workspace.rootPath);
}

/** The accepted Project of a qualified checkout (its workspace row's Project association). */
function resolveProjectSetupProjectId(
  scope: ServerAccountScope,
  workspace: WorkspaceAddressV1,
): string | null {
  const rows = readCurrentProjectAccountRows({
    projectAccountRows: storage.getState().projectAccountRows,
    profileScope: scope,
  });
  const resolved = resolveWorkspaceRefV1(rows?.workspaceRefs ?? [], workspace);
  return resolved.kind === 'resolved' ? resolved.ref.projectKey ?? null : null;
}
