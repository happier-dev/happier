import { normalizeId } from '../inputReading.js';
import { SESSION_TASKS_SET_ACTION_ID_V1 } from '../../actionIds.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../../connect/connectedAccountPurposeIdentity.js';
import { QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema } from '../../../connect/connectedAccountPurposeBindings.js';
import { resolveServerIdForSession } from '../sessionScope.js';
import { completeActionResult } from '../resultProjection.js';
import { isAgentCaller } from '../callerContext.js';
import type { SessionGoalSetRequestV1 } from '../../../sessions/work/state/sessionWorkStateRpc.js';
import type { SessionTasksSetInputV1 } from '../../../sessions/work/state/sessionWorkStateV1.js';
import { WorkflowTriggerListResultV1Schema } from '../../../workflows/triggers/workflowTriggerActionsV1.js';
import { isKeepGoingTriggerTargetV1 } from '../../../workflows/triggers/triggerTargetV1.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';



export async function dispatchSessionWork(inv: Pick<CoreInvocation, 'actionId' | 'data' | 'deps' | 'ctx' | 'parsed'>): Promise<ActionExecuteResult | null> {
  const { actionId, data, deps, ctx, parsed } = inv;

        if (actionId === 'session.status.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionStatusGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.status.get' };
          }
          const live = data.live === true;
          const operation = data.operation === 'credential' || data.operation === 'conversation' ? data.operation : undefined;
          const credentialPurpose = data.credentialPurpose === undefined ? undefined : QualifiedConnectedAccountPurposeV1Schema.parse(data.credentialPurpose);
          const credentialTeamSelection = data.credentialTeamSelection === undefined ? undefined : QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema.parse(data.credentialTeamSelection);
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionStatusGet({ sessionId, live, ...(data.readiness === true ? { readiness: true } : {}), context: ctx,
            ...(data.includeAcceptedWorkspace === true ? { includeAcceptedWorkspace: true } : {}),
            ...(operation ? { operation } : {}), ...(credentialPurpose ? { credentialPurpose } : {}),
            ...(credentialTeamSelection ? { credentialTeamSelection } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}), ...(serverId ? { serverId } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.work_state.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionWorkStateGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.work_state.get' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionWorkStateGet({ sessionId, ...(serverId ? { serverId } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.goal.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionGoalGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.goal.get' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionGoalGet({ sessionId, ...(serverId ? { serverId } : {}),
            ...(ctx.authority || isAgentCaller(ctx) ? { context: ctx } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
          return completeActionResult(res);
        }

        if (actionId === 'session.goal.set') {
          const goalMutation = parsed.data as SessionGoalSetRequestV1;
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionGoalSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.goal.set' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const tokenBudget = data.tokenBudget;
          const res = await deps.sessionGoalSet({
            sessionId,
            ...(typeof data.objective === 'string' ? { objective: data.objective } : {}),
            ...(typeof goalMutation.status === 'string' ? { status: goalMutation.status } : {}),
            ...(Object.prototype.hasOwnProperty.call(data, 'tokenBudget') && (typeof tokenBudget === 'number' || tokenBudget === null)
              ? { tokenBudget }
              : {}),
            ...(serverId ? { serverId } : {}),
            ...(typeof data.resumeInactiveWithInitialGoal === 'boolean' ? { resumeInactiveWithInitialGoal: data.resumeInactiveWithInitialGoal } : {}),
            ...(ctx.authority || isAgentCaller(ctx) ? { context: ctx } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            ...(ctx.actionRequestId ? { actionRequestId: ctx.actionRequestId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === SESSION_TASKS_SET_ACTION_ID_V1) {
          if (!deps.sessionTasksSet) {
            return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          }
          return completeActionResult(await deps.sessionTasksSet(parsed.data as SessionTasksSetInputV1,
            ctx.signal ? { signal: ctx.signal } : undefined));
        }

        if (actionId === 'session.goal.clear') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionGoalClear || !deps.workflowAction) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.goal.clear' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const context = serverId ? { ...ctx, serverId } : ctx;
          const listed = await deps.workflowAction({ actionId: 'workflow.trigger.list', input: { lifetimeSession: { sessionId } }, context,
            ...(ctx.signal ? { signal: ctx.signal } : {}) });
          const listResult = completeActionResult(listed);
          if (!listResult.ok) return listResult;
          const sets = WorkflowTriggerListResultV1Schema.parse(listed).sets;
          const cleared = completeActionResult(await deps.sessionGoalClear({ sessionId, ...(serverId ? { serverId } : {}),
            ...(ctx.authority || isAgentCaller(ctx) ? { context: ctx } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) }));
          if (!cleared.ok) return cleared;
          // Preserve a refused Goal mutation's continuation. A later detach failure is
          // returned honestly; retrying Clear can finish the retained attachment.
          for (const set of sets) {
            if (!isKeepGoingTriggerTargetV1(set.target)) continue;
            for (const trigger of set.triggers) {
              const removed = completeActionResult(await deps.workflowAction({ actionId: 'workflow.trigger.remove',
                input: { automationId: set.automationId, triggerId: trigger.id }, context, ...(ctx.signal ? { signal: ctx.signal } : {}) }));
              if (!removed.ok) return removed;
            }
          }
          return cleared;
        }

        if (actionId === 'session.usageLimit.waitResume.enable') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionUsageLimitWaitResumeEnable) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.waitResume.enable' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const issueFingerprint = typeof data.issueFingerprint === 'string'
            ? data.issueFingerprint
            : undefined;
          const remember = data.remember === true
            || data.rememberPreference === true;
          const resumePromptMode = data.resumePromptMode === 'off'
            ? 'off'
            : data.resumePromptMode === 'standard'
              ? 'standard'
              : data.resumePromptMode === 'custom'
                ? 'custom'
                : undefined;
          const res = await deps.sessionUsageLimitWaitResumeEnable({
            sessionId,
            ...(issueFingerprint ? { issueFingerprint } : {}),
            ...(remember ? { remember } : {}),
            ...(resumePromptMode ? { resumePromptMode } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.usageLimit.waitResume.cancel') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionUsageLimitWaitResumeCancel) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.waitResume.cancel' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const issueFingerprint = data.issueFingerprint;
          const armedAtMs = typeof data.armedAtMs === 'number' && Number.isFinite(data.armedAtMs)
            ? Math.trunc(data.armedAtMs)
            : undefined;
          const runtimeAuthRecoveryAttemptId = typeof data.runtimeAuthRecoveryAttemptId === 'string'
            ? data.runtimeAuthRecoveryAttemptId.trim()
            : '';
          const res = await deps.sessionUsageLimitWaitResumeCancel({
            sessionId,
            ...(Object.prototype.hasOwnProperty.call(data, 'issueFingerprint')
              && (typeof issueFingerprint === 'string' || issueFingerprint === null)
              ? { issueFingerprint }
              : {}),
            ...(armedAtMs !== undefined ? { armedAtMs } : {}),
            ...(runtimeAuthRecoveryAttemptId.length > 0 ? { runtimeAuthRecoveryAttemptId } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.usageLimit.checkNow') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const operation =
            data.operation === 'switch_account_now'
              ? 'switch_account_now'
              : 'check_now';
          const resumePromptMode = data.resumePromptMode === 'standard' || data.resumePromptMode === 'off' || data.resumePromptMode === 'custom'
            ? data.resumePromptMode
            : undefined;
          if (operation === 'switch_account_now') {
            if (!deps.sessionUsageLimitSwitchAccountNow) {
              return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.checkNow' };
            }
            const res = await deps.sessionUsageLimitSwitchAccountNow({
              sessionId,
              ...(typeof data.agentId === 'string' && data.agentId.trim().length > 0 ? { agentId: data.agentId.trim() } : {}),
              ...(resumePromptMode ? { resumePromptMode } : {}),
              ...(serverId ? { serverId } : {}),
            });
            return completeActionResult(res);
          }

          if (!deps.sessionUsageLimitCheckNow) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.checkNow' };
          }
          const res = await deps.sessionUsageLimitCheckNow({
            sessionId,
            ...(typeof data.agentId === 'string' && data.agentId.trim().length > 0 ? { agentId: data.agentId.trim() } : {}),
            ...(resumePromptMode ? { resumePromptMode } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.usageLimit.consumeResetCredit') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionUsageLimitConsumeResetCredit) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.usageLimit.consumeResetCredit' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const resumePromptMode = data.resumePromptMode === 'standard' || data.resumePromptMode === 'off' || data.resumePromptMode === 'custom'
            ? data.resumePromptMode
            : undefined;
          const res = await deps.sessionUsageLimitConsumeResetCredit({
            sessionId,
            ...(typeof data.agentId === 'string' && data.agentId.trim().length > 0 ? { agentId: data.agentId.trim() } : {}),
            ...(typeof data.issueFingerprint === 'string' && data.issueFingerprint.trim().length > 0 ? { issueFingerprint: data.issueFingerprint.trim() } : {}),
            ...(resumePromptMode ? { resumePromptMode } : {}),
            ...(serverId ? { serverId } : {}),
          });
          return completeActionResult(res);
        }
  return null;
}
