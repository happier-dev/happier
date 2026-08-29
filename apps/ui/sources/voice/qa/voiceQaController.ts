import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { storage } from '@/sync/domains/state/storage';
import { runVoiceAgentTurnWithTools } from '@/voice/local/runVoiceAgentTurnWithTools';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import { buildVoiceInitialContext } from '@/voice/context/buildVoiceInitialContext';
import { captureAssistantTextMessageBaseline } from '@/voice/runtime/waitForNextAssistantTextMessage';
import type { VoiceSessionSnapshot } from '@/voice/session/types';
import {
  submitDurableVoiceTextTurn,
  type VoiceTextTurnPendingPort,
} from '@/voice/binding/sendVoiceSessionComposerText';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import type { VoiceAgentSendTurnOptions } from '@/voice/agent/types';
import type { DaemonSpeechStreamQaRouteRequirement } from '@/voice/runtime/daemonInference/daemonSpeechStreamQaRouteRequirement';

import { formatVoiceQaErrorMessage } from './formatVoiceQaErrorMessage';
import { createDefaultVoiceQaControllerDeps } from './voiceQaRuntimeDeps';
import {
  appendVoiceQaPendingRequestContextDiagnostics,
  formatVoiceQaPendingRequestBreakdown,
} from './voiceQaPendingRequestDiagnostics';
import {
  beginVoiceQaRun,
  formatVoiceQaTargetLabel,
  isVoiceQaTurnAbortedError,
  resolveVoiceQaOperationalProvider,
} from './voiceQaControllerState';
import {
  assertLocalVoiceAgentSupportedForQa,
  formatVoiceQaPermissionModeLabel,
  normalizeVoiceQaText,
  resolveConfiguredVoiceQaProvider,
  resolveEffectiveVoiceQaSessionId,
  resolveEffectiveVoiceQaTargetSessionId,
  resolveLocalVoiceQaControlSessionId,
  resolveLocalVoiceQaRuntimeSessionId,
  resolveVoiceQaRuntimeSessionId,
  syncLatestLocalVoiceQaResolvedSessions,
} from './voiceQaSessionResolution';
import { useVoiceQaStore } from './voiceQaStore';
import {
  formatVoiceQaToolResultsSummary,
  shouldVoiceQaWatchForAsyncTargetFollowUp,
} from './voiceQaToolResultFormatting';

export type VoiceQaControllerDeps = Readonly<{
  getSettings: () => any;
  getVoiceTargetState: () => Readonly<{ primaryActionSessionId: string | null; lastFocusedSessionId: string | null }>;
  ensureLocalBinding: (params: Readonly<{ controlSessionId: string; requestedTargetSessionId?: string | null }>) => Promise<VoiceSessionBinding | null>;
  getLocalBinding?: (controlSessionId: string) => VoiceSessionBinding | null;
  ensureLocalRunningAndMaybeWelcome: (sessionId: string) => Promise<string | null>;
  ensureSessionVisibleForMessageRoute?: (sessionId: string, options?: Readonly<{ forceRefresh?: boolean }>) => Promise<unknown> | void;
  refreshSessionMessages?: (sessionId: string) => Promise<void> | void;
  pendingPort?: VoiceTextTurnPendingPort;
  commitLocalUserTranscript?: (sessionId: string, prompt: string, localId: string) => Promise<void>;
  sendLocalTurn: (
    sessionId: string,
    prompt: string,
    options?: VoiceAgentSendTurnOptions,
  ) => Promise<Readonly<{ assistantText: string; actions?: ReadonlyArray<unknown> }>>;
  stopLocal: (sessionId: string) => Promise<void>;
  appendLocalContextUpdate: (sessionId: string, update: string) => void;
  startRealtime: (sessionId: string, initialContext?: string, options?: Readonly<{ textOnly?: boolean }>) => Promise<void>;
  isRealtimeStarted: () => boolean;
  stopRealtime: () => Promise<void>;
  getRealtimeSession: () => Readonly<{ sendTextMessage: (message: string) => void; sendContextualUpdate: (update: string) => void }> | null;
  getRealtimeBinding: (controlSessionId: string) => VoiceSessionBinding | null;
  sendRealtimeTextTurn: (params: Readonly<{ controlSessionId: string; conversationSessionId: string; text: string }>) => Promise<void>;
  waitForInterruptedLocalAssistantTurn: (params: Readonly<{
    conversationSessionId: string;
    timeoutMs: number;
    baseline?: Readonly<{
      baselineIds: Set<string>;
      baselineCount: number;
    }> | null;
  }>) => Promise<string | null>;
  /** Dev-route media QA delegates to the same lifecycle owner as VoiceSurface. */
  installMediaTransportRouteRequirement?: (input: Readonly<{
    sessionId: string;
    routeKind: DaemonSpeechStreamQaRouteRequirement;
  }>) => () => void;
  startMedia?: (sessionId: string) => Promise<void>;
  stopMedia?: (sessionId: string, adapterId: string | null) => Promise<void>;
  getMediaSnapshot?: () => VoiceSessionSnapshot;
  qaStore: typeof useVoiceQaStore;
}>;

export type VoiceQaStartMode = 'text' | 'media';

type VoiceQaStartParams = Readonly<{
  sessionId?: string | null;
  initialContext?: string | null;
  mode?: VoiceQaStartMode;
  transportRouteRequirement?: DaemonSpeechStreamQaRouteRequirement;
}>;

type VoiceQaStartResult = Readonly<{
  provider: ReturnType<typeof resolveConfiguredVoiceQaProvider>;
  sessionId: string;
}>;

export function createVoiceQaController(
  deps: VoiceQaControllerDeps = createDefaultVoiceQaControllerDeps(),
) {
  let activeMediaSession: Readonly<{
    provider: VoiceQaStartResult['provider'];
    sessionId: string;
    adapterId: string | null;
    releaseTransportRouteRequirement: (() => void) | null;
  }> | null = null;
  let activeMediaStart: Promise<VoiceQaStartResult> | null = null;

  const startAttempt = async (params?: VoiceQaStartParams): Promise<VoiceQaStartResult> => {
    const settings = deps.getSettings();
    const provider = resolveConfiguredVoiceQaProvider(settings);
    const targetSessionId = resolveEffectiveVoiceQaSessionId(params?.sessionId, deps.getVoiceTargetState);
    const controlSessionId = provider === 'local_voice_agent' ? resolveLocalVoiceQaControlSessionId() : targetSessionId;
    beginVoiceQaRun(deps.qaStore, provider, controlSessionId);
    deps.qaStore.getState().setResolvedSessions({ targetSessionId, runtimeSessionId: null });
    deps.qaStore.getState().appendSystem(`Starting ${provider} QA session for ${formatVoiceQaTargetLabel(targetSessionId, settings)}`);
    let pendingMediaTransportRouteRelease: (() => void) | null = null;

    try {
      if (params?.mode === 'media') {
        if (!deps.startMedia || !deps.stopMedia || !deps.getMediaSnapshot) {
          throw new Error('voice_qa_media_mode_unavailable');
        }
        if (params.transportRouteRequirement) {
          if (!deps.installMediaTransportRouteRequirement) {
            throw new Error('voice_qa_media_transport_route_requirement_unavailable');
          }
          pendingMediaTransportRouteRelease = deps.installMediaTransportRouteRequirement({
            sessionId: targetSessionId,
            routeKind: params.transportRouteRequirement,
          });
        }

        await deps.startMedia(targetSessionId);
        const snapshot = deps.getMediaSnapshot();
        if (
          snapshot.status === 'disconnected'
          || snapshot.status === 'error'
          || !snapshot.sessionId
        ) {
          const adapterId = snapshot.adapterId ?? 'none';
          const errorCode = snapshot.errorCode ?? 'none';
          const errorReason = snapshot.errorMessage ?? 'none';
          throw new Error(
            `voice_qa_media_session_not_started:adapter=${adapterId},status=${snapshot.status},mode=${snapshot.mode},error=${errorCode},reason=${errorReason}`,
          );
        }

        activeMediaSession = {
          provider,
          sessionId: snapshot.sessionId,
          adapterId: snapshot.adapterId,
          releaseTransportRouteRequirement: pendingMediaTransportRouteRelease,
        };
        pendingMediaTransportRouteRelease = null;
        deps.qaStore.getState().setResolvedSessions({
          targetSessionId,
          runtimeSessionId: snapshot.sessionId,
        });
        deps.qaStore
          .getState()
          .appendSystem(`Media session started: status=${snapshot.status} mode=${snapshot.mode}`);
        deps.qaStore.getState().setStatus('running');
        return { provider, sessionId: snapshot.sessionId };
      }

      if (provider === 'local_voice_agent') {
        assertLocalVoiceAgentSupportedForQa(settings);
        const binding = await deps.ensureLocalBinding({
          controlSessionId,
          requestedTargetSessionId: targetSessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? null : targetSessionId,
        });
        if (targetSessionId !== VOICE_AGENT_GLOBAL_SESSION_ID) {
          await Promise.resolve(deps.ensureSessionVisibleForMessageRoute?.(targetSessionId)).catch(() => {});
          await Promise.resolve(deps.refreshSessionMessages?.(targetSessionId)).catch(() => {});
        }
        const runtimeSessionId = resolveLocalVoiceQaRuntimeSessionId(binding, controlSessionId);
        deps.qaStore.getState().setResolvedSessions({
          targetSessionId,
          runtimeSessionId: resolveVoiceQaRuntimeSessionId(binding, runtimeSessionId),
        });
        let targetSessionContext =
          targetSessionId !== VOICE_AGENT_GLOBAL_SESSION_ID
            ? normalizeVoiceQaText(buildVoiceInitialContext(runtimeSessionId, { targetSessionId }))
            : '';
        let hasPendingRequestsInTargetContext = false;
        let pendingRequestBreakdown: string | null = null;
        if (targetSessionContext) {
          hasPendingRequestsInTargetContext = targetSessionContext.includes('## Pending Requests');
          pendingRequestBreakdown = formatVoiceQaPendingRequestBreakdown(targetSessionId);
          appendVoiceQaPendingRequestContextDiagnostics(
            deps.qaStore,
            hasPendingRequestsInTargetContext,
            pendingRequestBreakdown,
          );
        }
        if (targetSessionId !== VOICE_AGENT_GLOBAL_SESSION_ID) {
          const state = storage.getState() as any;
          const targetSessionMetadata = readVoiceSessionOwnerMetadataFromState(state, targetSessionId);
          const targetSession = state?.sessions?.[targetSessionId] ?? null;
          const permissionMode = normalizeVoiceQaText(targetSessionMetadata?.permissionMode ?? targetSession?.permissionMode);
          if (permissionMode === 'read-only' || permissionMode === 'plan') {
            deps.qaStore
              .getState()
              .appendSystem(
                `Target session permission mode is ${formatVoiceQaPermissionModeLabel(permissionMode)}; write-like actions may auto-deny instead of surfacing an approvable pending request.`,
              );
          }
        }
        const welcome = await deps.ensureLocalRunningAndMaybeWelcome(runtimeSessionId);
        deps.qaStore.getState().setStatus('running');
        if (targetSessionContext) {
          deps.appendLocalContextUpdate(runtimeSessionId, targetSessionContext);
          deps.qaStore.getState().appendSystem('Sent local voice target-session context');
        }
        if (targetSessionId !== VOICE_AGENT_GLOBAL_SESSION_ID && !hasPendingRequestsInTargetContext) {
          void (async () => {
            await Promise.resolve(
              deps.ensureSessionVisibleForMessageRoute?.(targetSessionId, { forceRefresh: true }),
            ).catch(() => {});
            await Promise.resolve(deps.refreshSessionMessages?.(targetSessionId)).catch(() => {});
            const refreshedTargetSessionContext = normalizeVoiceQaText(
              buildVoiceInitialContext(runtimeSessionId, { targetSessionId }),
            );
            if (!refreshedTargetSessionContext || refreshedTargetSessionContext === targetSessionContext) return;
            const refreshedHasPendingRequests = refreshedTargetSessionContext.includes('## Pending Requests');
            if (!refreshedHasPendingRequests) return;
            appendVoiceQaPendingRequestContextDiagnostics(
              deps.qaStore,
              refreshedHasPendingRequests,
              formatVoiceQaPendingRequestBreakdown(targetSessionId),
              { refreshed: true },
            );
            deps.appendLocalContextUpdate(runtimeSessionId, refreshedTargetSessionContext);
            deps.qaStore.getState().appendSystem('Sent refreshed local voice target-session context');
          })();
        }
        if (normalizeVoiceQaText(params?.initialContext)) {
          deps.appendLocalContextUpdate(runtimeSessionId, normalizeVoiceQaText(params?.initialContext));
          deps.qaStore.getState().appendSystem('Sent local voice context update');
        }
        if (welcome) deps.qaStore.getState().appendAssistant(welcome);
        return { provider, sessionId: controlSessionId };
      }

      await deps.startRealtime(targetSessionId, normalizeVoiceQaText(params?.initialContext) || undefined, { textOnly: true });
      if (!deps.isRealtimeStarted()) {
        throw new Error('realtime_voice_session_not_started');
      }
      const realtimeBinding = deps.getRealtimeBinding(targetSessionId);
      deps.qaStore.getState().setResolvedSessions({
        targetSessionId,
        runtimeSessionId: normalizeVoiceQaText(realtimeBinding?.conversationSessionId) || targetSessionId,
      });
      deps.qaStore.getState().setStatus('running');
      return { provider, sessionId: targetSessionId };
    } catch (error) {
      pendingMediaTransportRouteRelease?.();
      const message = formatVoiceQaErrorMessage(error, 'voice_qa_start_failed');
      deps.qaStore.getState().setStatus('error');
      deps.qaStore.getState().appendError(message);
      throw error;
    }
  };

  const start = (params?: VoiceQaStartParams): Promise<VoiceQaStartResult> => {
    if (params?.mode !== 'media') {
      return startAttempt(params);
    }
    if (activeMediaSession) {
      return Promise.resolve({
        provider: activeMediaSession.provider,
        sessionId: activeMediaSession.sessionId,
      });
    }
    if (activeMediaStart) {
      return activeMediaStart;
    }

    const mediaStart = startAttempt(params);
    activeMediaStart = mediaStart;
    void mediaStart.then(
      () => {
        if (activeMediaStart === mediaStart) activeMediaStart = null;
      },
      () => {
        if (activeMediaStart === mediaStart) activeMediaStart = null;
      },
    );
    return mediaStart;
  };

  const sendPrompt = async (params: Readonly<{ prompt: string; sessionId?: string | null; autoStart?: boolean }>) => {
    const prompt = normalizeVoiceQaText(params.prompt);
    if (!prompt) return;

    const settings = deps.getSettings();
    const configuredProvider = resolveConfiguredVoiceQaProvider(settings);
    const targetSessionId = resolveEffectiveVoiceQaTargetSessionId(
      params.sessionId,
      configuredProvider,
      deps.getVoiceTargetState,
      deps.qaStore,
    );
    const sessionId = configuredProvider === 'local_voice_agent' ? resolveLocalVoiceQaControlSessionId() : targetSessionId;
    const current = deps.qaStore.getState();
    const provider = resolveVoiceQaOperationalProvider(configuredProvider, current, sessionId);
    if (params.autoStart !== false && (current.status === 'idle' || current.sessionId !== sessionId || current.provider !== provider)) {
      await start({ sessionId: targetSessionId });
    }

    deps.qaStore.getState().appendUser(prompt);

    try {
      if (provider === 'local_voice_agent') {
        assertLocalVoiceAgentSupportedForQa(settings);
        const binding = await deps.ensureLocalBinding({
          controlSessionId: sessionId,
          requestedTargetSessionId: targetSessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? null : targetSessionId,
        });
        const runtimeSessionId = resolveLocalVoiceQaRuntimeSessionId(binding, sessionId);
        const conversationSessionId = normalizeVoiceQaText(binding?.conversationSessionId);
        deps.qaStore.getState().setResolvedSessions({
          targetSessionId,
          runtimeSessionId: resolveVoiceQaRuntimeSessionId(binding, runtimeSessionId),
        });
        if (!conversationSessionId) throw new Error('voice_session_binding_required');
        const baseline = captureAssistantTextMessageBaseline(conversationSessionId);
        let appendedAssistantTurn = false;
        let shouldWatchAsyncTargetFollowUp = false;
        const appendFollowUpAssistantTurn = async (timeoutMs: number): Promise<string | null> => {
          const followUpAssistantText = await deps.waitForInterruptedLocalAssistantTurn({
            conversationSessionId,
            timeoutMs,
            baseline,
          });
          const normalizedFollowUpAssistantText = normalizeVoiceQaText(followUpAssistantText);
          if (!normalizedFollowUpAssistantText) return null;
          deps.qaStore.getState().appendAssistant(normalizedFollowUpAssistantText);
          return normalizedFollowUpAssistantText;
        };
        try {
          let result: Awaited<ReturnType<typeof runVoiceAgentTurnWithTools>> | null = null;
          let interruptedFollowUpText: string | null = null;
          const durableResult = await submitDurableVoiceTextTurn({
            conversationSessionId,
            text: prompt,
            pendingPort: deps.pendingPort,
            dispatch: async ({ localId, onAccepted }) => {
              try {
                result = await runVoiceAgentTurnWithTools({
                  sessionId: runtimeSessionId,
                  userText: prompt,
                  durableLocalId: localId,
                  currentToolSessionId: targetSessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? null : targetSessionId,
                  voiceAgentSessions: {
                    ...(deps.commitLocalUserTranscript
                      ? { commitUserTranscript: deps.commitLocalUserTranscript }
                      : {}),
                    sendTurn: deps.sendLocalTurn,
                    stop: deps.stopLocal,
                  },
                  onUserTranscriptAccepted: onAccepted,
                  onAssistantTurn: async ({ assistantText }) => {
                    deps.qaStore.getState().appendAssistant(assistantText);
                    if (normalizeVoiceQaText(assistantText)) appendedAssistantTurn = true;
                  },
                  onToolResults: async ({ toolResults }) => {
                    if (toolResults.length > 0) {
                      deps.qaStore.getState().appendSystem(formatVoiceQaToolResultsSummary(toolResults));
                      if (shouldVoiceQaWatchForAsyncTargetFollowUp(toolResults)) {
                        shouldWatchAsyncTargetFollowUp = true;
                      }
                    }
                  },
                });
              } catch (error) {
                if (!isVoiceQaTurnAbortedError(error)) throw error;
                const followUp = await appendFollowUpAssistantTurn(20_000);
                if (followUp) appendedAssistantTurn = true;
                interruptedFollowUpText = followUp;
                result = {
                  disposition: 'completed',
                  assistantTurns: followUp ? [followUp] : [],
                  toolResultBatches: [],
                  totalActions: 0,
                };
                if (!followUp) {
                  deps.qaStore.getState().appendSystem('Local voice turn was interrupted by a higher-priority update.');
                }
              }
            },
          });
          if (!durableResult.ok) {
            deps.qaStore.getState().setStatus('error');
            throw new Error(durableResult.message ?? durableResult.reason);
          }
          if (interruptedFollowUpText) {
            return { assistantText: interruptedFollowUpText, actions: [] };
          }
          if (result === null) {
            if (durableResult.disposition === 'settled') {
              return { assistantText: '', actions: [] };
            }
            throw new Error(
              durableResult.disposition === 'ambiguous'
                ? 'voice_turn_dispatch_ambiguous'
                : 'voice_turn_pending',
            );
          }
          if (result.disposition === 'tool_round_limit_reached') {
            deps.qaStore.getState().appendSystem('Local voice agent stopped at the tool round limit before its requested actions could run.');
          }
          if (appendedAssistantTurn && shouldWatchAsyncTargetFollowUp) {
            void appendFollowUpAssistantTurn(15_000);
          }
          if (!appendedAssistantTurn && conversationSessionId) {
            const normalizedFollowUpAssistantText = await appendFollowUpAssistantTurn(5_000);
            if (normalizedFollowUpAssistantText) {
              return { assistantText: normalizedFollowUpAssistantText, actions: [] };
            }
          }
          return result;
        } catch (error) {
          if (!isVoiceQaTurnAbortedError(error)) throw error;
          if (!conversationSessionId) {
            deps.qaStore.getState().appendSystem('Local voice turn was interrupted by a higher-priority update.');
            return { assistantText: '', actions: [] };
          }
          const normalizedFollowUpAssistantText = await appendFollowUpAssistantTurn(20_000);
          if (normalizedFollowUpAssistantText) {
            return { assistantText: normalizedFollowUpAssistantText, actions: [] };
          }
          deps.qaStore.getState().appendSystem('Local voice turn was interrupted by a higher-priority update.');
          return { assistantText: '', actions: [] };
        } finally {
          syncLatestLocalVoiceQaResolvedSessions(deps, sessionId, binding);
        }
      }

      const binding = deps.getRealtimeBinding(sessionId);
      if (binding) {
        deps.qaStore.getState().setResolvedSessions({
          targetSessionId,
          runtimeSessionId: normalizeVoiceQaText(binding.conversationSessionId) || targetSessionId,
        });
        await deps.sendRealtimeTextTurn({
          controlSessionId: binding.controlSessionId,
          conversationSessionId: binding.conversationSessionId,
          text: prompt,
        });
        return { assistantText: '', actions: [] };
      }

      const error = new Error('realtime_voice_session_binding_required');
      deps.qaStore.getState().setStatus('error');
      deps.qaStore.getState().appendError(error.message);
      throw error;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'voice_qa_send_failed';
      deps.qaStore.getState().appendError(message);
      throw error;
    }
  };

  const sendContextUpdate = async (params: Readonly<{ update: string; sessionId?: string | null; autoStart?: boolean }>) => {
    const update = normalizeVoiceQaText(params.update);
    if (!update) return;
    const settings = deps.getSettings();
    const configuredProvider = resolveConfiguredVoiceQaProvider(settings);
    const targetSessionId = resolveEffectiveVoiceQaTargetSessionId(
      params.sessionId,
      configuredProvider,
      deps.getVoiceTargetState,
      deps.qaStore,
    );
    const sessionId = configuredProvider === 'local_voice_agent' ? resolveLocalVoiceQaControlSessionId() : targetSessionId;
    const current = deps.qaStore.getState();
    const provider = resolveVoiceQaOperationalProvider(configuredProvider, current, sessionId);
    if (params.autoStart !== false && (current.status === 'idle' || current.sessionId !== sessionId || current.provider !== provider)) {
      await start({ sessionId: targetSessionId });
    }

    if (provider === 'local_voice_agent') {
      assertLocalVoiceAgentSupportedForQa(settings);
      const binding = await deps.ensureLocalBinding({
        controlSessionId: sessionId,
        requestedTargetSessionId: targetSessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? null : targetSessionId,
      });
      const runtimeSessionId = resolveLocalVoiceQaRuntimeSessionId(binding, sessionId);
      deps.qaStore.getState().setResolvedSessions({
        targetSessionId,
        runtimeSessionId: resolveVoiceQaRuntimeSessionId(binding, runtimeSessionId),
      });
      deps.appendLocalContextUpdate(runtimeSessionId, update);
      deps.qaStore.getState().appendSystem(`Context update: ${update}`);
      return;
    }

    const session = deps.getRealtimeSession();
    if (!session) {
      const error = new Error('realtime_voice_session_not_registered');
      deps.qaStore.getState().setStatus('error');
      deps.qaStore.getState().appendError(error.message);
      throw error;
    }
    session.sendContextualUpdate(update);
    deps.qaStore.getState().appendSystem(`Context update: ${update}`);
  };

  const stop = async (params?: Readonly<{ sessionId?: string | null }>) => {
    const settings = deps.getSettings();
    const current = deps.qaStore.getState();
    const targetSessionId = resolveEffectiveVoiceQaSessionId(params?.sessionId, deps.getVoiceTargetState);
    const configuredProvider = resolveConfiguredVoiceQaProvider(settings);
    const activeLocalControlSessionId =
      current.status !== 'idle' && current.provider === 'local_voice_agent' && normalizeVoiceQaText(current.sessionId)
        ? normalizeVoiceQaText(current.sessionId)
        : null;
    const sessionId = activeLocalControlSessionId
      ?? (configuredProvider === 'local_voice_agent' ? resolveLocalVoiceQaControlSessionId() : targetSessionId);
    const provider = activeLocalControlSessionId
      ? 'local_voice_agent'
      : resolveVoiceQaOperationalProvider(configuredProvider, current, sessionId);
    deps.qaStore.getState().setStatus('stopping');

    try {
      if (activeMediaSession) {
        const mediaSession = activeMediaSession;
        if (!deps.stopMedia) {
          throw new Error('voice_qa_media_mode_unavailable');
        }
        try {
          await deps.stopMedia(mediaSession.sessionId, mediaSession.adapterId);
        } finally {
          mediaSession.releaseTransportRouteRequirement?.();
          activeMediaSession = null;
        }
        deps.qaStore.getState().appendSystem('Stopped media QA session');
        deps.qaStore.getState().setStatus('idle');
        return;
      }

      if (provider === 'local_voice_agent') {
        const binding = deps.getLocalBinding?.(sessionId) ?? null;
        const runtimeSessionId = resolveLocalVoiceQaRuntimeSessionId(binding, sessionId);
        await deps.stopLocal(runtimeSessionId);
      } else {
        await deps.stopRealtime();
      }
      deps.qaStore.getState().appendSystem(`Stopped ${provider} QA session`);
      deps.qaStore.getState().setStatus('idle');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'voice_qa_stop_failed';
      deps.qaStore.getState().setStatus('error');
      deps.qaStore.getState().appendError(message);
      throw error;
    }
  };

  const clear = () => {
    deps.qaStore.getState().clear();
  };

  return {
    start,
    sendPrompt,
    sendContextUpdate,
    stop,
    clear,
  };
}

export const voiceQaController = createVoiceQaController();
