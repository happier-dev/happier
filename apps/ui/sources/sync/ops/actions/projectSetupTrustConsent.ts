import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { rememberAdmittedProjectSetupConsentV1, type RememberProjectSetupConsentResult } from '@happier-dev/protocol/workspaces/projectSetup/projectSetupConsent';
export { matchesRetainedCheckout, type RememberProjectSetupConsentResult } from '@happier-dev/protocol/workspaces/projectSetup/projectSetupConsent';

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
    if (response.kind !== 'found') return null;
    return response.operation;
  };
  try {
    return await rememberAdmittedProjectSetupConsentV1({ scope: input.scope, workspace,
      reviewedEffectDigest: input.reviewedEffectDigest, operation: retained.snapshot, project,
      refreshOperation: refresh,
      observeOperation: operation => publishActionOperationObservation({ serverId: retained.serverId, machineId: retained.snapshot.scope.machineId,
        observation: 'available', snapshots: [operation] }),
      readTrust: () => readProjectTrust(input.scope, project, input.signal),
      rememberEffect: value => rememberReviewedProjectEffect(input.scope, value, input.signal),
    });
  } catch (error) {
    if (error instanceof ProjectTrustOperationError) {
      return error.code === 'project_setup_effect_changed'
        ? { kind: 'changed' }
        : { kind: 'unavailable', code: error.code };
    }
    return { kind: 'unavailable', code: (error instanceof HappyError ? error.code : readRpcErrorCode(error)) ?? 'project_setup_requester_review_unavailable' };
  }
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
