import { resolveSessionIdFromInput, resolveServerIdForSession } from '../sessionScope.js';
import { normalizeId } from '../inputReading.js';
import { type HandoffWorkspaceActionV1 } from '../../../sessions/control/handoff/workspaceSyncSchemas.js';
import { completeActionResult, completeSessionHandoffActionResult } from '../resultProjection.js';
import type { SessionHandoffAbortRequest, SessionHandoffCommitRequest, SessionHandoffPrepareTargetResultGetRequest, SessionHandoffPrepareTargetRequest, SessionHandoffPrepareTargetResumeRequest, SessionHandoffStatusGetRequest } from '../../../sessions/control/handoff/handoffSchemas.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';



export async function dispatchSessionHandoff(inv: Pick<CoreInvocation, 'actionId' | 'parsed' | 'ctx' | 'data' | 'deps'>): Promise<ActionExecuteResult | null> {
  const { actionId, parsed, ctx, data, deps } = inv;

        if (actionId === 'session.handoff') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const targetMachineId = normalizeId(data.targetMachineId);
          if (!targetMachineId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionHandoffStart) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const targetSessionStorageMode =
            data.targetSessionStorageMode === 'direct' || data.targetSessionStorageMode === 'persisted'
              ? data.targetSessionStorageMode
              : undefined;
          const targetPath = normalizeId(data.targetPath);
          const stateTransfer = data.stateTransfer === 'existing' || data.stateTransfer === 'transfer' ? data.stateTransfer : undefined;
          const workspaceAction = data.workspaceAction as HandoffWorkspaceActionV1 | undefined;
          const res = await deps.sessionHandoffStart({
            sessionId,
            targetMachineId,
            ...(targetPath ? { targetPath } : {}),
            ...(targetSessionStorageMode ? { targetSessionStorageMode } : {}),
            ...(stateTransfer ? { stateTransfer } : {}),
            ...(workspaceAction ? { workspaceAction } : {}),
            ...(serverId ? { serverId } : {}),
            ...(ctx.actionRequestId ? { actionRequestId: ctx.actionRequestId } : {}),
            ...(ctx.handoffTargetReplacementApproval
              ? { handoffTargetReplacementApproval: ctx.handoffTargetReplacementApproval }
              : {}),
            ...(ctx.handoffTargetReplacementApprovalReceiptId
              ? {
                  handoffTargetReplacementApprovalReceiptId: ctx.handoffTargetReplacementApprovalReceiptId,
                  handoffTargetReplacementApprovalActionInput: parsed.data,
                }
              : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }, ctx);
          return completeSessionHandoffActionResult(res);
        }

        if (actionId === 'session.handoff.prepare_target') {
          if (!deps.sessionHandoffPrepareTarget) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.prepare_target' };
          }
          const res = await deps.sessionHandoffPrepareTarget(parsed.data as SessionHandoffPrepareTargetRequest);
          return completeActionResult(res);
        }

        if (actionId === 'session.handoff.prepare_target.resume') {
          if (!deps.sessionHandoffPrepareTargetResume) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.prepare_target.resume' };
          }
          const res = await deps.sessionHandoffPrepareTargetResume(parsed.data as SessionHandoffPrepareTargetResumeRequest, ctx);
          return completeActionResult(res);
        }

        if (actionId === 'session.handoff.prepare_target_result.get') {
          if (!deps.sessionHandoffPrepareTargetResultGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.prepare_target_result.get' };
          }
          const res = await deps.sessionHandoffPrepareTargetResultGet(parsed.data as SessionHandoffPrepareTargetResultGetRequest);
          return completeActionResult(res);
        }

        if (actionId === 'session.handoff.commit') {
          if (!deps.sessionHandoffCommit) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.commit' };
          }
          const res = await deps.sessionHandoffCommit(parsed.data as SessionHandoffCommitRequest);
          return completeActionResult(res);
        }

        if (actionId === 'session.handoff.abort') {
          if (!deps.sessionHandoffAbort) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.abort' };
          }
          const res = await deps.sessionHandoffAbort(parsed.data as SessionHandoffAbortRequest);
          return completeActionResult(res);
        }

        if (actionId === 'session.handoff.status.get') {
          if (!deps.sessionHandoffStatusGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff.status.get' };
          }
          const res = await deps.sessionHandoffStatusGet(parsed.data as SessionHandoffStatusGetRequest, ctx);
          return completeActionResult(res);
        }
  return null;
}
