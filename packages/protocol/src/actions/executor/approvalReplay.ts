import { ActionIdSchema } from '../actionIds.js';
import { isInternalActionId } from '../pluginActionSurface.js';
import { getActionSpec } from '../actionSpecs.js';
import type { createActionExecutor } from '../actionExecutor.js';
import type { ActionExecuteFailure, ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { StoredApprovalRequestSchema, isHistoricalPublishApprovalRequestV2, admitApprovalRequesterDecisionV1, type ApprovalRequest } from '../../approvals/approvalRequestV1.js';
import { requiresPresentUserExecutionAuthorityForActionInputV1 } from '../decisionAuthority.js';
import { readPluginInstallApprovalPendingReview } from '../actionApprovalPresentation.js';
import { isApprovalActionId, isBlockingApprovalRequest } from './approvalOrigins.js';
import { buildApprovalDecisionResult } from './approvalResults.js';
import { normalizeId } from './inputReading.js';
import { normalizeActionExecutorThrownError } from './resultProjection.js';
import { approvalReadFailure } from './approvalRead.js';

type Replay = ReturnType<typeof createActionExecutor>['replayApprovedApprovalRequest'];

/** Admission and effect-entry facts for the existing canonical approval execution owner. */
export function createApprovalReplay(deps: Pick<ActionExecutorDeps, 'approvalsGet' | 'approvalsUpdate'> & Readonly<{
  requireDiscussionDraftReviewAuthority(request: ApprovalRequest, context: ActionExecutorContext): Promise<ActionExecuteFailure | null>;
  settleApprovalExecutionPublication(artifactId: string, request: ApprovalRequest, context: ActionExecutorContext): Promise<ActionExecuteFailure | null>;
  resolveBlockingDecisionIfClaimed(args: Readonly<{
    artifactId: string; request: ApprovalRequest; decision: 'approve';
    decisionAuthority: NonNullable<ActionExecutorContext['authority']>; serverId: string | null;
  }>): Promise<boolean>;
  executeApprovedActionForRequest(args: Readonly<{
    artifactId: string; request: ApprovalRequest; artifactServerId: string | null; ctx: ActionExecutorContext;
    preExecutionFailure?: ActionExecuteFailure; observeExecution?: boolean;
  }>): Promise<Readonly<{ ok: true; request: ApprovalRequest; exec: ActionExecuteResult }> | ActionExecuteFailure>;
}>): Replay {
  return async args => {
    let effectMayHaveStarted = false;
    try {
      const artifactId = normalizeId(args.artifactId);
      if (!artifactId) return { ok: false, effectAttempted: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      if (!deps.approvalsGet || !deps.approvalsUpdate) {
        return { ok: false, effectAttempted: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
      }
      // Account-scoped Artifact identity comes from its strict stored origin,
      // never a device-local profile filter or caller-authored routing hint.
      let existingRaw: unknown;
      try {
        existingRaw = await deps.approvalsGet({ artifactId, serverId: null });
      } catch (error) {
        return { ...approvalReadFailure(error), effectAttempted: false };
      }
      if (!existingRaw) return { ok: false, effectAttempted: false, errorCode: 'approval_not_found', error: 'approval_not_found' };
      const parsed = StoredApprovalRequestSchema.safeParse(existingRaw);
      if (!parsed.success) return { ok: false, effectAttempted: false, errorCode: 'approval_invalid', error: 'approval_invalid' };
      const request = parsed.data;
      if (isHistoricalPublishApprovalRequestV2(request)) {
        return { ok: false, effectAttempted: false, errorCode: 'approval_stale', error: 'approval_stale' };
      }
      // Durable replay cannot reconstruct a requester's live decision proof.
      if (request.v === 2) {
        const admission = await admitApprovalRequesterDecisionV1({ request, context: {
          ...(args.callerAuthority ? { authority: args.callerAuthority } : {}),
          ...(args.currentAccount ? { runtimeAccountId: args.currentAccount.accountId,
            serverId: args.currentAccount.serverId, serverIdentityId: args.currentAccount.serverIdentityId } : {}),
          ...(args.signal ? { signal: args.signal } : {}),
        } });
        if (!admission.ok) return { ...admission, effectAttempted: false };
      }
      const parsedRequestActionId = ActionIdSchema.safeParse(request.actionId);
      if ((parsedRequestActionId.success && isApprovalActionId(parsedRequestActionId.data)) || isInternalActionId(request.actionId)) {
        return { ok: false, effectAttempted: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      if ((request.status === 'executed' || request.status === 'failed' || request.status === 'outcome_unknown')
        && request.decision?.kind === 'approve') {
        const settlementFailure = await deps.settleApprovalExecutionPublication(artifactId, request, {
          ...(args.callerAuthority ? { authority: args.callerAuthority } : {}),
          ...(args.currentAccount ? { runtimeAccountId: args.currentAccount.accountId, serverId: args.currentAccount.serverId,
            serverIdentityId: args.currentAccount.serverIdentityId } : {}),
          ...(args.signal ? { signal: args.signal } : {}),
        });
        return settlementFailure ?? buildApprovalDecisionResult(request);
      }
      if (request.v === 2 && request.status === 'executing') {
        return { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' };
      }
      if (request.status !== 'approved' || request.decision?.kind !== 'approve' || request.execution !== undefined) {
        return { ok: false, effectAttempted: false, errorCode: 'approval_not_approved', error: 'approval_not_approved' };
      }
      const draftReviewFailure = await deps.requireDiscussionDraftReviewAuthority(request,
        { ...(args.callerAuthority ? { authority: args.callerAuthority } : {}), ...(args.signal ? { signal: args.signal } : {}) });
      if (draftReviewFailure) return { ...draftReviewFailure, effectAttempted: false };
      const requiresHumanDecision = parsedRequestActionId.success
        && (requiresPresentUserExecutionAuthorityForActionInputV1(getActionSpec(parsedRequestActionId.data), request.actionArgs)
          || (parsedRequestActionId.data === 'plugins.install' && readPluginInstallApprovalPendingReview(request.preview) !== null));
      // A caller-writable approved Artifact is not authenticated human authority.
      if (requiresHumanDecision && args.callerAuthority !== 'present_user') {
        return { ok: false, effectAttempted: false, errorCode: 'present_user_required', error: 'present_user_required' };
      }
      const artifactServerId = request.v === 2
        ? normalizeId(request.executionOriginV1.serverId) || null : normalizeId(request.serverId) || null;
      // The signed logs envelope exists only for its original private Resource
      // invocation. A stored approved label cannot release that live waiter or
      // reconstruct its observer; authenticated decide owns its continuation.
      if (request.v === 2 && request.actionId === 'machines.services.logs.read'
        && request.executionOriginV1.originalActionEnvelope) {
        return { ok: false, effectAttempted: false, errorCode: 'approval_stale', error: 'approval_stale',
          details: { reason: 'live_invocation_unavailable' } };
      }
      effectMayHaveStarted = true;
      if (request.v === 1) {
        const failed = await deps.executeApprovedActionForRequest({ artifactId, request, artifactServerId,
          ctx: args.signal ? { signal: args.signal } : {},
          preExecutionFailure: { ok: false, errorCode: 'approval_stale', error: 'approval_stale' } });
        return failed.ok ? buildApprovalDecisionResult(failed.request) : failed;
      }
      if (isBlockingApprovalRequest(request) && await deps.resolveBlockingDecisionIfClaimed({ artifactId, request,
        decision: 'approve', decisionAuthority: args.callerAuthority ?? 'account_automation', serverId: artifactServerId,
      })) return buildApprovalDecisionResult(request);
      const executed = await deps.executeApprovedActionForRequest({ artifactId, request, artifactServerId,
        ctx: { ...(args.signal ? { signal: args.signal } : {}),
          ...(args.currentAccount ? { surface: 'cli' as const, runtimeAccountId: args.currentAccount.accountId,
            serverId: args.currentAccount.serverId, serverIdentityId: args.currentAccount.serverIdentityId,
            ...(args.currentAccount.actionsSettings ? { actionsSettings: args.currentAccount.actionsSettings } : {}) } : {}),
          ...(args.callerAuthority === 'present_user' ? { authority: 'present_user' as const } : {}),
        }, observeExecution: true });
      return executed.ok ? buildApprovalDecisionResult(executed.request, {
        exec: executed.exec, authority: args.callerAuthority,
      }) : executed;
    } catch (error) {
      const normalized = normalizeActionExecutorThrownError(error);
      return { ok: false, ...normalized, ...(!effectMayHaveStarted ? { effectAttempted: false } : {}) };
    }
  };
}
