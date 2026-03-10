import {
  ApprovalRequestV1Schema,
  ActionsSettingsV1Schema,
  createActionExecutor,
  isActionEnabledByActionsSettings,
  type ActionExecutorDeps,
  type ActionId,
  type ApprovalRequestV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  sessionExecutionRunAction,
  sessionExecutionRunGet,
  sessionExecutionRunList,
  sessionExecutionRunSend,
  sessionExecutionRunStart,
  sessionExecutionRunStop,
} from '@/sync/ops/sessionExecutionRuns';
import { forkSession as forkSessionOp } from '@/sync/ops/sessions';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { sendSessionMessageWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { storage } from '@/sync/domains/state/storage';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';
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
import { sync } from '@/sync/sync';
import { updatePromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { updateSkillPromptBundle } from '@/sync/ops/promptLibrary/promptBundles';
import { writePromptLibraryArtifactToExternalAsset } from '@/sync/ops/promptLibrary/exportPromptLibraryArtifact';
import { installPromptRegistryItem } from '@/sync/ops/promptLibrary/installPromptRegistryItem';

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

    sessionFork: async ({ sessionId, serverId }) => {
      const sid = String(sessionId ?? '').trim();
      if (!sid) return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      const stateAny: any = storage.getState();
      const session = stateAny?.sessions?.[sid] ?? null;
      const machineId = typeof session?.metadata?.machineId === 'string' ? String(session.metadata.machineId).trim() : '';

      const settings = stateAny?.settings ?? null;
      const replaySummaryRunner =
        settings?.sessionReplayStrategy === 'summary_plus_recent'
          ? (settings?.sessionReplaySummaryRunnerV1 ?? null)
          : null;
      const replayMaxSeedChars = typeof settings?.sessionReplayMaxSeedChars === 'number' ? settings.sessionReplayMaxSeedChars : undefined;

      const result = await forkSessionOp({
        ...(machineId ? { machineId } : {}),
        serverId,
        parentSessionId: sid,
        forkPoint: { type: 'latest' },
        ...(typeof replayMaxSeedChars === 'number' ? { replayMaxSeedChars } : {}),
        ...(replaySummaryRunner ? { replaySummaryRunner } : {}),
      } as any);
      if ((result as any)?.ok !== true) return result as any;

      const childSessionId = String((result as any).childSessionId ?? '').trim();
      if (childSessionId) {
        await openSessionForVoiceTool({ sessionId: childSessionId, resolveServerIdForSessionId: opts?.resolveServerIdForSessionId });
      }
      return { ok: true, status: 'forked', parentSessionId: sid, childSessionId };
    },

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

    approvalsCreate: async ({ request }) => {
      const sessionId = typeof request.createdBy.sessionId === 'string' ? String(request.createdBy.sessionId).trim() : '';
      const serverId = typeof (request as { serverId?: unknown }).serverId === 'string'
        ? String((request as { serverId?: string }).serverId).trim()
        : '';
      const header: ArtifactHeader = {
        v: 1,
        kind: 'approval_request.v1',
        title: request.summary,
        approvalStatus: request.status,
        actionId: request.actionId,
        ...(serverId ? { serverId } : {}),
        ...(sessionId ? { sessions: [sessionId], sessionId } : {}),
      };
      const artifactId = await sync.createArtifactWithHeader(header, JSON.stringify(request));
      return { artifactId };
    },

    approvalsGet: async ({ artifactId }) => {
      const local = storage.getState().artifacts[artifactId] ?? null;
      const localBody = local?.body;
      if (typeof localBody === 'string') {
        try {
          const parsed = ApprovalRequestV1Schema.safeParse(JSON.parse(localBody));
          if (parsed.success) return parsed.data;
        } catch {
          // ignore and fall through to fetch
        }
      }

      const full = await sync.fetchArtifactWithBody(artifactId);
      if (full) {
        storage.getState().updateArtifact(full);
        const body = full.body;
        if (typeof body !== 'string') return null;
        try {
          const parsed = ApprovalRequestV1Schema.safeParse(JSON.parse(body));
          return parsed.success ? parsed.data : null;
        } catch {
          return null;
        }
      }

      return null;
    },

    approvalsUpdate: async ({ artifactId, request }) => {
      const sessionId = typeof request.createdBy.sessionId === 'string' ? String(request.createdBy.sessionId).trim() : '';
      const header: ArtifactHeader = {
        v: 1,
        kind: 'approval_request.v1',
        title: request.summary,
        approvalStatus: request.status,
        actionId: request.actionId,
        ...(sessionId ? { sessions: [sessionId], sessionId } : {}),
      };

      await sync.updateArtifactWithHeader(artifactId, header, JSON.stringify(request satisfies ApprovalRequestV1));
      return { ok: true };
    },

    promptDocUpdate: async ({ artifactId, title, markdown, folderId, tags }) => {
      await updatePromptDoc({ artifactId, title, markdown, ...(typeof folderId !== 'undefined' ? { folderId } : {}), ...(tags ? { tags } : {}) });
      return { ok: true, artifactId };
    },

    promptBundleUpdate: async ({ artifactId, title, skillMarkdown, folderId, tags }) => {
      await updateSkillPromptBundle({ artifactId, title, skillMarkdown, ...(typeof folderId !== 'undefined' ? { folderId } : {}), ...(tags ? { tags } : {}) });
      return { ok: true, artifactId };
    },

    promptAssetExport: async ({ artifactId, machineId, assetTypeId, scope, directory, targetPath, targetName, installMode }) => {
      const result = await writePromptLibraryArtifactToExternalAsset({
        artifactId,
        machineId,
        assetTypeId,
        scope,
        workspacePath: directory ?? null,
        targetInput: targetPath ?? targetName ?? '',
        installMode,
        promptExternalLinks: storage.getState().settings.promptExternalLinksV1,
        previewOnly: false,
      });
      if (!result.ok || !result.nextPromptExternalLinks) {
        return { ok: false, errorCode: result.ok ? 'invalid_parameters' : (result.errorCode ?? 'invalid_parameters'), error: result.ok ? 'invalid_parameters' : result.error };
      }
      storage.getState().applySettingsLocal({ promptExternalLinksV1: result.nextPromptExternalLinks });
      return { ok: true, artifactId, exported: true };
    },

    promptRegistryInstall: async ({ machineId, sourceId, itemId, configuredSources, installTarget }) => {
      const result = await installPromptRegistryItem({
        machineId,
        sourceId,
        itemId,
        configuredSources,
        promptExternalLinks: storage.getState().settings.promptExternalLinksV1,
        ...(installTarget ? { installTarget } : {}),
      });
      if (!result.ok) {
        return { ok: false, errorCode: 'invalid_parameters', error: result.error, ...(result.artifactId ? { artifactId: result.artifactId } : {}) };
      }
      if (result.nextPromptExternalLinks) {
        storage.getState().applySettingsLocal({ promptExternalLinksV1: result.nextPromptExternalLinks });
      }
      return { ok: true, artifactId: result.artifactId, exported: result.exported };
    },

    ...(opts?.resolveServerIdForSessionId ? { resolveServerIdForSessionId: opts.resolveServerIdForSessionId } : {}),
  };

  return createActionExecutor(deps);
}
