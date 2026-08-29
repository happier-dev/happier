import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BundledRealtimeProviderRuntimeHost,
} from '@/voice/registry/bundledConversationRuntimeContract';
import {
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  PluginProjectionV2Schema,
  SPAWN_SESSION_ERROR_CODES,
} from '@happier-dev/protocol';
import type { BundledVoiceRuntimeContribution } from '@/voice/session/types';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
  installVoiceWebRtcBrowserBoundary,
  createSessionFixture,
} from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';

const rpcBoundary = vi.hoisted(() => ({
  sessionRpc: vi.fn(),
}));
const globalMachineBoundary = vi.hoisted(() => ({
  trustedSpawn: vi.fn(),
  completeCustody: vi.fn(),
  projectionDescribe: vi.fn(),
}));

// Genuine daemon RPC boundary. Internal binding/service/controller logic remains real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
  sessionRpcWithServerScope: rpcBoundary.sessionRpc,
}));

// Machine RPC/projection are genuine boundaries. The production hidden-session
// owner remains real below, including target resolution and finalization.
vi.mock('@/sync/ops/machines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/ops/machines')>();
  return {
    ...actual,
    machineSpawnTrustedHiddenSystemSession: (
      ...args: Parameters<typeof actual.machineSpawnTrustedHiddenSystemSession>
    ) => globalMachineBoundary.trustedSpawn(...args),
    completeMachineSpawnAttemptCustody: (
      ...args: Parameters<typeof actual.completeMachineSpawnAttemptCustody>
    ) => globalMachineBoundary.completeCustody(...args),
  };
});

vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>();
  return {
    ...actual,
    machineContributionRegistryProjectionDescribe: (
      ...args: Parameters<typeof actual.machineContributionRegistryProjectionDescribe>
    ) => globalMachineBoundary.projectionDescribe(...args),
  };
});

import { settingsDefaults } from '@/sync/domains/settings/settings';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { Encryption } from '@/sync/encryption/encryption';
import { sync } from '@/sync/sync';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import {
  readCanonicalVoiceTranscriptSnapshot,
} from '@/voice/transcript/voiceConversationTranscript';
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
import { createExternalVoiceProviderActivationScope } from './externalVoiceProviderActivation.testkit';
import { getExternalVoiceProviderRegistration } from './externalVoiceProviderRegistrations';
import {
  BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES,
} from './generatedBundledVoiceRuntimeEntries';

type CreateAgentSessionRealtimeService = NonNullable<
  BundledRealtimeProviderRuntimeHost['createAgentSessionRealtimeService']
>;

const CODEX_CONNECTED_SERVICE_KEY = buildQualifiedPluginContributionKey(
  createPluginContributionIdentity({
    pluginId: 'happier.agent.codex',
    localId: 'openai-codex',
  }),
);

function readEntryProviderId(entry: Readonly<{
  pluginId: string;
  declaration: Readonly<{ id: string }>;
}>): string {
  return buildQualifiedPluginContributionKey(createPluginContributionIdentity({
    pluginId: entry.pluginId,
    localId: entry.declaration.id,
  }));
}

function buildToken(accountId: string): string {
  const encode = (value: unknown) =>
    encodeBase64(new TextEncoder().encode(JSON.stringify(value)), 'base64url');
  return `${encode({ alg: 'none' })}.${encode({ sub: accountId })}.signature`;
}

function codexEntry() {
  const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES
    .find((candidate) => candidate.declaration.id === 'realtime-codex');
  if (!entry) throw new Error('realtime_codex bundled entry missing');
  return entry;
}

function activateCodexEntry(input: Readonly<{
  host: BundledRealtimeProviderRuntimeHost;
  authorityHost: BundledRealtimeProviderRuntimeHost;
}>): BundledVoiceRuntimeContribution {
  const entry = codexEntry();
  const providerId = readEntryProviderId(entry);
  const scope = createExternalVoiceProviderActivationScope({
    pluginId: entry.pluginId,
    declarations: [entry.declaration],
    hostPlatform: input.host.getPlatform(),
    runtimeHost: input.host,
    isRuntimeHostCurrent: () =>
      getCurrentBundledConversationRuntimeHost() === input.authorityHost,
    hostBindingsByLocalId: Object.freeze({
      [entry.declaration.id]: Object.freeze({
        recipientContract: createBundledVoiceRecipientContract({
          pluginId: entry.pluginId,
          declaration: entry.declaration,
        }),
        descriptor: 'bundled' as const,
      }),
    }),
  });
  entry.activate(scope.api as Parameters<typeof entry.activate>[0]);
  const commit = scope.commit();
  if (commit) {
    void commit.catch(() => undefined);
  }
  const registration = getExternalVoiceProviderRegistration(providerId);
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
    providerId: 'happier.agent.codex/realtime-codex',
    providers: {
      'happier.agent.codex/realtime-codex': {
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
        },
      }),
    },
  }) as never);
}

describe('realtime_codex normal web composed gate', () => {
  const originalSyncEncryption = sync.encryption;
  const originalSyncCredentials = Reflect.get(sync, 'credentials');
  let activeServerId: string;
  let nextTranscriptSeq: number;
  let persistenceCleanup: (() => void) | null;
  let transcriptRequest: ReturnType<typeof vi.fn>;

  const transcriptPostCount = (): number => transcriptRequest.mock.calls.filter(
    ([input]) => String(input).endsWith(
      '/v2/sessions/codex-direct-session/messages',
    ),
  ).length;

  const installTranscriptPersistenceBoundary = async (): Promise<void> => {
    const secretBytes = new Uint8Array(32).fill(10);
    const credentials: AuthCredentials = {
      token: buildToken('codex-composed-account'),
      secret: encodeBase64(secretBytes, 'base64url'),
    };
    Reflect.set(sync, 'credentials', credentials);
    sync.encryption = await Encryption.create(secretBytes);
    const tokenStorageSpy = vi.spyOn(
      TokenStorage,
      'getCredentialsForServerUrl',
    ).mockResolvedValue(credentials);
    const activeRequestSpy = vi.spyOn(apiSocket, 'request').mockRejectedValue(
      new Error('dynamic active request must not own transcript persistence'),
    );
    setRuntimeFetch(transcriptRequest);
    storage.getState().activateProfileScope({
      serverId: activeServerId,
      accountId: 'codex-composed-account',
    });
    persistenceCleanup = () => {
      storage.setState((current) => ({ ...current, profileScope: null }));
      resetRuntimeFetch();
      sync.encryption = originalSyncEncryption;
      Reflect.set(sync, 'credentials', originalSyncCredentials);
      tokenStorageSpy.mockRestore();
      activeRequestSpy.mockRestore();
      persistenceCleanup = null;
    };
  };

  beforeEach(() => {
    const activeServer = getActiveServerSnapshot();
    if (!activeServer.serverId) throw new Error('Codex composed test requires an active server');
    activeServerId = activeServer.serverId;
    storage.setState((current) => ({ ...current, profileScope: null }));
    nextTranscriptSeq = 0;
    persistenceCleanup = null;
    transcriptRequest = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(new URL(url).pathname).toBe(
        '/v2/sessions/codex-direct-session/messages',
      );
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as Readonly<{ localId: string }>;
      nextTranscriptSeq += 1;
      return new Response(JSON.stringify({
        didWrite: true,
        message: {
          id: `codex-direct-message-${nextTranscriptSeq}`,
          seq: nextTranscriptSeq,
          localId: body.localId,
          createdAt: Date.now(),
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    rpcBoundary.sessionRpc.mockReset();
    globalMachineBoundary.trustedSpawn.mockReset();
    globalMachineBoundary.completeCustody.mockReset();
    globalMachineBoundary.projectionDescribe.mockReset();
    globalMachineBoundary.projectionDescribe.mockResolvedValue({
      supported: false,
      reason: 'not-supported',
    });
    clearDaemonMergedProjectionCacheForTests();
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
    persistenceCleanup?.();
    resetRuntimeFetch();
    sync.encryption = originalSyncEncryption;
    Reflect.set(sync, 'credentials', originalSyncCredentials);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearDaemonMergedProjectionCacheForTests();
    resetVoiceAdapterRegistryForTests();
    voiceConversationRuntimeMachine.reset();
  });

  it('composes public activation, exact direct binding, bound V3 authority, host WebRTC, finals, and reverse terminal cleanup', async () => {
    const consoleError = vi.spyOn(console, 'error');
    const watchResolvers: Array<(value: unknown) => void> = [];
    let resolveFirstStop!: (value: unknown) => void;
    let stopCount = 0;
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
        stopCount += 1;
        if (stopCount === 1) {
          return await new Promise((resolve) => {
            resolveFirstStop = resolve;
          });
        }
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
        CreateAgentSessionRealtimeService
      >[0]) {
        expect(sync.patchSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
        expect(voiceSessionBindingStore.getState().getByControlSessionId(
          input.controlSessionId,
        )).toMatchObject({
          conversationSessionId: 'codex-direct-session',
        });
        expect(input.onStarted).toEqual(expect.any(Function));
        const createService = hostLease.host.createAgentSessionRealtimeService;
        return createService ? await createService(input) : null;
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
    await vi.waitFor(() => expect(runtime.adapter.getSnapshot().status).toBe('connecting'));
    await vi.waitFor(() => expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
    browser.peer.channel.open();
    await starting;

    expect(runtime.adapter.getSnapshot()).toMatchObject({
      adapterId: 'happier.agent.codex/realtime-codex',
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
    const watchRpc = rpcBoundary.sessionRpc.mock.calls
      .map(([input]) => input as Readonly<{
        method: string;
        timeoutMs?: number | null;
      }>)
      .find((input) => input.method.endsWith('.watch'));
    expect(watchRpc).toMatchObject({
      timeoutMs: null,
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

    await installTranscriptPersistenceBoundary();
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
    await vi.waitFor(() => expect(
      readStoredSessionMessages(storage.getState(), 'codex-direct-session'),
    ).toEqual([
      expect.objectContaining({
        kind: 'agent-text',
        text: 'Finished once.',
        meta: expect.objectContaining({
          happier: expect.objectContaining({
            conversationTurnOriginV1: {
              v: 1,
              channel: 'realtime_conversation',
              modality: 'voice',
              source: {
                pluginId: 'happier.agent.codex',
                contributionId: 'realtime-codex',
              },
            },
          }),
        }),
      }),
    ]));
    expect(transcriptPostCount()).toBe(1);
    persistenceCleanup?.();
    const secondBrowser = installVoiceWebRtcBrowserBoundary();
    browser.peer.channel.close();
    await vi.waitFor(() => expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.stop'),
    )).toHaveLength(1));
    await vi.waitFor(() => expect(browser.peer.close).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(secondBrowser.peer.createDataChannel).not.toHaveBeenCalled();
    resolveFirstStop({ ok: true, status: 'stopped' });
    await vi.waitFor(() => expect(secondBrowser.peer.createDataChannel).toHaveBeenCalledTimes(1));
    secondBrowser.peer.channel.open();
    await vi.waitFor(() => expect(runtime.adapter.getSnapshot()).toMatchObject({
      status: 'connected',
    }));
    expect(runtime.adapter.getSnapshot()).toMatchObject({
      status: 'connected',
    });
    expect(browser.peer.createDataChannel).toHaveBeenCalledTimes(1);
    expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.start'),
    )).toHaveLength(2);
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

    await installTranscriptPersistenceBoundary();
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
        epoch: 1,
        itemId: 'codex-v3:1:turn-direct-final',
        role: 'assistant',
        text: 'Finished once.',
        revision: 1,
        final: true,
      }),
      expect.objectContaining({
        // A reconnect retains the controller's current logical conversation
        // attempt; it must not create a second persistence epoch.
        epoch: 1,
        itemId: 'codex-v3:1:turn-second-attempt',
        role: 'assistant',
        text: 'Second attempt survives.',
        revision: 1,
        final: true,
      }),
    ]));
    await vi.waitFor(() => expect(
      readStoredSessionMessages(storage.getState(), 'codex-direct-session'),
    ).toEqual([
      expect.objectContaining({
        kind: 'agent-text',
        text: 'Finished once.',
      }),
      expect.objectContaining({
        kind: 'agent-text',
        text: 'Second attempt survives.',
        meta: expect.objectContaining({
          happier: expect.objectContaining({
            conversationTurnOriginV1: {
              v: 1,
              channel: 'realtime_conversation',
              modality: 'voice',
              source: {
                pluginId: 'happier.agent.codex',
                contributionId: 'realtime-codex',
              },
            },
          }),
        }),
      }),
    ]));
    expect(transcriptPostCount()).toBe(2);
    expect(consoleError).not.toHaveBeenCalledWith(
      '[fireAndForget] VoiceTranscriptProjector.persistFinal',
      expect.anything(),
    );
    persistenceCleanup?.();

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
    await vi.waitFor(() => expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.stop'),
    )).toHaveLength(3));

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
      expect(storage.getState().settings.voice.providerId).toBe('happier.agent.codex/realtime-codex');
    } finally {
      await runtime.dispose();
      hostLease.revoke();
      browser.restore();
    }
  });

  it('names an inactive target session as an unavailable session rather than a connection failure', async () => {
    // A resumable-but-inactive target is a real, common, user-reachable Start
    // refusal decided entirely on device. Reported as `voice_connection_failed`
    // it is byte-identical to a transport fault and offers the wrong remedy.
    storage.setState((current) => ({
      ...current,
      sessions: {
        ...current.sessions,
        'codex-direct-session': {
          ...current.sessions['codex-direct-session'],
          active: false,
        },
      },
    }) as never);
    rpcBoundary.sessionRpc.mockImplementation(async () => {
      throw new Error('inspect must not be reached for an inactive target session');
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
      })).rejects.toMatchObject({ code: 'session_unavailable' });

      await expect(runtime.adapter.start({
        sessionId: 'codex-direct-session',
      })).rejects.toMatchObject({ code: 'session_unavailable' });

      expect(runtime.adapter.getSnapshot()).toMatchObject({
        status: 'error',
        errorCode: 'session_unavailable',
        errorPresentation: 'error',
      });
      expect(rpcBoundary.sessionRpc).not.toHaveBeenCalled();
      expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
      expect(browser.peer.createDataChannel).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
      hostLease.revoke();
      browser.restore();
    }
  });

  it('projects a retryable global binding preflight failure before microphone or WebRTC acquisition', async () => {
    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        [CODEX_CONNECTED_SERVICE_KEY]: {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'voice-profile',
        },
      },
    };
    const globalMachine = {
      id: 'machine-global-preflight',
      active: true,
      metadata: {
        homeDir: '/Users/global-preflight',
        happyHomeDir: '/Users/global-preflight/.happier',
      },
    };
    const voice = voiceSettingsParse({
      providerId: 'happier.agent.codex/realtime-codex',
      executionMachine: {
        mode: 'fixed',
        machineId: globalMachine.id,
        autoMachineId: null,
      },
      providers: {
        'happier.agent.codex/realtime-codex': {
          schemaVersion: 2,
          config: { globalConnectedServices: connectedServices },
        },
        local_conversation: {
          schemaVersion: 1,
          config: {
            agent: {
              permissionIntent: 'safe-yolo',
              voiceHomeSubdirName: 'codex-global-preflight',
            },
          },
        },
      },
    });
    storage.setState((current) => ({
      ...current,
      settings: { ...settingsDefaults, voice },
      machines: {
        ...current.machines,
        [globalMachine.id]: globalMachine,
      },
      machineListByServerId: {
        ...current.machineListByServerId,
        [activeServerId]: [globalMachine],
      },
    }) as never);
    globalMachineBoundary.projectionDescribe.mockResolvedValue({
      supported: true,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
          codex: {
            id: 'codex',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            isBuiltIn: true,
            capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true, startupInstructions: { versions: [1] } } },
          },
        },
        backendsById: {
          codex: { id: 'codex', agentId: 'codex' },
        },
        familiesById: {},
      }),
    });
    globalMachineBoundary.trustedSpawn.mockImplementation(async (options, startupInstructions) => {
      expect(options).toMatchObject({
        machineId: globalMachine.id,
        directory: '/Users/global-preflight/.happier/codex-global-preflight',
        backendTarget: { kind: 'backend', backendId: 'codex' },
        connectedServices,
        permissionMode: 'safe-yolo',
        serverId: activeServerId,
      });
      expect(startupInstructions).toMatchObject({ v: 1 });
      return {
        type: 'error' as const,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'connected_service_credential_refresh_unavailable',
        errorDetail: {
          kind: 'connected_service_ux_diagnostic',
          uxDiagnostic: {
            code: 'connected_service_credential_refresh_unavailable',
            failurePhase: 'materialization',
            source: 'spawn_resume',
            serviceId: 'openai-codex',
            agentId: 'codex',
            profileId: 'voice-profile',
            retryable: true,
            suggestedActions: ['retry', 'open_connected_accounts'],
            diagnostics: {
              reason: 'spawn_preflight',
              status: 'refresh_failed',
              category: 'network_error',
            },
          },
        },
      };
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const createAgentSessionRealtimeService = vi.fn();
    const host = Object.freeze({
      ...hostLease.host,
      getPlatform: () => 'web' as const,
      createMicSession: () => browser.micSession,
      createAgentSessionRealtimeService,
    });
    const runtime = activateCodexEntry({ host, authorityHost: hostLease.host });
    registerVoiceAdapters([runtime.adapter]);

    try {
      await expect(runtime.adapter.start({
        sessionId: host.globalVoiceSessionId,
      })).rejects.toMatchObject({
        code: 'service_temporarily_unavailable',
        message: 'service_temporarily_unavailable',
      });
      // A preflight refusal the user must retry is surfaced, not swallowed:
      // projected as a recoverable notice it read as `disconnected`, which the
      // surface renders as plain idle, so Start showed nothing at all.
      expect(runtime.adapter.getSnapshot()).toMatchObject({
        status: 'error',
        errorCode: 'service_temporarily_unavailable',
        errorMessage: 'service_temporarily_unavailable',
        errorRecoveryAction: 'retry',
        errorPresentation: 'error',
      });
      expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
      expect(browser.peer.createDataChannel).not.toHaveBeenCalled();
      expect(globalMachineBoundary.trustedSpawn).toHaveBeenCalledTimes(1);
      expect(globalMachineBoundary.completeCustody).not.toHaveBeenCalled();
      expect(createAgentSessionRealtimeService).not.toHaveBeenCalled();
      expect(rpcBoundary.sessionRpc).not.toHaveBeenCalled();
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

  it.each([
    'codex_realtime_retry_unavailable',
    'codex_realtime_runtime_restart_required',
  ] as const)(
    'keeps the %s start diagnostic as a generic user-retryable provider failure',
    async (diagnosticCode) => {
      rpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{
        method: string;
      }>) => {
        if (input.method.endsWith('.inspect')) {
          return { ok: true, status: 'available', transport: 'webrtc' };
        }
        if (input.method.endsWith('.start')) {
          return {
            ok: false,
            status: 'unavailable',
            code: diagnosticCode,
            message: 'provider text must not become a machine policy',
          };
        }
        throw new Error(`unexpected session RPC: ${input.method}`);
      });
      const browser = installVoiceWebRtcBrowserBoundary();
      const hostLease = createBundledConversationRuntimeHostLease();
      const host = Object.freeze({
        ...hostLease.host,
        getPlatform: () => 'web' as const,
        createMicSession: () => browser.micSession,
        acquireAudioMode: async () => Object.freeze({ release: async () => undefined }),
      });
      const runtime = activateCodexEntry({ host, authorityHost: hostLease.host });
      registerVoiceAdapters([runtime.adapter]);

      try {
        await expect(runtime.adapter.start({
          sessionId: 'codex-direct-session',
        })).rejects.toMatchObject({
          code: diagnosticCode,
          message: diagnosticCode,
        });
        expect(runtime.adapter.getSnapshot()).toMatchObject({
          status: 'disconnected',
          errorCode: 'provider_error',
          errorMessage: diagnosticCode,
          errorRecoveryAction: 'retry',
          errorPresentation: 'notice',
        });
        expect(rpcBoundary.sessionRpc.mock.calls.filter(
          ([input]) => String((input as Readonly<{ method?: unknown }>).method).endsWith('.start'),
        )).toHaveLength(1);
      } finally {
        await runtime.dispose();
        hostLease.revoke();
        browser.restore();
      }
    },
  );

  it.each([
    'codex_realtime_retry_unavailable',
    'codex_realtime_runtime_restart_required',
  ] as const)(
    'matches that generic user-retryable policy when %s arrives after start',
    async (diagnosticCode) => {
      let resolveWatch!: (value: unknown) => void;
      rpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{
        method: string;
      }>) => {
        if (input.method.endsWith('.inspect')) {
          return { ok: true, status: 'available', transport: 'webrtc' };
        }
        if (input.method.endsWith('.start')) {
          return {
            ok: true,
            status: 'started',
            transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=terminal-answer\r\n' },
          };
        }
        if (input.method.endsWith('.watch')) {
          return await new Promise((resolve) => {
            resolveWatch = resolve;
          });
        }
        if (input.method.endsWith('.stop')) return { ok: true, status: 'stopped' };
        throw new Error(`unexpected session RPC: ${input.method}`);
      });
      const browser = installVoiceWebRtcBrowserBoundary();
      const hostLease = createBundledConversationRuntimeHostLease();
      const host = Object.freeze({
        ...hostLease.host,
        getPlatform: () => 'web' as const,
        createMicSession: () => browser.micSession,
        acquireAudioMode: async () => Object.freeze({ release: async () => undefined }),
      });
      const runtime = activateCodexEntry({ host, authorityHost: hostLease.host });
      registerVoiceAdapters([runtime.adapter]);

      try {
        const starting = runtime.adapter.start({ sessionId: 'codex-direct-session' });
        await vi.waitFor(() => expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
        browser.peer.channel.open();
        await starting;

        resolveWatch({
          ok: true,
          status: 'terminal',
          event: {
            kind: 'terminal',
            reason: 'error',
            diagnostic: { code: diagnosticCode, severity: 'error' },
          },
        });
        await vi.waitFor(() => expect(runtime.adapter.getSnapshot()).toMatchObject({
          status: 'disconnected',
          errorCode: 'provider_error',
          errorMessage: diagnosticCode,
          errorRecoveryAction: 'retry',
          errorPresentation: 'notice',
        }));
        expect(rpcBoundary.sessionRpc.mock.calls.filter(
          ([input]) => String((input as Readonly<{ method?: unknown }>).method).endsWith('.start'),
        )).toHaveLength(1);
      } finally {
        await runtime.dispose();
        hostLease.revoke();
        browser.restore();
      }
    },
  );

  it('composes Global through the real hidden-session owner before exact hidden-session inspection', async () => {
    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        [CODEX_CONNECTED_SERVICE_KEY]: {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'codex-global-profile',
        },
      },
    };
    const globalMachine = {
      id: 'machine-global',
      active: true,
      metadata: {
        homeDir: '/Users/global',
        happyHomeDir: '/Users/global/.happier',
      },
    };
    const voice = voiceSettingsParse({
      providerId: 'happier.agent.codex/realtime-codex',
      executionMachine: {
        mode: 'fixed',
        machineId: globalMachine.id,
        autoMachineId: null,
      },
      providers: {
        'happier.agent.codex/realtime-codex': {
          schemaVersion: 2,
          config: { globalConnectedServices: connectedServices },
        },
        local_conversation: {
          schemaVersion: 1,
          config: {
            agent: {
              permissionIntent: 'safe-yolo',
              voiceHomeSubdirName: 'codex-global-voice',
            },
          },
        },
      },
    });
    storage.setState((current) => ({
      ...current,
      settings: {
        ...settingsDefaults,
        voice,
      },
      machines: {
        ...current.machines,
        [globalMachine.id]: globalMachine,
      },
      machineListByServerId: {
        ...current.machineListByServerId,
        [activeServerId]: [globalMachine],
      },
      sessions: {
        ...current.sessions,
        // Production's cold-resume proof is deliberately false. This exact
        // candidate must not be inspected or reused while resolving Global.
        'hidden-never-reused': createSessionFixture({
          id: 'hidden-never-reused',
          active: true,
          encryptionMode: 'plain',
          metadata: {
            machineId: globalMachine.id,
            path: '/Users/global/.happier/codex-global-voice',
            host: 'global.test.local',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            connectedServices,
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
            voiceAgentStartupInstructionsV1: { v: 1, id: 'voice-global', revision: 1 },
          },
          permissionMode: 'safe-yolo',
        }),
      },
    }) as never);

    globalMachineBoundary.projectionDescribe.mockImplementation(async (machineId: string) => {
      expect([globalMachine.id, 'machine-direct']).toContain(machineId);
      return {
        supported: true as const,
        projection: PluginProjectionV2Schema.parse({
          v: 2,
          generation: 1,
          agentsById: {
            codex: {
              id: 'codex',
              identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              isBuiltIn: true,
              capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true, startupInstructions: { versions: [1] } } },
            },
            'acme.codex': {
              id: 'acme.codex',
              identity: { pluginId: 'acme.agent.codex', localId: 'codex' },
              isBuiltIn: false,
            },
          },
          backendsById: {
            codex: { id: 'codex', agentId: 'codex' },
            'acme-codex': { id: 'acme-codex', agentId: 'acme.codex' },
          },
          familiesById: {},
        }),
      };
    });

    const events: string[] = [];
    const spawnedSessionIds = ['hidden-global-failed', 'hidden-global-ready'];
    globalMachineBoundary.trustedSpawn.mockImplementation(async (options, startupInstructions) => {
      const sessionId = spawnedSessionIds[globalMachineBoundary.trustedSpawn.mock.calls.length - 1];
      if (!sessionId) throw new Error('unexpected trusted Global spawn');
      events.push(`spawn:${sessionId}`);
      expect(options).toMatchObject({
        machineId: globalMachine.id,
        directory: '/Users/global/.happier/codex-global-voice',
        backendTarget: { kind: 'backend', backendId: 'codex' },
        connectedServices,
        permissionMode: 'safe-yolo',
        serverId: activeServerId,
      });
      expect(startupInstructions).toMatchObject({ v: 1 });
      storage.setState((current) => ({
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: createSessionFixture({
            id: sessionId,
            active: true,
            encryptionMode: 'plain',
            metadata: {
              machineId: options.machineId,
              path: options.directory,
              host: 'global.test.local',
              backendTarget: options.backendTarget,
              connectedServices: options.connectedServices,
            },
            permissionMode: options.permissionMode,
          }),
        },
      }) as never);
      return {
        type: 'success' as const,
        sessionId,
        spawnAttemptCustody: {
          status: 'completed' as const,
          userAttemptId: options.userAttemptId,
          spawnNonce: options.spawnNonce,
          targetFingerprint: 'global-voice-target',
          machineId: options.machineId,
          scope: { serverId: activeServerId, accountId: 'codex-global-account' },
          createdSessionId: sessionId,
          firstTurnLocalId: 'global-first-turn',
          attachmentMessageLocalId: 'global-attachment',
        },
      };
    });
    globalMachineBoundary.completeCustody.mockImplementation(async (custody) => {
      events.push(`custody:${custody.createdSessionId}`);
      return true;
    });

    let rejectFailedCandidateMetadata = true;
    vi.spyOn(sync, 'refreshSessions').mockResolvedValue(undefined as never);
    vi.spyOn(sync, 'patchSessionMetadataWithRetry').mockImplementation(async (sessionId, patch) => {
      events.push(`metadata:${sessionId}`);
      if (sessionId === 'hidden-global-failed' && rejectFailedCandidateMetadata) {
        rejectFailedCandidateMetadata = false;
        throw new Error('metadata write must retire the candidate');
      }
      const session = storage.getState().sessions[sessionId];
      if (!session?.metadata) throw new Error(`missing test session metadata: ${sessionId}`);
      const metadata = await patch(session.metadata);
      storage.setState((current) => ({
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: { ...session, metadata },
        },
      }) as never);
    });

    let resolveWatch!: (value: unknown) => void;
    const assertFinalizedHiddenSession = (sessionId: string): void => {
      expect(sessionId).toBe('hidden-global-ready');
      expect(storage.getState().sessions[sessionId]).toMatchObject({
        active: true,
        metadata: {
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
          voiceAgentStartupInstructionsV1: expect.objectContaining({ v: 1 }),
        },
      });
      expect(globalMachineBoundary.completeCustody).toHaveBeenCalledTimes(1);
    };
    rpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{
      sessionId: string;
      method: string;
    }>) => {
      if (input.method.endsWith('.inspect')) {
        events.push(`inspect:${input.sessionId}`);
        if (input.sessionId === 'hidden-global-ready') assertFinalizedHiddenSession(input.sessionId);
        return { ok: true, status: 'available', transport: 'webrtc' };
      }
      if (input.method.endsWith('.start')) {
        events.push(`start:${input.sessionId}`);
        assertFinalizedHiddenSession(input.sessionId);
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
      if (input.method.endsWith('.stop')) return { ok: true, status: 'stopped' };
      throw new Error(`unexpected session RPC: ${input.method}`);
    });

    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const host = Object.freeze({
      ...hostLease.host,
      getPlatform: () => 'web' as const,
      createMicSession: () => browser.micSession,
      acquireAudioMode: async () => Object.freeze({ release: async () => undefined }),
      async createAgentSessionRealtimeService(input: Parameters<CreateAgentSessionRealtimeService>[0]) {
        const storedBinding = voiceSessionBindingStore.getState().getByControlSessionId(
          input.controlSessionId,
        );
        events.push(`service:${storedBinding?.conversationSessionId ?? 'none'}`);
        expect(storedBinding).toMatchObject({ conversationSessionId: 'hidden-global-ready' });
        const createService = hostLease.host.createAgentSessionRealtimeService;
        return createService ? await createService(input) : null;
      },
    });
    const runtime = activateCodexEntry({ host, authorityHost: hostLease.host });

    try {
      await expect(runtime.adapter.resolveConversationBinding?.({
        controlSessionId: host.globalVoiceSessionId,
        requestedTargetSessionId: 'visible-global-target',
        settings: storage.getState().settings,
      })).rejects.toMatchObject({ code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED' });
      expect(storage.getState().sessions['hidden-global-failed']).toMatchObject({
        metadata: {
          systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
        },
      });
      expect(globalMachineBoundary.completeCustody).not.toHaveBeenCalled();

      registerVoiceAdapters([runtime.adapter]);
      const starting = runtime.adapter.start({ sessionId: host.globalVoiceSessionId });
      await vi.waitFor(() => {
        expect(events).toContain('service:hidden-global-ready');
        expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      });
      browser.peer.channel.open();
      await starting;
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        host.globalVoiceSessionId,
      )).toMatchObject({
        conversationSessionId: 'hidden-global-ready',
        transcriptMode: 'native_session',
        targetSessionId: null,
      });
      expect(globalMachineBoundary.trustedSpawn).toHaveBeenCalledTimes(2);
      expect(globalMachineBoundary.projectionDescribe).toHaveBeenCalledWith(
        globalMachine.id,
        expect.objectContaining({ serverId: activeServerId }),
      );
      expect(events.indexOf('custody:hidden-global-ready')).toBeLessThan(
        events.indexOf('inspect:hidden-global-ready'),
      );
      expect(events).not.toContain('inspect:hidden-never-reused');
      expect(events.indexOf('custody:hidden-global-ready')).toBeLessThan(
        events.indexOf('start:hidden-global-ready'),
      );

      await runtime.adapter.stop({ sessionId: host.globalVoiceSessionId });
      resolveWatch({
        ok: true,
        status: 'terminal',
        event: { kind: 'terminal', reason: 'stopped' },
      });

      await expect(runtime.adapter.resolveConversationBinding?.({
        controlSessionId: 'codex-direct-session',
        requestedTargetSessionId: 'codex-direct-session',
        settings: storage.getState().settings,
      })).resolves.toEqual({
        conversationSessionId: 'codex-direct-session',
        transcriptMode: 'native_session',
        targetSessionId: 'codex-direct-session',
      });
      expect(globalMachineBoundary.trustedSpawn).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.dispose();
      hostLease.revoke();
      browser.restore();
    }
  });
});
