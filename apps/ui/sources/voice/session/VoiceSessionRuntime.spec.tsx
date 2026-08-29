import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import type { VoiceSessionSnapshot } from './types';
import type { VoiceSessionLifecycleController } from './voiceSessionLifecycleController';

const platformOsMock = vi.hoisted(() => ({ value: 'ios' as 'ios' | 'web' }));
const currentUiContextToolSetMode = vi.hoisted(() => ({
  value: 'on_demand' as 'off' | 'on_demand' | 'automatic',
}));
const activeServerAccountScopeFixture = vi.hoisted(() => ({
  profileScope: null as Readonly<{ serverId: string; accountId: string }> | null,
}));
const CODEX_PROVIDER_ID = 'happier.agent.codex/realtime-codex';
const EXTERNAL_PROVIDER_ID = 'acme.voice.demo/realtime-demo';
const EXTERNAL_REGISTRATION_TOKEN = Object.freeze({});
const ELEVENLABS_PROVIDER_ID = 'happier.voice.elevenlabs/realtime-elevenlabs';
const OPENAI_PROVIDER_ID = 'happier.voice.openai/realtime-openai';
const CODEX_CONNECTED_SERVICE_KEY = readBuiltInLegacyConnectedAccountServiceKeyIngress('openai-codex')!;

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The Account lifetime reads the process-global active-server snapshot rather
// than this component's React hook. Keep that genuine runtime boundary
// controllable while exercising the lifetime owner itself below.
vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>();
  return {
    ...actual,
    getActiveServerSnapshot: () => ({
      ...actual.getActiveServerSnapshot(),
      serverId: activeServerAccountScopeFixture.profileScope?.serverId ?? null,
    }),
  };
});

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
  const {
    createLiveStorageStoreMock,
    createStableStorageReader,
    createStorageModuleStub,
  } = await import('@/dev/testkit/mocks/storage');
  // The real hooks read through zustand's `useShallow`, so a re-render without a store
  // change observes the SAME object identity. Returning a fresh literal per call instead
  // makes `useVoiceDiagnosticsRuntimeSync` re-run its transition effect on every render,
  // and that effect publishes into a runtime-status store this same tree subscribes to —
  // an unbounded render loop that hangs and OOMs the file.
  const currentUiContextToolSetSettings = {
    ...settingsDefaults,
    voice: {
      ...settingsDefaults.voice,
      privacy: {
        ...settingsDefaults.voice.privacy,
        currentUiContextMode: currentUiContextToolSetMode.value,
      },
    },
  };
  return createStorageModuleStub({
    storage: createLiveStorageStoreMock(() => {
      currentUiContextToolSetSettings.voice.privacy.currentUiContextMode = currentUiContextToolSetMode.value;
      return {
        settings: currentUiContextToolSetSettings,
        profileScope: activeServerAccountScopeFixture.profileScope,
      };
    }),
    useActiveServerAccountScope: createStableStorageReader(() => useActiveServerAccountScope()),
    useProfile: createStableStorageReader(() => useProfile()),
    useSetting: createStableStorageReader((key: string) => useSetting(key)),
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

function LayoutCommitBoundary({
  children,
  onLayout,
}: Readonly<{
  children: React.ReactNode;
  onLayout: () => void;
}>): React.ReactElement {
  React.useLayoutEffect(() => {
    onLayout();
  }, [onLayout]);
  return <>{children}</>;
}

/**
 * `@vitest/spy` records every `vi.fn()` in a module-level `Set` it never prunes, and
 * `vi.restoreAllMocks()` does not clear it either. A spy created inside an `it()` body is
 * therefore retained for the whole file, and with it that body's closure context — which
 * holds the module namespaces the test pulled in after `vi.resetModules()`. One in-test spy
 * pins one whole module generation — measured at ~525 MB here — so the file grew by about a
 * generation per test and exhausted Node's 4192 MB default old-space limit by the eighth of
 * the twenty-two tests below, which took it out of reach of an unconfigured worker fork.
 *
 * Every spy this file uses is consequently built by a module-scope factory: the closure the
 * spy registry keeps alive is then this spec module's own context, which all generations
 * share, and a finished test's generation stays collectable.
 * `voiceSessionRuntimeSpecSpyOwnership.architecture.test.ts` fails if a `vi.fn(` is
 * reintroduced into a test body.
 */
function createAsyncNoopSpy() {
  return vi.fn(async () => {});
}

function createNoopSpy() {
  return vi.fn(() => {});
}

function createStubAdapterControls() {
  return {
    start: createAsyncNoopSpy(),
    stop: createAsyncNoopSpy(),
    toggle: createAsyncNoopSpy(),
    interrupt: createAsyncNoopSpy(),
    sendContextUpdate: createNoopSpy(),
  };
}

function createRearmSpy() {
  return vi.fn<VoiceSessionLifecycleController['rearmAfterCredentialAuthorityChange']>();
}

function createStubLifecycleController(
  rearmAfterCredentialAuthorityChange: VoiceSessionLifecycleController['rearmAfterCredentialAuthorityChange'],
) {
  return {
    bargeIn: createAsyncNoopSpy(),
    dispose: createAsyncNoopSpy(),
    getConfiguredProviderId: vi.fn(() => null),
    getSnapshot: vi.fn((): Snapshot => ({
      adapterId: null,
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'listening',
      canStop: true,
    })),
    interrupt: createAsyncNoopSpy(),
    rearmAfterCredentialAuthorityChange,
    sendContextUpdate: createNoopSpy(),
    setConfiguredProviderId: createNoopSpy(),
    setCurrentUiContextToolSetEnabled: createNoopSpy(),
    setMuted: createAsyncNoopSpy(),
    suspendInput: vi.fn(async () => null),
    retry: createAsyncNoopSpy(),
    stop: createAsyncNoopSpy(),
    subscribe: vi.fn(() => createNoopSpy()),
    toggle: createAsyncNoopSpy(),
  } satisfies VoiceSessionLifecycleController;
}

type RuntimeAdapterState = {
  current: Snapshot;
  hooks: Readonly<{ start?: () => Promise<void>; stop?: () => Promise<void> }> | null;
  listeners: Set<() => void>;
};

/**
 * Adapter state lives here rather than in the closures of the spies below. A spy keeps its
 * original implementation forever (`state.getOriginal()` in `@vitest/spy` survives
 * `mockReset()`), so a spy that closed over a caller-supplied `start`/`stop` hook — written
 * in an `it()` body — would pin that test's module generation, and a spy that closed over
 * the subscriber set would pin the generation whose component subscribed. Both are released
 * in `afterEach` via `releaseRuntimeAdapterStates()`.
 */
const runtimeAdapterStates = new Set<RuntimeAdapterState>();

function releaseRuntimeAdapterStates() {
  for (const state of runtimeAdapterStates) {
    state.hooks = null;
    state.listeners.clear();
  }
  runtimeAdapterStates.clear();
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
  const state: RuntimeAdapterState = {
    current: initial,
    hooks: { start: options?.start, stop: options?.stop },
    listeners: new Set<() => void>(),
  };
  runtimeAdapterStates.add(state);

  const notify = () => {
    for (const listener of state.listeners) {
      listener();
    }
  };

  return {
    controller: {
      id,
      engineKind: options?.engineKind,
      start: vi.fn(async ({ sessionId }: { sessionId: string }) => {
        await state.hooks?.start?.();
        state.current = {
          adapterId: id,
          sessionId,
          status: 'connecting',
          mode: 'idle',
          canStop: true,
        };
        notify();
      }),
      stop: vi.fn(async () => {
        await state.hooks?.stop?.();
      }),
      toggle: createAsyncNoopSpy(),
      interrupt: createAsyncNoopSpy(),
      sendContextUpdate: createNoopSpy(),
      getSnapshot: () => state.current,
      subscribe: (listener: () => void) => {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
    },
    setSnapshot(next: Snapshot) {
      state.current = next;
      notify();
    },
    getSnapshot() {
      return state.current;
    },
  };
}

describe('VoiceSessionRuntime', () => {
  beforeEach(async () => {
    platformOsMock.value = 'ios';
    currentUiContextToolSetMode.value = 'on_demand';
    activeServerAccountScopeFixture.profileScope = null;
    vi.resetModules();
    useSetting.mockReset();
    useSetting.mockImplementation(defaultUseSetting);
    useProfile.mockReset();
    useProfile.mockReturnValue(null);
    useActiveServerAccountScope.mockReset();
    useActiveServerAccountScope.mockReturnValue(null);

    const { storage } = await import('@/sync/domains/state/storage');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storage.getState());

    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
  });

  afterEach(async () => {
    const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    retireActiveServerAccountScopeLifetime();
    activeServerAccountScopeFixture.profileScope = null;
    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
    useSetting.mockReset();
    useSetting.mockImplementation(defaultUseSetting);
    useProfile.mockReset();
    useProfile.mockReturnValue(null);
    useActiveServerAccountScope.mockReset();
    useActiveServerAccountScope.mockReturnValue(null);
    currentUiContextToolSetMode.value = 'on_demand';
    vi.doUnmock('./voiceSessionLifecycleController');
    vi.doUnmock('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
    releaseRuntimeAdapterStates();
    // Every spy ever created stays in `@vitest/spy`'s module-level registry, and each one
    // holds its recorded `mock.contexts`/`calls`/`results`. Those records reach the adapter
    // objects a test body built (`{ ...controller, resolveSurfaceCapabilities: () => ... }`),
    // whose arrow functions carry that body's closure context and therefore its whole
    // `vi.resetModules()` module generation. Clearing the records at the end of the test
    // releases them; it runs after every assertion, so no guard depends on it.
    vi.clearAllMocks();
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
          ...createStubAdapterControls(),
          getSnapshot: () => snap,
          subscribe: (listener: () => void) => {
            // no-op; test only asserts initial publish
            void listener;
            return () => {};
          },
        },
      ], dispose: createAsyncNoopSpy() }),
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

  it('sends only current-UI tool availability changes to the lifecycle owner', async () => {
    const rearmAfterCredentialAuthorityChange = createRearmSpy();
    const lifecycleController = createStubLifecycleController(rearmAfterCredentialAuthorityChange);
    vi.doMock('./voiceSessionLifecycleController', () => ({
      createVoiceSessionLifecycleController: () => lifecycleController,
    }));
    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({
        adapters: [],
        dispose: createAsyncNoopSpy(),
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(lifecycleController.setCurrentUiContextToolSetEnabled).toHaveBeenCalledTimes(1);
    expect(lifecycleController.setCurrentUiContextToolSetEnabled).toHaveBeenLastCalledWith(true);

    currentUiContextToolSetMode.value = 'automatic';
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });
    expect(lifecycleController.setCurrentUiContextToolSetEnabled).toHaveBeenCalledTimes(1);

    currentUiContextToolSetMode.value = 'off';
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });
    expect(lifecycleController.setCurrentUiContextToolSetEnabled).toHaveBeenCalledTimes(2);
    expect(lifecycleController.setCurrentUiContextToolSetEnabled).toHaveBeenLastCalledWith(false);

    currentUiContextToolSetMode.value = 'on_demand';
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });
    expect(lifecycleController.setCurrentUiContextToolSetEnabled).toHaveBeenCalledTimes(3);
    expect(lifecycleController.setCurrentUiContextToolSetEnabled).toHaveBeenLastCalledWith(true);
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
          ...createStubAdapterControls(),
          getSnapshot: () => current,
          subscribe: (listener: () => void) => {
            subscribed = listener;
            return () => {
              subscribed = null;
            };
          },
        },
      ], dispose: createAsyncNoopSpy() }),
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
        dispose: createAsyncNoopSpy(),
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

  it('retires each Account scope transition once at the Account lifetime boundary', async () => {
    const accountA = { serverId: 'voice-server', accountId: 'voice-account-a' };
    const accountB = { serverId: 'voice-server', accountId: 'voice-account-b' };
    let accountScope: Readonly<{ serverId: string; accountId: string }> | null = null;
    activeServerAccountScopeFixture.profileScope = null;
    useActiveServerAccountScope.mockImplementation(() => accountScope);

    const rearmAfterCredentialAuthorityChange = createRearmSpy();
    const lifecycleController = createStubLifecycleController(rearmAfterCredentialAuthorityChange);
    vi.doMock('./voiceSessionLifecycleController', () => ({
      createVoiceSessionLifecycleController: () => lifecycleController,
    }));
    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({
        adapters: [],
        dispose: createAsyncNoopSpy(),
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { storage } = await import('@/sync/domains/state/storage');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storage.getState());
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));

    const transitionTo = async (nextAccountScope: Readonly<{ serverId: string; accountId: string }> | null) => {
      activeServerAccountScopeFixture.profileScope = nextAccountScope;
      accountScope = nextAccountScope;
      await act(async () => {
        screen.tree.update(React.createElement(VoiceSessionRuntime));
      });
    };

    await transitionTo(accountA);
    expect(rearmAfterCredentialAuthorityChange.mock.calls).toEqual([
      [{ exactSessionAccountScopeChanged: true }],
    ]);

    await transitionTo(accountB);
    expect(rearmAfterCredentialAuthorityChange.mock.calls).toEqual([
      [{ exactSessionAccountScopeChanged: true }],
      [{ exactSessionAccountScopeChanged: true }],
    ]);

    await transitionTo(null);
    expect(rearmAfterCredentialAuthorityChange.mock.calls).toEqual([
      [{ exactSessionAccountScopeChanged: true }],
      [{ exactSessionAccountScopeChanged: true }],
      [{ exactSessionAccountScopeChanged: true }],
    ]);
  });

  it('classifies ordinary OpenAI credential changes as next-start-only while every Account scope change fences the live attempt', async () => {
    platformOsMock.value = 'web';
    let selectedProviderId = 'happier.voice.openai/realtime-openai';
    let accountScope = { serverId: 'server-a', accountId: 'account-a' };
    activeServerAccountScopeFixture.profileScope = accountScope;
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

    const rearmAfterCredentialAuthorityChange = createRearmSpy();
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
    const lifecycleController = createStubLifecycleController(rearmAfterCredentialAuthorityChange);
    vi.doMock('./voiceSessionLifecycleController', () => ({
      createVoiceSessionLifecycleController: () => lifecycleController,
    }));
    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({
        adapters: [ordinaryOpenAiAdapter, exactSessionCodexAdapter],
        dispose: createAsyncNoopSpy(),
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { storage } = await import('@/sync/domains/state/storage');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storage.getState());
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));
    expect(rearmAfterCredentialAuthorityChange).not.toHaveBeenCalled();

    accountScope = { serverId: 'server-b', accountId: 'account-b' };
    activeServerAccountScopeFixture.profileScope = accountScope;
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
      // Account scope is not credential currentness: an ordinary provider's
      // running attempt belongs to the Account it started under, so the switch
      // fences it exactly like an Agent-runtime attempt.
      [{ exactSessionAccountScopeChanged: true }],
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
            [CODEX_CONNECTED_SERVICE_KEY]: {
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
    activeServerAccountScopeFixture.profileScope = accountScope;
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });
    providerEnvelope = {
      ...providerEnvelope,
      config: {
        ...(providerEnvelope.config as Readonly<Record<string, unknown>>),
        globalConnectedServices: {
          v: 1,
          bindingsByServiceId: {
            [CODEX_CONNECTED_SERVICE_KEY]: {
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
      [{ exactSessionAccountScopeChanged: true }],
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
        dispose: createAsyncNoopSpy(),
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
                [CODEX_CONNECTED_SERVICE_KEY]: {
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
        dispose: createAsyncNoopSpy(),
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
                  [CODEX_CONNECTED_SERVICE_KEY]: {
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
          dispose: createAsyncNoopSpy(),
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
                [CODEX_CONNECTED_SERVICE_KEY]: {
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
        dispose: createAsyncNoopSpy(),
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
                [CODEX_CONNECTED_SERVICE_KEY]: {
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
    activeServerAccountScopeFixture.profileScope = accountScope;
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
        dispose: createAsyncNoopSpy(),
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { storage } = await import('@/sync/domains/state/storage');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storage.getState());
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
    activeServerAccountScopeFixture.profileScope = accountScope;
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

  it('fences an established and a pending ordinary provider attempt when the server-account scope changes', async () => {
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
    let accountScope = { serverId: 'server-a', accountId: 'account-a' };
    activeServerAccountScopeFixture.profileScope = accountScope;
    useSetting.mockImplementation((key: string) => (
      key === 'voice' || key === 'voiceSettingsV1' ? voiceSetting : null
    ));
    useProfile.mockImplementation(() => ({
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [],
    }));
    useActiveServerAccountScope.mockImplementation(() => accountScope);

    const active = createRuntimeAdapter(
      OPENAI_PROVIDER_ID,
      {
        adapterId: OPENAI_PROVIDER_ID,
        sessionId: 'voice-session-account-a',
        status: 'connected',
        mode: 'listening',
        canStop: true,
      },
      { engineKind: 'realtime' },
    );
    const adapter = {
      ...active.controller,
      // An ordinary provider: no Agent runtime, so its credential currentness
      // is next-start-only. Its Account scope is not.
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
        dispose: createAsyncNoopSpy(),
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { storage } = await import('@/sync/domains/state/storage');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storage.getState());
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));

    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
      await Promise.resolve();
    });
    expect(active.controller.stop).not.toHaveBeenCalled();

    accountScope = { serverId: 'server-b', accountId: 'account-b' };
    activeServerAccountScopeFixture.profileScope = accountScope;
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
      await Promise.resolve();
    });

    expect(active.controller.stop).toHaveBeenCalledOnce();
    expect(active.controller.stop).toHaveBeenCalledWith({
      sessionId: 'voice-session-account-a',
    });
    expect(active.controller.start).not.toHaveBeenCalled();
  });

  it('synchronously retires an ordinary realtime attempt before a retained current-UI handler can reach either Account port', async () => {
    const accountA = { serverId: 'voice-server', accountId: 'voice-account-a' };
    const accountB = { serverId: 'voice-server', accountId: 'voice-account-b' };
    let accountScope = accountA;
    activeServerAccountScopeFixture.profileScope = accountA;
    useActiveServerAccountScope.mockImplementation(() => accountScope);
    useSetting.mockImplementation((key: string) => (
      key === 'voice' || key === 'voiceSettingsV1'
        ? {
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
          }
        : null
    ));

    const accountARead = createNoopSpy();
    const accountAEffect = createNoopSpy();
    const accountBRead = createNoopSpy();
    const accountBEffect = createNoopSpy();
    const accountAPort = {
      readCurrentUiContext: () => {
        accountARead();
        return null;
      },
      resolveCurrentUiCommand: (_commandId: string) => null,
      subscribe: (_listener: () => void) => () => {},
      invokeCurrentUiCommand: async (_input: Readonly<{ commandId: string; signal?: AbortSignal }>) => {
        accountAEffect();
        return { ok: true as const };
      },
    };
    const accountBPort = {
      readCurrentUiContext: () => {
        accountBRead();
        return null;
      },
      resolveCurrentUiCommand: (_commandId: string) => null,
      subscribe: (_listener: () => void) => () => {},
      invokeCurrentUiCommand: async (_input: Readonly<{ commandId: string; signal?: AbortSignal }>) => {
        accountBEffect();
        return { ok: true as const };
      },
    };
    let currentAccountPort = accountAPort;
    const currentUiContext = {
      readCurrentUiContext: () => currentAccountPort.readCurrentUiContext(),
      resolveCurrentUiCommand: (commandId: string) => currentAccountPort.resolveCurrentUiCommand(commandId),
      subscribe: (listener: () => void) => currentAccountPort.subscribe(listener),
      invokeCurrentUiCommand: (input: Readonly<{ commandId: string; signal?: AbortSignal }>) => (
        currentAccountPort.invokeCurrentUiCommand(input)
      ),
    };
    vi.doMock('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort', () => ({
      useCurrentUiContextVoiceToolPort: () => currentUiContext,
    }));

    let attemptLive = false;
    let assemblyPort: typeof currentUiContext | null = null;
    const retainedAttemptHandlerRef: { current: (() => void) | null } = { current: null };
    const runtime = createRuntimeAdapter(
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
          attemptLive = true;
          retainedAttemptHandlerRef.current = () => {
            if (!attemptLive || !assemblyPort) return;
            assemblyPort.readCurrentUiContext();
            void assemblyPort.invokeCurrentUiCommand({ commandId: 'retired-account-command' });
          };
        },
        stop: async () => {
          // A provider stop is the real system boundary: it synchronously revokes
          // the attempt's retained handler before its asynchronous close settles.
          attemptLive = false;
        },
      },
    );
    const adapter = {
      ...runtime.controller,
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true,
        controlSessionScope: 'global' as const,
        requiresVoiceAgentFeature: false,
        bargeInEnabled: false,
      }),
    };
    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: (input?: Readonly<{ currentUiContext?: typeof currentUiContext }>) => {
        assemblyPort = input?.currentUiContext ?? null;
        return {
          adapters: [adapter],
          dispose: createAsyncNoopSpy(),
        };
      },
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { storage } = await import('@/sync/domains/state/storage');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    // Loading the runtime pulls in the real storage store, which registers its
    // own reader. Re-register this test's live mock after that graph has loaded
    // so the real Account lifetime sees the same scope as the React hook.
    registerStorageStateReader(() => storage.getState());
    const {
      getActiveServerAccountScope,
      retireActiveServerAccountScopeLifetime,
    } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { readRegisteredStorageState } = await import('@/sync/domains/state/storageStateReaderBridge');
    expect(getActiveServerSnapshot().serverId).toBe(accountA.serverId);
    expect(readRegisteredStorageState()?.profileScope).toEqual(accountA);
    expect(getActiveServerAccountScope()).toEqual(accountA);
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));
    const controller = getVoiceSessionLifecycleController();
    if (!controller) throw new Error('voice lifecycle controller unavailable');

    expect(assemblyPort).toBe(currentUiContext);
    await controller.toggle('voice-session-account-a');
    expect(runtime.controller.start).toHaveBeenCalledOnce();
    expect(retainedAttemptHandlerRef.current).not.toBeNull();
    expect(attemptLive).toBe(true);

    // Sync owns the Account retirement. Do not re-render or yield a microtask:
    // the old attempt's retained handler must already be inert before Account B
    // can publish through the same stable AppShell port.
    retireActiveServerAccountScopeLifetime();
    currentAccountPort = accountBPort;
    retainedAttemptHandlerRef.current?.();

    expect(runtime.controller.stop).toHaveBeenCalledWith({ sessionId: 'voice-session-account-a' });
    expect(attemptLive).toBe(false);
    expect(accountARead).not.toHaveBeenCalled();
    expect(accountAEffect).not.toHaveBeenCalled();
    expect(accountBRead).not.toHaveBeenCalled();
    expect(accountBEffect).not.toHaveBeenCalled();

    // The sibling Account commit remains unable to revive Account A's retained
    // handler after layout/passive effects have had a chance to run.
    activeServerAccountScopeFixture.profileScope = accountB;
    accountScope = accountB;
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });
    retainedAttemptHandlerRef.current?.();

    expect(accountARead).not.toHaveBeenCalled();
    expect(accountAEffect).not.toHaveBeenCalled();
    expect(accountBRead).not.toHaveBeenCalled();
    expect(accountBEffect).not.toHaveBeenCalled();
  });

  it('synchronously retires a no-Account realtime attempt during the Account B layout commit before its retained current-UI handler can reach B', async () => {
    const accountB = { serverId: 'voice-server', accountId: 'voice-account-b' };
    let accountScope: Readonly<{ serverId: string; accountId: string }> | null = null;
    activeServerAccountScopeFixture.profileScope = null;
    useActiveServerAccountScope.mockImplementation(() => accountScope);
    useSetting.mockImplementation((key: string) => (
      key === 'voice' || key === 'voiceSettingsV1'
        ? {
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
          }
        : null
    ));

    const accountBRead = createNoopSpy();
    const accountBEffect = createNoopSpy();
    const noAccountPort = {
      readCurrentUiContext: () => null,
      resolveCurrentUiCommand: (_commandId: string) => null,
      subscribe: (_listener: () => void) => () => {},
      invokeCurrentUiCommand: async (_input: Readonly<{ commandId: string; signal?: AbortSignal }>) => ({ ok: true as const }),
    };
    const accountBPort = {
      readCurrentUiContext: () => {
        accountBRead();
        return null;
      },
      resolveCurrentUiCommand: (_commandId: string) => null,
      subscribe: (_listener: () => void) => () => {},
      invokeCurrentUiCommand: async (_input: Readonly<{ commandId: string; signal?: AbortSignal }>) => {
        accountBEffect();
        return { ok: true as const };
      },
    };
    let currentAccountPort = noAccountPort;
    const currentUiContext = {
      readCurrentUiContext: () => currentAccountPort.readCurrentUiContext(),
      resolveCurrentUiCommand: (commandId: string) => currentAccountPort.resolveCurrentUiCommand(commandId),
      subscribe: (listener: () => void) => currentAccountPort.subscribe(listener),
      invokeCurrentUiCommand: (input: Readonly<{ commandId: string; signal?: AbortSignal }>) => (
        currentAccountPort.invokeCurrentUiCommand(input)
      ),
    };
    vi.doMock('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort', () => ({
      useCurrentUiContextVoiceToolPort: () => currentUiContext,
    }));

    let attemptLive = false;
    let assemblyPort: typeof currentUiContext | null = null;
    const retainedAttemptHandlerRef: { current: (() => void) | null } = { current: null };
    const runtime = createRuntimeAdapter(
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
          attemptLive = true;
          retainedAttemptHandlerRef.current = () => {
            if (!attemptLive || !assemblyPort) return;
            assemblyPort.readCurrentUiContext();
            void assemblyPort.invokeCurrentUiCommand({ commandId: 'no-account-command' });
          };
        },
        stop: async () => {
          // The real provider boundary synchronously revokes its retained
          // handler while the asynchronous transport close settles.
          attemptLive = false;
        },
      },
    );
    const adapter = {
      ...runtime.controller,
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true,
        controlSessionScope: 'global' as const,
        requiresVoiceAgentFeature: false,
        bargeInEnabled: false,
      }),
    };
    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: (input?: Readonly<{ currentUiContext?: typeof currentUiContext }>) => {
        assemblyPort = input?.currentUiContext ?? null;
        return {
          adapters: [adapter],
          dispose: createAsyncNoopSpy(),
        };
      },
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { storage } = await import('@/sync/domains/state/storage');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storage.getState());
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    expect(getActiveServerAccountScope()).toBeNull();
    const renderRuntime = () => React.createElement(
      LayoutCommitBoundary,
      {
        onLayout: () => retainedAttemptHandlerRef.current?.(),
        children: React.createElement(VoiceSessionRuntime),
      },
    );
    const screen = await renderScreen(renderRuntime());
    const controller = getVoiceSessionLifecycleController();
    if (!controller) throw new Error('voice lifecycle controller unavailable');

    await act(async () => {
      await controller.toggle('voice-session-no-account');
    });
    expect(runtime.controller.start).toHaveBeenCalledOnce();
    expect(retainedAttemptHandlerRef.current).not.toBeNull();
    expect(attemptLive).toBe(true);

    // The parent layout effect runs after Voice's child layout effects but
    // before passive credential reconciliation. A no-Account admission has no
    // previous lifetime callback to retire it.
    activeServerAccountScopeFixture.profileScope = accountB;
    accountScope = accountB;
    currentAccountPort = accountBPort;
    await act(async () => {
      screen.tree.update(renderRuntime());
      await Promise.resolve();
    });

    expect(runtime.controller.stop).toHaveBeenCalledWith({ sessionId: 'voice-session-no-account' });
    expect(attemptLive).toBe(false);
    expect(accountBRead).not.toHaveBeenCalled();
    expect(accountBEffect).not.toHaveBeenCalled();
  });

  it('fences a pending ordinary provider Start when the server-account scope changes mid-preparation', async () => {
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
    let accountScope = { serverId: 'server-a', accountId: 'account-a' };
    activeServerAccountScopeFixture.profileScope = accountScope;
    useSetting.mockImplementation((key: string) => (
      key === 'voice' || key === 'voiceSettingsV1' ? voiceSetting : null
    ));
    useProfile.mockImplementation(() => ({
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [],
    }));
    useActiveServerAccountScope.mockImplementation(() => accountScope);

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
        // A Start still between credential mint and carrier creation.
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
        dispose: createAsyncNoopSpy(),
      }),
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { voiceCaptureAdmissionController } = await import('@/voice/runtime/input/VoiceCaptureAdmissionController');
    const { storage } = await import('@/sync/domains/state/storage');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storage.getState());
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));
    const controller = getVoiceSessionLifecycleController();
    if (!controller) throw new Error('voice lifecycle controller unavailable');
    const start = controller.toggle('voice-session-account-a');
    await vi.waitFor(() => expect(pending.controller.start).toHaveBeenCalledOnce());

    accountScope = { serverId: 'server-b', accountId: 'account-b' };
    activeServerAccountScopeFixture.profileScope = accountScope;
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
      await Promise.resolve();
    });

    expect(pending.controller.stop).toHaveBeenCalledOnce();
    expect(pending.controller.stop).toHaveBeenCalledWith({
      sessionId: 'voice-session-account-a',
    });

    startDeferred.resolve();
    await act(async () => {
      await start;
      await Promise.resolve();
    });
    // The fenced attempt settles and hands its exclusive capture back, so the
    // Account-B user is not left holding an Account-A microphone lease.
    const readmitted = voiceCaptureAdmissionController.acquire('conversation');
    expect(readmitted.status).toBe('acquired');
    if (readmitted.status === 'acquired') readmitted.lease.release();
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
          ...createStubAdapterControls(),
          getSnapshot: () => snapA,
          subscribe: () => () => {},
        },
        {
          id: 'local_conversation',
          ...createStubAdapterControls(),
          getSnapshot: () => snapB,
          subscribe: () => () => {},
        },
      ], dispose: createAsyncNoopSpy() }),
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
          ...createStubAdapterControls(),
          getSnapshot: () => snapA,
          subscribe: () => () => {},
        },
        {
          id: 'local_conversation',
          ...createStubAdapterControls(),
          getSnapshot: () => snapB,
          subscribe: () => () => {},
        },
      ], dispose: createAsyncNoopSpy() }),
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
      createBuiltinVoiceAdapterAssembly: () => ({ adapters: [active.controller, selected.controller], dispose: createAsyncNoopSpy() }),
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
      createBuiltinVoiceAdapterAssembly: () => ({ adapters: [active.controller, idlePeer.controller], dispose: createAsyncNoopSpy() }),
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
          ...createStubAdapterControls(),
          getSnapshot: () => snapA,
          subscribe: () => () => {},
        },
        {
          id: 'local_conversation',
          ...createStubAdapterControls(),
          getSnapshot: () => snapB,
          subscribe: () => () => {},
        },
      ], dispose: createAsyncNoopSpy() }),
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
          ...createStubAdapterControls(),
          getSnapshot: () => realtimeSnapshot,
          subscribe: () => () => {},
        },
        {
          id: 'local_conversation',
          ...createStubAdapterControls(),
          getSnapshot: () => localSnapshot,
          subscribe: () => () => {},
        },
      ], dispose: createAsyncNoopSpy() }),
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
          ...createStubAdapterControls(),
          getSnapshot: () => snapA,
          subscribe: () => () => {},
        },
      ], dispose: createAsyncNoopSpy() }),
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
    const assemblyDispose = createAsyncNoopSpy();

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
    const assemblyDispose = createAsyncNoopSpy();

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
    const oldAssemblyDispose = createAsyncNoopSpy();
    const freshAssemblyDispose = createAsyncNoopSpy();
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
    const oldAssemblyDispose = createAsyncNoopSpy();
    const freshAssemblyDispose = createAsyncNoopSpy();
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
  /**
   * C1 parity — an external provider must reach the runtime exactly like a built-in one.
   *
   * The selection is resolved through the provider registry, and a plugin only registers into
   * that registry when its runtime activates — after this component's first render on a cold
   * boot. Without observing the registry's own revision the first `null` answer stands forever:
   * the surface can present the persisted provider while Start silently does nothing, because
   * the lifecycle owner was never told which provider was configured.
   */
  it('configures a persisted external provider once its plugin registers', async () => {
    const rearmAfterCredentialAuthorityChange = createRearmSpy();
    const lifecycleController = createStubLifecycleController(rearmAfterCredentialAuthorityChange);
    vi.doMock('./voiceSessionLifecycleController', () => ({
      createVoiceSessionLifecycleController: () => lifecycleController,
    }));
    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapterAssembly: () => ({
        adapters: [],
        dispose: createAsyncNoopSpy(),
      }),
    }));
    useSetting.mockImplementation((key: string) => key === 'voice' || key === 'voiceSettingsV1'
      ? {
          providerId: EXTERNAL_PROVIDER_ID,
          providers: {
            [EXTERNAL_PROVIDER_ID]: { schemaVersion: 1, config: {} },
          },
        }
      : null);

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const {
      commitExternalVoiceProviderRegistration,
      removeExternalVoiceProviderRegistration,
    } = await import('@/voice/registry/externalVoiceProviderRegistrations');

    await renderScreen(React.createElement(VoiceSessionRuntime));
    expect(lifecycleController.setConfiguredProviderId).toHaveBeenLastCalledWith(null);

    await act(async () => {
      commitExternalVoiceProviderRegistration({
        token: EXTERNAL_REGISTRATION_TOKEN,
        pluginId: 'acme.voice.demo',
        localId: 'realtime-demo',
        providerId: EXTERNAL_PROVIDER_ID,
        descriptor: {
          kind: 'voice.conversation-provider.v1',
          pluginId: 'acme.voice.demo',
          providerId: EXTERNAL_PROVIDER_ID,
          settingsSectionId: 'voice.acme-demo',
          roles: [],
          requirements: [],
          source: { kind: 'external', pluginId: 'acme.voice.demo', localId: 'realtime-demo' },
          projectSettings: () => ({ status: 'ready', modeId: 'byo' }),
        } as never,
        adapter: null,
      });
    });

    expect(lifecycleController.setConfiguredProviderId).toHaveBeenLastCalledWith(EXTERNAL_PROVIDER_ID);

    // Withdrawal is the same authority in the other direction: an uninstalled plugin must not
    // leave the lifecycle owner holding a provider it can no longer resolve.
    await act(async () => {
      removeExternalVoiceProviderRegistration(EXTERNAL_REGISTRATION_TOKEN);
    });
    expect(lifecycleController.setConfiguredProviderId).toHaveBeenLastCalledWith(null);
  });
});
