import type { ApprovalExecutionOriginV1, ApprovalRequest } from '../../approvals/approvalRequestV1.js';
import { resolveApprovalExecutor } from '../../approvals/resolveApprovalExecutor.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';

type RetainedLogsReplayContext = Readonly<{
  externalActionExecutionAuthorization: NonNullable<ActionExecutorContext['externalActionExecutionAuthorization']>;
  machineServiceLogsResource: ActionExecutorContext['machineServiceLogsResource'];
}>;
type PreparedAuthorization = Awaited<ReturnType<NonNullable<ActionExecutorDeps['prepareApprovalExecutionAuthorization']>>>;

/** Only the unchanged, current original logs invocation retains private ports. */
export function resolveRetainedLogsReplayContext(input: Readonly<{
  retainsHostInvocation: boolean;
  retainedLogsLifetime: boolean;
  currentOrigin: ApprovalExecutionOriginV1 | undefined;
  context: ActionExecutorContext;
}>): RetainedLogsReplayContext | undefined {
  const { context, currentOrigin } = input;
  const authorization = context.externalActionExecutionAuthorization;
  return input.retainsHostInvocation && input.retainedLogsLifetime && currentOrigin && authorization
    && currentOrigin.externalActionExecutionAuthorization?.token === authorization.token
    && sameStrictJsonValue(currentOrigin.externalActionExecutionAuthorization.binding, authorization.binding)
    ? { externalActionExecutionAuthorization: authorization, machineServiceLogsResource: context.machineServiceLogsResource }
    : undefined;
}

/** Only detached replay reacquires private ports; retained custody was admitted with this execution. */
export async function prepareApprovalReplayAuthorization(input: Readonly<{
  request: ApprovalRequest;
  context: ActionExecutorContext;
  retainedLogs: boolean;
  prepare: ActionExecutorDeps['prepareApprovalExecutionAuthorization'];
}>): Promise<PreparedAuthorization | undefined> {
  // The retained live logs invocation keeps its private ports; its signed Home
  // root was admitted with this execution, before the executing claim.
  if (input.retainedLogs) return undefined;
  const authorization = input.context.externalActionExecutionAuthorization;
  return authorization && resolveApprovalExecutor(input.request).kind !== 'app' && input.prepare
    ? await input.prepare({ authorization, ...(input.context.signal ? { signal: input.context.signal } : {}) })
    : undefined;
}
