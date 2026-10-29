import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { setVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import { registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import { resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import type { VoiceMachineRecoveryAction } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import { createBuiltinVoiceAdapterAssembly } from '@/voice/adapters/registerBuiltinVoiceAdapters';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { storage } from '@/sync/domains/state/storage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { createSessionFixture, waitForTestEvent } from '@/dev/testkit';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';

import type { VoiceConnectRecoveryTarget } from '@/components/voice/surface/resolveVoiceConnectRecoveryTarget';
import { resolveVoiceSurfaceRecovery, type VoiceSurfaceRecovery } from '@/components/voice/surface/resolveVoiceSurfaceRecovery';

const state = vi.hoisted(() => ({
  openSettings: vi.fn(async () => undefined),
  platform: 'web' as 'web' | 'ios',
  startSession: vi.fn(),
  endSession: vi.fn(async () => undefined),
}));

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: state.startSession } }));
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: state.startSession } }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
  Linking: { openSettings: state.openSettings },
  Platform: { get OS() { return state.platform; } },
}));
vi.mock('expo-audio', () => ({ AudioModule: { setAudioModeAsync: vi.fn(async () => undefined) } }));

await loadSyncSingletonForTests();

let lifecycle: ReturnType<typeof createVoiceSessionLifecycleController>;
let assembly: ReturnType<typeof createBuiltinVoiceAdapterAssembly>;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
const initialStorage = storage.getState();
const initialBindings = voiceSessionBindingStore.getState();
const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find((candidate) => candidate.pluginId === 'happier.voice.elevenlabs');
if (!entry) throw new Error('recovery_elevenlabs_entry_unavailable');

async function admitFailedConversation(sessionId: string): Promise<void> {
  state.startSession.mockRejectedValueOnce(new Error('SDK connection failed'));
  await lifecycle.toggle({ serverId: account.home.id, sessionId }).catch(() => undefined);
  expect(state.startSession, `Voice Start failure code: ${lifecycle.getSnapshot().errorCode ?? 'none'}`).toHaveBeenCalledOnce();
  expect(lifecycle.getSnapshot().status).toBe('error');
}

const RUNTIME_TARGET = {
  agentId: 'codex',
  pluginId: 'acme.installed-agent',
  machineId: 'm2',
  serverIdentityId: 'server-identity-1',
} as const;

function context(overrides: Partial<{
  connectRecoveryTarget: VoiceConnectRecoveryTarget;
  runtimeRecoveryTarget: typeof RUNTIME_TARGET | null;
  attemptSessionId: string | null;
  startSessionId: string | null;
  globalStartAuthorized: boolean;
}> = {}) {
  return {
    connectRecoveryTarget: { kind: 'default' as const },
    runtimeRecoveryTarget: RUNTIME_TARGET,
    attemptSessionId: 's1',
    startSessionId: 's1',
    globalStartAuthorized: false,
    ...overrides,
  };
}

async function dispatch(
  recoveryAction: VoiceMachineRecoveryAction | null,
  navigate: (href: unknown) => void = vi.fn(),
  overrides: Parameters<typeof context>[0] = {},
  setupIncomplete = false,
) {
  const { createVoiceAttemptRecoveryDispatch } = await import('./voiceAttemptRecovery');
  return createVoiceAttemptRecoveryDispatch({
    recoveryAction,
    setupIncomplete,
    context: context(overrides),
    navigate,
  });
}

describe('the one Voice recovery dispatch every placement fires', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetVoiceSessionStoreForTests();
    state.platform = 'web';
    state.startSession.mockReset().mockResolvedValue({
        endSession: state.endSession, setMicMuted() {}, setVolume() {},
        sendUserMessage() {}, sendContextualUpdate() {}, getId: () => 'recovery-provider-conversation',
    });
    const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    account = await restoreServerAccountForTest({
      serverUrl: 'https://voice-recovery.example.test', accountId: 'recovery-account', credentialScope: 'restored-home',
      request: createSessionReadBatchFetchBoundary(async (url, init) => {
        const path = new URL(String(url)).pathname;
        const preparation = answerVoiceRealtimePreparationHttpRequest(url, storage.getState().settings);
        if (preparation) return preparation;
        if (path === '/health') return Response.json({});
        if (path === '/v1/voice/token') return Response.json({ allowed: true, token: 'recovery-hosted-token', leaseId: 'recovery-hosted-lease', bindingNonce: 'recovery-hosted-nonce', expiresAtMs: Date.now() + 60_000 });
        if (path === '/v1/voice/session/complete' || path === '/v1/voice/session/release') return Response.json({ ok: true });
        const response = sessionHttp.handle(url, init);
        if (response) return response;
        return null;
      }),
    });
    expect(await TokenStorage.getCredentials()).toEqual(account.credentials);
    const voice = writeVoiceProviderSettingsConfig(initialStorage.settings.voice, entry.providerId, ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS);
    storage.setState((current) => ({ ...current,
      settings: { ...current.settings, voice: { ...voice, providerId: entry.providerId } },
      sessions: Object.fromEntries(['s1', 'named-session'].map((id) => [id, createSessionFixture({ id, serverId: account.home.id, encryptionMode: 'plain' })])),
    }));
    voiceConversationRuntimeMachine.reset();
    assembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] });
    registerVoiceAdapters(assembly.adapters);
    lifecycle = createVoiceSessionLifecycleController({ captureAdmission: createVoiceCaptureAdmissionController() });
    setVoiceSessionLifecycleController(lifecycle);
    lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
    lifecycle.setConfiguredProviderId(entry.providerId);
  });
  afterEach(async () => {
    await lifecycle.dispose();
    await assembly.dispose();
    await account.dispose();
    setVoiceSessionLifecycleController(null);
    registerVoiceAdapters([]);
    voiceSessionBindingStore.setState(initialBindings, true);
    storage.setState(initialStorage, true);
    vi.restoreAllMocks();
    resetVoiceSessionStoreForTests();
  });

  it('opens app voice settings for credential review', async () => {
    const navigate = vi.fn();
    (await dispatch('review_credentials', navigate))();
    expect(navigate).toHaveBeenCalledWith({
      pathname: '/settings/voice/conversations',
      params: { focus: 'provider' },
    });
  });

  it('opens the canonical execution-machine settings section for an unavailable machine', async () => {
    const navigate = vi.fn();
    (await dispatch('select_execution_machine', navigate))();
    expect(navigate).toHaveBeenCalledWith({
      pathname: '/settings/voice/conversations',
      params: { focus: 'execution_machine' },
    });
  });

  it('reveals the Conversations speech engine without opening system microphone settings or retrying', async () => {
    const navigate = vi.fn();
    const { executeVoiceAttemptRecovery } = await import('./voiceAttemptRecovery');
    expect(await executeVoiceAttemptRecovery({
      recoveryAction: 'select_speech_engine', setupIncomplete: false, context: context(), navigate,
    })).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/settings/voice/conversations?setting=voiceConversations.sttProvider');
    expect(state.openSettings).not.toHaveBeenCalled();
    expect(lifecycle.getSnapshot().status).toBe('disconnected');
  });

  it('forwards the canonical selected service and account route for Connect recovery', async () => {
    const navigate = vi.fn();
    const route = {
      pathname: '/(app)/settings/connected-services/account',
      params: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
        accountId: 'account-work',
      },
    } as const;
    (await dispatch('connect_agent', navigate, {
      connectRecoveryTarget: { kind: 'exact', route } satisfies VoiceConnectRecoveryTarget,
    }))();
    expect(navigate).toHaveBeenCalledWith(route);
  });

  it('opens the selected Agent settings for inherited authentication so the user can sign in or choose its default account', async () => {
    const navigate = vi.fn();
    (await dispatch('connect_agent', navigate))();
    expect(navigate).toHaveBeenCalledWith({
      pathname: '/(app)/settings/agents/[agentId]',
      params: {
        agentId: 'codex', pluginId: 'acme.installed-agent', machineId: 'm2',
        serverIdentityId: 'server-identity-1',
      },
    });
  });

  it('opens Agent settings for Connect recovery without an exact runtime target', async () => {
    const navigate = vi.fn();
    (await dispatch('connect_agent', navigate, { runtimeRecoveryTarget: null }))();
    expect(navigate).toHaveBeenCalledWith('/settings/agents');
  });

  it('opens the canonical Voice binding setup when provider settings must be repaired', async () => {
    const navigate = vi.fn();
    (await dispatch('connect_agent', navigate, {
      connectRecoveryTarget: { kind: 'provider_settings' },
    }))();
    expect(navigate).toHaveBeenCalledWith({
      pathname: '/settings/voice/conversations',
      params: { focus: 'provider' },
    });
  });

  it('fails Connect recovery closed when selected context is stale or unavailable', async () => {
    const navigate = vi.fn();
    (await dispatch('connect_agent', navigate, {
      connectRecoveryTarget: { kind: 'unavailable' },
    }))();
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['install_agent_runtime', 'install'],
    ['update_agent_runtime', 'update'],
  ] as const)('routes %s to the exact portable Agent runtime target', async (action, installIntent) => {
    const navigate = vi.fn();
    (await dispatch(action, navigate))();
    expect(navigate).toHaveBeenCalledWith({
      pathname: '/(app)/settings/agents/[agentId]',
      params: {
        agentId: 'codex',
        pluginId: 'acme.installed-agent',
        machineId: 'm2',
        serverIdentityId: 'server-identity-1',
        installIntent,
      },
    });
  });

  it('fails Agent runtime recovery closed when exact target identity is unavailable', async () => {
    const navigate = vi.fn();
    (await dispatch('update_agent_runtime', navigate, { runtimeRecoveryTarget: null }))();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens platform settings for microphone permission recovery', async () => {
    state.platform = 'ios';
    (await dispatch('open_settings'))();
    expect(state.openSettings).toHaveBeenCalledTimes(1);
  });

  it('retries through the canonical voice session manager', async () => {
    await admitFailedConversation('s1');
    await (await dispatch('retry'))();
    await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.status === 'connected');
    expect(lifecycle.getSnapshot()).toMatchObject({ sessionId: 's1', status: 'connected', mode: 'idle', canStop: true });
    expect(lifecycle.getAttemptTargetSessionAddress()).toEqual({ serverId: account.home.id, sessionId: 's1' });
  });

  it('retries the conversation the surface named rather than falling back to a global start', async () => {
    await admitFailedConversation('named-session');
    await (await dispatch('retry', vi.fn(), {
      attemptSessionId: null,
      startSessionId: 'named-session',
      globalStartAuthorized: false,
    }))();
    await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.status === 'connected');
    expect(lifecycle.getSnapshot()).toMatchObject({ sessionId: 'named-session', status: 'connected' });
    expect(lifecycle.getAttemptTargetSessionAddress()).toEqual({ serverId: account.home.id, sessionId: 'named-session' });
  });

  it('refuses a retry that has no conversation to retry', async () => {
    (await dispatch('reconnect', vi.fn(), {
      attemptSessionId: null,
      startSessionId: null,
      globalStartAuthorized: false,
    }))();
    expect(lifecycle.getSnapshot().status).toBe('disconnected');
  });

  it('finishes an unfinished provider setup in Voice settings when nothing has failed yet', async () => {
    const navigate = vi.fn();
    (await dispatch(null, navigate, {}, true))();
    expect(navigate).toHaveBeenCalledWith({
      pathname: '/settings/voice/conversations',
      params: { focus: 'provider' },
    });
  });

  it('does nothing when there is neither a failure nor an unfinished setup', async () => {
    const navigate = vi.fn();
    (await dispatch(null, navigate))();
    expect(navigate).not.toHaveBeenCalled();
    expect(lifecycle.getSnapshot().status).toBe('disconnected');
  });
});

describe('whether an offered Voice recovery can reach a remedy', () => {
  async function available(
    recovery: VoiceSurfaceRecovery | null,
    overrides: Parameters<typeof context>[0] = {},
  ) {
    const { resolveVoiceAttemptRecoveryAvailable } = await import('./voiceAttemptRecovery');
    return resolveVoiceAttemptRecoveryAvailable(recovery, context(overrides));
  }

  it('withholds Connect recovery whose account cannot be resolved', async () => {
    const recovery = resolveVoiceSurfaceRecovery('connect_agent');
    expect(await available(recovery)).toBe(true);
    expect(await available(recovery, { connectRecoveryTarget: { kind: 'unavailable' } })).toBe(false);
  });

  it('withholds Agent runtime recovery without an exact runtime target', async () => {
    const recovery = resolveVoiceSurfaceRecovery('install_agent_runtime');
    expect(await available(recovery)).toBe(true);
    expect(await available(recovery, { runtimeRecoveryTarget: null })).toBe(false);
  });

  it('withholds a retry with no conversation and no global start authority', async () => {
    const recovery = resolveVoiceSurfaceRecovery('retry');
    expect(await available(recovery, {
      attemptSessionId: null,
      startSessionId: null,
      globalStartAuthorized: true,
    })).toBe(true);
    expect(await available(recovery, {
      attemptSessionId: null,
      startSessionId: null,
      globalStartAuthorized: false,
    })).toBe(false);
  });

  it('keeps settings-shaped recoveries available', async () => {
    expect(await available(resolveVoiceSurfaceRecovery('open_settings'))).toBe(true);
    expect(await available(resolveVoiceSurfaceRecovery('review_credentials'))).toBe(true);
    expect(await available(null)).toBe(false);
  });
});
