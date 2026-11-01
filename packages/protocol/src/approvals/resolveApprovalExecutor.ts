import { ActionIdSchema } from '../actions/actionIds.js';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '../actions/actionSpecs.js';
import { isSessionDiscussionApprovalPublicationV1, type ApprovalRequest } from './approvalRequestV1.js';
import type { TargetActionApprovalRequestV1 } from './targetActionApprovalRequestV1.js';
import { ConfidentialActionInputReviewV1Schema } from './privateSecretContinuationV1.js';
import { readRecord } from '../inputs/inputRecords.js';
import { isNativeSecretFillAction } from '../actions/executor/confidentialInputs.js';
import { deploymentOperationForRootActionV1 } from '../deployments/deploymentActionIdsV1.js';

export type ApprovalExecutor =
  | Readonly<{ kind: 'app'; placement: 'account' | 'client' }>
  | Readonly<{ kind: 'daemon'; machineId: string; sessionId?: string }>
  | Readonly<{ kind: 'live_invocation'; daemonMachineId?: string }>
  | Readonly<{ kind: 'unavailable'; reason: 'legacy_request' | 'invalid_input' | 'missing_machine' }>;

function isTargetApproval(request: ApprovalRequest | TargetActionApprovalRequestV1): request is TargetActionApprovalRequestV1 {
  return 'kind' in request && request.kind === 'plugin_target_action';
}

/** Location, not admission: the chosen executor still runs ordinary Action admission. */
export function resolveApprovalExecutor(request: ApprovalRequest | TargetActionApprovalRequestV1): ApprovalExecutor {
  if (isTargetApproval(request)) {
    if (request.approvalInputCustody === 'live_only') {
      const daemonMachineId = request.replayPlacement?.machineId.trim() ?? request.executionOriginV1?.machineId?.trim();
      return { kind: 'live_invocation', ...(daemonMachineId ? { daemonMachineId } : {}) };
    }
    const machineId = request.replayPlacement?.machineId.trim();
    return machineId ? { kind: 'daemon', machineId,
      ...(request.replayPlacement?.defaultSessionId ? { sessionId: request.replayPlacement.defaultSessionId } : {}) }
      : { kind: 'unavailable', reason: 'missing_machine' };
  }
  if (request.v !== 2) return { kind: 'unavailable', reason: 'legacy_request' };
  const actionId = ActionIdSchema.safeParse(request.actionId);
  if (!actionId.success) return { kind: 'unavailable', reason: 'invalid_input' };
  const spec = getActionSpec(actionId.data);
  const origin = request.executionOriginV1;
  if (ConfidentialActionInputReviewV1Schema.safeParse(readRecord(request.preview).confidentialInputs).success) {
    return { kind: 'live_invocation', ...(origin.machineId ? { daemonMachineId: origin.machineId } : {}) };
  }
  // Private operands/results and host-retained closures cannot be reconstructed
  // from an Artifact. Their authenticated decision resumes the original waiter.
  if (spec.approvalInputCustody === 'live_only' || spec.approvalResultCustody === 'live_only'
    // The person's value or Saved Secret selection is supplied only to the
    // authenticated confidential continuation, never to durable replay.
    || isNativeSecretFillAction(actionId.data)
    || request.approval?.flow === 'blocking'
      && (origin.surface === 'ui' || origin.surface === 'cli' || origin.surface === 'plugin')
      && (origin.caller.kind === 'host' || origin.caller.kind === 'plugin')) {
    const appOrTerminalInvocation = !origin.externalActionExecutionAuthorization
      && (origin.caller.kind === 'host' || origin.caller.kind === 'plugin')
      && (origin.surface === 'ui' || origin.surface === 'voice' || origin.surface === 'plugin' || origin.surface === 'cli');
    const daemonMachineId = appOrTerminalInvocation ? undefined : origin.machineId?.trim();
    return { kind: 'live_invocation', ...(daemonMachineId ? { daemonMachineId } : {}) };
  }
  const input = spec.inputSchema.safeParse(request.actionArgs);
  if (!input.success) return { kind: 'unavailable', reason: 'invalid_input' };
  // Workflow model invitations reserve a slot; the Workflow owns Session start.
  // Keep that caller on its daemon, just as Session publications keep theirs.
  // Ordinary Account proposals still belong to the deciding app.
  const placement = isSessionDiscussionApprovalPublicationV1(request)
    ? 'session'
    : actionId.data === 'discussion.invite' && origin.caller.kind === 'workflowRun'
      && origin.caller.discussionModelReservation
      ? 'machine' : resolveActionExecutionPlacementForInput(spec, input.data);
  // Native deployment roots and managed bootstrap recovery return to their controller, including
  // public read projections that omit private replay authorization. The daemon
  // reads that custody from the original Artifact; location grants no authority.
  // Ordinary Account proposals keep their app executor.
  if ((deploymentOperationForRootActionV1(actionId.data) !== undefined
      || actionId.data === 'machines.managed.bootstrap.retry'
      || actionId.data === 'machines.managed.power.set' && readRecord(input.data).when === 'now'
        && origin.externalActionExecutionAuthorization?.binding.actionId === actionId.data)
    && origin.target?.kind === 'machine') return { kind: 'daemon', machineId: origin.target.machineId };
  if (placement === 'account' || placement === 'client') return { kind: 'app', placement };
  const machineId = origin.machineId?.trim()
    || (origin.target?.kind === 'machine' ? origin.target.machineId.trim() : '');
  if (!machineId) return { kind: 'unavailable', reason: 'missing_machine' };
  const sessionId = placement === 'session'
    ? origin.target?.kind === 'session' ? origin.target.sessionId
      : origin.sessionId ?? (origin.caller.kind === 'session' ? origin.caller.sessionId : undefined)
    : undefined;
  return { kind: 'daemon', machineId, ...(sessionId ? { sessionId } : {}) };
}
