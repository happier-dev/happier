import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';

import { createElevenLabsConversationHandle } from './createElevenLabsConversationHandle.js';
import { createElevenLabsAttemptResources } from './elevenLabsAttemptResources.js';
import { createElevenLabsConversationHandleRegistry } from './elevenLabsConversationHandleRegistry.js';
import { createElevenLabsDiagnostics } from './elevenLabsDiagnostics.js';
import { createElevenLabsEventMapper } from './elevenLabsEventMapper.js';
import { createElevenLabsLiveness } from './elevenLabsLiveness.js';
import { createElevenLabsProtocolAdapter } from './elevenLabsProtocolAdapter.js';
import { createElevenLabsSdkConnection } from './elevenLabsSdkConnection.js';
import { createElevenLabsSessionLifecycle } from './elevenLabsSessionLifecycle.js';
import { createElevenLabsSessionPreparationService } from './elevenLabsSessionPreparation.js';
import { resolveElevenLabsStartIdentity } from './elevenLabsStartIdentity.js';
import { createRealtimeElevenLabsRuntime } from './realtimeElevenLabsRuntime.js';
import type {
  CreateConversationController,
  ElevenLabsRuntimeContribution,
  RealtimeConnection,
  VoiceAdapterSnapshot,
  VoiceToolResultRedactionPrefs,
} from './types.js';

export type ElevenLabsRuntimeHost = Readonly<{
  globalVoiceSessionId: string;
  getSettings: () => unknown;
  projectVoiceSettings: Parameters<typeof createElevenLabsSessionPreparationService>[0]['projectVoiceSettings'];
  createProviderClient: Parameters<typeof createElevenLabsSessionPreparationService>[0]['createProviderClient'];
  getCredentials: Parameters<typeof createElevenLabsSessionPreparationService>[0]['getCredentials'];
  fetchHostedVoiceToken: Parameters<typeof createElevenLabsSessionPreparationService>[0]['fetchHostedVoiceToken'];
  completeHostedVoiceSession: Parameters<typeof createElevenLabsSessionLifecycle>[0]['completeSession'];
  presentPaywall: Parameters<typeof createElevenLabsSessionPreparationService>[0]['presentPaywall'];
  alert: Parameters<typeof createElevenLabsSessionPreparationService>[0]['alert'];
  translate: Parameters<typeof createElevenLabsSessionLifecycle>[0]['translate'];
  createMachineError: Parameters<typeof createElevenLabsSessionPreparationService>[0]['createMachineError'];
  machine: Readonly<{
    transitionToAcquiringMic(controlSessionId: string, adapterId: string): void;
    transitionToConnecting(controlSessionId: string, adapterId: string): void;
    transitionToConnected(controlSessionId: string, adapterId: string): void;
    transitionToSpeaking(controlSessionId: string, adapterId: string): void;
    transitionToEnding(controlSessionId: string, adapterId: string): void;
    transitionToDisconnected(controlSessionId: string, adapterId: string, error: unknown | null): void;
    setError(controlSessionId: string, adapterId: string, error: unknown): void;
    setMuted(muted: boolean): void;
    getSnapshot(): unknown;
    projectSnapshot(adapterId: string, snapshot: unknown): VoiceAdapterSnapshot;
    subscribe(listener: () => void): () => void;
  }>;
  createConversationController: CreateConversationController;
  createSdkHandleConnection: Parameters<typeof createElevenLabsSdkConnection>[0]['createSdkHandleConnection'];
  createMicSession(input: Readonly<{ onFailure: (failure: Readonly<{ kind: string; reason: string }>) => void }>): Readonly<{
    ensureActive(): Promise<void>;
    teardown(): Promise<void>;
    setMuted(muted: boolean): void;
  }>;
  ensureBound(input: Readonly<{ adapterId: string; controlSessionId: string; requestedTargetSessionId: string | null }>): Promise<unknown>;
  resolveConversationSessionId(controlSessionId: string, adapterId: string): string | null;
  applyTargetSelection(input: Readonly<{ controlSessionId: string; targetSessionId: string; updateLastFocused: boolean }>): void;
  enableAudioMode(): Promise<void>;
  disableAudioMode(): Promise<void>;
  createStorageMirror(input: Readonly<{
    adapterId: string;
    getSnapshot: () => unknown;
    subscribe: (listener: () => void) => () => void;
    projectSnapshot: (snapshot: unknown) => Readonly<{ status: 'disconnected' | 'connecting' | 'connected' | 'error'; mode: 'idle' | 'speaking' }>;
  }>): () => void;
  projectTranscript(input: Readonly<{ conversationSessionId: string; event: unknown }>): void;
  appendConversationNote(input: Readonly<{ conversationSessionId: string; text: string }>): void;
  createInboundWatchdog: Parameters<typeof createElevenLabsLiveness>[0]['createInboundWatchdog'];
  runtimeConfig: Readonly<{
    handleReadyTimeoutMs: number;
    watchdogPollMs: number;
    watchdogPlateauMs: number;
    inboundStallMs: number;
    awaitingResponseMs: number;
  }>;
  diagnostics: Readonly<{
    appendSystem(message: string): void;
    appendProviderPayload(payload: unknown): void;
    appendError(reason: string): void;
  }>;
  voiceHooks: Readonly<{
    onStarted(sessionId: string): string;
    onStopped(): void;
  }>;
  realtimeClientTools: Readonly<Record<string, (parameters: unknown) => Promise<string>>>;
  resolveRedactionPrefs(): VoiceToolResultRedactionPrefs;
  redactToolResultValue(value: unknown, prefs: VoiceToolResultRedactionPrefs): unknown;
}>;

const ADAPTER_ID = 'realtime_elevenlabs' as const;

export function createElevenLabsRuntimeContribution(host: ElevenLabsRuntimeHost): ElevenLabsRuntimeContribution {
  const registry = createElevenLabsConversationHandleRegistry();
  const handle = createElevenLabsConversationHandle({
    clientTools: host.realtimeClientTools,
    resolveRedactionPrefs: host.resolveRedactionPrefs,
    redactToolResultValue: host.redactToolResultValue,
  });
  const unregisterVoice = registry.register('voice', handle);
  const unregisterText = registry.register('text', handle);
  const diagnostics = createElevenLabsDiagnostics(host.diagnostics);
  const preparation = createElevenLabsSessionPreparationService({
    providerId: ADAPTER_ID,
    projectVoiceSettings: host.projectVoiceSettings,
    createProviderClient: host.createProviderClient,
    getCredentials: host.getCredentials,
    fetchHostedVoiceToken: host.fetchHostedVoiceToken,
    presentPaywall: host.presentPaywall,
    alert: host.alert,
    createMachineError: host.createMachineError,
  });
  const lifecycle = createElevenLabsSessionLifecycle({
    getCredentials: host.getCredentials,
    completeSession: host.completeHostedVoiceSession,
    appendNote(controlSessionId, text) {
      const conversationSessionId = host.resolveConversationSessionId(controlSessionId, ADAPTER_ID)?.trim();
      if (conversationSessionId) host.appendConversationNote({ conversationSessionId, text });
    },
    translate: host.translate,
  });
  const protocol = createElevenLabsProtocolAdapter({
    preparation,
    lifecycle,
    eventMapper: createElevenLabsEventMapper(),
    onDiagnosticError: diagnostics.error,
    getSettings: host.getSettings,
  });
  let runtime: ReturnType<typeof createRealtimeElevenLabsRuntime> | null = null;

  const surfaceLivenessFailure = (reason: string): void => {
    if (!runtime?.getControlSessionId()) return;
    diagnostics.error(reason);
    void runtime.requestReconnect();
  };
  const liveness = createElevenLabsLiveness({
    createInboundWatchdog: host.createInboundWatchdog,
    now: () => Date.now(),
    readOutboundBytes: async () => await (registry.current('voice')?.readOutboundAudioBytes() ?? null),
    onInboundStall: () => surfaceLivenessFailure('realtime_inbound_stall'),
    onOutboundPlateau: () => surfaceLivenessFailure('realtime_outbound_audio_plateau'),
    pollMs: host.runtimeConfig.watchdogPollMs,
    plateauMs: host.runtimeConfig.watchdogPlateauMs,
    inboundStallMs: host.runtimeConfig.inboundStallMs,
    awaitingResponseMs: host.runtimeConfig.awaitingResponseMs,
  });
  const mic = host.createMicSession({
    onFailure(failure) {
      if (!runtime?.getControlSessionId()) return;
      const code = failure.kind === 'mic_permission_denied' ? 'mic_permission_revoked' : failure.kind;
      diagnostics.error(failure.kind === 'mic_permission_denied' ? 'realtime_mic_permission_revoked' : failure.reason);
      void runtime.fail(code);
    },
  });
  const resources = createElevenLabsAttemptResources({
    mic,
    transitionToAcquiringMic: (controlSessionId) => host.machine.transitionToAcquiringMic(controlSessionId, ADAPTER_ID),
    ensureBound: host.ensureBound,
    enableAudioMode: host.enableAudioMode,
    disableAudioMode: host.disableAudioMode,
  });

  const unsubscribeMirror = host.createStorageMirror({
    adapterId: ADAPTER_ID,
    getSnapshot: host.machine.getSnapshot,
    subscribe: host.machine.subscribe,
    projectSnapshot(snapshot) {
      const projected = host.machine.projectSnapshot(ADAPTER_ID, snapshot);
      return { status: projected.status, mode: projected.mode === 'speaking' ? 'speaking' : 'idle' };
    },
  });

  runtime = createRealtimeElevenLabsRuntime({
    createConversationController: host.createConversationController,
    protocol,
    machine: {
      connecting: ({ controlSessionId }) => host.machine.transitionToConnecting(controlSessionId, ADAPTER_ID),
      connected: ({ controlSessionId }) => {
        host.machine.transitionToConnected(controlSessionId, ADAPTER_ID);
        diagnostics.connected();
        liveness.connected();
      },
      ending: ({ controlSessionId }) => {
        liveness.disconnected();
        host.machine.transitionToEnding(controlSessionId, ADAPTER_ID);
      },
      disconnected: ({ controlSessionId, code }) => {
        liveness.disconnected();
        host.machine.transitionToDisconnected(
          controlSessionId,
          ADAPTER_ID,
          code ? host.createMachineError({ kind: 'provider_error', reason: code }) : null,
        );
        diagnostics.disconnected();
      },
      failed: ({ controlSessionId, code }) => {
        liveness.disconnected();
        host.machine.setError(controlSessionId, ADAPTER_ID, host.createMachineError({
          kind: code === 'reconnect_exhausted'
            ? 'reconnect_exhausted'
            : code === 'mic_permission_revoked'
              ? 'mic_permission_revoked'
              : 'provider_error',
          reason: code,
        }));
        diagnostics.error(code);
      },
    },
    resources: resources.port,
    createConnection: async (session): Promise<RealtimeConnection> => {
      const config = session.config && typeof session.config === 'object' && !Array.isArray(session.config)
        ? session.config as Readonly<Record<string, unknown>>
        : {};
      return createElevenLabsSdkConnection({
        createSdkHandleConnection: host.createSdkHandleConnection,
        startConfig: session.config,
        resolveHandle: async (signal) => registry.current(config.textOnly === true ? 'text' : 'voice')
          ?? await registry.waitForCurrent(
            config.textOnly === true ? 'text' : 'voice',
            signal,
            host.runtimeConfig.handleReadyTimeoutMs,
          ),
      });
    },
    isSelectionCurrent: () => preparation.isSelected(host.getSettings()),
    projectTranscript: ({ controlSessionId, event }) => {
      const conversationSessionId = host.resolveConversationSessionId(controlSessionId, ADAPTER_ID)?.trim();
      if (conversationSessionId) host.projectTranscript({ conversationSessionId, event });
    },
    onProviderMode(mode, controlSessionId) {
      liveness.modeChanged(mode);
      if (mode === 'speaking') host.machine.transitionToSpeaking(controlSessionId, ADAPTER_ID);
      else host.machine.transitionToConnected(controlSessionId, ADAPTER_ID);
    },
    onProviderEvent(event: VoiceRealtimeJsonValue) {
      liveness.noteInboundEvent();
      if (event && typeof event === 'object' && !Array.isArray(event)) {
        const message = event as Readonly<Record<string, unknown>>;
        if (message.role === 'user' || message.source === 'user') liveness.userTurnCommitted();
      }
      diagnostics.providerEvent(event);
    },
  });

  const startRuntime = async (
    sessionId: string,
    initialContext?: string,
    retryAfterPaywall = false,
    options?: Readonly<{ textOnly?: boolean }>,
  ) => {
    const { controlSessionId, requestedTargetSessionId } = resolveElevenLabsStartIdentity(
      sessionId,
      host.globalVoiceSessionId,
    );
    if (requestedTargetSessionId) {
      host.applyTargetSelection({ controlSessionId, targetSessionId: requestedTargetSessionId, updateLastFocused: true });
    }
    return await runtime!.start(controlSessionId, {
      initialContext,
      requestedTargetSessionId,
      retryAfterPaywall,
      textOnly: options?.textOnly === true,
    });
  };
  const getSnapshot = (): VoiceAdapterSnapshot => host.machine.projectSnapshot(ADAPTER_ID, host.machine.getSnapshot());
  let disposed = false;
  const adapter = Object.freeze({
    id: ADAPTER_ID,
    engineKind: 'realtime' as const,
    async start(input: Readonly<{ sessionId: string; initialContext?: string; textOnly?: boolean }>) {
      const initialContext = input.initialContext ?? host.voiceHooks.onStarted(input.sessionId);
      await startRuntime(input.sessionId, initialContext, false, { textOnly: input.textOnly });
    },
    async stop(_input?: Readonly<{ sessionId: string }>) {
      await runtime!.stop();
      host.voiceHooks.onStopped();
    },
    async toggle(input: Readonly<{ sessionId: string; initialContext?: string }>) { await adapter.start(input); },
    async interrupt(input: Readonly<{ sessionId: string }>) { await adapter.stop(input); },
    async setMuted(input: Readonly<{ sessionId: string; muted: boolean }>) {
      void input.sessionId;
      resources.setMuted(input.muted);
      host.machine.setMuted(input.muted);
      await runtime!.setInputMuted(input.muted);
    },
    sendContextUpdate(input: Readonly<{ sessionId: string; update: string }>) {
      void input.sessionId;
      if (runtime!.isStarted()) void runtime!.sendContextUpdate(input.update);
    },
    sendContextText(input: Readonly<{ sessionId: string; text: string }>) {
      void input.sessionId;
      if (runtime!.isStarted()) void runtime!.sendText(input.text);
    },
    async sendTextTurn(input: Readonly<{ controlSessionId: string; conversationSessionId: string; text: string }>) {
      void input.conversationSessionId;
      if (!runtime!.isStarted()) await startRuntime(input.controlSessionId, undefined, false, { textOnly: true });
      if (!runtime!.isStarted()) throw new Error('voice_service_unavailable');
      const result = await runtime!.sendText(input.text);
      if (result.status !== 'sent') throw new Error('voice_service_unavailable');
    },
    getSnapshot,
    subscribe: host.machine.subscribe,
    resolveBindingTranscriptMode: () => 'synthetic' as const,
    resolveSurfaceCapabilities: (voiceSettings: unknown) => {
      const projection = host.projectVoiceSettings({ voice: voiceSettings }, ADAPTER_ID);
      if (projection?.providerId !== ADAPTER_ID || !projection.providerConfig) return null;
      return {
        allowsGlobalStart: true,
        controlSessionScope: 'global' as const,
        requiresVoiceAgentFeature: false,
        bargeInEnabled: false,
      };
    },
    resolveContextChannel: (voiceSettings: unknown) => {
      const projection = host.projectVoiceSettings({ voice: voiceSettings }, ADAPTER_ID);
      if (!projection?.providerConfig || !runtime!.isStarted()) return null;
      return {
        sendContextualUpdate: (update: string) => { void runtime!.sendContextUpdate(update); },
        sendTextMessage: (text: string) => { void runtime!.sendText(text); },
      };
    },
  });

  return Object.freeze({
    adapter,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await runtime?.stop().catch(() => {});
      unregisterVoice();
      unregisterText();
      handle.dispose();
      unsubscribeMirror();
      liveness.disconnected();
    },
  });
}
