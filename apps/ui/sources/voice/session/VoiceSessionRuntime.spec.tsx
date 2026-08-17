import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import type { VoiceSessionSnapshot } from './types';
import type { VoiceSessionLifecycleController } from './voiceSessionLifecycleController';

const platformOsMock = vi.hoisted(() => ({ value: 'ios' as 'ios' | 'web' }));
const CODEX_PROVIDER_ID = 'happier.agent.codex/realtime-codex';
const ELEVENLABS_PROVIDER_ID = 'happier.voice.elevenlabs/realtime-elevenlabs';
const OPENAI_PROVIDER_ID = 'happier.voice.openai/realtime-openai';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      get OS() {
        return platformOsMock.value;
      },
      select: <T,>(options: { web?: T; default?: T; native?: T; ios?: T; android?: T }) =>
        options?.[platformOsMock.value] ?? options?.default ?? options?.native ?? options?.ios ?? options?.android,
    },
  });
});

const defaultUseSetting = (key: string) => {
  if (key === 'voice' || key === 'voiceSettingsV1') return { providerId: 'local_direct' };
  return null;
};

const useSetting = vi.fn<(key: string) => unknown>(defaultUseSetting);
type TestProfileAuthority = Readonly<{
  connectedServicesV2: ReadonlyArray<Readonly<{
    serviceId: string;
    profiles: ReadonlyArray<Readonly<{
      profileId: string;
      status: string;
      kind: string;
    }>>;
    groups: ReadonlyArray<Readonly<{
      groupId: string;
      activeProfileId: string | null;
      generation?: number;
      memberProfileIds?: ReadonlyArray<string>;
    }>>;
  }>>;
  connectedServiceCredentialRevisionsV1: ReadonlyArray<Readonly<{
    serviceId: string;
    profileId: string;
    credentialRevision: string;
  }>>;
}> | null;

const useProfile = vi.fn<() => TestProfileAuthority>(() => null);
const useActiveServerAccountScope = vi.fn<
  () => Readonly<{ serverId: string; accountId: string }> | null
>(() => null);

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useActiveServerAccountScope: () => useActiveServerAccountScope(),
    useProfile: () => useProfile(),
    useSetting: (key: string) => useSetting(key),
});
});

type Snapshot = VoiceSessionSnapshot;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createRuntimeAdapter(
  id: string,
  initial: Snapshot,
  options?: Readonly<{
    engineKind?: 'local' | 'realtime';
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
  }>,
) {
  let current = initial;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    controller: {
      id,
      engineKind: options?.engineKind,
      start: vi.fn(async ({ sessionId }: { sessionId: string }) => {
        await options?.start?.();
        current = {
          adapterId: id,
          sessionId,
          status: 'connecting',
          mode: 'idle',
          canStop: true,
        };
        notify();
      }),
      stop: vi.fn(async () => {
        await options?.stop?.();
      }),
      toggle: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      sendContextUpdate: vi.fn(() => {}),
      getSnapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    setSnapshot(next: Snapshot) {
      current = next;
      notify();
    },
    getSnapshot() {
      return current;
    },
  };
}

describe('VoiceSessionRuntime', () => {
  beforeEach(async () => {
    platformOsMock.value = 'ios';
    vi.resetModules();
    useSetting.mockReset();
    useSetting.mockImplementation(defaultUseSetting);
    useProfile.mockReset();
    useProfile.mockReturnValue(null);
    useActiveServerAccountScope.mockReset();
    useActiveServerAccountScope.mockReturnValue(null);

    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
  });

  afterEach(async () => {
    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
    useSetting.mockReset();
    useSetting.mockImplementation(defaultUseSetting);
    useProfile.mockReset();
    useProfile.mockReturnValue(null);
    useActiveServerAccountScope.mockReset();
    useActiveServerAccountScope.mockReturnValue(null);
    vi.doUnmock('./voiceSessionLifecycleController');
  });

  it('publishes the active adapter snapshot into the voice session store', async () => {
    const snap: Snapshot = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    };

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({ adapters: [
        {
          id: 'local_direct',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => snap,
          subscribe: (listener: () => void) => {
            // no-op; test only asserts initial publish
            void listener;
            return () => {};
          },
        },
      ], dispose: vi.fn(async () => {}) }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual(snap);
  });

  it('configures exact-session Codex Voice without requiring its global account binding', async () => {
    platformOsMock.value = 'web';
    useSetting.mockImplementation((key: string) => key === 'voice' || key === 'voiceSettingsV1'
      ? {
          providerId: CODEX_PROVIDER_ID,
          providers: {
            [CODEX_PROVIDER_ID]: {
              schemaVersion: 2,
              config: { globalConnectedServices: null },
            },
          },
        }
      : null);

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');

    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionLifecycleController()?.getConfiguredProviderId()).toBe(CODEX_PROVIDER_ID);
  });

  it('updates the store when an adapter subscription fires', async () => {
    let current: Snapshot = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    };

    let subscribed: (() => void) | null = null;

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({ adapters: [
        {
          id: 'local_direct',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => current,
          subscribe: (listener: () => void) => {
            subscribed = listener;
            return () => {
              subscribed = null;
            };
          },
        },
      ], dispose: vi.fn(async () => {}) }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');

    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot().mode).toBe('idle');

    current = { ...current, mode: 'speaking' };
    await act(async () => {
      subscribed?.();
    });

    expect(getVoiceSessionSnapshot().mode).toBe('speaking');
  });

  it('rearms a failed provider-auth preparation after credential authority changes and waits for explicit start', async () => {
    let voiceSetting = {
      providerId: OPENAI_PROVIDER_ID,
      providers: {
        [OPENAI_PROVIDER_ID]: {
          schemaVersion: 1,
          config: {
            model: { kind: 'pinned', id: 'gpt-realtime-2.1' },
            voice: 'marin',
            instructions: '',
            turnDetection: 'server_vad',
            inputTranscriptionModel: '',
          },
        },
      },
    };
    const canonicalVoiceSetting = {
      ...voiceSetting,
      credentialBindings: [{
        contribution: {
          pluginId: 'happier.voice.openai',
          localId: 'realtime-openai',
        },
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'connectedAccount' },
        credentialBindings: {},
      }],
    };
    let profile: Exclude<TestProfileAuthority, null> = {
      connectedServicesV2: [{
        serviceId: 'openai',
        profiles: [{ profileId: 'work', status: 'needs_reauth', kind: 'token' }],
        groups: [],
      }],
      connectedServiceCredentialRevisionsV1: [],
    };
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice') return voiceSetting;
      if (key === 'voiceSettingsV1') return canonicalVoiceSetting;
      if (key === 'secrets') return [];
      return null;
    });
    useProfile.mockImplementation(() => profile);
    const selected = createRuntimeAdapter(OPENAI_PROVIDER_ID, {
      adapterId: OPENAI_PROVIDER_ID,
      sessionId: 'voice-session',
      status: 'error',
      mode: 'idle',
      canStop: false,
      errorCode: 'provider_auth_invalid',
      errorMessage: 'credential_unavailable',
      errorRecoveryAction: 'review_credentials',
      errorPresentation: 'error',
    });

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({
        adapters: [selected.controller],
        dispose: vi.fn(async () => {}),
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toMatchObject({
      status: 'error',
      errorCode: 'provider_auth_invalid',
      errorRecoveryAction: 'review_credentials',
    });

    profile = {
      connectedServicesV2: [{
        serviceId: 'openai',
        profiles: [{ profileId: 'work', status: 'connected', kind: 'token' }],
        groups: [],
      }],
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'openai',
        profileId: 'work',
        credentialRevision: 'csr_replacement',
      }],
    };
    voiceSetting = {
      ...voiceSetting,
      providers: {
        ...voiceSetting.providers,
        [OPENAI_PROVIDER_ID]: {
          ...voiceSetting.providers[OPENAI_PROVIDER_ID],
          config: {
            ...voiceSetting.providers[OPENAI_PROVIDER_ID].config,
          },
        },
      },
    };
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });

    expect(getVoiceSessionSnapshot()).toEqual({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
    expect(selected.controller.start).not.toHaveBeenCalled();
    expect(selected.controller.stop).not.toHaveBeenCalled();

    await act(async () => {
      await getVoiceSessionLifecycleController()?.toggle('voice-session-retry');
    });
    expect(selected.controller.start).toHaveBeenCalledWith({ sessionId: 'voice-session-retry' });
  });

  it('classifies ordinary OpenAI credential changes as next-start-only and Codex authority as exact-session', async () => {
    let selectedProviderId = 'happier.voice.openai/realtime-openai';
    let accountScope = { serverId: 'server-a', accountId: 'account-a' };
    let credentialBindings: ReadonlyArray<unknown> = [];
    let providerEnvelope: Readonly<Record<string, unknown>> = {
      schemaVersion: 1,
      config: {
        model: { kind: 'pinned', id: 'gpt-realtime-2.1' },
        voice: 'marin',
        instructions: '',
        turnDetection: 'server_vad',
        inputTranscriptionModel: '',
      },
    };
    let secrets: ReadonlyArray<unknown> = [];
    let profile: Exclude<TestProfileAuthority, null> = {
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [],
    };
    const readVoiceSetting = () => ({
      providerId: selectedProviderId,
      providers: { [selectedProviderId]: providerEnvelope },
    });
    const readCanonicalVoiceSetting = () => ({
      providerId: selectedProviderId,
      credentialBindings,
      providers: { [selectedProviderId]: providerEnvelope },
    });
    useActiveServerAccountScope.mockImplementation(() => accountScope);
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice') return readVoiceSetting();
      if (key === 'voiceSettingsV1') return readCanonicalVoiceSetting();
      if (key === 'secrets') return secrets;
      return null;
    });
    useProfile.mockImplementation(() => profile);

    const rearmAfterCredentialAuthorityChange = vi.fn();
    const disconnectedSnapshot: Snapshot = {
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    };
    const ordinaryOpenAiAdapter = {
      ...createRuntimeAdapter(
        'happier.voice.openai/realtime-openai',
        disconnectedSnapshot,
        { engineKind: 'realtime' },
      ).controller,
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true,
        controlSessionScope: 'global' as const,
        requiresVoiceAgentFeature: false,
        bargeInEnabled: false,
      }),
    };
    const exactSessionCodexAdapter = {
      ...createRuntimeAdapter(
        'happier.agent.codex/realtime-codex',
        disconnectedSnapshot,
        { engineKind: 'realtime' },
      ).controller,
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true,
        controlSessionScope: 'global' as const,
        requiresVoiceAgentFeature: true,
        bargeInEnabled: false,
        agentRuntime: {
          pluginId: 'happier.codex',
          localId: 'codex',
        },
      }),
    };
    const lifecycleController = {
      bargeIn: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      getConfiguredProviderId: vi.fn(() => null),
      getSnapshot: vi.fn((): Snapshot => ({
        adapterId: null,
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        status: 'connected',
        mode: 'listening',
        canStop: true,
      })),
      interrupt: vi.fn(async () => undefined),
      rearmAfterCredentialAuthorityChange,
      sendContextUpdate: vi.fn(),
      setConfiguredProviderId: vi.fn(),
      setMuted: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      subscribe: vi.fn(() => vi.fn()),
      toggle: vi.fn(async () => undefined),
    } satisfies VoiceSessionLifecycleController;
    vi.doMock('./voiceSessionLifecycleController', () => ({
      createVoiceSessionLifecycleController: () => lifecycleController,
    }));
    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({
        adapters: [ordinaryOpenAiAdapter, exactSessionCodexAdapter],
        dispose: vi.fn(async () => undefined),
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));
    expect(rearmAfterCredentialAuthorityChange).not.toHaveBeenCalled();

    accountScope = { serverId: 'server-b', accountId: 'account-b' };
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });

    const selectedCredentialBinding = {
      contribution: {
        pluginId: 'happier.voice.openai',
        localId: 'realtime-openai',
      },
      credentialSlotId: 'api_key',
      credentialSource: { kind: 'savedSecret' },
      credentialBindings: { account: { api_key: 'secret-b' } },
    };
    credentialBindings = [selectedCredentialBinding];
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });

    providerEnvelope = {
      ...providerEnvelope,
      config: {
        ...(providerEnvelope.config as Readonly<Record<string, unknown>>),
        voice: 'cedar',
      },
    };
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });

    credentialBindings = [
      selectedCredentialBinding,
      {
        contribution: { pluginId: 'acme.voice', localId: 'other' },
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: { account: { api_key: 'unrelated-secret' } },
      },
    ];
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });
    expect(rearmAfterCredentialAuthorityChange).toHaveBeenCalledTimes(3);

    credentialBindings = JSON.parse(JSON.stringify(credentialBindings));
    providerEnvelope = JSON.parse(JSON.stringify(providerEnvelope));
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });
    expect(rearmAfterCredentialAuthorityChange).toHaveBeenCalledTimes(3);

    secrets = [{ id: 'secret-b', revision: 2 }];
    profile = {
      connectedServicesV2: [{
        serviceId: 'openai',
        profiles: [{ profileId: 'work', status: 'connected', kind: 'token' }],
        groups: [],
      }],
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'openai',
        profileId: 'work',
        credentialRevision: 'csr_replacement',
      }],
    };
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });

    expect(rearmAfterCredentialAuthorityChange.mock.calls).toEqual([
      [{ exactSessionAccountScopeChanged: false, globalBindingAuthorityChanged: false }],
      [{ exactSessionAccountScopeChanged: false, globalBindingAuthorityChanged: false }],
      [{ exactSessionAccountScopeChanged: false, globalBindingAuthorityChanged: false }],
      [{ exactSessionAccountScopeChanged: false, globalBindingAuthorityChanged: false }],
    ]);

    selectedProviderId = 'happier.agent.codex/realtime-codex';
    credentialBindings = [];
    providerEnvelope = {
      schemaVersion: 2,
      config: {
        globalConnectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'codex-account-a',
            },
          },
        },
      },
    };
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });
    rearmAfterCredentialAuthorityChange.mockClear();

    accountScope = { serverId: 'server-b', accountId: 'codex-account-b' };
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });
    providerEnvelope = {
      ...providerEnvelope,
      config: {
        globalConnectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'codex-account-b',
            },
          },
        },
      },
    };
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });

    expect(rearmAfterCredentialAuthorityChange.mock.calls).toEqual([
      [{ exactSessionAccountScopeChanged: true, globalBindingAuthorityChanged: false }],
      [{ exactSessionAccountScopeChanged: false, globalBindingAuthorityChanged: true }],
    ]);
  });

  it('does not terminate a pending ordinary OpenAI Start for unrelated secret, profile, or revision refreshes', async () => {
    const voiceSetting = {
      providerId: OPENAI_PROVIDER_ID,
      providers: {
        [OPENAI_PROVIDER_ID]: {
          schemaVersion: 1,
          config: {
            model: { kind: 'pinned', id: 'gpt-realtime-2.1' },
            voice: 'marin',
            instructions: '',
            turnDetection: 'server_vad',
            inputTranscriptionModel: '',
          },
        },
      },
    };
    const canonicalVoiceSetting = {
      ...voiceSetting,
      credentialBindings: [{
        contribution: {
          pluginId: 'happier.voice.openai',
          localId: 'realtime-openai',
        },
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: { account: { api_key: 'openai-secret' } },
      }],
    };
    let secrets: ReadonlyArray<unknown> = [{ id: 'openai-secret', revision: 1 }];
    let profile: Exclude<TestProfileAuthority, null> = {
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [],
    };
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice') return voiceSetting;
      if (key === 'voiceSettingsV1') return canonicalVoiceSetting;
      if (key === 'secrets') return secrets;
      return null;
    });
    useProfile.mockImplementation(() => profile);

    const startDeferred = createDeferred<void>();
    const pending = createRuntimeAdapter(
      OPENAI_PROVIDER_ID,
      {
        adapterId: null,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      },
      {
        engineKind: 'realtime',
        start: async () => {
          await startDeferred.promise;
        },
      },
    );
    const adapter = {
      ...pending.controller,
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true,
        controlSessionScope: 'global' as const,
        requiresVoiceAgentFeature: false,
        bargeInEnabled: false,
      }),
    };
    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({
        adapters: [adapter],
        dispose: vi.fn(async () => undefined),
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));
    const controller = getVoiceSessionLifecycleController();
    if (!controller) throw new Error('voice lifecycle controller unavailable');
    const start = controller.toggle('voice-session');
    await vi.waitFor(() => expect(pending.controller.start).toHaveBeenCalledOnce());

    secrets = [
      ...secrets,
      { id: 'unrelated-secret', revision: 2 },
    ];
    profile = {
      connectedServicesV2: [{
        serviceId: 'unrelated-service',
        profiles: [{ profileId: 'unrelated-profile', status: 'connected', kind: 'token' }],
        groups: [],
      }],
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'unrelated-service',
        profileId: 'unrelated-profile',
        credentialRevision: 'revision-2',
      }],
    };
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
      await Promise.resolve();
    });

    expect(pending.controller.stop).not.toHaveBeenCalled();

    startDeferred.resolve();
    await act(async () => {
      await start;
    });
    expect(pending.getSnapshot()).toMatchObject({
      adapterId: OPENAI_PROVIDER_ID,
      sessionId: 'voice-session',
      status: 'connecting',
    });
  });

  it('fences an established global Agent attachment exactly once when its selected group changes active profile', async () => {
    const voiceSetting = {
      providerId: CODEX_PROVIDER_ID,
      providers: {
        [CODEX_PROVIDER_ID]: {
          schemaVersion: 2,
          config: {
            globalConnectedServices: {
              v: 1,
              bindingsByServiceId: {
                'openai-codex': {
                  source: 'connected',
                  selection: 'group',
                  groupId: 'voice-pool',
                },
              },
            },
          },
        },
      },
    };
    let profile: Exclude<TestProfileAuthority, null> = {
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [
          { profileId: 'primary', status: 'connected', kind: 'oauth' },
          { profileId: 'backup', status: 'connected', kind: 'oauth' },
        ],
        groups: [{
          groupId: 'voice-pool',
          activeProfileId: 'primary',
          generation: 1,
          memberProfileIds: ['primary', 'backup'],
        }],
      }],
      connectedServiceCredentialRevisionsV1: [],
    };
    useSetting.mockImplementation((key: string) => (
      key === 'voice' || key === 'voiceSettingsV1' ? voiceSetting : null
    ));
    useProfile.mockImplementation(() => profile);
    const active = createRuntimeAdapter(
      CODEX_PROVIDER_ID,
      {
        adapterId: CODEX_PROVIDER_ID,
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        status: 'connected',
        mode: 'listening',
        canStop: true,
      },
      { engineKind: 'realtime' },
    );
    const adapter = {
      ...active.controller,
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true,
        controlSessionScope: 'global' as const,
        requiresVoiceAgentFeature: false,
        bargeInEnabled: false,
        agentRuntime: {
          pluginId: 'happier.codex',
          localId: 'codex',
        },
      }),
    };
    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({
        adapters: [adapter],
        dispose: vi.fn(async () => undefined),
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));
    expect(active.controller.stop).not.toHaveBeenCalled();

    profile = {
      ...profile,
      connectedServicesV2: [{
        ...profile.connectedServicesV2[0]!,
        groups: [{
          groupId: 'voice-pool',
          activeProfileId: 'backup',
          generation: 2,
          memberProfileIds: ['primary', 'backup'],
        }],
      }],
    };
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
      await Promise.resolve();
    });

    expect(active.controller.stop).toHaveBeenCalledOnce();
    expect(active.controller.stop).toHaveBeenCalledWith({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    });

    profile = {
      ...profile,
      connectedServicesV2: [
        profile.connectedServicesV2[0]!,
        {
          serviceId: 'openai',
          profiles: [{ profileId: 'unrelated', status: 'connected', kind: 'token' }],
          groups: [],
        },
      ],
    };
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
      await Promise.resolve();
    });
    expect(active.controller.stop).toHaveBeenCalledOnce();
  });

  it.each([
    ['is deleted', []],
    ['is revoked', [{ profileId: 'work', status: 'needs_reauth', kind: 'oauth' }]],
  ] as const)(
    'fences an established global Agent attachment exactly once when its selected profile %s',
    async (_caseName, nextProfiles) => {
      const voiceSetting = {
        providerId: CODEX_PROVIDER_ID,
        providers: {
          [CODEX_PROVIDER_ID]: {
            schemaVersion: 2,
            config: {
              globalConnectedServices: {
                v: 1,
                bindingsByServiceId: {
                  'openai-codex': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'work',
                  },
                },
              },
            },
          },
        },
      };
      let profile: Exclude<TestProfileAuthority, null> = {
        connectedServicesV2: [{
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
          groups: [],
        }],
        connectedServiceCredentialRevisionsV1: [],
      };
      useSetting.mockImplementation((key: string) => (
        key === 'voice' || key === 'voiceSettingsV1' ? voiceSetting : null
      ));
      useProfile.mockImplementation(() => profile);
      const active = createRuntimeAdapter(
        CODEX_PROVIDER_ID,
        {
          adapterId: CODEX_PROVIDER_ID,
          sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
          status: 'connected',
          mode: 'listening',
          canStop: true,
        },
        { engineKind: 'realtime' },
      );
      const adapter = {
        ...active.controller,
        resolveSurfaceCapabilities: () => ({
          allowsGlobalStart: true,
          controlSessionScope: 'global' as const,
          requiresVoiceAgentFeature: false,
          bargeInEnabled: false,
          agentRuntime: {
            pluginId: 'happier.codex',
            localId: 'codex',
          },
        }),
      };
      vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
        createBuiltinVoiceAdapterAssembly: () => ({
          adapters: [adapter],
          dispose: vi.fn(async () => undefined),
        }),
      }));

      const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
      const screen = await renderScreen(React.createElement(VoiceSessionRuntime));
      expect(active.controller.stop).not.toHaveBeenCalled();

      profile = {
        ...profile,
        connectedServicesV2: [{
          ...profile.connectedServicesV2[0]!,
          profiles: [...nextProfiles],
        }],
      };
      await act(async () => {
        screen.tree.update(React.createElement(VoiceSessionRuntime));
        await Promise.resolve();
      });

      expect(active.controller.stop).toHaveBeenCalledOnce();
      expect(active.controller.stop).toHaveBeenCalledWith({
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      });
    },
  );

  it('does not fence an established global Agent attachment for an unrelated Connected Services update', async () => {
    const voiceSetting = {
      providerId: CODEX_PROVIDER_ID,
      providers: {
        [CODEX_PROVIDER_ID]: {
          schemaVersion: 2,
          config: {
            globalConnectedServices: {
              v: 1,
              bindingsByServiceId: {
                'openai-codex': {
                  source: 'connected',
                  selection: 'profile',
                  profileId: 'work',
                },
              },
            },
          },
        },
      },
    };
    let profile: Exclude<TestProfileAuthority, null> = {
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
          groups: [],
        },
        {
          serviceId: 'openai',
          profiles: [{ profileId: 'unrelated', status: 'connected', kind: 'token' }],
          groups: [],
        },
      ],
      connectedServiceCredentialRevisionsV1: [],
    };
    useSetting.mockImplementation((key: string) => (
      key === 'voice' || key === 'voiceSettingsV1' ? voiceSetting : null
    ));
    useProfile.mockImplementation(() => profile);
    const active = createRuntimeAdapter(
      CODEX_PROVIDER_ID,
      {
        adapterId: CODEX_PROVIDER_ID,
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        status: 'connected',
        mode: 'listening',
        canStop: true,
      },
      { engineKind: 'realtime' },
    );
    const adapter = {
      ...active.controller,
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true,
        controlSessionScope: 'global' as const,
        requiresVoiceAgentFeature: false,
        bargeInEnabled: false,
        agentRuntime: {
          pluginId: 'happier.codex',
          localId: 'codex',
        },
      }),
    };
    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({
        adapters: [adapter],
        dispose: vi.fn(async () => undefined),
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));

    profile = {
      ...profile,
      connectedServicesV2: [
        profile.connectedServicesV2[0]!,
        {
          serviceId: 'openai',
          profiles: [{ profileId: 'unrelated', status: 'needs_reauth', kind: 'token' }],
          groups: [],
        },
      ],
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'openai',
        profileId: 'unrelated',
        credentialRevision: 'csr_unrelated',
      }],
    };
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
      await Promise.resolve();
    });

    expect(active.controller.stop).not.toHaveBeenCalled();
  });

  it('fences an established direct Agent attachment only when its server-account scope changes', async () => {
    const voiceSetting = {
      providerId: CODEX_PROVIDER_ID,
      providers: {
        [CODEX_PROVIDER_ID]: {
          schemaVersion: 2,
          config: {
            globalConnectedServices: {
              v: 1,
              bindingsByServiceId: {
                'openai-codex': {
                  source: 'connected',
                  selection: 'group',
                  groupId: 'voice-pool',
                },
              },
            },
          },
        },
      },
    };
    let accountScope = { serverId: 'server-a', accountId: 'account-a' };
    let profile: Exclude<TestProfileAuthority, null> = {
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [
          { profileId: 'primary', status: 'connected', kind: 'oauth' },
          { profileId: 'backup', status: 'connected', kind: 'oauth' },
        ],
        groups: [{
          groupId: 'voice-pool',
          activeProfileId: 'primary',
          generation: 1,
          memberProfileIds: ['primary', 'backup'],
        }],
      }],
      connectedServiceCredentialRevisionsV1: [],
    };
    useSetting.mockImplementation((key: string) => (
      key === 'voice' || key === 'voiceSettingsV1' ? voiceSetting : null
    ));
    useProfile.mockImplementation(() => profile);
    useActiveServerAccountScope.mockImplementation(() => accountScope);
    const active = createRuntimeAdapter(
      CODEX_PROVIDER_ID,
      {
        adapterId: CODEX_PROVIDER_ID,
        sessionId: 'direct-agent-session',
        status: 'connected',
        mode: 'listening',
        canStop: true,
      },
      { engineKind: 'realtime' },
    );
    const adapter = {
      ...active.controller,
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true,
        controlSessionScope: 'global' as const,
        requiresVoiceAgentFeature: false,
        bargeInEnabled: false,
        agentRuntime: {
          pluginId: 'happier.codex',
          localId: 'codex',
        },
      }),
    };
    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({
        adapters: [adapter],
        dispose: vi.fn(async () => undefined),
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));

    // Route-only rerenders preserve an established direct Agent attachment.
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
      await Promise.resolve();
    });
    expect(active.controller.stop).not.toHaveBeenCalled();

    // Global binding/profile changes apply to the next global attachment, not this direct session.
    profile = {
      ...profile,
      connectedServicesV2: [{
        ...profile.connectedServicesV2[0]!,
        groups: [{
          groupId: 'voice-pool',
          activeProfileId: 'backup',
          generation: 2,
          memberProfileIds: ['primary', 'backup'],
        }],
      }],
    };
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
      await Promise.resolve();
    });
    expect(active.controller.stop).not.toHaveBeenCalled();

    accountScope = { serverId: 'server-b', accountId: 'account-b' };
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
      await Promise.resolve();
    });

    expect(active.controller.stop).toHaveBeenCalledOnce();
    expect(active.controller.stop).toHaveBeenCalledWith({
      sessionId: 'direct-agent-session',
    });

    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
      await Promise.resolve();
    });
    expect(active.controller.stop).toHaveBeenCalledOnce();
  });

  it('prefers the selected provider adapter snapshot when multiple adapters are active', async () => {
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice' || key === 'voiceSettingsV1') return { providerId: 'local_conversation' };
      return null;
    });

    const snapA: Snapshot = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    };
    const snapB: Snapshot = {
      adapterId: 'local_conversation',
      sessionId: 's2',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    };

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({ adapters: [
        {
          id: 'local_direct',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => snapA,
          subscribe: () => () => {},
        },
        {
          id: 'local_conversation',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => snapB,
          subscribe: () => () => {},
        },
      ], dispose: vi.fn(async () => {}) }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');

    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual(snapB);
  });

  it('keeps the active store owner stable when the selected provider changes mid-call', async () => {
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice' || key === 'voiceSettingsV1') return { providerId: 'local_conversation' };
      return null;
    });

    const snapA: Snapshot = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    };
    const snapB: Snapshot = {
      adapterId: 'local_conversation',
      sessionId: 's2',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    };

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({ adapters: [
        {
          id: 'local_direct',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => snapA,
          subscribe: () => () => {},
        },
        {
          id: 'local_conversation',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => snapB,
          subscribe: () => () => {},
        },
      ], dispose: vi.fn(async () => {}) }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot(snapA);
    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual(snapA);
  });

  it('stops the current owner and starts the newly selected provider after disconnect', async () => {
    let selectedProviderId = 'local_direct';
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice' || key === 'voiceSettingsV1') return { providerId: selectedProviderId };
      return null;
    });

    const active = createRuntimeAdapter('local_direct', {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });
    const selected = createRuntimeAdapter('local_conversation', {
      adapterId: 'local_conversation',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({ adapters: [active.controller, selected.controller], dispose: vi.fn(async () => {}) }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot(active.getSnapshot());
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual(active.getSnapshot());

    selectedProviderId = 'local_conversation';
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });

    expect(active.controller.stop).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(selected.controller.start).not.toHaveBeenCalled();
    expect(getVoiceSessionSnapshot()).toEqual(active.getSnapshot());

    await act(async () => {
      active.setSnapshot({
        adapterId: 'local_direct',
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      });
    });

    expect(selected.controller.start).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(getVoiceSessionSnapshot()).toEqual({
      adapterId: 'local_conversation',
      sessionId: 's1',
      status: 'connecting',
      mode: 'idle',
      canStop: true,
    });
  });

  it('stops the current owner and settles to off after a real disconnect snapshot', async () => {
    let selectedProviderId = 'local_direct';
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice' || key === 'voiceSettingsV1') return { providerId: selectedProviderId };
      return null;
    });

    const active = createRuntimeAdapter('local_direct', {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });
    const idlePeer = createRuntimeAdapter('local_conversation', {
      adapterId: 'local_conversation',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({ adapters: [active.controller, idlePeer.controller], dispose: vi.fn(async () => {}) }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot(active.getSnapshot());
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual(active.getSnapshot());

    selectedProviderId = 'off';
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });

    expect(active.controller.stop).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(idlePeer.controller.start).not.toHaveBeenCalled();
    expect(getVoiceSessionSnapshot()).toEqual(active.getSnapshot());

    await act(async () => {
      active.setSnapshot({
        adapterId: 'local_direct',
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      });
    });

    expect(getVoiceSessionSnapshot()).toEqual({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  it('prefers the selected provider adapter snapshot when the provider id is padded', async () => {
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice' || key === 'voiceSettingsV1') return { providerId: ' local_conversation ' };
      return null;
    });

    const snapA: Snapshot = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    };
    const snapB: Snapshot = {
      adapterId: 'local_conversation',
      sessionId: 's2',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    };

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({ adapters: [
        {
          id: 'local_direct',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => snapA,
          subscribe: () => () => {},
        },
        {
          id: 'local_conversation',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => snapB,
          subscribe: () => () => {},
        },
      ], dispose: vi.fn(async () => {}) }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');

    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual(snapB);
  });

  it('keeps the stored local provider as the continuous-mode owner on web', async () => {
    platformOsMock.value = 'web';
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice' || key === 'voiceSettingsV1') return { providerId: 'local_conversation' };
      return null;
    });

    const realtimeSnapshot: Snapshot = {
      adapterId: ELEVENLABS_PROVIDER_ID,
      sessionId: 's-rt',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    };
    const localSnapshot: Snapshot = {
      adapterId: 'local_conversation',
      sessionId: 's-local',
      status: 'connected',
      mode: 'listening',
      canStop: true,
    };

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({ adapters: [
        {
          id: ELEVENLABS_PROVIDER_ID,
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => realtimeSnapshot,
          subscribe: () => () => {},
        },
        {
          id: 'local_conversation',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => localSnapshot,
          subscribe: () => () => {},
        },
      ], dispose: vi.fn(async () => {}) }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');

    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual(localSnapshot);
  });

  it('fails closed when the configured provider id is unsupported', async () => {
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice' || key === 'voiceSettingsV1') return { providerId: 'unsupported_provider' };
      return null;
    });

    const snapA: Snapshot = {
      adapterId: 'adapter_a',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    };

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({ adapters: [
        {
          id: 'adapter_a',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => snapA,
          subscribe: () => () => {},
        },
      ], dispose: vi.fn(async () => {}) }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');

    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  it('keeps realtime capture admission and the active snapshot until unmount stop completes', async () => {
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice' || key === 'voiceSettingsV1') return { providerId: OPENAI_PROVIDER_ID };
      return null;
    });
    const stopDeferred = createDeferred<void>();
    const realtime = createRuntimeAdapter(
      OPENAI_PROVIDER_ID,
      {
        adapterId: OPENAI_PROVIDER_ID,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      },
      {
        engineKind: 'realtime',
        stop: async () => {
          await stopDeferred.promise;
        },
      },
    );
    const assemblyDispose = vi.fn(async () => {});

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({
        adapters: [realtime.controller],
        dispose: assemblyDispose,
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const { voiceCaptureAdmissionController } = await import('@/voice/runtime/input/VoiceCaptureAdmissionController');
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));

    await act(async () => {
      await getVoiceSessionLifecycleController()?.toggle('voice-session');
    });

    await act(async () => {
      screen.tree.unmount();
    });

    expect(realtime.controller.stop).toHaveBeenCalledWith({ sessionId: 'voice-session' });
    const competingAdmission = voiceCaptureAdmissionController.acquire('dictation');
    if (competingAdmission.status === 'acquired') {
      competingAdmission.lease.release();
    }
    expect(competingAdmission).toMatchObject({
      status: 'busy',
      activeOwner: 'conversation',
    });
    expect(getVoiceSessionSnapshot()).toMatchObject({
      adapterId: OPENAI_PROVIDER_ID,
      sessionId: 'voice-session',
      status: 'connecting',
    });
    expect(assemblyDispose).not.toHaveBeenCalled();

    await act(async () => {
      stopDeferred.resolve();
      await realtime.controller.stop.mock.results[0]?.value;
      await Promise.resolve();
    });

    expect(assemblyDispose).toHaveBeenCalledOnce();
    expect(getVoiceSessionSnapshot()).toEqual({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
    const admissionAfterStop = voiceCaptureAdmissionController.acquire('dictation');
    expect(admissionAfterStop.status).toBe('acquired');
    if (admissionAfterStop.status === 'acquired') {
      admissionAfterStop.lease.release();
    }
  });

  it('stops and awaits an active Local Voice adapter before publishing idle on unmount', async () => {
    const stopDeferred = createDeferred<void>();
    const local = createRuntimeAdapter(
      'local_direct',
      {
        adapterId: 'local_direct',
        sessionId: 'local-session',
        status: 'connected',
        mode: 'listening',
        canStop: true,
      },
      {
        engineKind: 'local',
        stop: async () => {
          await stopDeferred.promise;
        },
      },
    );
    const assemblyDispose = vi.fn(async () => {});

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({
        adapters: [local.controller],
        dispose: assemblyDispose,
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));

    await act(async () => {
      screen.tree.unmount();
    });

    expect(local.controller.stop).toHaveBeenCalledWith({ sessionId: 'local-session' });
    expect(getVoiceSessionSnapshot()).toEqual(local.getSnapshot());
    expect(assemblyDispose).not.toHaveBeenCalled();

    await act(async () => {
      stopDeferred.resolve();
      await local.controller.stop.mock.results[0]?.value;
      await Promise.resolve();
    });

    expect(assemblyDispose).toHaveBeenCalledOnce();
    expect(getVoiceSessionSnapshot()).toEqual({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  it('does not let an earlier StrictMode-equivalent cleanup overwrite a remounted owner', async () => {
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice' || key === 'voiceSettingsV1') return { providerId: OPENAI_PROVIDER_ID };
      return null;
    });
    const oldStopDeferred = createDeferred<void>();
    const oldRuntime = createRuntimeAdapter(
      OPENAI_PROVIDER_ID,
      {
        adapterId: OPENAI_PROVIDER_ID,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      },
      {
        engineKind: 'realtime',
        stop: async () => {
          await oldStopDeferred.promise;
        },
      },
    );
    const freshRuntime = createRuntimeAdapter(
      OPENAI_PROVIDER_ID,
      {
        adapterId: OPENAI_PROVIDER_ID,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      },
      { engineKind: 'realtime' },
    );
    const oldAssemblyDispose = vi.fn(async () => {});
    const freshAssemblyDispose = vi.fn(async () => {});
    let assemblyCount = 0;

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => {
        assemblyCount += 1;
        return assemblyCount === 1
          ? { adapters: [oldRuntime.controller], dispose: oldAssemblyDispose }
          : { adapters: [freshRuntime.controller], dispose: freshAssemblyDispose };
      },
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const oldScreen = await renderScreen(React.createElement(VoiceSessionRuntime));

    await act(async () => {
      await getVoiceSessionLifecycleController()?.toggle('old-session');
    });
    await act(async () => {
      oldScreen.tree.unmount();
    });

    const freshScreen = await renderScreen(React.createElement(VoiceSessionRuntime));
    const freshController = getVoiceSessionLifecycleController();
    await expect(freshController?.toggle('fresh-session')).rejects.toMatchObject({
      name: 'VoiceCaptureBusyError',
      activeOwner: 'conversation',
    });
    expect(freshRuntime.controller.start).not.toHaveBeenCalled();

    oldRuntime.setSnapshot({
      adapterId: OPENAI_PROVIDER_ID,
      sessionId: 'old-session',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    });
    await act(async () => {
      oldStopDeferred.resolve();
      await oldRuntime.controller.stop.mock.results[0]?.value;
      await Promise.resolve();
    });

    expect(getVoiceSessionLifecycleController()).toBe(freshController);
    expect(getVoiceSessionSnapshot()).not.toMatchObject({
      sessionId: 'old-session',
      mode: 'speaking',
    });
    expect(oldAssemblyDispose).toHaveBeenCalledOnce();

    await act(async () => {
      await freshController?.toggle('fresh-session');
    });
    expect(freshRuntime.controller.start).toHaveBeenCalledWith({ sessionId: 'fresh-session' });
    expect(getVoiceSessionSnapshot()).toMatchObject({
      sessionId: 'fresh-session',
      status: 'connecting',
    });

    await act(async () => {
      freshScreen.tree.unmount();
      await Promise.resolve();
    });
    expect(freshAssemblyDispose).toHaveBeenCalledOnce();
  });

  it('does not let deferred Local cleanup stop or overwrite a replacement Local session', async () => {
    const oldStopDeferred = createDeferred<void>();
    const oldRuntime = createRuntimeAdapter(
      'local_direct',
      {
        adapterId: 'local_direct',
        sessionId: 'old-local-session',
        status: 'connected',
        mode: 'listening',
        canStop: true,
      },
      {
        engineKind: 'local',
        stop: async () => {
          await oldStopDeferred.promise;
        },
      },
    );
    const freshRuntime = createRuntimeAdapter(
      'local_direct',
      {
        adapterId: 'local_direct',
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      },
      { engineKind: 'local' },
    );
    const oldAssemblyDispose = vi.fn(async () => {});
    const freshAssemblyDispose = vi.fn(async () => {});
    let assemblyCount = 0;

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => {
        assemblyCount += 1;
        return assemblyCount === 1
          ? { adapters: [oldRuntime.controller], dispose: oldAssemblyDispose }
          : { adapters: [freshRuntime.controller], dispose: freshAssemblyDispose };
      },
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const oldScreen = await renderScreen(React.createElement(VoiceSessionRuntime));

    await act(async () => {
      oldScreen.tree.unmount();
    });
    expect(oldRuntime.controller.stop).toHaveBeenCalledWith({ sessionId: 'old-local-session' });
    expect(oldAssemblyDispose).not.toHaveBeenCalled();

    const freshScreen = await renderScreen(React.createElement(VoiceSessionRuntime));
    const freshController = getVoiceSessionLifecycleController();
    await act(async () => {
      await freshController?.toggle('fresh-local-session');
    });
    expect(freshRuntime.controller.start).toHaveBeenCalledWith({ sessionId: 'fresh-local-session' });
    expect(getVoiceSessionSnapshot()).toMatchObject({
      sessionId: 'fresh-local-session',
      status: 'connecting',
    });

    await act(async () => {
      oldStopDeferred.resolve();
      await oldRuntime.controller.stop.mock.results[0]?.value;
      await Promise.resolve();
    });

    expect(oldAssemblyDispose).toHaveBeenCalledOnce();
    expect(getVoiceSessionLifecycleController()).toBe(freshController);
    expect(getVoiceSessionSnapshot()).toMatchObject({
      sessionId: 'fresh-local-session',
      status: 'connecting',
    });
    expect(freshRuntime.controller.stop).not.toHaveBeenCalled();

    await act(async () => {
      freshScreen.tree.unmount();
      await Promise.resolve();
    });
    expect(freshRuntime.controller.stop).toHaveBeenCalledWith({ sessionId: 'fresh-local-session' });
    expect(freshAssemblyDispose).toHaveBeenCalledOnce();
  });
});
