import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BundledRealtimeProviderRuntimeHost,
  BundledVoiceRuntimeContribution,
} from '@happier-dev/bundled-voice-runtime-contract';
import {
  installVoiceWebRtcBrowserBoundary,
  createSessionFixture,
} from '@/dev/testkit';

const rpcBoundary = vi.hoisted(() => ({
  sessionRpc: vi.fn(),
}));

// Genuine daemon RPC boundary. Internal binding/service/controller logic remains real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
  sessionRpcWithServerScope: rpcBoundary.sessionRpc,
}));

import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import {
  readCanonicalVoiceTranscriptSnapshot,
} from '@/voice/transcript/voiceConversationTranscript';
import { voiceOutputStatusStore } from '@/voice/runtime/outputStatus/voiceOutputStatusStore';
import {
  registerVoiceAdapters,
  resetVoiceAdapterRegistryForTests,
} from '@/voice/session/voiceAdapterRegistry';
import { resetVoiceSessionStoreForTests } from '@/voice/session/voiceSessionStore';
import {
  createBundledConversationRuntimeHostLease,
  getCurrentBundledConversationRuntimeHost,
} from './bundledConversationRuntimeHost';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import { resolveAgentRealtimeVoiceConversationBinding } from './resolveAgentRealtimeVoiceConversationBinding';
import {
  createExternalVoiceProviderActivationScope,
} from './externalVoiceProviderActivation';
import { getExternalVoiceProviderRegistration } from './externalVoiceProviderRegistrations';
import {
  BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES,
} from './generatedBundledVoiceRuntimeEntries';

function codexEntry() {
  const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES
    .find((candidate) => candidate.uiEntry.providerId === 'realtime_codex');
  if (!entry) throw new Error('realtime_codex bundled entry missing');
  return entry;
}

function activateCodexEntry(input: Readonly<{
  host: BundledRealtimeProviderRuntimeHost;
  authorityHost: BundledRealtimeProviderRuntimeHost;
}>): BundledVoiceRuntimeContribution {
  const entry = codexEntry();
  const { uiEntry } = entry;
  const scope = createExternalVoiceProviderActivationScope({
    pluginId: uiEntry.pluginId,
    declarations: [uiEntry.declaration],
    hostPlatform: input.host.getPlatform(),
    runtimeHost: input.host,
    isRuntimeHostCurrent: () =>
      getCurrentBundledConversationRuntimeHost() === input.authorityHost,
    hostBindingsByLocalId: Object.freeze({
      [uiEntry.declaration.id]: Object.freeze({
        providerId: uiEntry.providerId,
        recipientContract: createBundledVoiceRecipientContract({
          pluginId: uiEntry.pluginId,
          declaration: uiEntry.declaration,
        }),
        descriptor: 'bundled' as const,
        resolveSurfaceCapabilities: (settings: unknown) => {
          const projection = input.host.projectVoiceSettings(settings, uiEntry.providerId);
          return projection?.providerId === uiEntry.providerId
            ? uiEntry.internal.resolveSurfaceCapabilities?.(projection.providerConfig) ?? null
            : null;
        },
      }),
    }),
  });
  entry.activate(scope.api as Parameters<typeof entry.activate>[0]);
  const commit = scope.commit();
  if (commit) {
    void commit.catch(() => undefined);
  }
  const registration = getExternalVoiceProviderRegistration(uiEntry.providerId);
  if (!registration?.adapter) {
    throw new Error('realtime_codex bundled activation failed');
  }
  return Object.freeze({
    adapter: registration.adapter,
    async dispose() {
      await scope.unwind();
    },
  });
}

function installDirectSessionState(): void {
  const voice = voiceSettingsParse({
    providerId: 'realtime_codex',
    providers: {
      realtime_codex: {
        schemaVersion: 2,
        config: { globalConnectedServices: null },
      },
    },
  });
  storage.setState((current) => ({
    ...current,
    settings: {
      ...settingsDefaults,
      voice,
    },
    sessions: {
      ...current.sessions,
      'codex-direct-session': createSessionFixture({
        id: 'codex-direct-session',
        active: true,
        encryptionMode: 'plain',
        metadata: {
          path: '/workspace/direct',
          host: 'test.local',
          homeDir: '/Users/tester',
          machineId: 'machine-direct',
          flavor: 'codex',
        } as ReturnType<typeof createSessionFixture>['metadata'],
      }),
    },
  }) as never);
}

describe('realtime_codex normal web composed gate', () => {
  beforeEach(() => {
    rpcBoundary.sessionRpc.mockReset();
    vi.spyOn(sync, 'patchSessionMetadataWithRetry').mockResolvedValue(undefined as never);
    resetVoiceAdapterRegistryForTests();
    resetVoiceSessionStoreForTests();
    voiceConversationRuntimeMachine.reset();
    voiceSessionBindingStore.setState({
      ...voiceSessionBindingStore.getInitialState(),
      bind: voiceSessionBindingStore.getState().bind,
      unbind: voiceSessionBindingStore.getState().unbind,
      replacePersistedBindings: voiceSessionBindingStore.getState().replacePersistedBindings,
      getByConversationSessionId: voiceSessionBindingStore.getState().getByConversationSessionId,
      getByControlSessionId: voiceSessionBindingStore.getState().getByControlSessionId,
      list: voiceSessionBindingStore.getState().list,
    }, true);
    installDirectSessionState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetVoiceAdapterRegistryForTests();
    voiceConversationRuntimeMachine.reset();
  });

  it('composes public activation, exact direct binding, bound V3 authority, host WebRTC, finals, and reverse terminal cleanup', async () => {
    const watchResolvers: Array<(value: unknown) => void> = [];
    rpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{
      sessionId: string;
      method: string;
      payload: unknown;
    }>) => {
      if (input.method.endsWith('.inspect')) {
        return { ok: true, status: 'available', transport: 'webrtc' };
      }
      if (input.method.endsWith('.start')) {
        return {
          ok: true,
          status: 'started',
          transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=test-answer\r\n' },
        };
      }
      if (input.method.endsWith('.watch')) {
        return await new Promise((resolve) => {
          watchResolvers.push(resolve);
        });
      }
      if (input.method.endsWith('.stop')) {
        return { ok: true, status: 'stopped' };
      }
      throw new Error(`unexpected session RPC: ${input.method}`);
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const presentAttemptDiagnostic = vi.fn(hostLease.host.presentAttemptDiagnostic);
    const webHost = Object.freeze({
      ...hostLease.host,
      getPlatform: () => 'web' as const,
      createMicSession: () => browser.micSession,
      presentAttemptDiagnostic,
      acquireAudioMode: async () => Object.freeze({
        release: async () => undefined,
      }),
      async createAgentSessionRealtimeService(input: Parameters<
        NonNullable<typeof hostLease.host.createAgentSessionRealtimeService>
      >[0]) {
        expect(sync.patchSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
        expect(voiceSessionBindingStore.getState().getByControlSessionId(
          input.controlSessionId,
        )).toMatchObject({
          conversationSessionId: 'codex-direct-session',
        });
        return await hostLease.host.createAgentSessionRealtimeService?.(input) ?? null;
      },
    });
    const runtime = activateCodexEntry({
      host: webHost,
      authorityHost: hostLease.host,
    });
    registerVoiceAdapters([runtime.adapter]);

    const binding = await runtime.adapter.resolveConversationBinding?.({
      controlSessionId: 'codex-direct-session',
      requestedTargetSessionId: 'codex-direct-session',
      settings: storage.getState().settings,
    });
    expect(binding).toEqual({
      conversationSessionId: 'codex-direct-session',
      transcriptMode: 'native_session',
      targetSessionId: 'codex-direct-session',
    });

    const starting = runtime.adapter.start({ sessionId: 'codex-direct-session' });
    await vi.waitFor(() => expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
    expect(runtime.adapter.getSnapshot().status).toBe('connecting');
    browser.peer.channel.open();
    await starting;

    expect(runtime.adapter.getSnapshot()).toMatchObject({
      adapterId: 'realtime_codex',
      sessionId: 'codex-direct-session',
      status: 'connected',
    });
    expect(browser.peer.setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: 'v=0\r\na=test-answer\r\n',
    });
    expect(browser.peer.addTrack).toHaveBeenCalledWith(
      browser.micTrack,
      browser.micStream,
    );
    const startRpc = rpcBoundary.sessionRpc.mock.calls
      .map(([input]) => input as Readonly<{ sessionId: string; method: string; payload: unknown }>)
      .find((input) => input.method.endsWith('.start'));
    const applicationAttemptId = (
      startRpc?.payload as Readonly<{ applicationAttemptId?: unknown }> | undefined
    )?.applicationAttemptId;
    expect(applicationAttemptId).toMatch(
      /^voice:1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(startRpc).toMatchObject({
      sessionId: 'codex-direct-session',
      payload: {
        v: 1,
        provider: {
          pluginId: 'happier.agent.codex',
          localId: 'realtime-codex',
        },
        applicationAttemptId,
        transport: {
          kind: 'webrtc',
          offerSdp: 'v=0\r\na=test-offer\r\n',
        },
      },
    });

    const final = {
      type: 'turn.done',
      turn: {
        id: 'turn-direct-final',
        role: 'assistant',
        transcript: 'Finished once.',
      },
    };
    browser.peer.channel.message(JSON.stringify({
      type: 'turn.done',
      turn: {
        id: 'turn-\uD800',
        role: 'assistant',
        transcript: 'must remain inert',
      },
    }));
    await vi.waitFor(() => expect(presentAttemptDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnostic: expect.objectContaining({
          code: 'codex_v3_malformed_turn_done',
        }),
      }),
    ));
    expect(runtime.adapter.getSnapshot().status).toBe('connected');
    expect(readCanonicalVoiceTranscriptSnapshot('codex-direct-session')).toEqual([]);

    browser.peer.channel.message(JSON.stringify(final));
    browser.peer.channel.message(JSON.stringify(final));
    await vi.waitFor(() => expect(
      readCanonicalVoiceTranscriptSnapshot('codex-direct-session'),
    ).toEqual([
      expect.objectContaining({
        itemId: 'codex-v3:1:turn-direct-final',
        role: 'assistant',
        text: 'Finished once.',
        revision: 1,
        final: true,
      }),
    ]));
    browser.peer.channel.close();
    await vi.waitFor(() => expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.stop'),
    )).toHaveLength(1));
    await vi.waitFor(() => expect(browser.peer.close).toHaveBeenCalledTimes(1));
    expect(runtime.adapter.getSnapshot()).toMatchObject({
      status: 'error',
      errorCode: 'voice_webrtc_data_channel_closed',
      errorMessage: 'voice_webrtc_data_channel_closed',
    });
    expect(browser.peer.createDataChannel).toHaveBeenCalledTimes(1);
    expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.start'),
    )).toHaveLength(1);
    expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.stop'),
    )).toHaveLength(1);
    const firstStopRpc = rpcBoundary.sessionRpc.mock.calls
      .map(([input]) => input as Readonly<{ sessionId: string; method: string; payload: unknown }>)
      .find((input) => input.method.endsWith('.stop'));
    expect(firstStopRpc).toMatchObject({
      sessionId: 'codex-direct-session',
      payload: { applicationAttemptId },
    });

    await runtime.adapter.stop({ sessionId: 'codex-direct-session' });
    expect(storage.getState().sessions['codex-direct-session']).toBeDefined();
    expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.stop'),
    )).toHaveLength(1);

    const secondBrowser = installVoiceWebRtcBrowserBoundary();
    const secondStarting = runtime.adapter.start({ sessionId: 'codex-direct-session' });
    await vi.waitFor(() => expect(secondBrowser.peer.createDataChannel).toHaveBeenCalledTimes(1));
    secondBrowser.peer.channel.open();
    await secondStarting;

    secondBrowser.peer.channel.message(JSON.stringify({
      type: 'turn.done',
      turn: {
        id: 'turn-second-attempt',
        role: 'assistant',
        transcript: 'Second attempt survives.',
      },
    }));
    await vi.waitFor(() => expect(
      readCanonicalVoiceTranscriptSnapshot('codex-direct-session'),
    ).toEqual([
      expect.objectContaining({
        epoch: 2,
        itemId: 'codex-v3:2:turn-second-attempt',
        role: 'assistant',
        text: 'Second attempt survives.',
        revision: 1,
        final: true,
      }),
    ]));

    expect(watchResolvers).toHaveLength(2);
    watchResolvers[1]!({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'upstream_closed' },
    });
    await vi.waitFor(() => expect(secondBrowser.peer.close).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.stop'),
    )).toHaveLength(2));
    expect(runtime.adapter.getSnapshot().status).not.toBe('connected');

    const thirdBrowser = installVoiceWebRtcBrowserBoundary();
    const remoteAudio = {
      autoplay: false,
      srcObject: null as MediaStream | null,
      volume: 1,
      play: vi.fn(async () => {
        throw new DOMException(
          'browser autoplay policy detail must not escape',
          'NotAllowedError',
        );
      }),
      pause: vi.fn<() => void>(),
      remove: vi.fn<() => void>(),
    };
    vi.stubGlobal('document', {
      createElement: vi.fn((tagName: string) => {
        if (tagName !== 'audio') throw new Error(`unexpected element: ${tagName}`);
        return remoteAudio;
      }),
    });
    const thirdStarting = runtime.adapter.start({ sessionId: 'codex-direct-session' });
    const thirdRejected = expect(thirdStarting).rejects.toMatchObject({
      code: 'voice_webrtc_remote_audio_playback_failed',
      message: 'voice_webrtc_remote_audio_playback_failed',
    });
    await vi.waitFor(() => expect(thirdBrowser.peer.setRemoteDescription).toHaveBeenCalledTimes(1));
    const remoteTrackEvent = new Event('track');
    Object.defineProperties(remoteTrackEvent, {
      track: { value: { id: 'remote-playback-failure' } as MediaStreamTrack },
      streams: { value: [{ id: 'remote-playback-stream' } as MediaStream] },
    });
    thirdBrowser.peer.dispatchEvent(remoteTrackEvent);
    await vi.waitFor(() => expect(remoteAudio.play).toHaveBeenCalledTimes(1));
    thirdBrowser.peer.channel.open();

    await thirdRejected;
    expect(runtime.adapter.getSnapshot()).toMatchObject({
      status: 'error',
      errorCode: 'voice_webrtc_remote_audio_playback_failed',
      errorMessage: 'voice_webrtc_remote_audio_playback_failed',
    });

    await runtime.dispose();
    hostLease.revoke();
    thirdBrowser.restore();
    secondBrowser.restore();
    browser.restore();
  });

  it('fails closed against an old daemon with no Agent-realtime method and opens no media or fallback', async () => {
    rpcBoundary.sessionRpc.mockRejectedValue(
      Object.assign(new Error('RPC method not available'), {
        errorCode: 'RPC_METHOD_NOT_AVAILABLE',
      }),
    );
    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const webHost = Object.freeze({
      ...hostLease.host,
      getPlatform: () => 'web' as const,
      createMicSession: () => browser.micSession,
    });
    const runtime = activateCodexEntry({
      host: webHost,
      authorityHost: hostLease.host,
    });

    try {
      await expect(runtime.adapter.resolveConversationBinding?.({
        controlSessionId: 'codex-direct-session',
        requestedTargetSessionId: 'codex-direct-session',
        settings: storage.getState().settings,
      })).resolves.toBeNull();

      const methods = rpcBoundary.sessionRpc.mock.calls.map(
        ([input]) => String((input as Readonly<{ method?: unknown }>).method),
      );
      expect(methods).toEqual(['session.agentRealtime.inspect']);
      expect(methods).not.toContain('session.agentRealtime.start');
      expect(methods.some((method) => method.includes('voice_media'))).toBe(false);
      expect(browser.peer.createDataChannel).not.toHaveBeenCalled();
      expect(storage.getState().settings.voice.providerId).toBe('realtime_codex');
    } finally {
      await runtime.dispose();
      hostLease.revoke();
      browser.restore();
    }
  });

  it('preserves a safe start diagnostic through the canonical machine and excludes raw provider text', async () => {
    const rawProviderText = 'upstream rejected /Users/private/repository token=secret';
    rpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{
      method: string;
    }>) => {
      if (input.method.endsWith('.inspect')) {
        return { ok: true, status: 'available', transport: 'webrtc' };
      }
      if (input.method.endsWith('.start')) {
        return {
          ok: false,
          status: 'failed',
          code: 'update_required',
          message: rawProviderText,
        };
      }
      throw new Error(`unexpected session RPC: ${input.method}`);
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const webHost = Object.freeze({
      ...hostLease.host,
      getPlatform: () => 'web' as const,
      createMicSession: () => browser.micSession,
      acquireAudioMode: async () => Object.freeze({
        release: async () => undefined,
      }),
    });
    const runtime = activateCodexEntry({
      host: webHost,
      authorityHost: hostLease.host,
    });
    registerVoiceAdapters([runtime.adapter]);

    try {
      await expect(runtime.adapter.resolveConversationBinding?.({
        controlSessionId: 'codex-direct-session',
        requestedTargetSessionId: 'codex-direct-session',
        settings: storage.getState().settings,
      })).resolves.toMatchObject({
        conversationSessionId: 'codex-direct-session',
      });

      await expect(runtime.adapter.start({
        sessionId: 'codex-direct-session',
      })).rejects.toMatchObject({
        code: 'update_required',
        message: 'update_required',
      });

      const snapshot = runtime.adapter.getSnapshot();
      expect(snapshot).toMatchObject({
        status: 'error',
        errorCode: 'update_required',
        errorMessage: 'update_required',
        errorRecoveryAction: 'update_agent_runtime',
      });
      expect(JSON.stringify(snapshot)).not.toContain(rawProviderText);
    } finally {
      await runtime.dispose();
      hostLease.revoke();
      browser.restore();
    }
  });

  it('composes global exact account/startup-compatible selection and projects zero-final transcript unavailability once', async () => {
    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'codex-work-profile',
        },
      },
    };
    const settings = {
      voice: voiceSettingsParse({
        providerId: 'realtime_codex',
        providers: {
          realtime_codex: {
            schemaVersion: 2,
            config: { globalConnectedServices: connectedServices },
          },
        },
      }),
    };
    storage.setState((current) => ({
      ...current,
      settings: {
        ...settingsDefaults,
        ...settings,
      },
      sessions: {
        ...current.sessions,
        'hidden-startup-compatible': createSessionFixture({
          id: 'hidden-startup-compatible',
          active: true,
          encryptionMode: 'plain',
          metadata: {
            path: '/workspace/global',
            host: 'test.local',
            homeDir: '/Users/tester',
            machineId: 'machine-global',
            backendTarget: { kind: 'backend', backendId: 'codex' },
          } as ReturnType<typeof createSessionFixture>['metadata'],
        }),
      },
    }) as never);
    let resolveWatch!: (value: unknown) => void;
    rpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{
      sessionId: string;
      method: string;
    }>) => {
      if (input.method.endsWith('.inspect')) {
        return { ok: true, status: 'available', transport: 'webrtc' };
      }
      if (input.method.endsWith('.start')) {
        return {
          ok: true,
          status: 'started',
          transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=global-answer\r\n' },
        };
      }
      if (input.method.endsWith('.watch')) {
        return await new Promise((resolve) => {
          resolveWatch = resolve;
        });
      }
      if (input.method.endsWith('.stop')) {
        return { ok: true, status: 'stopped' };
      }
      throw new Error(`unexpected session RPC: ${input.method}`);
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const releasePrepared = vi.fn();
    const presentAttemptDiagnosticCalls = vi.fn();
    const presentAttemptDiagnostic = (
      input: Parameters<typeof hostLease.host.presentAttemptDiagnostic>[0],
    ): void => {
      presentAttemptDiagnosticCalls(input);
      hostLease.host.presentAttemptDiagnostic(input);
    };
    const inspect = vi.fn(async ({ sessionId }: Readonly<{ sessionId: string }>) =>
      sessionId === 'hidden-startup-compatible');
    const ensureGlobalConversation = vi.fn(async (input: Readonly<{
      agent: Readonly<{ pluginId: string; localId: string }>;
      isReusableSession(input: Readonly<{ sessionId: string }>): Promise<boolean>;
    }>) => {
      expect(input.agent).toEqual({
        pluginId: 'happier.agent.codex',
        localId: 'codex',
      });
      await expect(input.isReusableSession({
        sessionId: 'hidden-stale-startup-revision',
      })).resolves.toBe(false);
      await expect(input.isReusableSession({
        sessionId: 'hidden-startup-compatible',
      })).resolves.toBe(true);
      return 'hidden-startup-compatible';
    });
    const host = Object.freeze({
      ...hostLease.host,
      getPlatform: () => 'web' as const,
      createMicSession: () => browser.micSession,
      acquireAudioMode: async () => Object.freeze({
        release: async () => undefined,
      }),
      presentAttemptDiagnostic,
      createConversationController(input: Parameters<
        typeof hostLease.host.createConversationController
      >[0]) {
        const release = input.adapter.releasePrepared;
        return hostLease.host.createConversationController({
          ...input,
          adapter: Object.freeze({
            ...input.adapter,
            async releasePrepared(releaseInput) {
              releasePrepared(releaseInput);
              await release?.(releaseInput);
            },
          }),
        });
      },
      async resolveAgentRealtimeVoiceConversationBinding(input: Parameters<
        typeof hostLease.host.resolveAgentRealtimeVoiceConversationBinding
      >[0]) {
        expect(input.connectedServices).toEqual(connectedServices);
        return await resolveAgentRealtimeVoiceConversationBinding({
          provider: input.provider,
          agent: input.agent,
          controlSessionId: input.controlSessionId,
          globalSessionId: hostLease.host.globalVoiceSessionId,
          requestedTargetSessionId: input.requestedTargetSessionId,
          inspect,
          ensureGlobalConversation,
        });
      },
      async createAgentSessionRealtimeService(input: Parameters<
        NonNullable<typeof hostLease.host.createAgentSessionRealtimeService>
      >[0]) {
        expect(sync.patchSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
        expect(voiceSessionBindingStore.getState().getByControlSessionId(
          input.controlSessionId,
        )).toMatchObject({
          conversationSessionId: 'hidden-startup-compatible',
        });
        return await hostLease.host.createAgentSessionRealtimeService?.(input) ?? null;
      },
    });

    const runtime = activateCodexEntry({
      host,
      authorityHost: hostLease.host,
    });
    const binding = await runtime.adapter.resolveConversationBinding?.({
      controlSessionId: host.globalVoiceSessionId,
      requestedTargetSessionId: 'visible-session',
      settings,
    });

    expect(binding).toEqual({
      conversationSessionId: 'hidden-startup-compatible',
      transcriptMode: 'native_session',
      targetSessionId: 'visible-session',
    });
    expect(ensureGlobalConversation).toHaveBeenCalledTimes(1);
    rpcBoundary.sessionRpc.mockClear();

    registerVoiceAdapters([runtime.adapter]);
    expect(runtime.adapter.conversationTargeting).toBe('bound_conversation');
    const starting = runtime.adapter.start({
      sessionId: host.globalVoiceSessionId,
    });
    await vi.waitFor(() => expect(browser.peer.createDataChannel).toHaveBeenCalledTimes(1));
    browser.peer.channel.open();
    await starting;

    const startCalls = rpcBoundary.sessionRpc.mock.calls
      .map(([input]) => input as Readonly<{ sessionId: string; method: string }>)
      .filter((input) => input.method.endsWith('.start'));
    expect(startCalls).toEqual([
      expect.objectContaining({ sessionId: 'hidden-startup-compatible' }),
    ]);
    expect(browser.peer.createDataChannel).toHaveBeenCalledTimes(1);

    const globalEnsureCountBeforeOpen = ensureGlobalConversation.mock.calls.length;
    const inspectCountBeforeOpen = inspect.mock.calls.length;
    await expect(voiceSessionBindingManager.ensureBoundForOpenConversation({
      openConversationSessionId: 'hidden-startup-compatible',
      fallbackControlSessionId: host.globalVoiceSessionId,
      activeAdapterId: 'realtime_codex',
      providerId: 'realtime_codex',
      requestedTargetSessionId: 'unrelated-visible-session',
    })).resolves.toEqual({
      conversationSessionId: 'hidden-startup-compatible',
    });
    expect(ensureGlobalConversation).toHaveBeenCalledTimes(globalEnsureCountBeforeOpen);
    expect(inspect).toHaveBeenCalledTimes(inspectCountBeforeOpen);

    await runtime.adapter.stop({ sessionId: host.globalVoiceSessionId });
    expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.stop'),
    )).toHaveLength(1);
    await expect(voiceSessionBindingManager.ensureBoundForOpenConversation({
      openConversationSessionId: 'hidden-startup-compatible',
      fallbackControlSessionId: host.globalVoiceSessionId,
      activeAdapterId: null,
      providerId: 'realtime_codex',
      requestedTargetSessionId: 'unrelated-visible-session',
    })).resolves.toEqual({
      conversationSessionId: 'hidden-startup-compatible',
    });
    expect(ensureGlobalConversation).toHaveBeenCalledTimes(globalEnsureCountBeforeOpen);
    expect(inspect).toHaveBeenCalledTimes(inspectCountBeforeOpen);
    expect(storage.getState().sessions['hidden-startup-compatible']).toBeDefined();
    expect(releasePrepared).toHaveBeenCalledTimes(1);
    expect(presentAttemptDiagnosticCalls).toHaveBeenCalledTimes(1);
    expect(presentAttemptDiagnosticCalls).toHaveBeenCalledWith(expect.objectContaining({
      controlSessionId: host.globalVoiceSessionId,
      diagnostic: expect.objectContaining({
        code: 'codex_v3_conversational_transcript_unavailable',
      }),
    }));
    expect(voiceOutputStatusStore.readForSession(host.globalVoiceSessionId)).toMatchObject({
      statusId: 'codex_v3_conversational_transcript_unavailable',
    });
    expect(readCanonicalVoiceTranscriptSnapshot('hidden-startup-compatible')).toEqual([]);

    resolveWatch({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'stopped' },
    });
    await runtime.dispose();
    hostLease.revoke();
    browser.restore();
  });
});
