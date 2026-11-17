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
import type { ProjectSetupSetInputV1, ProjectSetupSetOutputV1 } from '@happier-dev/protocol/projects/projectSetupSetV1';
import type { ProjectPrepareResultV1 } from '@happier-dev/protocol/actions/projectActionFamily';

export type ProjectSetupDecision = 'thisTime' | 'untilChanged' | 'skip';
export type ProjectSharedSetupUpdateDecision = 'keep' | Exclude<ProjectSetupDecision, 'skip'>;
export type ProjectSharedSetupUpdateRequest = Readonly<{
  projectRef: ProjectSetupSetInputV1['projectRef'];
  expectedRevision: ProjectSetupSetInputV1['expectedRevision'];
  review: Extract<ProjectSharedSetupChangeV1, { kind: 'changed' }>;
}>;
type AcceptedSetup = Extract<ProjectSetupSetOutputV1, { ok: true }>;
export type ProjectSharedSetupUpdateDecisionResult =
  | Readonly<{ kind: 'kept' }>
  | Readonly<{ kind: 'unavailable'; code: string }>
  | Readonly<{ kind: 'accepted'; setup: AcceptedSetup; preparation: ProjectPrepareResultV1 }>
  | Readonly<{ kind: 'acceptedConsentUnavailable'; setup: AcceptedSetup; code: string }>;

/** One human update choice commits the reviewed copy, then enters the existing preparation owner.
 * The controller consumes that operation's pushed review to finish the same choice; no Trust is
 * written from proposed facts and a failed preparation leaves its accepted-copy receipt visible.
 */
export async function decideProjectSharedSetupUpdate(input: ProjectSharedSetupUpdateRequest & Readonly<{
  scope: ServerAccountScope;
  workspace: WorkspaceAddressV1;
  decision: ProjectSharedSetupUpdateDecision;
  signal?: AbortSignal;
  execute?: Parameters<typeof createProjectManifestActionClient>[0]['execute'];
  onApprovalPending?: Parameters<typeof createProjectManifestActionClient>[0]['onApprovalPending'];
}>): Promise<ProjectSharedSetupUpdateDecisionResult> {
  if (input.decision === 'keep') return { kind: 'kept' };
  const readiness = input.review.setupReadiness;
  const reviewedEffectDigest = readiness.kind === 'notRequired'
    ? readiness.reviewedEffectDigest : input.review.setupReview?.reviewedEffectDigest;
  if (!reviewedEffectDigest) return { kind: 'unavailable',
    code: readiness.kind === 'unknown' || readiness.kind === 'needsReview' ? readiness.code : 'project_setup_review_unavailable' };
  const client = createProjectManifestActionClient({ workspace: input.workspace, expectedAccountId: input.scope.accountId,
    signal: input.signal, execute: input.execute, onApprovalPending: input.onApprovalPending });
  let setup: AcceptedSetup | undefined;
  try {
    const accepted = await client.setSetup({ projectRef: input.projectRef, expectedRevision: input.expectedRevision,
      intent: { kind: 'accept', sourceId: input.review.selection.sourceId, expectedSelection: input.review.selection } });
    if (!accepted.ok) return { kind: 'unavailable', code: accepted.errorCode };
    setup = accepted;
    if (readiness.kind === 'notRequired') return { kind: 'accepted', setup,
      preparation: { kind: 'notRequired', reviewedEffectDigest: readiness.reviewedEffectDigest } };
    const preparation = await client.prepare({ phase: 'setup', expectedEffectDigest: reviewedEffectDigest });
    return { kind: 'accepted', setup, preparation };
  } catch (error) {
    const code = (error instanceof HappyError ? error.code : readRpcErrorCode(error)) ?? 'project_setup_review_unavailable';
    return setup ? { kind: 'acceptedConsentUnavailable', setup, code } : { kind: 'unavailable', code };
  }
}

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
