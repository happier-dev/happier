import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { publishActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationRuntime';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { HappyError } from '@/utils/errors/errors';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { createProjectManifestActionClient } from './projectManifestActionClient';
import { matchesRetainedCheckout } from '@/sync/ops/actions/projectSetupTrustConsent';

import type { ProjectSharedSetupChangeV1 } from '@happier-dev/protocol/projects/projectSetupChangeV1';
import type { ProjectSetupSetInputV1 } from '@happier-dev/protocol/projects/projectSetupSetV1';

export type ProjectSetupDecision = 'thisTime' | 'untilChanged' | 'skip';
export type ProjectSharedSetupUpdateRequest = Readonly<{
  projectRef: ProjectSetupSetInputV1['projectRef'];
  expectedRevision: ProjectSetupSetInputV1['expectedRevision'];
  review: Extract<ProjectSharedSetupChangeV1, { kind: 'changed' }>;
}>;

export type ProjectSetupConsentDecisionResult =
  | Readonly<{ kind: 'remembered'; operation: ActionOperationSnapshotV1 }>
  | Readonly<{ kind: 'continued' }>
  | Readonly<{ kind: 'changed' }>
  | Readonly<{ kind: 'unavailable'; code: string }>;

/**
 * All human setup choices enter the retained target's projects.prepare Action.
 * Its admitted effect owns Trust and refreshes the same retained producer.
 */
export async function decideProjectSetupConsent(
  input: Readonly<{
    scope: ServerAccountScope;
    workspace: WorkspaceAddressV1;
    reviewedEffectDigest: string;
    decision: ProjectSetupDecision;
    operation?: QualifiedActionOperation;
    signal?: AbortSignal;
    execute?: Parameters<typeof createProjectManifestActionClient>[0]['execute'];
    onApprovalPending?: Parameters<typeof createProjectManifestActionClient>[0]['onApprovalPending'];
  }>,
): Promise<ProjectSetupConsentDecisionResult> {
  const workspace = { ...input.workspace, serverId: resolveServerProfileScopeIdForIdentifier(input.workspace.serverId) };
  const retained = input.operation;
  if (!retained) return { kind: 'unavailable', code: 'project_setup_requester_review_unavailable' };
  if (retained.serverId !== input.scope.serverId || !matchesRetainedCheckout(retained.snapshot, retained.snapshot, input.scope, workspace)) {
    return { kind: 'unavailable', code: 'project_setup_review_unavailable' };
  }
  const target = retained.snapshot.domainRef;
  if (target?.kind !== 'projectCommand') return { kind: 'unavailable', code: 'project_setup_review_unavailable' };
  try {
    const client = createProjectManifestActionClient({
      workspace: { serverId: target.serverId, machineId: target.machineId, workspaceId: target.workspaceRefId, rootPath: target.cwd },
      expectedAccountId: input.scope.accountId, signal: input.signal, execute: input.execute, onApprovalPending: input.onApprovalPending,
    });
    const result = await client.prepare({ phase: target.purpose === 'teardown' ? 'teardown' : 'setup',
      heldOperationId: retained.snapshot.operationId, expectedEffectDigest: input.reviewedEffectDigest,
      ...(input.decision === 'skip' ? { skipForInvocation: true } : { consentScope: input.decision }),
    });
    if (!('operation' in result) || result.operation.operationId !== retained.snapshot.operationId
      || !matchesRetainedCheckout(result.operation, retained.snapshot, input.scope, workspace)) {
      return { kind: 'unavailable', code: 'project_setup_review_unavailable' };
    }
    const resumed = result.operation;
    publishActionOperationObservation({ serverId: retained.serverId, machineId: retained.snapshot.scope.machineId,
      observation: 'available', snapshots: [resumed] });
    if (resumed.setupReview) return resumed.setupReview.reviewedEffectDigest !== input.reviewedEffectDigest
      || resumed.setupReview.code === 'project_setup_effect_changed'
      ? { kind: 'changed' } : { kind: 'unavailable', code: resumed.setupReview.code };
    if (resumed.state === 'failed' || resumed.state === 'cancelled') return { kind: 'unavailable', code: resumed.error?.errorCode ?? 'cancelled' };
    return input.decision === 'untilChanged' ? { kind: 'remembered', operation: resumed } : { kind: 'continued' };
  } catch (error) {
    const code = (error instanceof HappyError ? error.code : readRpcErrorCode(error)) ?? 'project_setup_review_unavailable';
    return input.decision === 'untilChanged' && code === 'project_setup_effect_changed'
      ? { kind: 'changed' } : { kind: 'unavailable', code };
  }
}
