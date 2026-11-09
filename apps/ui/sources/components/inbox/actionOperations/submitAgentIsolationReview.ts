import { MachineAgentIsolationSetResultV1Schema, type MachineAgentIsolationSetInputV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';

import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { publishActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationRuntime';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';

import type { AgentIsolationReviewDetail } from './actionOperationDetailPresentation';

const SET_ACTION_ID = 'machines.agentIsolation.set' as const;

export type AgentIsolationReviewSubmission =
  /** The set was accepted (or already true); the operation's own progress reports the rest. */
  | Readonly<{ kind: 'applying' }>
  /** The reviewed effects no longer match. Never retried here; the person reviews the current ones. */
  | Readonly<{ kind: 'review_changed' }>
  /** The Account's own setting asked first; the set runs once someone approves it. */
  | Readonly<{ kind: 'approval_requested'; artifactId: string }>
  /** The owner could not confirm the elevated effects. Nonterminal: nothing here may replay it. */
  | Readonly<{ kind: 'outcome_unknown' }>
  | Readonly<{
      kind: 'refused';
      code: 'denied' | 'cancelled' | 'locked' | 'invalid' | 'unavailable';
    }>
  | Readonly<{ kind: 'failed'; errorCode: string }>;

/**
 * "Approve and apply": the person's own press is the approval of the exact reviewed effects. It submits
 * the same set the review describes (the held operation's Machine, desired policy, current policy,
 * metadata version and plan digest) on the held operation's ORIGINAL action-request identity, so the
 * operation owner resumes that operation instead of starting a second one.
 */
export async function submitAgentIsolationReview(
  input: Readonly<{
    operation: QualifiedActionOperation;
    detail: AgentIsolationReviewDetail;
    execute: FrontDoorActionExecute;
    signal?: AbortSignal;
  }>,
): Promise<AgentIsolationReviewSubmission> {
  const { snapshot, serverId } = input.operation;
  const { review, requestId } = input.detail;
  if (!requestId)
    return { kind: 'failed', errorCode: 'action_operation_unavailable' };
  const result = await input.execute(
    SET_ACTION_ID,
    {
      ...(serverId ? { serverId } : {}),
      machineId: review.machineId,
      enabled: review.enabled,
      ...(review.current.plan.memberProvisioning
        ? { memberProvisioning: review.current.plan.memberProvisioning }
        : {}),
      expectedPolicy: review.current.policy,
      expectedMetadataVersion: review.current.metadataVersion,
      expectedPlanDigest: review.current.plan.planDigest,
    } satisfies MachineAgentIsolationSetInputV1,
    {
      surface: 'ui',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
      ...(serverId ? { serverId } : {}),
      expectedAccountId: snapshot.scope.accountId,
      actionRequestId: requestId,
      presentUserConfirmation: { actionId: SET_ACTION_ID },
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (!result.ok) {
    return result.errorCode === 'action_request_input_conflict' ||
      result.errorCode === 'action_operation_unavailable'
      ? { kind: 'review_changed' }
      : { kind: 'failed', errorCode: result.errorCode };
  }
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
  if (approval.success)
    return { kind: 'approval_requested', artifactId: approval.data.artifactId };
  const parsed = MachineAgentIsolationSetResultV1Schema.safeParse(
    result.result,
  );
  if (!parsed.success)
    return { kind: 'failed', errorCode: 'invalid_action_output' };
  switch (parsed.data.kind) {
    case 'accepted':
    case 'unchanged':
      return { kind: 'applying' };
    case 'plan_changed':
    case 'conflict':
      return { kind: 'review_changed' };
    case 'failed':
      return parsed.data.code === 'outcome_unknown'
        ? { kind: 'outcome_unknown' }
        : { kind: 'refused', code: parsed.data.code };
  }
}

/** Re-review: read the owner's current operation (its review carries the fresh effects) into the store. */
export async function refreshAgentIsolationReview(
  operation: QualifiedActionOperation,
  signal: AbortSignal | undefined,
  execute: FrontDoorActionExecute,
): Promise<boolean> {
  const { snapshot, serverId } = operation;
  const result = await execute('action.operations.get', {
    machineId: snapshot.scope.machineId,
    ...(serverId ? { serverId } : {}),
    operationId: snapshot.operationId,
    refreshSetupReview: true,
  }, {
    surface: 'ui',
    authority: 'present_user',
    actionCaller: { kind: 'host' },
    ...(serverId ? { serverId } : {}),
    expectedAccountId: snapshot.scope.accountId,
    ...(signal ? { signal } : {}),
  });
  if (!result.ok) return false;
  const response = ActionOperationGetV1ResponseSchema.safeParse(result.result);
  if (!response.success || response.data.kind !== 'found') return false;
  publishActionOperationObservation({
    serverId,
    machineId: snapshot.scope.machineId,
    observation: 'available',
    snapshots: [response.data.operation],
  });
  return true;
}
