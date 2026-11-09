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
import { HappyError } from '@/utils/errors/errors';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

export type RememberProjectSetupConsentResult =
  | Readonly<{ kind: 'remembered'; operation: ActionOperationSnapshotV1 }>
  | Readonly<{ kind: 'changed' }>
  | Readonly<{ kind: 'unavailable'; code: string }>;

/** The projects.prepare effect, reached only after present-user Action admission. */
export async function rememberAdmittedProjectSetupConsent(input: Readonly<{
  scope: ServerAccountScope;
  workspace: WorkspaceAddressV1;
  reviewedEffectDigest: string;
  operation: QualifiedActionOperation;
  signal?: AbortSignal;
}>): Promise<RememberProjectSetupConsentResult> {
  const workspace = { ...input.workspace, serverId: resolveServerProfileScopeIdForIdentifier(input.workspace.serverId) };
  const retained = input.operation;
  const projectId = resolveProjectSetupProjectId(input.scope, workspace);
  if (!projectId) return { kind: 'unavailable', code: 'project_unavailable' };
  const project = { serverId: workspace.serverId, projectId };
  const refresh = async () => {
    if (input.signal?.aborted) throw new ProjectTrustOperationError('cancelled');
    const response = await getActionOperation({ serverId: retained.serverId, accountId: input.scope.accountId,
      machineId: retained.snapshot.scope.machineId, operationId: retained.snapshot.operationId,
      requireCurrentDomainFacts: true, refreshSetupReview: true, signal: input.signal });
    if (input.signal?.aborted) throw new ProjectTrustOperationError('cancelled');
    if (response.kind !== 'found' || !matchesRetainedCheckout(response.operation, retained.snapshot, input.scope, workspace)) return null;
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
    return { kind: 'remembered', operation: resumed };
  } catch (error) {
    if (error instanceof ProjectTrustOperationError) {
      return error.code === 'project_setup_effect_changed'
        ? { kind: 'changed' }
        : { kind: 'unavailable', code: error.code };
    }
    return { kind: 'unavailable', code: (error instanceof HappyError ? error.code : readRpcErrorCode(error)) ?? 'project_setup_requester_review_unavailable' };
  }
}

/** Bind the current target review to the same retained invocation and its original Source checkout. */
export function matchesRetainedCheckout(
  current: ActionOperationSnapshotV1,
  retained: ActionOperationSnapshotV1,
  scope: ServerAccountScope,
  workspace: WorkspaceAddressV1,
): boolean {
  const target = current.domainRef;
  const original = retained.domainRef;
  if (target?.kind !== 'projectCommand' || original?.kind !== 'projectCommand') return false;
  // Once review clears, the same invocation's producer may project only its target.
  // Its validated retained review still binds Source; a supplied Source must match.
  const source = target.sourceWorkspace ?? (!current.setupReview ? original.sourceWorkspace : undefined);
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
  const resolved = resolveWorkspaceRefV1(rows?.workspaceRefs ?? [], workspace, {
    normalizeServerId: resolveServerProfileScopeIdForIdentifier,
  });
  return resolved.kind === 'resolved' ? resolved.ref.projectKey ?? null : null;
}
