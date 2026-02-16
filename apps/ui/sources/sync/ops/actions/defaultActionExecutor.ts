import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';

import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings, type ActionId } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

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
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { storage } from '@/sync/domains/state/storage';
import { openSessionForVoiceTool } from '@/voice/tools/actionImpl/openSession';
import { spawnSessionForVoiceTool } from '@/voice/tools/actionImpl/spawnSession';
import { spawnSessionWithPickerForVoiceTool } from '@/voice/tools/actionImpl/spawnSessionPicker';
import { setPrimaryActionSessionId, setTrackedSessionIds } from '@/voice/tools/actionImpl/sessionTargets';
import { listSessionsForVoiceTool } from '@/voice/tools/actionImpl/sessionList';
import { getSessionActivityForVoiceTool } from '@/voice/tools/actionImpl/sessionActivity';
import { getSessionRecentMessagesForVoiceTool } from '@/voice/tools/actionImpl/sessionRecentMessages';
import { listRecentWorkspacesForVoiceTool } from '@/voice/tools/actionImpl/workspacesListRecent';
import { listRecentPathsForVoiceTool } from '@/voice/tools/actionImpl/pathsListRecent';
import { listMachinesForVoiceTool } from '@/voice/tools/actionImpl/machinesList';
import { listServersForVoiceTool } from '@/voice/tools/actionImpl/serversList';
import { listAgentBackendsForVoiceTool, listAgentModelsForVoiceTool } from '@/voice/tools/actionImpl/agentCatalogList';

export function createDefaultActionExecutor(opts?: Readonly<{
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
}>): ReturnType<typeof createActionExecutor> {
  const resolveActionsSettingsSnapshot = () => {
    const stateAny: any = storage.getState();
    const raw = stateAny?.settings?.actionsSettingsV1;
    const parsed = ActionsSettingsV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : { v: 1 as const, actions: {} as Record<ActionId, any> };
  };

  const deps: ActionExecutorDeps = {
    isActionEnabled: (actionId: ActionId, ctx) =>
      isActionEnabledByActionsSettings(actionId, resolveActionsSettingsSnapshot(), {
        surface: ctx.surface ?? null,
        placement: ctx.placement ?? null,
      }),
    executionRunStart: sessionExecutionRunStart,
    executionRunList: sessionExecutionRunList,
    executionRunGet: sessionExecutionRunGet,
    executionRunSend: sessionExecutionRunSend,
    executionRunStop: sessionExecutionRunStop,
    executionRunAction: sessionExecutionRunAction,

    sessionOpen: async ({ sessionId }) =>
      await openSessionForVoiceTool({ sessionId, resolveServerIdForSessionId: opts?.resolveServerIdForSessionId }),

    sessionSpawnNew: async ({ tag, workspaceId, agentId, modelId, path, host, initialMessage }) =>
      await spawnSessionForVoiceTool({ tag, workspaceId, agentId, modelId, path, host, initialMessage }),

    sessionSpawnPicker: async ({ tag, agentId, modelId, initialMessage }) =>
      await spawnSessionWithPickerForVoiceTool({ tag, agentId, modelId, initialMessage }),

    workspacesListRecent: async ({ limit }) => await listRecentWorkspacesForVoiceTool({ limit }),
    pathsListRecent: async ({ machineId, limit }) => await listRecentPathsForVoiceTool({ machineId, limit }),
    machinesList: async ({ limit }) => await listMachinesForVoiceTool({ limit }),
    serversList: async ({ limit }) => await listServersForVoiceTool({ limit }),
    agentsBackendsList: async ({ includeDisabled }) => await listAgentBackendsForVoiceTool({ includeDisabled }),
    agentsModelsList: async ({ agentId, machineId }) => await listAgentModelsForVoiceTool({ agentId, machineId }),

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

    daemonMemorySearch: async ({ machineId, query, serverId }) =>
      await machineRpcWithServerScope({
        machineId,
        serverId,
        method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
        payload: query,
      }),

    daemonMemoryGetWindow: async ({ machineId, sessionId, seqFrom, seqTo, serverId }) =>
      await machineRpcWithServerScope({
        machineId,
        serverId,
        method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
        payload: { v: 1, sessionId, seqFrom, seqTo },
      }),

    daemonMemoryEnsureUpToDate: async ({ machineId, sessionId, serverId }) =>
      await machineRpcWithServerScope({
        machineId,
        serverId,
        method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
        payload: sessionId ? { sessionId } : {},
      }),

    ...(opts?.resolveServerIdForSessionId ? { resolveServerIdForSessionId: opts.resolveServerIdForSessionId } : {}),
  };

  return createActionExecutor(deps);
}
