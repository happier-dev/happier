import { describe, expect, it, vi } from 'vitest';

import { createElevenLabsRuntimeContribution } from './createRuntimeContribution.js';
import type { ElevenLabsRuntimeHost } from './createRuntimeContribution.js';

function createHost() {
  let active: string | null = null;
  const start = vi.fn(async (input: Readonly<{ controlSessionId: string }>) => {
    active = input.controlSessionId;
    return { status: 'connected' };
  });
  const stop = vi.fn(async () => { active = null; });
  const sendClientControl = vi.fn(async () => ({ status: 'sent' as const }));
  const mirrorDispose = vi.fn();
  const hooks = { onStarted: vi.fn(() => 'initial-context'), onStopped: vi.fn() };
  const host: ElevenLabsRuntimeHost = {
    globalVoiceSessionId: '__voice_agent__',
    getSettings: () => ({ voice: { providerId: 'realtime_elevenlabs' } }),
    projectVoiceSettings: (settings) => ({
      providerId: (settings as { voice?: { providerId?: string } })?.voice?.providerId ?? 'realtime_elevenlabs', assistantLanguage: null,
      welcome: { enabled: false, mode: 'immediate' },
      providerConfig: { billingMode: 'byo', byo: { agentId: 'agent' }, tts: {
        voiceId: 'voice', modelId: null, voiceSettings: {
          stability: null, similarityBoost: null, style: null, useSpeakerBoost: null, speed: null,
        },
      } },
    }),
    createProviderClient: () => ({
      credentialStatus: async () => ({ exists: true }),
      mintConversationAuth: async () => ({ kind: 'token', value: 'short-lived' }),
    }),
    getCredentials: async () => null,
    fetchHostedVoiceToken: async () => ({ allowed: false, reason: 'disabled' }),
    completeHostedVoiceSession: async () => undefined,
    presentPaywall: async () => ({ purchased: false }),
    alert: vi.fn(),
    translate: (key) => key,
    createMachineError: (input) => input,
    machine: {
      transitionToAcquiringMic: vi.fn(), transitionToConnecting: vi.fn(),
      transitionToConnected: vi.fn(), transitionToSpeaking: vi.fn(), transitionToEnding: vi.fn(),
      transitionToDisconnected: vi.fn(), setError: vi.fn(), setMuted: vi.fn(),
      getSnapshot: () => ({ adapterId: 'realtime_elevenlabs' }),
      projectSnapshot: () => ({
        adapterId: 'realtime_elevenlabs', sessionId: active, status: active ? 'connected' : 'disconnected',
        mode: 'idle', canStop: active !== null,
      }),
      subscribe: () => () => {},
    },
    createConversationController: () => ({
      start, stop, fail: async () => { active = null; }, sendClientControl,
      getActiveControlSessionId: () => active, getOwnedControlSessionId: () => active,
      requestReconnect: async () => {},
    }),
    createSdkHandleConnection: () => { throw new Error('connection not expected'); },
    createMicSession: () => ({ ensureActive: async () => {}, teardown: async () => {}, setMuted: vi.fn() }),
    ensureBound: async () => undefined,
    resolveConversationSessionId: () => null,
    applyTargetSelection: vi.fn(),
    enableAudioMode: async () => {}, disableAudioMode: async () => {},
    createStorageMirror: () => mirrorDispose,
    projectTranscript: vi.fn(), appendConversationNote: vi.fn(),
    createInboundWatchdog: () => ({
      start: vi.fn(), stop: vi.fn(), noteInboundEvent: vi.fn(),
      markAwaitingResponse: vi.fn(), markTurnActive: vi.fn(),
    }),
    runtimeConfig: {
      handleReadyTimeoutMs: 10, watchdogPollMs: 10, watchdogPlateauMs: 10,
      inboundStallMs: 10, awaitingResponseMs: 10,
    },
    diagnostics: { appendSystem: vi.fn(), appendProviderPayload: vi.fn(), appendError: vi.fn() },
    voiceHooks: hooks,
    realtimeClientTools: {},
    resolveRedactionPrefs: () => ({
      shareFilePaths: false, shareSessionSummary: false, sharePermissionRequests: false,
    }),
    redactToolResultValue: (value) => value,
  };
  return { host, start, stop, sendClientControl, hooks, mirrorDispose };
}

describe('createElevenLabsRuntimeContribution', () => {
  it('owns global surface semantics and fails closed when provider settings are unavailable', async () => {
    const fixture = createHost();
    const runtime = createElevenLabsRuntimeContribution(fixture.host);
    expect(runtime.adapter.resolveSurfaceCapabilities?.({ providerId: 'realtime_elevenlabs' })).toEqual({
      allowsGlobalStart: true,
      controlSessionScope: 'global',
      requiresVoiceAgentFeature: false,
      bargeInEnabled: false,
    });
    await runtime.dispose();

    const unavailable = createElevenLabsRuntimeContribution({
      ...fixture.host,
      projectVoiceSettings: () => null,
    });
    expect(unavailable.adapter.resolveSurfaceCapabilities?.({ providerId: 'realtime_elevenlabs' })).toBeNull();
    await unavailable.dispose();
  });

  it('owns adapter start, context, text-only fallback, mute, and teardown', async () => {
    const fixture = createHost();
    const runtime = createElevenLabsRuntimeContribution(fixture.host);

    await runtime.adapter.toggle({ sessionId: 'session-1' });
    expect(fixture.hooks.onStarted).toHaveBeenCalledWith('session-1');
    expect(fixture.start).toHaveBeenCalledWith(expect.objectContaining({ controlSessionId: 'session-1' }));
    const contextChannel = runtime.adapter.resolveContextChannel?.({ providerId: 'realtime_elevenlabs' });
    expect(contextChannel).not.toBeNull();
    expect(runtime.adapter.resolveContextChannel?.({ providerId: 'another_provider' })).not.toBeNull();
    contextChannel?.sendContextualUpdate('context-via-capability');
    contextChannel?.sendTextMessage('text-via-capability');
    runtime.adapter.sendContextUpdate({ sessionId: 'session-1', update: 'context' });
    runtime.adapter.sendContextText?.({ sessionId: 'session-1', text: 'text' });
    expect(fixture.sendClientControl).toHaveBeenCalledWith({ type: 'voice.context_update', text: 'context' });
    expect(fixture.sendClientControl).toHaveBeenCalledWith({ type: 'voice.user_text', text: 'text' });
    expect(fixture.sendClientControl).toHaveBeenCalledWith({ type: 'voice.context_update', text: 'context-via-capability' });
    expect(fixture.sendClientControl).toHaveBeenCalledWith({ type: 'voice.user_text', text: 'text-via-capability' });

    await runtime.adapter.stop({ sessionId: 'session-1' });
    expect(fixture.hooks.onStopped).toHaveBeenCalledTimes(1);
    await runtime.adapter.sendTextTurn?.({
      controlSessionId: '__voice_agent__', conversationSessionId: 'carrier', text: 'reopen',
    });
    expect(fixture.start).toHaveBeenLastCalledWith(expect.objectContaining({
      controlSessionId: '__voice_agent__', request: expect.objectContaining({ textOnly: true }),
    }));

    await runtime.dispose();
    expect(fixture.mirrorDispose).toHaveBeenCalledTimes(1);
    expect(fixture.stop).toHaveBeenCalled();
  });

  it('creates independent runtime state after disable/re-enable rather than caching an adapter', async () => {
    const first = createElevenLabsRuntimeContribution(createHost().host);
    await first.dispose();
    const second = createElevenLabsRuntimeContribution(createHost().host);
    expect(second).not.toBe(first);
    expect(second.adapter).not.toBe(first.adapter);
    await second.dispose();
  });

  it('disposes an active runtime exactly once and closes it before releasing host subscriptions', async () => {
    const fixture = createHost();
    const events: string[] = [];
    fixture.stop.mockImplementation(async () => { events.push('runtime.stop'); });
    fixture.mirrorDispose.mockImplementation(() => { events.push('mirror.dispose'); });
    const runtime = createElevenLabsRuntimeContribution(fixture.host);
    await runtime.adapter.start({ sessionId: 'session-1' });

    await runtime.dispose();
    await runtime.dispose();

    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect(fixture.mirrorDispose).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['runtime.stop', 'mirror.dispose']);
  });
});
