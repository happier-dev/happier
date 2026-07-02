import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  type ActionExecuteResult,
  type ActionId,
  type ExternalSessionTranscriptDeltaEphemeral,
} from '@happier-dev/protocol';

import { createExternalSessionFollowLeaseManager } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import { registerExternalSessionFollowLeaseArchiveHandler } from '@/api/session/external/leases/externalSessionFollowLeaseArchiveRegistry';
import { dispatchActionFromRpc, type RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { EXTERNAL_SESSION_REQUIRED_GENERIC_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import {
  externalSessionsError,
  executeExternalSessionAttachAction,
  executeExternalSessionCandidatesListAction,
  executeExternalSessionDetachAction,
  executeExternalSessionFollowPolicySetAction,
  executeExternalSessionLinkEnsureAction,
  executeExternalSessionStatusGetAction,
  executeExternalSessionTakeoverAction,
  executeExternalSessionTranscriptPageAction,
  executeExternalSessionTranscriptReadAfterAction,
  internalErrorResponse,
  mapActionFailureToExternalSessionsError,
  resolveTakeoverReadinessCacheMs,
  type ExternalSessionActionContext,
  type ExternalSessionTakeoverActionInput,
} from '@/session/actions/externalSessions';

import { registerLegacyDirectSessionTakeoverWireAliases } from './legacyDirectSessionWireAliases';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

function unsupportedExternalSessionAction(actionId: ActionId): ActionExecuteResult {
  return {
    ok: false,
    errorCode: 'unsupported_action',
    error: `unsupported_action:${actionId}`,
  };
}

function createExternalSessionRpcActionExecutor(
  context: ExternalSessionActionContext,
): RpcActionExecutor {
  return {
    execute: async (actionId, input) => {
      switch (actionId) {
        case 'sessions.external.follow':
          return { ok: true, result: await executeExternalSessionAttachAction(input, context) };
        case 'sessions.external.unfollow':
          return { ok: true, result: await executeExternalSessionDetachAction(input, context) };
        case 'sessions.external.followPolicy.set':
          return { ok: true, result: await executeExternalSessionFollowPolicySetAction(input, context) };
        case 'sessions.external.candidates.list':
          return { ok: true, result: await executeExternalSessionCandidatesListAction(input) };
        case 'sessions.external.link.ensure':
          return { ok: true, result: await executeExternalSessionLinkEnsureAction(input) };
        case 'sessions.external.status.get':
          return { ok: true, result: await executeExternalSessionStatusGetAction(input, context) };
        case 'sessions.external.transcript.page':
          return { ok: true, result: await executeExternalSessionTranscriptPageAction(input, context) };
        case 'sessions.external.transcript.readAfter':
          return { ok: true, result: await executeExternalSessionTranscriptReadAfterAction(input, context) };
        case 'sessions.external.takeover':
          return { ok: true, result: await executeExternalSessionTakeoverAction(input, context) };
        default:
          return unsupportedExternalSessionAction(actionId);
      }
    },
  };
}

function readExternalSessionGenericFailure(actionId: ActionId): string {
  switch (actionId) {
    case 'sessions.external.candidates.list':
      return 'external_sessions_candidates_list_failed';
    case 'sessions.external.link.ensure':
      return 'external_session_link_ensure_failed';
    case 'sessions.external.follow':
      return 'external_session_attach_failed';
    case 'sessions.external.unfollow':
      return 'external_session_detach_failed';
    case 'sessions.external.followPolicy.set':
      return 'follow_policy_set_failed';
    case 'sessions.external.status.get':
      return 'external_session_status_get_failed';
    case 'sessions.external.transcript.page':
      return 'external_session_transcript_page_failed';
    case 'sessions.external.transcript.readAfter':
      return 'external_session_transcript_read_after_failed';
    default:
      return 'external_session_action_failed';
  }
}

function createExternalSessionGenericRpcActionExecutor(
  executor: RpcActionExecutor,
): RpcActionExecutor {
  return {
    execute: async (actionId, input, context) => {
      try {
        const result = await executor.execute(actionId, input, context);
        if (result.ok) {
          return result;
        }
        return {
          ok: true,
          result: mapActionFailureToExternalSessionsError(result),
        };
      } catch (error) {
        return {
          ok: true,
          result: internalErrorResponse(
            `external_session_generic.${actionId}`,
            error,
            readExternalSessionGenericFailure(actionId),
          ),
        };
      }
    },
  };
}

export function registerMachineExternalSessionsRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  spawnSession?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession?: (sessionId: string) => Promise<boolean>;
  emitExternalSessionTranscriptUpdate?: (payload: ExternalSessionTranscriptDeltaEphemeral) => void;
  transientMediaReadAllowance?: ExternalSessionActionContext['transientMediaReadAllowance'];
  actionExecutor?: RpcActionExecutor;
}>): void {
  const { rpcHandlerManager, emitExternalSessionTranscriptUpdate } = params;
  const takeoverReadinessCacheMs = resolveTakeoverReadinessCacheMs();
  const takeoverReadinessBySessionId = new Map<string, Readonly<{ value: boolean; expiresAtMs: number }>>();
  const followLeaseManager = createExternalSessionFollowLeaseManager();
  registerExternalSessionFollowLeaseArchiveHandler(async (sessionId) => {
    await followLeaseManager.releaseSession({ sessionId });
  });

  const readCachedTakeoverReadiness = (sessionId: string): boolean | null => {
    if (takeoverReadinessCacheMs <= 0) return null;
    const cached = takeoverReadinessBySessionId.get(sessionId) ?? null;
    if (!cached) return null;
    if (cached.expiresAtMs <= Date.now()) {
      takeoverReadinessBySessionId.delete(sessionId);
      return null;
    }
    return cached.value;
  };

  const writeCachedTakeoverReadiness = (sessionId: string, value: boolean): void => {
    if (takeoverReadinessCacheMs <= 0) return;
    takeoverReadinessBySessionId.set(sessionId, {
      value,
      expiresAtMs: Date.now() + takeoverReadinessCacheMs,
    });
  };

  const invalidateTakeoverReadiness = (sessionId: string): void => {
    takeoverReadinessBySessionId.delete(sessionId);
  };

  const externalSessionActionContext: ExternalSessionActionContext = {
    followLeaseManager,
    emitExternalSessionTranscriptUpdate,
    transientMediaReadAllowance: params.transientMediaReadAllowance,
    spawnSession: params.spawnSession,
    stopSession: params.stopSession,
    takeoverReadiness: {
      read: readCachedTakeoverReadiness,
      write: writeCachedTakeoverReadiness,
      invalidate: invalidateTakeoverReadiness,
    },
  };

  const externalSessionRpcActionExecutor = params.actionExecutor
    ?? createExternalSessionRpcActionExecutor(externalSessionActionContext);

  registerActionSpecRpcHandlers({
    rpcHandlerManager,
    actionExecutor: createExternalSessionGenericRpcActionExecutor(externalSessionRpcActionExecutor),
    scopes: EXTERNAL_SESSION_REQUIRED_GENERIC_RPC_SCOPES,
  });

  const dispatchExternalSessionTakeoverAction = async (
    actionInput: ExternalSessionTakeoverActionInput,
  ): Promise<ActionExecuteResult> => {
    try {
      return await dispatchActionFromRpc({
        actionId: 'sessions.external.takeover',
        input: actionInput,
        executor: externalSessionRpcActionExecutor,
      });
    } catch (error) {
      return internalErrorResponse('external_session_takeover', error, 'external_session_takeover_failed');
    }
  };

  registerLegacyDirectSessionTakeoverWireAliases({
    rpcHandlerManager,
    dispatchExternalSessionTakeoverAction,
  });
}
