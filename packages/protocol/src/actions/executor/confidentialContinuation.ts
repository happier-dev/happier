import { StoredApprovalRequestSchema, type ApprovalRequest } from '../../approvals/approvalRequestV1.js';
import { ConfidentialActionInputReviewV1Schema, PrivateConfidentialContinuationV1Schema, type PrivateConfidentialContinuationV1, type PrivateSecretContinuationV1, type PrivateActionInputContinuationV1 } from '../../approvals/privateSecretContinuationV1.js';
import type { ActionId } from '../actionIds.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { isApiTokenGrantTargetMemberV1 } from '../../auth/apiTokenGrant.js';
import type { ActionExecuteFailure, ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { buildActionExecuteResultFromRecordedApprovalExecution } from './approvalResults.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { readInputPath } from '../../inputs/inputPredicates.js';

export async function isDecidingHumanAdmissionCurrent(ctx: ActionExecutorContext): Promise<boolean> {
  if (ctx.signal?.aborted) return false;
  try {
    const admitted = !ctx.verifyMachineAdmissionCurrent || await ctx.verifyMachineAdmissionCurrent();
    return admitted && !ctx.signal?.aborted;
  } catch {
    return false;
  }
}

/** Private choice admission shares the ordinary approval claim and execution owner. */
export function createConfidentialApprovalContinuation(deps: Pick<ActionExecutorDeps, 'approvalsGet' | 'approvalsUpdate'> & Readonly<{
  isActionEnabled(actionId: ActionId, context: ActionExecutorContext): boolean;
  declaredInputPaths(actionId: ActionId, input: unknown): readonly string[];
  isOriginCurrent(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean>;
  executeApproved(args: Readonly<{
    artifactId: string; request: ApprovalRequest; artifactServerId: string;
    ctx: ActionExecutorContext; privateSecretContinuation?: PrivateSecretContinuationV1;
    privateActionInputContinuation?: PrivateActionInputContinuationV1; observeExecution: true;
  }>): Promise<Readonly<{ ok: true; exec: ActionExecuteResult }> | ActionExecuteFailure>;
}>) {
  return async (input: unknown, ctx: ActionExecutorContext = {}): Promise<ActionExecuteResult> => {
    if (ctx.authority !== 'present_user') {
      return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
    }
    const parsed = PrivateConfidentialContinuationV1Schema.safeParse(input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    if (!deps.approvalsGet || !deps.approvalsUpdate) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    }
    let continuation: PrivateConfidentialContinuationV1 | null = parsed.data;
    try {
      const raw = await deps.approvalsGet({ artifactId: continuation.artifactId, serverId: null });
      const stored = StoredApprovalRequestSchema.safeParse(raw);
      if (!stored.success || stored.data.v !== 2) {
        return { ok: false, errorCode: raw ? 'approval_invalid' : 'approval_not_found', error: raw ? 'approval_invalid' : 'approval_not_found' };
      }
      let request: ApprovalRequest = stored.data;
      const origin = stored.data.executionOriginV1;
      const homeId = origin.serverIdentityId ?? origin.serverId;
      if (request.actionId !== continuation.actionId || origin.requestId !== continuation.requestId
        || (ctx.serverId && ctx.serverId !== homeId && ctx.serverId !== origin.serverId
          && (!origin.serverIdentityId || ctx.serverIdentityId !== origin.serverIdentityId))
        || (ctx.serverIdentityId && origin.serverIdentityId && ctx.serverIdentityId !== origin.serverIdentityId)
        || !sameStrictJsonValue(request.actionArgs, continuation.request)
        || (!('kind' in continuation) && continuation.submit && !continuation.request.submit)) {
        return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
      }
      if ('kind' in continuation) {
        if (continuation.machineId !== origin.machineId
          || continuation.serverId !== homeId && continuation.serverId !== origin.serverId) {
          return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        }
      }
      const recorded = buildActionExecuteResultFromRecordedApprovalExecution(request);
      if (recorded) return recorded;
      if (request.status === 'executing') {
        return { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' };
      }
      if (request.status !== 'open') return { ok: false, errorCode: 'approval_not_open', error: 'approval_not_open' };
      if ('kind' in continuation) {
        const review = ConfidentialActionInputReviewV1Schema.safeParse(readRecord(request.preview).confidentialInputs);
        const paths = review.success ? review.data.paths : [];
        const declared = deps.declaredInputPaths(continuation.actionId, request.actionArgs);
        if (paths.length === 0 || paths.some(path => !declared.includes(path) || readInputPath(request.actionArgs, path) !== undefined)
          || paths.length !== continuation.choices.length
          || new Set(continuation.choices.map(item => item.path)).size !== paths.length
          || continuation.choices.some(item => !paths.includes(item.path))) {
          return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        }
      }
      const callerGrant = ctx.externalActionCredential?.grant;
      const target = origin.target ?? { kind: 'session' as const, sessionId: origin.sessionId ?? '' };
      if (callerGrant && !isApiTokenGrantTargetMemberV1(callerGrant, target, origin.machineId)) {
        return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
      }
      if (!deps.isActionEnabled(continuation.actionId, { ...ctx, surface: origin.surface })) {
        return { ok: false, errorCode: 'action_disabled', error: 'action_disabled' };
      }
      if (!await deps.isOriginCurrent(request, ctx.signal) || !await isDecidingHumanAdmissionCurrent(ctx)) {
        return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
      }
      const now = Date.now();
      request = { ...request, status: 'approved', updatedAtMs: Math.max(now, request.updatedAtMs),
        decision: { kind: 'approve', decidedAtMs: now, authority: 'present_user' } };
      const claimed = await deps.approvalsUpdate({ artifactId: continuation.artifactId, request, serverId: homeId });
      const failure = readActionFailureEnvelope(claimed);
      if (failure) return failure;
      const execution = await deps.executeApproved({ artifactId: continuation.artifactId, request,
        artifactServerId: homeId, ctx,
        ...('kind' in continuation ? { privateActionInputContinuation: continuation }
          : { privateSecretContinuation: continuation }), observeExecution: true });
      return execution.ok ? execution.exec : execution;
    } finally {
      // JavaScript cannot promise forensic string erasure; no owned durable reference remains.
      continuation = null;
    }
  };
}
