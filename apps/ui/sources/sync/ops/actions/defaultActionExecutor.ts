import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';

import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings, type ActionId } from '@happier-dev/protocol';

import {
  sessionExecutionRunAction,
  sessionExecutionRunGet,
  sessionExecutionRunList,
  sessionExecutionRunSend,
  sessionExecutionRunStart,
  sessionExecutionRunStop,
} from '@/sync/ops/sessionExecutionRuns';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { sendSessionMessageWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { storage } from '@/sync/domains/state/storage';
import { openSessionForVoiceTool } from '@/voice/tools/actionImpl/openSession';
import { spawnSessionForVoiceTool } from '@/voice/tools/actionImpl/spawnSession';
import { setPrimaryActionSessionId, setTrackedSessionIds } from '@/voice/tools/actionImpl/sessionTargets';
import { listSessionsForVoiceTool } from '@/voice/tools/actionImpl/sessionList';
import { getSessionActivityForVoiceTool } from '@/voice/tools/actionImpl/sessionActivity';
import { getSessionRecentMessagesForVoiceTool } from '@/voice/tools/actionImpl/sessionRecentMessages';

export function createDefaultActionExecutor(opts?: Readonly<{
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
}>): ReturnType<typeof createActionExecutor> {
  const resolveActionsSettingsSnapshot = () => {
    const stateAny: any = storage.getState();
    const raw = stateAny?.settings?.actionsSettingsV1;
    const parsed = ActionsSettingsV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : { v: 1 as const, disabledActionIds: [] as ActionId[] };
  };

  const deps: ActionExecutorDeps = {
    isActionEnabled: (actionId: ActionId) => isActionEnabledByActionsSettings(actionId, resolveActionsSettingsSnapshot()),
    executionRunStart: sessionExecutionRunStart,
    executionRunList: sessionExecutionRunList,
    executionRunGet: sessionExecutionRunGet,
    executionRunSend: sessionExecutionRunSend,
    executionRunStop: sessionExecutionRunStop,
    executionRunAction: sessionExecutionRunAction,

    sessionOpen: async ({ sessionId }) =>
      await openSessionForVoiceTool({ sessionId, resolveServerIdForSessionId: opts?.resolveServerIdForSessionId }),

    sessionSpawnNew: async ({ tag, path, host, initialMessage }) =>
      await spawnSessionForVoiceTool({ tag, path, host, initialMessage }),

    sessionSendMessage: async ({ sessionId, message, serverId }) =>
      await sendSessionMessageWithServerScope({ sessionId, message, serverId }),

    sessionPermissionRespond: async ({ sessionId, requestId, decision, serverId }) => {
      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }
      const request = decision === 'allow'
        ? { id: reqId, approved: true }
        : { id: reqId, approved: false };
      return await sessionRpcWithServerScope({
        sessionId,
        serverId,
        method: 'permission',
        payload: request,
      });
    },

    sessionTargetPrimarySet: async ({ sessionId }) => await setPrimaryActionSessionId({ sessionId }),
    sessionTargetTrackedSet: async ({ sessionIds }) => await setTrackedSessionIds({ sessionIds }),
    sessionList: async ({ limit, cursor, includeLastMessagePreview }) => await listSessionsForVoiceTool({ limit, cursor, includeLastMessagePreview }),
    sessionActivityGet: async ({ sessionId, windowSeconds }) => await getSessionActivityForVoiceTool({ sessionId, windowSeconds }),
    sessionRecentMessagesGet: async ({ sessionId, defaultSessionId, limit, cursor, includeUser, includeAssistant, maxCharsPerMessage }) =>
      await getSessionRecentMessagesForVoiceTool({ sessionId, defaultSessionId, limit, cursor, includeUser, includeAssistant, maxCharsPerMessage }),

    resetGlobalVoiceAgent: async () => {
      voiceActivityController.clearSession(VOICE_AGENT_GLOBAL_SESSION_ID);
      const stateAny: any = storage.getState();
      const transcriptCfg = stateAny?.settings?.voice?.adapters?.local_conversation?.agent?.transcript ?? null;
      if (transcriptCfg?.persistenceMode === 'persistent' && typeof stateAny?.applySettingsLocal === 'function') {
        const currentEpochRaw = Number(transcriptCfg.epoch ?? 0);
        const currentEpoch = Number.isFinite(currentEpochRaw) && currentEpochRaw >= 0 ? Math.floor(currentEpochRaw) : 0;
        const nextEpoch = currentEpoch + 1;
        try {
          stateAny.applySettingsLocal({
            voice: {
              adapters: {
                local_conversation: {
                  agent: {
                    transcript: {
                      epoch: nextEpoch,
                    },
                  },
                },
              },
            },
          });
        } catch {
          // best-effort only
        }
      }
      await voiceSessionManager.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
    },

    ...(opts?.resolveServerIdForSessionId ? { resolveServerIdForSessionId: opts.resolveServerIdForSessionId } : {}),
  };

  return createActionExecutor(deps);
}
