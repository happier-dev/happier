import {
  ApprovalRequestV1Schema,
  ActionsSettingsV1Schema,
  buildBackendTargetKeyV2,
  createActionExecutor,
  isActionEnabledByActionsSettings,
  isApprovalRequiredByActionsSettings,
  readSessionProviderBindingMetadataV1,
  SessionModelTransitionRequestV1Schema,
  SessionModelTransitionResultV1Schema,
  type ActionExecutorDeps,
  type ActionDefinitionV1,
  type ActionId,
  type ApprovalRequestV1,
  type SessionModelTransitionRequestV1,
  type SessionModelTransitionResultV1,
  type SessionSpawnNewInputV2,
  type SessionSpawnNewResultV1,
} from '@happier-dev/protocol';
import { resolveModelSelectionIntentFromSessionMetadata } from '@happier-dev/agents';
import {
  createModelIntentMetadataCasCandidate,
  runModelIntentAtAuthoritativeDisposition,
} from '@happier-dev/agents/session/state/metadataWriters';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { publishDisplayTitleToMetadata } from '@/sync/state/displayTitlePublish';
import { createUiExecutionRunActionDeps } from './executionRunActionDeps';
import {
    forkSession as forkSessionOp,
    rollbackSessionCheckpointCode as rollbackSessionCheckpointCodeOp,
    rollbackSessionConversation as rollbackSessionConversationOp,
    sessionStopWithServerScope,
} from '@/sync/ops/sessions';
import { completeSessionHandoff as completeSessionHandoffOp } from '@/sync/ops/sessionHandoffs';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { sendSessionMessageWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { teleportVoiceAgentToSessionRoot } from '@/voice/agent/teleportVoiceAgentToSessionRoot';
import { storage } from '@/sync/domains/state/storage';
import { resolveHappierReplayConfig } from '@/sync/domains/session/resume/happierReplayPrompt';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { resolveSessionForkStrategyAvailability } from '@/sync/domains/sessionFork/forkUiSupport';
import { resolveSessionForkReplayOptions } from '@/sync/domains/sessionFork/resolveSessionForkReplayOptions';
import { resetVoiceAgentPersistenceState } from '@/voice/persistence/resetVoiceAgentPersistenceState';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';
import { openSessionForVoiceTool } from '@/voice/tools/actionImpl/openSession';
import { setPrimaryActionSessionId, setTrackedSessionIds } from '@/voice/tools/actionImpl/sessionTargets';
import { listSessionsForVoiceTool } from '@/voice/tools/actionImpl/sessionList';
import { getSessionActivityForVoiceTool } from '@/voice/tools/actionImpl/sessionActivity';
import {
  getSessionRecentMessagesForVoiceTool,
  getSessionTranscriptForVoiceTool,
} from '@/voice/tools/actionImpl/sessionRecentMessages';
import { listRecentPathsForVoiceTool } from '@/voice/tools/actionImpl/pathsListRecent';
import { listMachinesForVoiceTool } from '@/voice/tools/actionImpl/machinesList';
import { listServersForVoiceTool } from '@/voice/tools/actionImpl/serversList';
import { listReviewEnginesForVoiceTool } from '@/voice/tools/actionImpl/reviewEnginesList';
import { listAgentBackendsForVoiceTool, listAgentModelsForVoiceTool } from '@/voice/tools/actionImpl/agentCatalogList';
import { createReviewCommentsHttpActionExecutor } from '@/sync/domains/reviews/comments/api';
import { sync } from '@/sync/sync';
import { publishAcpSessionModeOverrideToMetadata } from '@/sync/state/acpSessionModeOverridePublish';
import { updatePromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { updateSkillPromptBundle } from '@/sync/ops/promptLibrary/promptBundles';
import { writePromptLibraryArtifactToExternalAsset } from '@/sync/ops/promptLibrary/exportPromptLibraryArtifact';
import { installPromptRegistryItem } from '@/sync/ops/promptLibrary/installPromptRegistryItem';
import { canRollbackConversation } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import type { CurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { completeSessionForkNavigation } from '@/sync/domains/sessionFork/completeSessionForkNavigation';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { getSessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import {
  isRequestedSessionModeSupported,
  isSessionModeActionAvailable,
  normalizeRequestedSessionModeId,
  resolveSessionModeActionControl,
  serializeSessionModeActionOptions,
} from './sessionModeActionSupport';
import {
  createDefaultRuntimeActionExecutor,
  type CreateDefaultRuntimeActionExecutorInput,
} from './defaultRuntimeActionExecutor';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { executeAccountPluginDataEraseAction } from '@/sync/domains/plugins/settings/accountPluginDataEraseAction';

  type OpenSessionOptions = Readonly<{ serverId?: string | null }>;

  export function createDefaultActionExecutor(opts?: Readonly<{
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
  resolveServerNameForSessionId?: (sessionId: string) => string | null;
  openSession?: (sessionId: string, options?: OpenSessionOptions) => void | Promise<void>;
  runtimeActions?: CreateDefaultRuntimeActionExecutorInput;
  listContributedActionDefinitions?: () => readonly ActionDefinitionV1[];
  /** Optional surface-local policy composed with the canonical Action settings policy. */
  isActionEnabled?: NonNullable<ActionExecutorDeps['isActionEnabled']>;
  /** Current external Agent declaration supplied by a rendered lifecycle control. */
  currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
  }>): ReturnType<typeof createActionExecutor> {
    type AgentsBackendsListArgs = Readonly<{ includeDisabled?: boolean; limit?: number; machineId?: string }>;
    type AgentsModelsListArgs = Readonly<{ agentId?: string; machineId?: string; limit?: number; backendTargetKey?: string }>;

  const resolveSessionMachineId = (sessionId: string, metadata: { machineId?: unknown } | null | undefined): string => {
    const controlMachineId = readMachineControlTargetForSession(sessionId)?.machineId ?? '';
    if (controlMachineId) {
      return controlMachineId;
    }
    return typeof metadata?.machineId === 'string' ? String(metadata.machineId).trim() : '';
  };

  const resolveActionsSettingsSnapshot = () => {
    const stateAny: any = storage.getState();
    const raw = stateAny?.settings?.actionsSettingsV1;
    const parsed = ActionsSettingsV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : { v: 1 as const, actions: {} as Record<ActionId, any> };
  };
  const executeReviewCommentAction = createReviewCommentsHttpActionExecutor();

  const deps: ActionExecutorDeps = {
    listContributedActionDefinitions: opts?.listContributedActionDefinitions,
    isActionEnabled: (actionId: ActionId, ctx) =>
      {
        if (opts?.isActionEnabled && !opts.isActionEnabled(actionId, ctx)) {
          return false;
        }
        if (
          !isActionEnabledByActionsSettings(actionId, resolveActionsSettingsSnapshot(), {
            surface: ctx.surface ?? null,
            placement: ctx.placement ?? null,
          })
        ) {
          return false;
        }
        if (actionId !== 'session.mode.set') {
          return true;
        }
        const sessionId = typeof ctx.defaultSessionId === 'string' ? ctx.defaultSessionId.trim() : '';
        if (!sessionId) {
          return true;
        }
        const session = (storage.getState() as any)?.sessions?.[sessionId] ?? null;
        return isSessionModeActionAvailable(session);
      },
    isActionApprovalRequired: (actionId, ctx) =>
      isApprovalRequiredByActionsSettings(actionId, resolveActionsSettingsSnapshot(), {
        surface: ctx.surface ?? null,
      }),
    ...createUiExecutionRunActionDeps(),
    runtimeActionExecute: createDefaultRuntimeActionExecutor(opts?.runtimeActions),
    accountPluginDataEraseAction: async ({ input, signal }) => await executeAccountPluginDataEraseAction(
      input,
      signal ? { signal } : undefined,
    ),

    sessionOpen: async ({ sessionId, serverId }) =>
      opts?.openSession
        ? (
          serverId
            ? await opts.openSession(sessionId, { serverId })
            : await opts.openSession(sessionId),
          { ok: true, status: 'opened', sessionId } as const
        )
        : await openSessionForVoiceTool({
          sessionId,
          resolveServerIdForSessionId: serverId
            ? (targetSessionId) => targetSessionId === sessionId ? serverId : opts?.resolveServerIdForSessionId?.(targetSessionId) ?? null
            : opts?.resolveServerIdForSessionId,
          resolveServerNameForSessionId: opts?.resolveServerNameForSessionId,
        }),

    sessionFork: async ({ sessionId, serverId }) => {
      const sid = String(sessionId ?? '').trim();
      if (!sid) return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      const resolvedServerId = String(serverId ?? opts?.resolveServerIdForSessionId?.(sid) ?? '').trim();
      const stateAny: any = storage.getState();
      const session = stateAny?.sessions?.[sid] ?? null;
      const metadata = session ? readSessionOwnerMetadataView(session) : null;
      const machineId = resolveSessionMachineId(sid, metadata);

      const settings = stateAny?.settings ?? null;
      const forkPoint = { type: 'latest' } as const;
      // One fork policy for every surface. This executor has no strategy modal
      // to show, so it reads the same availability the modal renders and asks
      // for the exact route that modal would have offered. An unqualified
      // request is what let the daemon settle on Replay for an account that
      // turned Replay off.
      const availability = resolveSessionForkStrategyAvailability({
        session,
        forkPoint,
        replayEnabled: resolveHappierReplayConfig(settings ?? {}).enabled,
        // Source-context continuation is a navigation to the New Session
        // screen; this executor has no such route, so it is not one of its
        // options rather than a route it silently fails to take.
        agentSwitchingEnabled: false,
        currentAgentCapabilities: opts?.currentAgentCapabilities,
      });
      if (!availability.native && !availability.replay) {
        return { ok: false, errorCode: 'action_disabled', errorMessage: 'action_disabled' };
      }
      const replayOptions = resolveSessionForkReplayOptions({
        settings,
        executionRunsEnabled: resolveLocalFeaturePolicyEnabled('execution.runs', settings ?? {}),
      });

      const result = await forkSessionOp({
        ...(machineId ? { machineId } : {}),
        serverId: resolvedServerId || undefined,
        parentSessionId: sid,
        forkPoint,
        // `auto` is the only value that can fall through to Replay, so it stays
        // the request exactly while Replay is a route the account allows.
        ...(availability.replay ? {} : { strategy: 'native' as const }),
        ...replayOptions,
      } as any);
      if ((result as any)?.ok !== true) return result as any;

      const childSessionId = String((result as any).childSessionId ?? '').trim();
      if (childSessionId) {
        await completeSessionForkNavigation({
          childSessionId,
          parentSessionId: sid,
          ...(resolvedServerId ? { serverId: resolvedServerId } : {}),
          navigate: async (targetSessionId, navigationOptions) => {
            const navigationServerId = navigationOptions?.serverId ?? resolvedServerId;
            if (opts?.openSession) {
              if (navigationServerId) {
                await opts.openSession(targetSessionId, { serverId: navigationServerId });
              } else {
                await opts.openSession(targetSessionId);
              }
              return;
            }
            await openSessionForVoiceTool({
              sessionId: targetSessionId,
              resolveServerIdForSessionId: navigationServerId
                ? (candidateSessionId) => candidateSessionId === targetSessionId
                  ? navigationServerId
                  : opts?.resolveServerIdForSessionId?.(candidateSessionId) ?? null
                : opts?.resolveServerIdForSessionId,
              resolveServerNameForSessionId: opts?.resolveServerNameForSessionId,
            });
          },
        });
      }
      return { ok: true, status: 'forked', parentSessionId: sid, childSessionId };
    },

    sessionStop: async ({ sessionId, serverId }) =>
      await sessionStopWithServerScope(sessionId, { serverId }),

    sessionTerminalComposerClear: async ({ sessionId, expectedStateAtMs, serverId }) =>
      await sessionRpcWithServerScope({
        sessionId,
        serverId,
        method: SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR,
        payload: {
          sessionId,
          ...(typeof expectedStateAtMs === 'number' && Number.isFinite(expectedStateAtMs)
            ? { expectedStateAtMs }
            : {}),
        },
      }),

    sessionPendingInputInterruptAndRun: async ({ sessionId, localId, expectedStateAtMs, serverId }) =>
      await sessionRpcWithServerScope({
        sessionId,
        serverId,
        method: SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN,
        payload: {
          sessionId,
          localId,
          ...(typeof expectedStateAtMs === 'number' && Number.isFinite(expectedStateAtMs)
            ? { expectedStateAtMs }
            : {}),
        },
      }),

    sessionRollback: async ({ sessionId, serverId, target }) => {
      const sid = String(sessionId ?? '').trim();
      if (!sid) return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      const resolvedTarget = target ?? { type: 'latest_turn' };
      const session = (storage.getState() as any)?.sessions?.[sid] ?? null;
      if (!canRollbackConversation({
        session,
        target: resolvedTarget,
        currentAgentCapabilities: opts?.currentAgentCapabilities,
      })) {
        return { ok: false, errorCode: 'action_disabled', errorMessage: 'action_disabled' };
      }
      return await rollbackSessionConversationOp({
        sessionId: sid,
        serverId,
        target: resolvedTarget,
      });
    },

    checkpointCodeRollback: async ({ request, serverId }) =>
      await rollbackSessionCheckpointCodeOp({ request, serverId }),

    sessionHandoffStart: async ({ sessionId, targetMachineId, targetSessionStorageMode, workspaceTransfer, serverId }) => {
      const sid = String(sessionId ?? '').trim();
      const tid = String(targetMachineId ?? '').trim();
      if (!sid || !tid) return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };

      const stateAny: any = storage.getState();
      const session = stateAny?.sessions?.[sid] ?? null;
      const metadata = session ? readSessionOwnerMetadataView(session) : null;
      const sourceMachineId = resolveSessionMachineId(sid, metadata);
      const sessionStorageMode = getSessionStorageKind(session);

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
        sourceMetadata: metadata ?? { path: '', host: '' },
        serverId,
      });
    },

    sessionSpawnNew: async ({
      sessionCreationTag: _sessionCreationTag,
      legacyMetadataLabel: _legacyMetadataLabel,
      actionCaller: _actionCaller,
      callerSurface: _callerSurface,
      callerPermissionMode: _callerPermissionMode,
      sessionAgentSpawnPolicyV1: _sessionAgentSpawnPolicyV1,
      actionRequestId: _actionRequestId,
      resumeActionRequest: _resumeActionRequest,
      signal,
      ...input
    }) => await machineRpcWithServerScope<SessionSpawnNewResultV1, SessionSpawnNewInputV2>({
      serverId: input.executionTarget.serverId,
      machineId: input.executionTarget.machineId,
      method: RPC_METHODS.SESSION_SPAWN_NEW,
      payload: input,
      signal,
    }),

    pathsListRecent: async ({ machineId, limit }) => await listRecentPathsForVoiceTool({ machineId, limit }),
    machinesList: async ({ limit }) => await listMachinesForVoiceTool({ limit }),
    serversList: async ({ limit }) => await listServersForVoiceTool({ limit }),
    reviewEnginesList: async ({ sessionId, includeDisabled }) => await listReviewEnginesForVoiceTool({ sessionId, includeDisabled }),
    reviewCommentAction: async ({ actionId, input }) => await executeReviewCommentAction(actionId, input),
    agentsBackendsList: async (args) => {
      const { includeDisabled, limit, machineId } = args as AgentsBackendsListArgs;
      return await listAgentBackendsForVoiceTool({ includeDisabled, limit, machineId });
    },
    agentsModelsList: async (args) => {
      const { agentId, machineId, limit, backendTargetKey } = args as AgentsModelsListArgs;
      return await listAgentModelsForVoiceTool({ agentId, machineId, limit, backendTargetKey });
    },

    sessionSendMessage: async ({ sessionId, message, serverId, requestedAction }) =>
      await sendSessionMessageWithServerScope({ sessionId, message, serverId, requestedAction }),

    sessionTitleSet: async ({ sessionId, title, serverId }) => {
      const sid = String(sessionId ?? '').trim();
      const normalizedTitle = String(title ?? '').trim();
      if (!sid || !normalizedTitle) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
      }

      const updatedAt = Date.now();
      try {
        await publishDisplayTitleToMetadata({
          sessionId: sid,
          title: normalizedTitle,
          updatedAt,
          updateSessionMetadataWithRetry: async (targetSessionId, updater) => {
            await sync.patchSessionMetadataWithRetry(
              targetSessionId,
              updater,
              { serverId: typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : null },
            );
          },
        });
      } catch (error) {
        const err = new Error(error instanceof Error ? error.message : 'action_failed');
        (err as Error & { code?: string }).code = 'action_failed';
        throw err;
      }

      return { ok: true, sessionId: sid, title: normalizedTitle, updatedAt };
    },

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
        method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
        payload: request,
      });
    },
    sessionPermissionRemoteAction: async (args) => {
      const rejectUnavailable = (
        code: 'canceled' | 'mediationStateUnavailable' | 'ownerMachineUnavailable',
      ) => args.actionId === 'session.permission.remote.pending.list'
        || args.actionId === 'session.permission.remote.grants.list'
        ? { ok: false as const, errorCode: code, error: code }
        : { status: 'rejected' as const, code };
      if (args.signal?.aborted) {
        return rejectUnavailable('canceled');
      }
      try {
        const result = await sessionRpcWithServerScope({
          sessionId: args.input.sessionId,
          serverId: args.serverId,
          method: args.actionId,
          payload: args.input,
        });
        return args.signal?.aborted ? rejectUnavailable('canceled') : result;
      } catch (error) {
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        throw error;
      }
    },
    sessionUserActionAnswer: async ({ sessionId, requestId, answers, decision, reason, updatedPermissions, serverId }) => {
      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }
      const normalizedAnswers = Object.create(null) as Record<string, readonly string[]>;
      for (const entry of Array.isArray(answers) ? answers : []) {
        const question = String(entry?.question ?? '');
        if (question.trim().length > 0 && entry.values.length > 0) {
          normalizedAnswers[question] = [...entry.values];
        }
      }
      if (!decision && Object.keys(normalizedAnswers).length === 0) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', sessionId };
      }
      const approved = decision ? decision === 'approve' : true;
      return await sessionRpcWithServerScope({
        sessionId,
        serverId,
        method: RPC_METHODS.SESSION_USER_ACTION_ANSWER,
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
      const normalizedModeId = normalizeRequestedSessionModeId(control, modeId);
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
    sessionModelSet: async (args) => {
      const { sessionId, modelId, providerConnectionId, serverId } = args;
      const normalizedSessionId = String(sessionId ?? '').trim();
      const normalizedModelId = String(modelId ?? '').trim();
      if (!normalizedSessionId || !normalizedModelId) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }

      const session = storage.getState().sessions[normalizedSessionId] ?? null;
      if (!session) {
        return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
      }
      const hasExplicitProviderConnectionId = Object.prototype.hasOwnProperty.call(
        args,
        'providerConnectionId',
      );
      const resolveRequest = (candidateSession: typeof session) => {
        const backend = resolveSessionActionDefaultBackend({
          session: candidateSession,
        });
        if (!backend) return null;
        const agentTargetKey =
          buildBackendTargetKeyV2(backend.backendTarget);
        const ownerMetadata = readSessionOwnerMetadataView(candidateSession);
        const currentIntent = resolveModelSelectionIntentFromSessionMetadata(
          ownerMetadata,
          agentTargetKey,
        );
        const parsed = SessionModelTransitionRequestV1Schema.safeParse({
          v: 1,
          selection: {
            agentTargetKey,
            providerConnectionId: hasExplicitProviderConnectionId
              ? providerConnectionId ?? null
              : candidateSession.active === true
                ? readSessionProviderBindingMetadataV1(ownerMetadata)
                  ?.connectionId ?? null
                : currentIntent?.selection?.providerConnectionId ?? null,
            modelId: normalizedModelId,
          },
        });
        return parsed.success
          ? {
            request: parsed.data,
            currentIntent,
            agentTargetKey,
          }
          : null;
      };
      const initialRequest = resolveRequest(session);
      if (!initialRequest) {
        return {
          ok: false,
          errorCode: 'model_selection_agent_target_unknown',
          error: 'model_selection_agent_target_unknown',
        };
      }

      const invokeActiveOwner = async (
        request: SessionModelTransitionRequestV1,
      ) => {
        let transition: SessionModelTransitionResultV1;
        try {
          const result = await sessionRpcWithServerScope<
            SessionModelTransitionResultV1,
            SessionModelTransitionRequestV1
          >({
            sessionId: normalizedSessionId,
            serverId,
            method: SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
            payload: request,
          });
          transition = SessionModelTransitionResultV1Schema.parse(result);
        } catch (error) {
          transition = SessionModelTransitionResultV1Schema.parse({
            ok: false,
            status: 'owner_unavailable',
            activeSelection: null,
            requestedSelection: request.selection,
            reason: error instanceof Error
              ? error.message.slice(0, 512)
                || 'session_model_transition_owner_unavailable'
              : 'session_model_transition_owner_unavailable',
          });
        }
        if (!transition.ok) {
          return {
            ok: false,
            errorCode: transition.status,
            error: transition.status,
            details: {
              status: transition.status,
              activeSelection: transition.activeSelection,
              requestedSelection: transition.requestedSelection,
              ...(transition.reason ? { reason: transition.reason } : {}),
            },
          };
        }
        return {
          ...transition,
          sessionId: normalizedSessionId,
          modelId: transition.activeSelection.modelId,
        };
      };

      return await runModelIntentAtAuthoritativeDisposition({
        observedActive: session.active === true,
        invokeObservedActiveOwner: async () =>
          await invokeActiveOwner(initialRequest.request),
        updateInactiveIntent: async () => {
          const candidate = createModelIntentMetadataCasCandidate({
            selection: initialRequest.request.selection,
          });
          await sync.patchSessionMetadataWithRetry(
            normalizedSessionId,
            candidate.update,
            {
              serverId:
                typeof serverId === 'string'
                && serverId.trim().length > 0
                  ? serverId.trim()
                  : null,
              sessionExpectation: { kind: 'inactive_model_intent' },
            },
          );
          const candidateState = candidate.readState();
          if (
            !candidateState.accepted
            || candidateState.updatedAt === null
          ) {
            return {
              ok: false,
              errorCode: 'superseded',
              error: 'superseded',
              details: {
                status: 'superseded',
                activeSelection:
                  initialRequest.currentIntent?.selection ?? {
                    agentTargetKey: initialRequest.agentTargetKey,
                    providerConnectionId: null,
                    modelId: 'default',
                  },
                requestedSelection: initialRequest.request.selection,
                reason: 'accepted_intent_was_superseded',
              },
            };
          }
          return {
            ok: true,
            status: 'intent_updated',
            sessionId: normalizedSessionId,
            modelId: initialRequest.request.selection.modelId,
            selection: initialRequest.request.selection,
            updatedAt: candidateState.updatedAt,
          };
        },
        resolveAndInvokeActiveOwnerAfterConflict: async () => {
          const currentSession =
            storage.getState().sessions[normalizedSessionId] ?? null;
          if (!currentSession || currentSession.active !== true) {
            return {
              ok: false,
              errorCode: 'owner_unavailable',
              error: 'owner_unavailable',
              details: {
                status: 'owner_unavailable',
                activeSelection: null,
                requestedSelection: initialRequest.request.selection,
                reason: 'session_model_transition_owner_unproven',
              },
            };
          }
          const currentRequest = resolveRequest(currentSession);
          if (!currentRequest) {
            return {
              ok: false,
              errorCode: 'owner_unavailable',
              error: 'owner_unavailable',
              details: {
                status: 'owner_unavailable',
                activeSelection: null,
                requestedSelection: initialRequest.request.selection,
                reason:
                  'session_model_transition_owner_metadata_unavailable',
              },
            };
          }
          return await invokeActiveOwner(currentRequest.request);
        },
      });
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
    sessionTranscriptGet: async ({ sessionId, projection, limit, cursor, roles, maxCharsPerMessage }) =>
      await getSessionTranscriptForVoiceTool({
        sessionId,
        ...(projection ? { projection } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(roles ? { roles } : {}),
        ...(maxCharsPerMessage !== undefined ? { maxCharsPerMessage } : {}),
      }),
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
