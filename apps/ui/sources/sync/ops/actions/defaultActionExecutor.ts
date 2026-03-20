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
import { forkSession as forkSessionOp, rollbackSessionConversation as rollbackSessionConversationOp } from '@/sync/ops/sessions';
import { completeSessionHandoff as completeSessionHandoffOp } from '@/sync/ops/sessionHandoffs';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { sendSessionMessageWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { teleportVoiceAgentToSessionRoot } from '@/voice/agent/teleportVoiceAgentToSessionRoot';
import { storage } from '@/sync/domains/state/storage';
import { resetVoiceAgentPersistenceState } from '@/voice/persistence/resetVoiceAgentPersistenceState';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';
import { openSessionForVoiceTool } from '@/voice/tools/actionImpl/openSession';
import { spawnSessionForVoiceTool } from '@/voice/tools/actionImpl/spawnSession';
import { spawnSessionWithPickerForVoiceTool } from '@/voice/tools/actionImpl/spawnSessionPicker';
import { setPrimaryActionSessionId, setTrackedSessionIds } from '@/voice/tools/actionImpl/sessionTargets';
import { listSessionsForVoiceTool } from '@/voice/tools/actionImpl/sessionList';
import { getSessionActivityForVoiceTool } from '@/voice/tools/actionImpl/sessionActivity';
import { getSessionRecentMessagesForVoiceTool } from '@/voice/tools/actionImpl/sessionRecentMessages';
import { listRecentPathsForVoiceTool } from '@/voice/tools/actionImpl/pathsListRecent';
import { listMachinesForVoiceTool } from '@/voice/tools/actionImpl/machinesList';
import { listServersForVoiceTool } from '@/voice/tools/actionImpl/serversList';
import { listReviewEnginesForVoiceTool } from '@/voice/tools/actionImpl/reviewEnginesList';
import { listAgentBackendsForVoiceTool, listAgentModelsForVoiceTool } from '@/voice/tools/actionImpl/agentCatalogList';
import { sync } from '@/sync/sync';
import { publishAcpSessionModeOverrideToMetadata } from '@/sync/engine/overrides/acpSessionModeOverridePublish';
import { updatePromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { updateSkillPromptBundle } from '@/sync/ops/promptLibrary/promptBundles';
import { writePromptLibraryArtifactToExternalAsset } from '@/sync/ops/promptLibrary/exportPromptLibraryArtifact';
import { installPromptRegistryItem } from '@/sync/ops/promptLibrary/installPromptRegistryItem';
import { canRollbackConversation } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import {
  isRequestedSessionModeSupported,
  isSessionModeActionAvailable,
  normalizeRequestedSessionModeId,
  resolveSessionModeActionControl,
  serializeSessionModeActionOptions,
} from './sessionModeActionSupport';

export function createDefaultActionExecutor(opts?: Readonly<{
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
  resolveServerNameForSessionId?: (sessionId: string) => string | null;
  openSession?: (sessionId: string) => void | Promise<void>;
}>): ReturnType<typeof createActionExecutor> {
  const resolveSessionMachineId = (sessionId: string, metadata: { machineId?: unknown } | null | undefined): string => {
    const reachableMachineId = readMachineTargetForSession(sessionId)?.machineId ?? '';
    if (reachableMachineId) {
      return reachableMachineId;
    }
    return typeof metadata?.machineId === 'string' ? String(metadata.machineId).trim() : '';
  };

  const resolveActionsSettingsSnapshot = () => {
    const stateAny: any = storage.getState();
    const raw = stateAny?.settings?.actionsSettingsV1;
    const parsed = ActionsSettingsV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : { v: 1 as const, actions: {} as Record<ActionId, any> };
  };

  const deps: ActionExecutorDeps = {
    isActionEnabled: (actionId: ActionId, ctx) =>
      {
        if (
          !isActionEnabledByActionsSettings(actionId, resolveActionsSettingsSnapshot(), {
            surface: ctx.surface ?? null,
            placement: ctx.placement ?? null,
          })
        ) {
          return false;
        }
        if (actionId !== 'session.mode.set') {
          if (actionId !== 'session.rollback') {
            return true;
          }
          const sessionId = typeof ctx.defaultSessionId === 'string' ? ctx.defaultSessionId.trim() : '';
          if (!sessionId) {
            return false;
          }
          const session = (storage.getState() as any)?.sessions?.[sessionId] ?? null;
          return canRollbackConversation({ session });
        }
        const sessionId = typeof ctx.defaultSessionId === 'string' ? ctx.defaultSessionId.trim() : '';
        if (!sessionId) {
          return true;
        }
        const session = (storage.getState() as any)?.sessions?.[sessionId] ?? null;
        return isSessionModeActionAvailable(session);
      },
    executionRunStart: sessionExecutionRunStart,
    executionRunList: sessionExecutionRunList,
    executionRunGet: sessionExecutionRunGet,
    executionRunSend: sessionExecutionRunSend,
    executionRunStop: sessionExecutionRunStop,
    executionRunAction: sessionExecutionRunAction,

    sessionOpen: async ({ sessionId }) =>
      opts?.openSession
        ? (await opts.openSession(sessionId), { ok: true, status: 'opened', sessionId } as const)
        : await openSessionForVoiceTool({
          sessionId,
          resolveServerIdForSessionId: opts?.resolveServerIdForSessionId,
          resolveServerNameForSessionId: opts?.resolveServerNameForSessionId,
        }),

    sessionFork: async ({ sessionId, serverId }) => {
      const sid = String(sessionId ?? '').trim();
      if (!sid) return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      const stateAny: any = storage.getState();
      const session = stateAny?.sessions?.[sid] ?? null;
      const machineId = resolveSessionMachineId(sid, session?.metadata ?? null);

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
        if (opts?.openSession) {
          await opts.openSession(childSessionId);
        } else {
          await openSessionForVoiceTool({
            sessionId: childSessionId,
            resolveServerIdForSessionId: opts?.resolveServerIdForSessionId,
            resolveServerNameForSessionId: opts?.resolveServerNameForSessionId,
          });
        }
      }
      return { ok: true, status: 'forked', parentSessionId: sid, childSessionId };
    },

    sessionRollback: async ({ sessionId, serverId, target }) => {
      const sid = String(sessionId ?? '').trim();
      if (!sid) return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      return await rollbackSessionConversationOp({
        sessionId: sid,
        serverId,
        target: target ?? { type: 'latest_turn' },
      });
    },

    sessionHandoffStart: async ({ sessionId, targetMachineId, targetSessionStorageMode, workspaceTransfer, serverId }) => {
      const sid = String(sessionId ?? '').trim();
      const tid = String(targetMachineId ?? '').trim();
      if (!sid || !tid) return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };

      const stateAny: any = storage.getState();
      const session = stateAny?.sessions?.[sid] ?? null;
      const metadata = session?.metadata ?? null;
      const sourceMachineId = resolveSessionMachineId(sid, metadata);
      const sessionStorageMode = metadata?.directSessionV1 ? 'direct' : 'persisted';

      return await completeSessionHandoffOp({
        sessionId: sid,
        sourceMachineId: sourceMachineId || undefined,
        targetMachineId: tid,
        sessionStorageMode,
        ...(targetSessionStorageMode ? { targetSessionStorageMode } : {}),
        preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
        ...(workspaceTransfer ? {
          workspaceTransfer: {
            ...workspaceTransfer,
            ignoredIncludeGlobs: [...workspaceTransfer.ignoredIncludeGlobs],
          },
        } : {}),
        sourceMetadata: metadata ?? {},
        serverId,
      });
    },

    sessionSpawnNew: async ({ tag, agentId, modelId, path, host, initialMessage }) =>
      await spawnSessionForVoiceTool({ tag, agentId, modelId, path, host, initialMessage }),

    sessionSpawnPicker: async ({ tag, agentId, modelId, initialMessage }) =>
      await spawnSessionWithPickerForVoiceTool({ tag, agentId, modelId, initialMessage }),

    pathsListRecent: async ({ machineId, limit }) => await listRecentPathsForVoiceTool({ machineId, limit }),
    machinesList: async ({ limit }) => await listMachinesForVoiceTool({ limit }),
    serversList: async ({ limit }) => await listServersForVoiceTool({ limit }),
    reviewEnginesList: async ({ sessionId, includeDisabled }) => await listReviewEnginesForVoiceTool({ sessionId, includeDisabled }),
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
    sessionUserActionAnswer: async ({ sessionId, requestId, answers, decision, reason, updatedPermissions, serverId }) => {
      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }
      const normalizedAnswers = Object.fromEntries(
        (Array.isArray(answers) ? answers : [])
          .map((entry: any) => ({
            question: String(entry?.question ?? '').trim(),
            answer: String(entry?.answer ?? '').trim(),
          }))
          .filter((entry) => entry.question.length > 0 && entry.answer.length > 0)
          .map((entry) => [entry.question, entry.answer] as const),
      );
      if (!decision && Object.keys(normalizedAnswers).length === 0) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', sessionId };
      }
      const approved = decision ? decision === 'approve' : true;
      return await sessionRpcWithServerScope({
        sessionId,
        serverId,
        method: 'permission',
        payload: {
          id: reqId,
          approved,
          ...(Object.keys(normalizedAnswers).length > 0 ? { answers: normalizedAnswers } : {}),
          ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
          ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
        },
      });
    },
    sessionModeSet: async ({ sessionId, modeId }) => {
      const session = (storage.getState() as any)?.sessions?.[sessionId] ?? null;
      const control = resolveSessionModeActionControl(session);
      const normalizedModeId = normalizeRequestedSessionModeId(modeId);
      if (!isRequestedSessionModeSupported(control, normalizedModeId)) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      await publishAcpSessionModeOverrideToMetadata({
        sessionId,
        modeId: normalizedModeId,
        updatedAt: Date.now(),
        updateSessionMetadataWithRetry: sync.patchSessionMetadataWithRetry,
      });
      return { ok: true, sessionId, modeId: normalizedModeId };
    },
    sessionModesList: async ({ sessionId }) => {
      const session = (storage.getState() as any)?.sessions?.[sessionId] ?? null;
      return {
        items: serializeSessionModeActionOptions(resolveSessionModeActionControl(session)).map((option) => ({
          id: option.value,
          label: option.label,
          ...(typeof option.description === 'string' && option.description.trim().length > 0
            ? { description: option.description }
            : {}),
        })),
      };
    },

    sessionTargetPrimarySet: async ({ sessionId }) => await setPrimaryActionSessionId({ sessionId }),
    sessionTargetTrackedSet: async ({ sessionIds }) => await setTrackedSessionIds({ sessionIds }),
    sessionList: async ({ limit, cursor, includeLastMessagePreview }) => await listSessionsForVoiceTool({ limit, cursor, includeLastMessagePreview }),
    sessionActivityGet: async ({ sessionId, windowSeconds }) => await getSessionActivityForVoiceTool({ sessionId, windowSeconds }),
    sessionRecentMessagesGet: async ({ sessionId, defaultSessionId, limit, cursor, includeUser, includeAssistant, maxCharsPerMessage }) =>
      await getSessionRecentMessagesForVoiceTool({ sessionId, defaultSessionId, limit, cursor, includeUser, includeAssistant, maxCharsPerMessage }),

    resetGlobalVoiceAgent: async () => {
      await resetVoiceAgentPersistenceState({
        stop: async () => await voiceSessionManager.stop(VOICE_AGENT_GLOBAL_SESSION_ID),
      });
    },
    teleportVoiceAgentToSessionRoot: async ({ sessionId }) => await teleportVoiceAgentToSessionRoot({ sessionId }),

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
      const serverId = typeof request.serverId === 'string' ? request.serverId.trim() : '';
      const header: ArtifactHeader = {
        v: 1,
        kind: 'approval_request.v1',
        title: request.summary,
        approvalStatus: request.status,
        actionId: request.actionId,
        ...(serverId ? { serverId } : {}),
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

    promptAssetExport: async ({ artifactId, machineId, assetTypeId, scope, serverId, directory, targetPath, targetName, installMode }) => {
      const result = await writePromptLibraryArtifactToExternalAsset({
        artifactId,
        machineId,
        assetTypeId,
        scope,
        serverId,
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

    promptRegistryInstall: async ({ machineId, sourceId, itemId, configuredSources, serverId, installTarget }) => {
      const result = await installPromptRegistryItem({
        machineId,
        sourceId,
        itemId,
        configuredSources,
        serverId,
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

  const executor = createActionExecutor(deps);

  return {
    execute: async (actionId, input, context) => await executor.execute(actionId, input, context),
  };
}
