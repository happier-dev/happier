import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { buildVoiceTranscriptHistorySessionMetadata } from '@/voice/persistence/voiceTranscriptHistorySession';
import { createBuiltinVoiceAdapterAssembly } from '@/voice/adapters/registerBuiltinVoiceAdapters';
import {
  BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES,
} from './generatedBundledVoiceRuntimeEntries';
import { getCurrentBundledConversationRuntimeHost } from './bundledConversationRuntimeHost';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';

installDisconnectedServerSocketBoundary();

const sdk = vi.hoisted(() => ({ startSession: vi.fn(), endSession: vi.fn() }));
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: sdk.startSession } }));
// The native/browser audio-mode adapter is an OS boundary; all host custody stays real.
vi.mock('@/voice/runtime/voiceAudioMode', () => ({
  acquireVoiceBackgroundCallAudioMode: async () => ({ release: async () => undefined }),
}));

await loadSyncSingletonForTests();

const sourceEntry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(
  (entry) => entry.pluginId === 'happier.voice.elevenlabs',
)!;
const entry = sourceEntry;
const initialSettings = storage.getState().settings;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let assembly: ReturnType<typeof createBuiltinVoiceAdapterAssembly>;
let completionFailures = 0;
let releaseFailures = 0;
let settlements = 0;
const requests: Array<{ path: string; body: unknown }> = [];

function adapter() {
  const result = assembly.adapters.find((value) => value.id === entry.providerId);
  if (!result) throw new Error('ElevenLabs adapter was not activated');
  return result;
}

async function start() {
  await adapter().start({
    sessionId: '',
    requestedTargetSessionAddress: null,
    initialContext: '',
  });
}

describe('hosted ElevenLabs settlement through host teardown', () => {
  beforeEach(async () => {
    requests.length = 0;
    completionFailures = 0;
    releaseFailures = 0;
    settlements = 0;
    sdk.endSession.mockReset().mockResolvedValue(undefined);
    sdk.startSession.mockReset().mockResolvedValue({
      endSession: sdk.endSession, setMicMuted() {}, setVolume() {},
      sendUserMessage() {}, sendContextualUpdate() {}, getId: () => 'provider-conversation',
    });
    account = await restoreServerAccountForTest({
      serverUrl: 'https://hosted-settlement.example.test', accountId: 'hosted-account',
      request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health') return new Response('{}');
        if (!path.startsWith('/v1/voice/')) return new Response('{}', { status: 404 });
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${account.credentials.token}`);
        const body: unknown = JSON.parse(String(init?.body));
        requests.push({ path, body });
        if (path === '/v1/voice/token') return Response.json({
          allowed: true, token: 'hosted-token', leaseId: 'hosted-lease',
          bindingNonce: 'hosted-nonce', expiresAtMs: Date.now() + 60_000,
        });
        if (path === '/v1/voice/session/complete') {
          if (completionFailures-- > 0) return Response.json({ ok: false, reason: 'upstream_error' }, { status: 503 });
          settlements += 1;
          return Response.json({ ok: true });
        }
        if (path === '/v1/voice/session/release') {
          if (releaseFailures-- > 0) return Response.json({ ok: false }, { status: 503 });
          return Response.json({ ok: true });
        }
        throw new Error(`Unexpected hosted request: ${path}`);
      },
    });
    vi.spyOn(TokenStorage, 'getCredentials').mockResolvedValue(account.credentials);
    const voice = writeVoiceProviderSettingsConfig(
      initialSettings.voice, entry.providerId, ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
    );
    storage.setState((state) => ({
      ...state, settings: { ...state.settings, voice: { ...voice, providerId: entry.providerId } },
      sessions: { ...state.sessions, 'hosted-session': createSessionFixture({
        id: 'hosted-session', serverId: account.home.id, encryptionMode: 'plain',
        active: false, metadata: { path: '/voice-history', host: 'test', ...buildVoiceTranscriptHistorySessionMetadata() },
      }) },
    }));
    voiceConversationRuntimeMachine.reset();
    assembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] });
    voiceSessionBindingStore.getState().bind({
      adapterId: entry.providerId, controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'hosted-session',
      conversationSessionAddress: { serverId: account.home.id, sessionId: 'hosted-session' },
      targetSessionAddress: null, lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: 1,
    });
  });

  afterEach(async () => {
    completionFailures = 0;
    releaseFailures = 0;
    await assembly?.dispose();
    await account?.dispose();
    storage.setState((state) => ({ ...state, settings: initialSettings }));
    vi.restoreAllMocks();
  });

  it('keeps End retry reachable after two failed completion/release attempts, with media ended once', async () => {
    await start();
    expect(adapter().getSnapshot().status).toBe('connected');
    completionFailures = 2;
    await expect(adapter().stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID })).rejects.toThrow();
    expect(sdk.endSession).toHaveBeenCalledTimes(1);
    expect(settlements).toBe(0);
    // A second End uses the exact retained attempt, rather than a manual public-runtime dispose.
    await adapter().stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    await adapter().stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    expect(settlements).toBe(1);
    expect(requests.filter((request) => request.path.endsWith('/complete'))).toEqual([
      { path: '/v1/voice/session/complete', body: { leaseId: 'hosted-lease', providerConversationId: 'provider-conversation' } },
      { path: '/v1/voice/session/complete', body: { leaseId: 'hosted-lease', providerConversationId: 'provider-conversation' } },
      { path: '/v1/voice/session/complete', body: { leaseId: 'hosted-lease', providerConversationId: 'provider-conversation' } },
    ]);
    expect(sdk.endSession).toHaveBeenCalledTimes(1);
    expect(adapter().getSnapshot().status).toBe('disconnected');
  });

  it('retains a minted pre-identity lease when SDK startup and abort fail', async () => {
    sdk.startSession.mockRejectedValueOnce(new Error('sdk startup failed'));
    releaseFailures = 20;
    await expect(start()).rejects.toThrow();
    const failedReleases = requests.filter((request) => request.path.endsWith('/release'));
    expect(failedReleases.length).toBeGreaterThanOrEqual(2);
    expect(releaseFailures).toBeGreaterThan(0);
    releaseFailures = 0;
    await adapter().stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    const releases = requests.filter((request) => request.path.endsWith('/release'));
    expect(releases).toHaveLength(failedReleases.length + 1);
    expect(releases.every((request) => JSON.stringify(request.body) === JSON.stringify({ leaseId: 'hosted-lease' }))).toBe(true);
    await adapter().stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    expect(requests.filter((request) => request.path.endsWith('/release'))).toHaveLength(releases.length);
    expect(settlements).toBe(0);
  });

  it('refuses another Start while its previous tuple still cannot settle', async () => {
    await start();
    completionFailures = 20;
    await expect(adapter().stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID })).rejects.toThrow();
    await expect(start()).rejects.toThrow();
    expect(sdk.startSession).toHaveBeenCalledTimes(1);
    expect(settlements).toBe(0);
    completionFailures = 0;
    await adapter().stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    expect(settlements).toBe(1);
  });

  it('retries retirement after host revocation without admitting new work or discarding the old tuple', async () => {
    await start();
    const retiring = assembly;
    completionFailures = 4;
    const replacement = createBuiltinVoiceAdapterAssembly({ bundledEntries: [] });
    const replacementHost = getCurrentBundledConversationRuntimeHost();
    await expect(retiring.dispose()).rejects.toThrow();
    expect(sdk.endSession).toHaveBeenCalledTimes(1);
    expect(getCurrentBundledConversationRuntimeHost()).toBe(replacementHost);
    vi.mocked(TokenStorage.getCredentials).mockResolvedValue({ token: 'another-account' });
    completionFailures = 0;
    // No manually retained runtime is the retry owner: the existing generation
    // subscription must keep the failed activation cleanup reachable.
    const retryGeneration = createBuiltinVoiceAdapterAssembly({ bundledEntries: [] });
    const retryHost = getCurrentBundledConversationRuntimeHost();
    try {
      await vi.waitFor(() => expect(settlements).toBe(1));
      await retiring.dispose();
      await retiring.dispose();
      expect(settlements).toBe(1);
      expect(getCurrentBundledConversationRuntimeHost()).toBe(retryHost);
      await expect(adapter().start({ sessionId: '', requestedTargetSessionAddress: null, initialContext: '' })).rejects.toThrow();
    } finally {
      await retryGeneration.dispose();
      await replacement.dispose();
    }
  });
});
