import { isSessionTerminalActionId } from '../../sessionTerminalActionFamily.js';
import { normalizeActionExecutorThrownError, completeActionResult, settleActionOutput } from '../resultProjection.js';
import { resolveActionSessionAddress } from '../sessionTargets.js';
import { resolveSessionIdFromInput, projectSessionReferenceFailure, resolveServerIdForSession } from '../sessionScope.js';
import type { PublicActionInputById } from '../../actionSpecs.js';
import type { SessionResumeRequestV1 } from '../../../sessions/control/sessionResumeRequestV1.js';
import { SessionForkRpcParamsSchema } from '../../../sessions/fork.js';
import { readRecord, readNonEmptyString, hasOwn } from '../../../inputs/inputRecords.js';
import type { SessionContinueWithReplayRpcParams } from '../../../sessions/continueWithReplay.js';
import type { SessionRollbackTarget } from '../../../sessions/rollback.js';
import type { CheckpointCodeRollbackActionRequest } from '../../../sessions/control/rollback/checkpointCodeRollback.js';
import type { SessionCheckpointRequestV1, SessionRestoreRequestV1 } from '../../../sessions/control/checkpoints/v1.js';
import { normalizeId } from '../inputReading.js';
import { SessionArchiveResultSchema, SessionArchiveActionInputV1Schema, SessionArchiveActionResultV1Schema, type SessionArchiveReportOutcomeV1 } from '../../../sessions/control/contract.js';
import { parseSessionListQueryActionResultV1 } from '../../../sessions/awareness/action.js';
import { SESSION_LIST_PAGE_MAX_LIMIT } from '../../../sessions/listing/query.js';
import { readActionFailureEnvelope } from '../actionFailureEnvelope.js';
import { readSessionManagerSessionIdV1 } from '../../../sessions/follow/sessionManagerV1.js';
import type { ActionExecuteResult, ActionExecutorContext } from '../types.js';
import { ActionApprovalRequestCreatedResultSchema } from '../../actionExecutionResult.js';
import { isSessionFollowActionIdV1, SessionFollowActionInputSchemasV1 } from '../../../sessions/follow/actions.js';
import { parseSessionFollowActionResponse } from '../../../sessions/follow/actionTransport.js';
import { isSessionReadStateActionIdV1, SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1 } from '../../../sessions/readState/actions.js';
import { parseSessionReadStateActionResponse } from '../../../sessions/readState/actionTransport.js';
import { type ActionId } from '../../actionIds.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecutorDeps } from '../types.js';



export async function dispatchSessionLifecycle1(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'parsed' | 'ctx' | 'data'> & Readonly<{
  isDeferredApprovalResult: (result: ActionExecuteResult) => boolean;
  stopThenArchiveSession: (sessionId: string, childContext: ActionExecutorContext) => Promise<ActionExecuteResult>;
  executeHostChild: (childId: ActionId, childInput: unknown, childContext: ActionExecutorContext) => Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, parsed, ctx, data, isDeferredApprovalResult, stopThenArchiveSession, executeHostChild } = inv;

        if (isSessionTerminalActionId(actionId)) {
          if (!deps.sessionTerminalAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          return completeActionResult(await deps.sessionTerminalAction({ actionId, input: parsed.data, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'session.open') {
          // A headless Session-open owner can resume Sessions, but cannot target a client tab.
          if (data.presentation !== 'window' && (typeof data.tabId === 'string' || data.destination !== undefined) && !deps.workspaceAction) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.open' };
          }
          const resolution = await resolveActionSessionAddress(deps, data, ctx, 'session.open');
          if (resolution.kind !== 'unique') return projectSessionReferenceFailure(resolution);
          const { serverId, sessionId } = resolution.address;
          const destination = (parsed.data as PublicActionInputById['session.open']).destination;
          if (destination && 'sessionId' in destination.comparison && destination.comparison.sessionId
            && destination.comparison.sessionId !== sessionId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'comparison_session_mismatch' };
          }
          if (data.presentation === 'window') {
            if (!deps.desktopWindowsOpen) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:desktop.windows.open' };
            const accountId = ctx.runtimeAccountId;
            if (!accountId) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
            return settleActionOutput('desktop.windows.open', completeActionResult(await deps.desktopWindowsOpen({
              input: { target: typeof data.tabId === 'string'
                ? { kind: 'workspaceTab', accountId, serverId, tabId: data.tabId, ...(destination ? { destination } : {}) }
                : { kind: 'session', accountId, serverId, sessionId, ...(destination ? { destination } : {}) } }, context: ctx,
            })));
          }
          if (!deps.sessionOpen) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const res = await deps.sessionOpen({
            sessionId,
            serverId,
            ...(data.presentation === 'main' || data.presentation === 'overlay' ? { presentation: data.presentation } : {}),
            ...(data.intent === 'resume' ? { intent: 'resume' as const } : {}),
            ...(data.resumeRequest ? { resumeRequest: data.resumeRequest as SessionResumeRequestV1 } : {}),
            ...(destination ? { destination } : {}),
            ...(typeof data.tabId === 'string' ? { tabId: data.tabId } : {}),
            ...(typeof data.approvedNewDirectoryCreation === 'boolean'
              ? { approvedNewDirectoryCreation: data.approvedNewDirectoryCreation } : {}),
            ...(ctx.actionRequestId ? { actionRequestId: ctx.actionRequestId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }, ctx);
          return completeActionResult(res);
        }

        if (actionId === 'session.fork') {
          if (!deps.sessionFork) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const forkRequest = SessionForkRpcParamsSchema.safeParse({
            v: 1,
            parentSessionId: sessionId,
            forkPoint: data.forkPoint ?? { type: 'latest' },
            ...(hasOwn(data, 'strategy') ? { strategy: data.strategy } : {}),
            ...(hasOwn(data, 'replaySummaryRunner') ? { replaySummaryRunner: data.replaySummaryRunner } : {}),
            ...(hasOwn(data, 'replayMaxSeedChars') ? { replayMaxSeedChars: data.replayMaxSeedChars } : {}),
            ...(hasOwn(data, 'requestId')
              ? { requestId: data.requestId }
              : ctx.actionRequestId
                ? { requestId: ctx.actionRequestId }
                : {}),
          });
          if (!forkRequest.success) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const { parentSessionId } = forkRequest.data;
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionFork({
            sessionId: parentSessionId,
            forkPoint: forkRequest.data.forkPoint,
            ...(forkRequest.data.strategy ? { strategy: forkRequest.data.strategy } : {}),
            ...(forkRequest.data.replaySummaryRunner
              ? { replaySummaryRunner: forkRequest.data.replaySummaryRunner }
              : {}),
            ...(forkRequest.data.replayMaxSeedChars !== undefined
              ? { replayMaxSeedChars: forkRequest.data.replayMaxSeedChars }
              : {}),
            ...(forkRequest.data.requestId ? { requestId: forkRequest.data.requestId } : {}),
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.continue_with_replay') {
          if (!deps.sessionContinueWithReplay) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.continue_with_replay' };
          }
          const res = await deps.sessionContinueWithReplay({
            ...(parsed.data as SessionContinueWithReplayRpcParams),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.rollback') {
          if (!deps.sessionRollback) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const rawTarget = data?.target;
          const target = rawTarget && typeof rawTarget === 'object' ? (rawTarget as SessionRollbackTarget) : undefined;
          const res = await deps.sessionRollback({
            sessionId,
            ...(serverId ? { serverId } : {}),
            ...(target ? { target } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.checkpoint_code_rollback') {
          if (!deps.checkpointCodeRollback) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.checkpoint_code_rollback' };
          }
          const request = parsed.data as CheckpointCodeRollbackActionRequest;
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          const res = await deps.checkpointCodeRollback({
            request,
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.checkpoint') {
          if (!deps.sessionCheckpoint) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.checkpoint' };
          }
          const request = parsed.data as SessionCheckpointRequestV1;
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          const res = await deps.sessionCheckpoint({
            request,
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'session.restore') {
          if (!deps.sessionRestore) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.restore' };
          }
          const request = parsed.data as SessionRestoreRequestV1;
          const serverId = resolveServerIdForSession(deps, ctx, request.sessionId);
          const res = await deps.sessionRestore({
            request,
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }
  return null;
}

export async function dispatchSessionLifecycle2(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'parsed' | 'ctx' | 'data'> & Readonly<{
  sameHome: import('../coreInvocation.js').ActionHomeEquivalence;
  isDeferredApprovalResult: (result: ActionExecuteResult) => boolean;
  stopThenArchiveSession: (sessionId: string, childContext: ActionExecutorContext) => Promise<ActionExecuteResult>;
  executeHostChild: (childId: ActionId, childInput: unknown, childContext: ActionExecutorContext) => Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, parsed, ctx, data, isDeferredApprovalResult, stopThenArchiveSession, executeHostChild } = inv;

        if (actionId === 'session.archive' || actionId === 'session.unarchive') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionArchiveSet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.archive' };
          }
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionArchiveSet({
            sessionId,
            context: ctx,
            archived: actionId === 'session.archive',
            ...(serverId ? { serverId } : {}),
          });
          if (actionId === 'session.unarchive') return completeActionResult(res);
          const completed = completeActionResult(res);
          if (!completed.ok || isDeferredApprovalResult(completed)) return completed;
          const native = readRecord(res);
          if (native.ok === false || native.success === false) {
            const code = readNonEmptyString(native.code) ?? 'session_archive_failed';
            return { ok: false, errorCode: code, error: readNonEmptyString(native.message) ?? code };
          }
          if (native.ok !== true && native.success !== true && !SessionArchiveResultSchema.safeParse(native).success) {
            return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          }
          const archivedSessionId = readNonEmptyString(native.sessionId) ?? sessionId;
          const result = { success: true as const, sessionId: archivedSessionId,
            ...(typeof native.archivedAt === 'number' ? { archivedAt: native.archivedAt } : {}) };
          if (SessionArchiveActionInputV1Schema.parse(data).alsoArchiveReports !== true) {
            return completeActionResult(SessionArchiveActionResultV1Schema.parse(result));
          }
          const reports: SessionArchiveReportOutcomeV1[] = [];
          const seenReports = new Set<string>();
          const seenCursors = new Set<string>();
          let cursor: string | undefined;
          let reportsError: { errorCode: string; error: string } | undefined;
          let reportsWithheld = false;
          do {
            if (!deps.sessionList) {
              reportsError = { errorCode: 'unsupported_action', error: 'unsupported_action:session.list' };
              break;
            }
            let page: ReturnType<typeof parseSessionListQueryActionResultV1>;
            try {
              ctx.signal?.throwIfAborted();
              const rawPage = await deps.sessionList({
                context: ctx, view: 'summary', query: { v: 1, storage: 'active', includeInactive: true,
                  scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [],
                  underSessionId: archivedSessionId, limit: SESSION_LIST_PAGE_MAX_LIMIT,
                  ...(cursor ? { cursor } : {}) },
                ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
              });
              const failure = readActionFailureEnvelope(rawPage);
              if (failure) { reportsError = { errorCode: failure.errorCode, error: failure.error }; break; }
              page = parseSessionListQueryActionResultV1(rawPage);
            } catch (error) {
              const failure = normalizeActionExecutorThrownError(error);
              reportsError = { errorCode: failure.errorCode, error: failure.error };
              break;
            }
            if (!page || 'view' in page) {
              reportsError = { errorCode: 'invalid_action_output', error: 'invalid_action_output' };
              break;
            }
            reportsWithheld ||= (page.metadataUpgradeRequiredCount ?? 0) > 0;
            for (const report of page.sessions) {
              if (ctx.signal?.aborted) { reportsError = { errorCode: 'cancelled', error: 'cancelled' }; break; }
              if (report.id === archivedSessionId || seenReports.has(report.id)
                || readSessionManagerSessionIdV1(report) !== archivedSessionId || ('archivedAt' in report && report.archivedAt != null)
                || (serverId && typeof report.serverId === 'string' && !inv.sameHome(report.serverId, serverId))) continue;
              seenReports.add(report.id);
              const identity = { sessionId: report.id, ...(typeof report.title === 'string' ? { title: report.title } : {}) };
              const childContext = { ...ctx, ...(serverId ? { serverId } : {}),
                // A decision about the lead is not approval for a different target.
                bypassApprovals: false, presentUserConfirmation: undefined,
                sessionTargetsV1: undefined };
              let archived: ActionExecuteResult;
              try {
                archived = report.active ? await stopThenArchiveSession(report.id, childContext)
                  : await executeHostChild('session.archive', { sessionId: report.id }, childContext);
                if (!archived.ok && archived.errorCode === 'session_active' && !report.active) archived = await stopThenArchiveSession(report.id, childContext);
              } catch (error) {
                archived = { ok: false, ...normalizeActionExecutorThrownError(error) };
              }
              const approval = archived.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(archived.result) : null;
              reports.push(!archived.ok ? { ...identity, status: 'failed', errorCode: archived.errorCode, error: archived.error }
                : approval?.success ? { ...identity, status: 'approval_pending', artifactId: approval.data.artifactId }
                : { ...identity, status: 'archived' });
            }
            if (reportsError) break;
            if (!page.hasNext) break;
            if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
              reportsError = { errorCode: 'invalid_action_output', error: 'invalid_action_output' };
              break;
            }
            seenCursors.add(page.nextCursor);
            cursor = page.nextCursor;
          } while (true);
          if (reportsWithheld && !reportsError) reportsError = {
            errorCode: 'session_metadata_upgrade_required', error: 'session_metadata_upgrade_required',
          };
          return completeActionResult(SessionArchiveActionResultV1Schema.parse({ ...result, reports,
            ...(reportsError ? { reportsError } : {}) }));
        }

        if (isSessionFollowActionIdV1(actionId)) {
          const receiver = readRecord(data.receiver);
          const source = readRecord(data.source);
          if (receiver.kind === 'session' && source.kind === 'session' && source.sessionId === receiver.sessionId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'session_follow_same_session' };
          }
          const sessionId = receiver.kind === 'session' ? normalizeId(receiver.sessionId)
            : source.kind === 'session' ? normalizeId(source.sessionId) : undefined;
          const serverId = sessionId ? resolveServerIdForSession(deps, ctx, sessionId) : normalizeId(ctx.serverId);
          const scope = { ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) };
          let result: unknown;
          if (actionId === 'follow.preview') {
            if (!deps.sessionFollowPreview) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
            result = await deps.sessionFollowPreview({ context: ctx,
              input: SessionFollowActionInputSchemasV1['follow.preview'].parse(data), ...scope });
          } else {
            if (!deps.sessionFollowAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
            result = await deps.sessionFollowAction({ context: ctx, actionId, input: data, ...scope });
          }
          const failure = readActionFailureEnvelope(result);
          if (failure) return failure;
          return completeActionResult(parseSessionFollowActionResponse(actionId, data, result));
        }

        if (isSessionReadStateActionIdV1(actionId)) {
          if (!deps.sessionReadStateAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const parsed = SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(data);
          const sessionId = normalizeId(parsed.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const result = await deps.sessionReadStateAction({ context: ctx, actionId, input: parsed,
            ...(serverId ? { serverId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const failure = readActionFailureEnvelope(result);
          if (failure) return failure;
          try {
            return completeActionResult(parseSessionReadStateActionResponse(actionId, parsed, result));
          } catch {
            return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          }
        }
  return null;
}
