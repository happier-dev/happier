import { ActionApprovalRequestCreatedResultSchema, isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { prepareActionCompletionV1 } from '@happier-dev/protocol/actions/actionCompletion';
import { ApprovalRequestPublicReadSchema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowInvocationRecoveryObservation } from './recovery';
import { isWorkflowJsonObject } from './input';

type ActionExecution = Extract<NonNullable<WorkflowProgressEnvelopeV1['execution']>, { kind: 'action' }>;

/** The retained envelope identifies custody; only the approval owner can settle its effect. */
export async function readWorkflowActionApprovalSettlement(params: Readonly<{
  /** Host settlement reads are limited to this admitted Run's exact recorded invocation. */
  runId: string;
  execution: ActionExecution;
  read: (artifactId: string) => Promise<unknown>;
}>): Promise<WorkflowInvocationRecoveryObservation | null> {
  const envelope = ActionApprovalRequestCreatedResultSchema.safeParse(params.execution.output);
  if (!envelope.success) return null;
  const builtin = envelope.data.actionId === params.execution.actionId && envelope.data.actionId !== 'action.invoke';
  if (!builtin && envelope.data.actionId !== 'action.invoke') return null;
  const wrapped = params.execution.actionId === 'action.invoke'
    ? PluginContributionIdentityV1Schema.safeParse(params.execution.input.action) : null;
  const identity = wrapped?.success ? wrapped.data : parseQualifiedPluginActionId(params.execution.actionId);
  if (!builtin && !identity) return { kind: 'unresolved', code: 'approval_unavailable' };
  try {
    const raw = await params.read(envelope.data.artifactId);
    const body = isWorkflowJsonObject(raw) ? raw : null;
    const request = ApprovalRequestPublicReadSchema.safeParse(body?.request);
    if (!request.success) {
      return { kind: 'unresolved', code: 'approval_unavailable' };
    }
    const origin = 'executionOriginV1' in request.data ? request.data.executionOriginV1 : undefined;
    if (body?.artifactId !== envelope.data.artifactId || origin?.caller.kind !== 'workflowRun'
      || origin.caller.runId !== params.runId || origin.requestId !== params.execution.actionRequestId
      || origin.actionId !== envelope.data.actionId) {
      return { kind: 'unresolved', code: 'approval_unavailable' };
    }
    if (builtin) {
      const core = 'actionArgs' in request.data ? request.data : null;
      if (core?.v !== 2 || core.actionId !== params.execution.actionId
        || core.executionOriginV1.requestId !== params.execution.actionRequestId) {
        return { kind: 'unresolved', code: 'approval_unavailable' };
      }
    } else if (!identity || !('qualifiedActionId' in request.data)
      || request.data.qualifiedActionId !== formatQualifiedPluginActionId(identity)) {
      return { kind: 'unresolved', code: 'approval_unavailable' };
    }
    if (request.data.status === 'rejected') return { kind: 'failed', code: 'approval_rejected' };
    if (request.data.status === 'canceled') return { kind: 'failed', code: 'approval_canceled' };
    const execution = request.data.execution;
    if (!execution) return { kind: 'unresolved', code: 'approval_required' };
    if (request.data.status === 'outcome_unknown' || !execution.ok && isActionOutcomeUnknownErrorCodeV1(execution.errorCode)) {
      return { kind: 'outcome_uncertain', code: execution.errorCode ?? 'approval_execution_outcome_unknown' };
    }
    const completion = prepareActionCompletionV1(undefined, execution.ok ? { ok: true, result: execution.result }
      : { ok: false, errorCode: execution.errorCode ?? 'action_failed', error: execution.error ?? 'action_failed',
        ...('details' in execution ? { details: execution.details } : {}),
        ...('failureCause' in execution ? { failureCause: execution.failureCause } : {}) });
    if (completion.kind === 'completed') return { kind: 'completed', result: completion.value };
    if (completion.kind === 'awaiting') return { kind: 'outcome_uncertain', code: 'outcome_uncertain' };
    return { kind: 'failed', code: completion.errorCode,
      ...('value' in completion && completion.value !== undefined ? { result: completion.value } : {}),
      ...('failureCause' in completion && completion.failureCause !== undefined ? { failureCause: completion.failureCause } : {}),
      ...('error' in completion && completion.error !== undefined ? { message: completion.error } : {}) };
  } catch {
    return { kind: 'unresolved', code: 'approval_unavailable' };
  }
}
