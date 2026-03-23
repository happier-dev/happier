import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { storage } from '@/sync/domains/state/storage';
import { resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import { runVoiceAgentTurnWithTools } from '@/voice/local/runVoiceAgentTurnWithTools';
import type { VoiceSessionBinding } from '@/voice/sessionBinding/voiceSessionBindingTypes';
import { buildVoiceInitialContext } from '@/voice/context/buildVoiceInitialContext';
import { captureAssistantTextMessageBaseline } from '@/voice/runtime/waitForNextAssistantTextMessage';

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
  sendLocalTurn: (sessionId: string, prompt: string) => Promise<Readonly<{ assistantText: string; actions?: ReadonlyArray<unknown> }>>;
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
  qaStore: typeof useVoiceQaStore;
}>;

export function createVoiceQaController(
  deps: VoiceQaControllerDeps = createDefaultVoiceQaControllerDeps(),
) {
  const start = async (params?: Readonly<{ sessionId?: string | null; initialContext?: string | null }>) => {
    const settings = deps.getSettings();
    const provider = resolveConfiguredVoiceQaProvider(settings);
    const targetSessionId = resolveEffectiveVoiceQaSessionId(params?.sessionId, deps.getVoiceTargetState);
    const controlSessionId = provider === 'local_voice_agent' ? resolveLocalVoiceQaControlSessionId() : targetSessionId;
    beginVoiceQaRun(deps.qaStore, provider, controlSessionId);
    deps.qaStore.getState().setResolvedSessions({ targetSessionId, runtimeSessionId: null });
    deps.qaStore.getState().appendSystem(`Starting ${provider} QA session for ${formatVoiceQaTargetLabel(targetSessionId, settings)}`);

    try {
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
          const targetSession = (storage.getState() as any)?.sessions?.[targetSessionId] ?? null;
          const permissionMode = normalizeVoiceQaText(targetSession?.permissionMode);
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
      const message = formatVoiceQaErrorMessage(error, 'voice_qa_start_failed');
      deps.qaStore.getState().setStatus('error');
      deps.qaStore.getState().appendError(message);
      throw error;
    }
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
        const baseline =
          conversationSessionId
            ? captureAssistantTextMessageBaseline(conversationSessionId)
            : null;
        let appendedAssistantTurn = false;
        let shouldWatchAsyncTargetFollowUp = false;
        const appendFollowUpAssistantTurn = async (timeoutMs: number): Promise<string | null> => {
          if (!conversationSessionId) return null;
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
          const result = await runVoiceAgentTurnWithTools({
            sessionId: runtimeSessionId,
            userText: prompt,
            currentToolSessionId: targetSessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? null : targetSessionId,
            voiceAgentSessions: {
              sendTurn: deps.sendLocalTurn,
            },
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

      const session = deps.getRealtimeSession();
      const binding = deps.getRealtimeBinding(sessionId);
      if (binding?.adapterId === 'realtime_elevenlabs') {
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

      if (!session) {
        const error = new Error('realtime_voice_session_not_registered');
        deps.qaStore.getState().setStatus('error');
        deps.qaStore.getState().appendError(error.message);
        throw error;
      }
      session.sendTextMessage(prompt);
      return { assistantText: '', actions: [] };
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
      if (provider === 'local_voice_agent') {
        const binding = resolveVoiceSessionBindingByControlSessionId({
          controlSessionId: sessionId,
          adapterId: 'local_conversation',
        });
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
