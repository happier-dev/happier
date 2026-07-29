import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import type { VoiceAdapterController } from '@/voice/session/types';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import { installVoiceSurfaceCommonModuleMocks } from './voiceSurfaceTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createHostComponentMock(type: string) {
    return (props: any) => React.createElement(type, props, props.children);
}

async function registerMockedStorageStateBridge() {
    const { registerStorageStateReader, registerStorageStateSubscribe } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => mockedStorage.getState());
    registerStorageStateSubscribe((listener) => mockedStorage.subscribe(listener));
}

async function getVoiceConversationBindingStore() {
    return (await import('@/voice/binding/voiceConversationBindingStore')).voiceSessionBindingStore;
}

async function getVoiceTargetStore() {
    return (await import('@/voice/runtime/voiceTargetStore')).useVoiceTargetStore;
}

installVoiceSurfaceCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: createHostComponentMock('Pressable'),
            ScrollView: 'ScrollView',
            Platform: {
                OS: 'web',
                select: (spec: any) => spec?.web ?? spec?.default,
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: {
                push: (...args: any[]) => routerPushSpy(...args),
                navigate: (...args: any[]) => routerPushSpy(...args),
            },
            pathname: () => pathnameState.current,
        });
        return expoRouterMock.module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: () => voiceSettingState.current,
            storage: {
                getState: () => mockedStorage.getState(),
                subscribe: (listener: () => void) => mockedStorage.subscribe(listener),
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    status: {
                        connecting: '#00f',
                        connected: '#0f0',
                        error: '#f00',
                        default: '#999',
                    },
                    surfaceHighest: '#fff',
                    surface: '#fff',
                    divider: '#eee',
                    text: '#000',
                    textSecondary: '#555',
                },
            },
        });
    },
});

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: createHostComponentMock('StatusDot'),
}));

vi.mock('./VoiceLevelVisualizer', () => ({
    VoiceLevelVisualizer: createHostComponentMock('VoiceLevelVisualizer'),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: createHostComponentMock('Ionicons'),
}));

const routerPushSpy = vi.fn();
const pathnameState: { current: string } = { current: '/' };

const featureEnabledState: Record<string, boolean> = { 'voice.agent': true };
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] ?? true,
}));

const activeServerSnapshotState = vi.hoisted(() => ({
  current: {
    serverId: 'server-active',
    serverUrl: 'https://active.example.test',
    generation: 1,
  },
}));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
  useActiveServerSnapshot: () => activeServerSnapshotState.current,
}));

const connectedServicesRegistryState = vi.hoisted(() => ({
  current: {
    scopeKey: 'voice-surface-test',
    status: 'ready' as const,
    entries: [{
      serviceId: 'openai-codex',
      service: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      },
      connectCommand: 'happier connect openai-codex',
      supportsOauth: true,
      executable: true,
    }],
    errorReason: null,
  },
}));
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
  useProjectedConnectedServicesRegistry: () => connectedServicesRegistryState.current,
}));

const voiceSettingState: { current: any } = {
    current: { providerId: 'realtime_elevenlabs', ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' } },
};
const storageState: { current: any } = { current: { sessions: {}, concurrentSessionListCacheByServerId: {} } };
const storageListeners = new Set<() => void>();
const mockedStorage = {
    getState: () => storageState.current,
    subscribe: (listener: (nextState: any) => void) => {
        storageListeners.add(listener as () => void);
        return () => {
            storageListeners.delete(listener as () => void);
        };
    },
    setState: (nextState: any) => {
        storageState.current = nextState;
        for (const listener of storageListeners) {
            (listener as unknown as (state: any) => void)(storageState.current);
        }
    },
};

const registeredVoiceAdapterTargetingState = vi.hoisted(() => ({
  current: {} as Record<string, 'route_target' | 'bound_conversation'>,
}));

let sharedVoiceAdapterAssembly: Readonly<{
  adapters: readonly VoiceAdapterController[];
  dispose: () => Promise<void>;
}> | null = null;

function mirrorRegisteredVoiceAdapterTargeting(
  adapters: readonly VoiceAdapterController[],
): void {
  registeredVoiceAdapterTargetingState.current = Object.fromEntries(
    adapters.map((adapter) => [
      adapter.id,
      adapter.conversationTargeting ?? 'route_target',
    ]),
  );
}

async function renderVoiceSurface(element: React.ReactElement) {
  if (!sharedVoiceAdapterAssembly) {
    const { createBuiltinVoiceAdapterAssembly } = await import('@/voice/adapters/registerBuiltinVoiceAdapters');
    sharedVoiceAdapterAssembly = createBuiltinVoiceAdapterAssembly();
  }
  const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
  mirrorRegisteredVoiceAdapterTargeting(sharedVoiceAdapterAssembly.adapters);
  registerVoiceAdapters(sharedVoiceAdapterAssembly.adapters);
  return await renderScreen(element);
}

async function renderVoiceSurfaceWithAdapter(
  element: React.ReactElement,
  adapter: VoiceAdapterController,
) {
  const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
  mirrorRegisteredVoiceAdapterTargeting([adapter]);
  registerVoiceAdapters([adapter]);
  return await renderScreen(element);
}

function createGlobalSurfaceTestAdapter(
  id: string,
  conversationTargeting?: VoiceAdapterController['conversationTargeting'],
  agentRuntime?: Readonly<{ pluginId: string; localId: string }>,
): VoiceAdapterController {
  return {
    id,
    engineKind: 'realtime',
    ...(conversationTargeting ? { conversationTargeting } : {}),
    start: async () => undefined,
    stop: async () => undefined,
    toggle: async () => undefined,
    interrupt: async () => undefined,
    bargeIn: async () => undefined,
    setMuted: async () => undefined,
    sendContextUpdate: () => undefined,
    getSnapshot: () => ({
      adapterId: id,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    }),
    resolveSurfaceCapabilities: () => ({
      allowsGlobalStart: true,
      controlSessionScope: 'global',
      requiresVoiceAgentFeature: false,
      bargeInEnabled: false,
      cancelResponse: 'unsupported',
      ...(agentRuntime ? { agentRuntime } : {}),
    }),
  };
}

function createElevenLabsVoiceSettings(input: Readonly<{
  activityFeedEnabled: boolean;
  scopeDefault: 'global' | 'session';
  surfaceLocation: 'auto' | 'session' | 'sidebar';
  billingMode?: 'happier' | 'byo';
}>) {
  return {
    providerId: 'realtime_elevenlabs',
    ui: {
      activityFeedEnabled: input.activityFeedEnabled,
      scopeDefault: input.scopeDefault,
      surfaceLocation: input.surfaceLocation,
    },
    providers: {
      realtime_elevenlabs: {
        schemaVersion: 2,
        config: {
          ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
          ...(input.billingMode ? { billingMode: input.billingMode } : {}),
        },
      },
    },
  };
}

function createCodexVoiceSettings(
  globalConnectedServices: unknown,
) {
  return {
    providerId: 'realtime_codex',
    ui: {
      activityFeedEnabled: false,
      scopeDefault: 'global' as const,
      surfaceLocation: 'auto' as const,
    },
    providers: {
      realtime_codex: {
        schemaVersion: 2,
        config: { globalConnectedServices },
      },
    },
  };
}

function createHydratedVoiceConversationSession(
  id: string,
  binding?: VoiceSessionBinding,
) {
  return {
    id,
    active: true,
    updatedAt: binding?.updatedAt ?? 1,
    metadata: {
      systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      ...(binding
        ? {
            voiceConversationBindingV1: {
              v: 1,
              adapterId: binding.adapterId,
              controlSessionId: binding.controlSessionId,
              transcriptMode: binding.transcriptMode,
              targetSessionId: binding.targetSessionId,
              updatedAt: binding.updatedAt,
            },
          }
        : {}),
    },
  };
}

const allSessionsState: { current: any[] } = { current: [] };
vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    return {
        ...actual,
        useAllSessions: () => allSessionsState.current,
        useLocalSetting: () => 1,
        useSession: (sessionId: string) =>
            (storageState.current?.sessions?.[sessionId] ?? null),
        useSessionListPreferredMetadata: (sessionId: string) =>
            storageState.current?.sessionListRenderables?.[sessionId]?.metadata
            ?? storageState.current?.sessions?.[sessionId]?.metadata
            ?? null,
    };
});

const teleportSpy = vi.fn(async (_args: any) => ({ ok: true }));
vi.mock('@/voice/agent/teleportVoiceAgentToSessionRoot', () => ({
    teleportVoiceAgentToSessionRoot: (args: any) => teleportSpy(args),
}));

const ensureVoiceBindingSpy = vi.fn(async (_params: any): Promise<VoiceSessionBinding | null> => null);
vi.mock('@/voice/binding/voiceConversationBindingRuntime', async () => {
    // Build a real manager so the rebind-on-open policy (now owned by the binding
    // manager via ensureBoundForOpenConversation) is exercised end-to-end. The
    // ensureBound spy is wired in as the manager's `resolveBinding` so existing
    // assertions still observe the canonical { adapterId, controlSessionId,
    // requestedTargetSessionId } call shape and drive routing from its result.
    // Resolve the store and resolver from the current reset module graph for each
    // operation; retaining either singleton here creates a test-only split brain.
    const { createVoiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingManager');
    const createCurrentManager = async () => {
        const [
            { voiceConversationBindingResolver },
            { voiceSessionBindingStore },
        ] = await Promise.all([
            import('@/voice/binding/VoiceConversationBindingResolver'),
            import('@/voice/binding/voiceConversationBindingStore'),
        ]);
        return createVoiceSessionBindingManager({
            store: voiceSessionBindingStore,
            resolveBinding: (params: any) => ensureVoiceBindingSpy(params) as any,
            resolveExistingBindingByConversationSessionId: (conversationSessionId: string) =>
                voiceConversationBindingResolver.resolveByConversationSessionId({ conversationSessionId }),
            resolveConversationTargeting: (adapterId: string) =>
                registeredVoiceAdapterTargetingState.current[adapterId] ?? 'route_target',
        });
    };
    return {
        voiceSessionBindingManager: {
            ensureBound: async (params: any) => (await createCurrentManager()).ensureBound(params),
            ensureBoundForOpenConversation: async (params: any) =>
                (await createCurrentManager()).ensureBoundForOpenConversation(params),
            syncTargetSession: async (params: any) => (await createCurrentManager()).syncTargetSession(params),
        },
    };
});

describe('VoiceSurface', () => {
  beforeEach(() => {
    pathnameState.current = '/';
    storageState.current = { sessions: {}, concurrentSessionListCacheByServerId: {} };
    activeServerSnapshotState.current = {
      serverId: 'server-active',
      serverUrl: 'https://active.example.test',
      generation: 1,
    };
  });

  afterEach(async () => {
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    registeredVoiceAdapterTargetingState.current = {};
    registerVoiceAdapters([]);
  });

  afterAll(async () => {
    await sharedVoiceAdapterAssembly?.dispose();
    sharedVoiceAdapterAssembly = null;
  });

  it('disables daemon local voice start when voice.agent is unavailable on the active server', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = false;
    pathnameState.current = '/';
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      providers: {
        local_conversation: { schemaVersion: 1, config: {
          conversationMode: 'agent',
          agent: { backend: 'daemon' },
        } },
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const startButton = screen.findByProps({ accessibilityLabel: 'voiceAssistant.startVoice' });
    expect(startButton.props.disabled).toBe(true);
    expect(screen.getTextContent()).toContain('settingsVoice.local.conversation.resumability.disabledVoiceAgent');
  });

  it('renders stop control when connected', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findByProps({ accessibilityLabel: 'voiceAssistant.endVoice' }).props.disabled).toBe(false);
  });

  it('opens the selected provider disclosure without routing to context-sharing controls', async () => {
    vi.resetModules();
    routerPushSpy.mockReset();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = createCodexVoiceSettings({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'profile',
          profileId: 'account-work',
        },
      },
    });

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_codex',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { VoiceSurface } = await import('./VoiceSurface');
    const screen = await renderVoiceSurfaceWithAdapter(
      React.createElement(VoiceSurface, { variant: 'sidebar' }),
      createGlobalSurfaceTestAdapter('realtime_codex'),
    );

    const disclosure = screen.findByProps({ testID: 'voice-surface-data:sidebar' });
    expect(disclosure.props.accessibilityLabel).toBe('voiceSurface.a11y.providerDataDisclosure');
    await pressTestInstanceAsync(disclosure, 'voiceSurface.a11y.providerDataDisclosure');
    expect(routerPushSpy).toHaveBeenCalledWith({
      pathname: '/settings/voice',
      params: { focus: 'provider' },
    });
  });

  it('renders credential recovery without stale mute or stop controls after terminal preflight decline', async () => {
    vi.resetModules();
    routerPushSpy.mockReset();
    featureEnabledState['voice.agent'] = true;
    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'error',
      mode: 'idle',
      canStop: false,
      errorCode: 'provider_auth_invalid',
      errorMessage: 'credential_unavailable',
      errorRecoveryAction: 'review_credentials',
      errorPresentation: 'error',
    });

    const { VoiceSurface } = await import('./VoiceSurface');
    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.getTextContent()).toContain('settingsVoice.local.machineErrors.provider_auth_invalid');
    expect(screen.findAllByProps({ accessibilityLabel: 'voiceAssistant.endVoice' })).toHaveLength(0);
    expect(screen.findAllByProps({ accessibilityLabel: 'voiceSurface.a11y.mute' })).toHaveLength(0);
    const recovery = screen.findByProps({ accessibilityLabel: 'voiceSurface.reviewCredentials' });
    expect(screen.findByProps({ testID: 'voice-surface-recovery:sidebar' })).toBe(recovery);
    await pressTestInstanceAsync(recovery, 'voiceSurface.reviewCredentials');
    expect(routerPushSpy).toHaveBeenCalledWith('/settings/voice');
  });

  it.each([
    'session_unavailable',
    'feature_unavailable',
  ] as const)('does not expose Start or Retry for the non-retryable %s hard error until the snapshot clears', async (errorCode) => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = createElevenLabsVoiceSettings({
      activityFeedEnabled: false,
      scopeDefault: 'global',
      surfaceLocation: 'auto',
    });
    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'error',
      mode: 'idle',
      canStop: false,
      errorCode,
      errorMessage: errorCode,
      errorRecoveryAction: 'none',
      errorPresentation: 'error',
    });

    const { VoiceSurface } = await import('./VoiceSurface');
    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.getTextContent()).toContain(`settingsVoice.local.machineErrors.${errorCode}`);
    expect(screen.findAllByProps({ testID: 'voice-surface-toggle:sidebar' })).toHaveLength(0);
    expect(screen.findAllByProps({ testID: 'voice-surface-recovery:sidebar' })).toHaveLength(0);

    await act(async () => {
      setVoiceSessionSnapshot({
        adapterId: 'realtime_elevenlabs',
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      });
    });

    expect(screen.findByProps({ testID: 'voice-surface-toggle:sidebar' }).props.disabled).toBe(false);
  });

  it('keeps the canonical Retry action for a neighboring recoverable provider failure', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = createElevenLabsVoiceSettings({
      activityFeedEnabled: false,
      scopeDefault: 'global',
      surfaceLocation: 'auto',
    });
    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
      errorCode: 'provider_error',
      errorMessage: 'provider_error',
      errorRecoveryAction: 'retry',
      errorPresentation: 'notice',
    });

    const { VoiceSurface } = await import('./VoiceSurface');
    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findByProps({ testID: 'voice-surface-recovery:sidebar' }).props.accessibilityLabel).toBe('common.retry');
    expect(screen.findAllByProps({ testID: 'voice-surface-toggle:sidebar' })).toHaveLength(0);
  });

  it('does not show the level visualizer for stale speaking mode after disconnect', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: null,
      status: 'disconnected',
      mode: 'speaking',
      canStop: false,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findAllByType('VoiceLevelVisualizer' as any)).toHaveLength(0);
  });

  it('routes the stop control through voiceSessionManager.stop using the active voice session id', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'realtime_codex',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_codex',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { voiceSessionManager } = await import('@/voice/session/voiceSession');
    const stopSpy = vi.spyOn(voiceSessionManager, 'stop').mockResolvedValue(undefined as any);

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurfaceWithAdapter(
      React.createElement(VoiceSurface, { variant: 'sidebar' }),
      createGlobalSurfaceTestAdapter('realtime_codex'),
    );

    await pressTestInstanceAsync(
      screen.findByProps({ accessibilityLabel: 'voiceAssistant.endVoice' }),
      'voiceAssistant.endVoice',
    );

    expect(stopSpy).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
    expect(stopSpy).not.toHaveBeenCalledWith('');
    stopSpy.mockRestore();
  });

  it('exposes a stable listening mode test id when the sidebar voice surface is actively listening', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: 's1',
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findByProps({ testID: 'voice-surface-mode:sidebar:listening' })).toBeTruthy();
  });

  it('opens the hidden voice conversation session from the header icon when a binding exists', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    routerPushSpy.mockReset();
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };

    const voiceSessionBindingStore = await getVoiceConversationBindingStore();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic',
      targetSessionId: 's1',
      updatedAt: 1,
    });
    storageState.current = {
      ...storageState.current,
      sessions: {
        'carrier-s1': createHydratedVoiceConversationSession('carrier-s1'),
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    await pressTestInstanceAsync(
      screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.openConversation' }),
      'voiceSurface.a11y.openConversation',
    );

    expect(routerPushSpy).toHaveBeenCalledWith('/session/carrier-s1');
  });

  it('shows the hidden voice conversation icon when the binding appears after the surface renders', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findAllByProps({ accessibilityLabel: 'voiceSurface.a11y.openConversation' })).toHaveLength(0);

    await act(async () => {
      mockedStorage.setState({
        ...storageState.current,
        sessions: {
          'carrier-s2': createHydratedVoiceConversationSession('carrier-s2'),
        },
      });
      const voiceSessionBindingStore = await getVoiceConversationBindingStore();
      voiceSessionBindingStore.getState().bind({
        adapterId: 'realtime_elevenlabs',
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        conversationSessionId: 'carrier-s2',
        transcriptMode: 'synthetic',
        targetSessionId: 's2',
        updatedAt: 2,
      });
    });

    expect(screen.findAllByProps({ accessibilityLabel: 'voiceSurface.a11y.openConversation' }).length).toBeGreaterThan(0);
  });

  it('refreshes the hidden voice conversation icon when persisted binding metadata hydrates after render', async () => {
    vi.resetModules();
    await registerMockedStorageStateBridge();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };
    allSessionsState.current = [];
    storageState.current = { sessions: {}, concurrentSessionListCacheByServerId: {} };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findAllByProps({ accessibilityLabel: 'voiceSurface.a11y.openConversation' })).toHaveLength(0);

    await act(async () => {
      const persistedSession = {
        id: 'persisted-voice-session',
        updatedAt: 100,
        metadata: {
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          summary: { text: 'Voice conversation' },
          voiceConversationBindingV1: {
            v: 1,
            adapterId: 'realtime_elevenlabs',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            transcriptMode: 'synthetic',
            targetSessionId: null,
            updatedAt: 100,
          },
        },
      };
      allSessionsState.current = [persistedSession];
      mockedStorage.setState({
        ...storageState.current,
        sessions: {
          'persisted-voice-session': persistedSession,
        },
        concurrentSessionListCacheByServerId: {},
      });
    });

    expect(screen.findAllByProps({ accessibilityLabel: 'voiceSurface.a11y.openConversation' }).length).toBeGreaterThan(0);
  });

  it('refreshes the sidebar transcript projection when persisted binding metadata and transcript messages hydrate through storage only', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: true, scopeDefault: 'global', surfaceLocation: 'auto' },
    };
    allSessionsState.current = [];
    storageState.current = { sessions: {}, sessionMessages: {}, concurrentSessionListCacheByServerId: {} };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findAllByProps({ accessibilityLabel: 'voiceSurface.a11y.openConversation' })).toHaveLength(0);

    await act(async () => {
      mockedStorage.setState({
        ...storageState.current,
        sessions: {
          'persisted-voice-session': {
            id: 'persisted-voice-session',
            updatedAt: 100,
            metadata: {
              systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
              summary: { text: 'Voice conversation' },
              voiceConversationBindingV1: {
                v: 1,
                adapterId: 'realtime_elevenlabs',
                controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                transcriptMode: 'synthetic',
                targetSessionId: null,
                updatedAt: 100,
              },
            },
          },
        },
        sessionMessages: {
          'persisted-voice-session': {
            messages: [
              { id: 'm1', createdAt: 1, localId: 'm1', isSidechain: false, role: 'user', content: { type: 'text', text: 'first' } },
              {
                id: 'm2',
                createdAt: 2,
                localId: 'm2',
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text: 'second', uuid: 'u2', parentUUID: null }],
              },
            ],
          },
        },
        concurrentSessionListCacheByServerId: {},
      });
    });

    expect(screen.findAllByProps({ accessibilityLabel: 'voiceSurface.a11y.openConversation' }).length).toBeGreaterThan(0);
    const texts = screen.findAllByType('Text' as any).map((n) => String(n.props.children ?? ''));
    expect(texts).toContain('2');
  });

  it('keeps the sidebar hidden conversation affordance when the current provider no longer matches the persisted binding adapter', async () => {
    vi.resetModules();
    await registerMockedStorageStateBridge();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'realtime_codex',
      ui: { activityFeedEnabled: true, scopeDefault: 'global', surfaceLocation: 'auto' },
      providers: {
        local_conversation: { schemaVersion: 1, config: {
          conversationMode: 'agent',
        } },
      },
    };
    allSessionsState.current = [];
    storageState.current = { sessions: {}, sessionMessages: {}, concurrentSessionListCacheByServerId: {} };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    await act(async () => {
      mockedStorage.setState({
        ...storageState.current,
        sessions: {
          'persisted-voice-session': {
            id: 'persisted-voice-session',
            updatedAt: 100,
            metadata: {
              systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
              summary: { text: 'Voice conversation' },
              voiceConversationBindingV1: {
                v: 1,
                adapterId: 'realtime_elevenlabs',
                controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                transcriptMode: 'synthetic',
                targetSessionId: null,
                updatedAt: 100,
              },
            },
          },
        },
        sessionMessages: {
          'persisted-voice-session': {
            messages: [
              { id: 'm1', createdAt: 1, localId: 'm1', isSidechain: false, role: 'user', content: { type: 'text', text: 'first' } },
              {
                id: 'm2',
                createdAt: 2,
                localId: 'm2',
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text: 'second', uuid: 'u2', parentUUID: null }],
              },
            ],
          },
        },
        concurrentSessionListCacheByServerId: {},
      });
    });

    expect(screen.findAllByProps({ accessibilityLabel: 'voiceSurface.a11y.openConversation' }).length).toBeGreaterThan(0);
    const texts = screen.findAllByType('Text' as any).map((n) => String(n.props.children ?? ''));
    expect(texts).toContain('2');
  });

  it('does not present a global Voice Home tool target as the voice binding', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'realtime_codex',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      privacy: { shareSessionSummary: true, shareFilePaths: true },
    };
    allSessionsState.current = [];
    storageState.current = {
      sessions: {
        s_target: {
          id: 's_target',
          metadata: {
            summaryText: 'Ready and waiting',
          },
        },
      },
      concurrentSessionListCacheByServerId: {},
    };
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    useVoiceTargetStore.getState().setScope('global');
    useVoiceTargetStore.getState().setPrimaryActionSessionId('s_target');

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_codex',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurfaceWithAdapter(
      React.createElement(VoiceSurface, { variant: 'sidebar' }),
      createGlobalSurfaceTestAdapter('realtime_codex'),
    );

    expect(screen.getTextContent()).not.toContain('Ready and waiting');
    expect(screen.getTextContent()).not.toContain('s_target');
  });

  it('does not present lookup metadata for a global Voice Home tool target as the voice binding', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'realtime_codex',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      privacy: { shareSessionSummary: true, shareFilePaths: true },
    };
    allSessionsState.current = [
      {
        id: 's_target',
        metadata: {
          summaryText: 'Raw target session summary',
        },
      },
    ];
    storageState.current = {
      sessions: {
        s_target: {
          id: 's_target',
          metadata: {
            summaryText: 'Raw target session summary',
          },
        },
      },
      sessionListRenderables: {
        s_target: {
          id: 's_target',
          updatedAt: 99,
          metadata: {
            summaryText: 'Lookup target session summary',
          },
        },
      },
      sessionListIndexByServerId: {
        'active-server': [
          {
            type: 'session',
            sessionId: 's_target',
            serverId: 'active-server',
            serverName: 'Active',
          },
        ],
      },
      concurrentSessionListCacheByServerId: {},
    };
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    useVoiceTargetStore.getState().setScope('global');
    useVoiceTargetStore.getState().setPrimaryActionSessionId('s_target');

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_codex',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurfaceWithAdapter(
      React.createElement(VoiceSurface, { variant: 'sidebar' }),
      createGlobalSurfaceTestAdapter('realtime_codex'),
    );

    expect(screen.getTextContent()).not.toContain('Lookup target session summary');
    expect(screen.getTextContent()).not.toContain('Raw target session summary');
  });

  it('shows the voice conversation icon from a persisted hidden voice session even without an active binding', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    routerPushSpy.mockReset();
    ensureVoiceBindingSpy.mockReset();
    pathnameState.current = '/';
    ensureVoiceBindingSpy.mockResolvedValueOnce({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'persisted-voice-session',
      transcriptMode: 'synthetic',
      targetSessionId: null,
      updatedAt: 1,
    });
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };
    allSessionsState.current = [
      {
        id: 'persisted-voice-session',
        updatedAt: 100,
        metadata: {
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          summary: { text: 'Voice conversation' },
          voiceConversationBindingV1: {
            v: 1,
            adapterId: 'realtime_elevenlabs',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            transcriptMode: 'synthetic',
            targetSessionId: null,
            updatedAt: 1,
          },
        },
      },
    ];
    storageState.current = {
      ...storageState.current,
      sessions: {
        'persisted-voice-session': allSessionsState.current[0],
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const openConversation = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.openConversation' });
    const icon = screen.root
      .findAllByType('Ionicons' as any)
      .find((node: any) => node.props?.name === 'chatbubble-ellipses-outline');

    expect(openConversation).toBeTruthy();
    expect(icon).toBeTruthy();

    await pressTestInstanceAsync(openConversation, 'voiceSurface.a11y.openConversation');

    expect(ensureVoiceBindingSpy).not.toHaveBeenCalled();
    expect(routerPushSpy).toHaveBeenCalledWith('/session/persisted-voice-session');
  });

  it.each([
    ['active', 'connected', true],
    ['post-End', 'disconnected', false],
  ] as const)(
    'opens the exact surviving global Agent-session conversation while viewing another route (%s)',
    async (_phase, status, canStop) => {
      vi.resetModules();
      featureEnabledState['voice.agent'] = true;
      routerPushSpy.mockReset();
      ensureVoiceBindingSpy.mockReset();
      pathnameState.current = '/session/visible-session-b';
      voiceSettingState.current = createCodexVoiceSettings({
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'codex-work-profile',
          },
        },
      });
      const hiddenBinding = {
        adapterId: 'realtime_codex',
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        conversationSessionId: 'hidden-codex-voice-a',
        transcriptMode: 'native_session',
        targetSessionId: null,
        updatedAt: 100,
      } satisfies VoiceSessionBinding;
      const hydratedHiddenSession = createHydratedVoiceConversationSession(
        'hidden-codex-voice-a',
        hiddenBinding,
      );
      const hiddenSession = {
        ...hydratedHiddenSession,
        metadata: {
          ...hydratedHiddenSession.metadata,
          summary: { text: 'Codex Voice conversation' },
        },
      };
      storageState.current = {
        ...storageState.current,
        sessions: {
          'hidden-codex-voice-a': hiddenSession,
          'visible-session-b': {
            id: 'visible-session-b',
            updatedAt: 99,
            metadata: {
              summary: { text: 'Unrelated visible session' },
            },
          },
        },
      };

      const voiceSessionBindingStore = await getVoiceConversationBindingStore();
      voiceSessionBindingStore.getState().bind({
        adapterId: 'realtime_codex',
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        conversationSessionId: 'hidden-codex-voice-a',
        transcriptMode: 'native_session',
        targetSessionId: null,
        updatedAt: 100,
      });

      const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
      setVoiceSessionSnapshot({
        adapterId: 'realtime_codex',
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        status,
        mode: 'idle',
        canStop,
      });

      const { VoiceSurface } = await import('./VoiceSurface');
      const screen = await renderVoiceSurfaceWithAdapter(
        React.createElement(VoiceSurface, { variant: 'sidebar' }),
        createGlobalSurfaceTestAdapter('realtime_codex', 'bound_conversation'),
      );

      await pressTestInstanceAsync(
        screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.openConversation' }),
        'voiceSurface.a11y.openConversation',
      );

      expect(ensureVoiceBindingSpy).not.toHaveBeenCalled();
      expect(routerPushSpy).toHaveBeenCalledWith('/session/hidden-codex-voice-a');
    },
  );

  it('rebinds open-conversation routing through the canonical binding adapter when selected settings drift to another provider', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    routerPushSpy.mockReset();
    ensureVoiceBindingSpy.mockReset();
    ensureVoiceBindingSpy.mockResolvedValueOnce({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'persisted-voice-session-s2',
      transcriptMode: 'native_session',
      targetSessionId: 's2',
      updatedAt: 2,
    });
    voiceSettingState.current = createElevenLabsVoiceSettings({
      activityFeedEnabled: false,
      scopeDefault: 'session',
      surfaceLocation: 'session',
    });
    allSessionsState.current = [
      {
        id: 's2',
        updatedAt: 2,
        metadata: {
          summary: { text: 'Selected session' },
          path: '/tmp/project-s2',
          host: 'localhost',
        },
      },
      {
        id: 'persisted-voice-session',
        updatedAt: 100,
        metadata: {
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          summary: { text: 'Voice conversation' },
          voiceConversationBindingV1: {
            v: 1,
            adapterId: 'local_conversation',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            transcriptMode: 'native_session',
            targetSessionId: 's1',
            updatedAt: 1,
          },
        },
      },
    ];
    storageState.current = {
      ...storageState.current,
      sessions: {
        s2: allSessionsState.current[0],
        'persisted-voice-session': allSessionsState.current[1],
      },
    };

    const voiceSessionBindingStore = await getVoiceConversationBindingStore();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'persisted-voice-session',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    });

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's2' }));

    await pressTestInstanceAsync(
      screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.openConversation' }),
      'voiceSurface.a11y.openConversation',
    );

    expect(ensureVoiceBindingSpy).toHaveBeenCalledWith({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      requestedTargetSessionId: 's2',
    });
    expect(ensureVoiceBindingSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: 'realtime_elevenlabs' }),
    );
    expect(routerPushSpy).toHaveBeenCalledWith('/session/persisted-voice-session-s2');
  });

  it('does not render the session voice surface inside a hidden voice conversation session', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'session' },
      providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent', agent: { backend: 'daemon', teleportEnabled: true } } },
      },
    };
    const carrierSession = {
      id: 'voice-carrier',
      updatedAt: 1,
      metadataLayoutVersion: 1,
      metadata: {
        summary: { text: 'Shared voice carrier' },
      },
      ownerMetadataView: {
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        path: '/Users/leeroy/.happier/voice-agent',
      },
    };
    allSessionsState.current = [carrierSession];
    // The surface resolves the current session from the canonical store map, so
    // the hidden carrier must live there for the hidden-session gate to fire.
    storageState.current = { ...storageState.current, sessions: { 'voice-carrier': carrierSession } };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: 'voice-carrier',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'session', sessionId: 'voice-carrier' }));

    expect(screen.tree.toJSON()).toBeNull();
  });

  it('does not trust shared-only hidden-session metadata when the layout1 owner view is missing', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'session' },
      providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent', agent: { backend: 'daemon', teleportEnabled: true } } },
      },
    };
    const sharedOnlySession = {
      id: 'voice-carrier-shared-only',
      updatedAt: 1,
      metadataLayoutVersion: 1,
      metadata: {
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        path: '/shared/decoy',
      },
      ownerMetadataView: null,
    };
    allSessionsState.current = [sharedOnlySession];
    storageState.current = {
      ...storageState.current,
      sessions: { 'voice-carrier-shared-only': sharedOnlySession },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: 'voice-carrier-shared-only',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');
    const screen = await renderVoiceSurface(
      React.createElement(VoiceSurface, { variant: 'session', sessionId: 'voice-carrier-shared-only' }),
    );

    expect(screen.tree.toJSON()).not.toBeNull();
  });

  it('does not render the session voice surface inside a retired hidden voice conversation session', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'session' },
      providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent', agent: { backend: 'daemon', teleportEnabled: true } } },
      },
    };
    const retiredCarrierSession = {
      id: 'voice-carrier-retired',
      updatedAt: 1,
      metadata: {
        systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
        path: '/Users/leeroy/.happier/voice-agent',
      },
    };
    allSessionsState.current = [retiredCarrierSession];
    // The surface resolves the current session from the canonical store map, so
    // the hidden carrier must live there for the hidden-session gate to fire.
    storageState.current = { ...storageState.current, sessions: { 'voice-carrier-retired': retiredCarrierSession } };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: 'voice-carrier-retired',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'session', sessionId: 'voice-carrier-retired' }));

    expect(screen.tree.toJSON()).toBeNull();
  });

  it('ignores persisted hidden voice sessions that do not have binding metadata', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    routerPushSpy.mockReset();
    ensureVoiceBindingSpy.mockReset();
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };
    allSessionsState.current = [
      {
        id: 'stale-voice-session',
        updatedAt: 100,
        metadata: {
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          summary: { text: 'Voice conversation' },
        },
      },
    ];

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findAllByProps({ accessibilityLabel: 'voiceSurface.a11y.openConversation' })).toHaveLength(0);
    expect(ensureVoiceBindingSpy).not.toHaveBeenCalled();
    expect(routerPushSpy).not.toHaveBeenCalled();
  });

  it('shows a slashed mic and allows barge-in when speaking (local voice)', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent', tts: { bargeInEnabled: true } } },
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');
    const { voiceSessionManager } = await import('@/voice/session/voiceSession');
    const bargeInSpy = vi.spyOn(voiceSessionManager, 'bargeIn').mockResolvedValue(undefined as any);

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const bargeIn = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.bargeIn' });
    expect(bargeIn).toBeTruthy();
    expect(typeof bargeIn.props.onPress).toBe('function');

    const micIcon = screen.root
      .findAllByType('Ionicons' as any)
      .find((n: any) => n.props?.name === 'mic-off-outline');
    expect(micIcon).toBeTruthy();

    await pressTestInstanceAsync(bargeIn, 'voiceSurface.a11y.bargeIn');
    expect(bargeInSpy).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
  });

  it('shows truthful live microphone capture while Codex full-duplex output is speaking', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = createCodexVoiceSettings({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'profile',
          profileId: 'account-work',
        },
      },
    });

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_codex',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    });
    const { voiceRuntimeLevelStore } = await import('@/voice/runtime/levels/voiceRuntimeLevelStore');
    const inputLevel = voiceRuntimeLevelStore.open({
      channel: 'input',
      sourceId: 'realtime_codex:voice-global',
    });

    try {
      const { VoiceSurface } = await import('./VoiceSurface');
      const screen = await renderVoiceSurfaceWithAdapter(
        React.createElement(VoiceSurface, { variant: 'sidebar' }),
        createGlobalSurfaceTestAdapter('realtime_codex'),
      );

      expect(screen.findAllByProps({ accessibilityLabel: 'voiceSurface.a11y.bargeIn' })).toHaveLength(0);
      expect(screen.findByProps({
        accessibilityLabel: 'voiceSurface.a11y.microphoneActive',
      })).toBeTruthy();
      expect(screen.root.findAllByType('Ionicons' as any).some(
        (node: any) => node.props?.name === 'mic',
      )).toBe(true);
      expect(screen.findByType('VoiceLevelVisualizer' as any).props).toMatchObject({
        channel: 'input',
        fallbackPulse: false,
      });
    } finally {
      await act(async () => {
        inputLevel.close();
      });
    }
  });

  it('does not offer destructive barge-in while the active microphone is muted', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent', tts: { bargeInEnabled: true } } },
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'speaking',
      canStop: true,
      micMuted: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');
    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findAllByProps({ accessibilityLabel: 'voiceSurface.a11y.bargeIn' })).toHaveLength(0);
    expect(screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.unmute' })).toBeTruthy();
  });

  it('renders a cancel-turn control while thinking and calls voiceSessionManager.interrupt', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'thinking',
      canStop: true,
    });

    const { voiceSessionManager } = await import('@/voice/session/voiceSession');
    const interruptSpy = vi.spyOn(voiceSessionManager, 'interrupt').mockResolvedValue(undefined as any);

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const cancelTurn = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.cancelTurn' });
    expect(cancelTurn).toBeTruthy();

    await pressTestInstanceAsync(cancelTurn, 'voiceSurface.a11y.cancelTurn');

    expect(interruptSpy).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
    interruptSpy.mockRestore();
  });

  it('keeps End Voice but hides Cancel response when the selected provider cannot cancel a response', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = createElevenLabsVoiceSettings({
      activityFeedEnabled: false,
      scopeDefault: 'global',
      surfaceLocation: 'auto',
      billingMode: 'byo',
    });

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    });
    const { voiceSessionManager } = await import('@/voice/session/voiceSession');
    const interruptSpy = vi.spyOn(voiceSessionManager, 'interrupt').mockResolvedValue(undefined as any);
    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findAllByProps({ accessibilityLabel: 'voiceSurface.a11y.cancelTurn' })).toHaveLength(0);
    expect(screen.findByProps({ accessibilityLabel: 'voiceAssistant.endVoice' })).toBeTruthy();
    expect(interruptSpy).not.toHaveBeenCalled();
    interruptSpy.mockRestore();
  });

  it('renders a mute control for an active voice session and routes it through voiceSessionManager.setMuted', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });

    const { voiceSessionManager } = await import('@/voice/session/voiceSession');
    const setMutedSpy = vi.spyOn(voiceSessionManager, 'setMuted').mockResolvedValue(undefined as any);

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const mute = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.mute' });
    expect(mute).toBeTruthy();

    await pressTestInstanceAsync(mute, 'voiceSurface.a11y.mute');

    expect(setMutedSpy).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID, true);
    setMutedSpy.mockRestore();
  });

  it('renders an unmute control when the active voice session snapshot is muted', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'listening',
      canStop: true,
      micMuted: true,
    });

    const { voiceSessionManager } = await import('@/voice/session/voiceSession');
    const setMutedSpy = vi.spyOn(voiceSessionManager, 'setMuted').mockResolvedValue(undefined as any);

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const unmute = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.unmute' });
    expect(unmute).toBeTruthy();

    await pressTestInstanceAsync(unmute, 'voiceSurface.a11y.unmute');

    expect(setMutedSpy).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID, false);
    setMutedSpy.mockRestore();
  });

  it('starts a global-scoped Voice Home provider globally even when a focused and last-focused session exist', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    pathnameState.current = '/session/s1';
    voiceSettingState.current = createCodexVoiceSettings({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'profile',
          profileId: 'account-work',
        },
      },
    });

    const currentVoiceTargetStore = await getVoiceTargetStore();
    currentVoiceTargetStore.setState({
      scope: 'global',
      lastFocusedSessionId: 'stale-session',
      primaryActionSessionId: null,
      trackedSessionIds: [],
    });

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_codex',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { voiceSessionManager } = await import('@/voice/session/voiceSession');
    const toggleSpy = vi.spyOn(voiceSessionManager, 'toggle').mockResolvedValue(undefined as any);

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurfaceWithAdapter(
      React.createElement(VoiceSurface, { variant: 'sidebar' }),
      createGlobalSurfaceTestAdapter('realtime_codex'),
    );

    const pressable = screen.findByProps({ accessibilityLabel: 'voiceAssistant.startVoice' });

    await pressTestInstanceAsync(pressable, 'voiceAssistant.startVoice');

    expect(toggleSpy).toHaveBeenCalledWith('');
    expect(toggleSpy).not.toHaveBeenCalledWith('s1');
    expect(toggleSpy).not.toHaveBeenCalledWith('stale-session');
    toggleSpy.mockRestore();
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['malformed', { v: 1, bindingsByServiceId: [] }],
  ])('disables global Codex Start when its exact account binding is %s', async (_state, binding) => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    pathnameState.current = '/';
    voiceSettingState.current = binding === undefined
      ? {
          providerId: 'realtime_codex',
          ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
        }
      : createCodexVoiceSettings(binding);
    const currentVoiceTargetStore = await getVoiceTargetStore();
    currentVoiceTargetStore.setState({
      scope: 'global',
      lastFocusedSessionId: null,
      primaryActionSessionId: null,
      trackedSessionIds: [],
    });

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_codex',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { voiceSessionManager } = await import('@/voice/session/voiceSession');
    const toggleSpy = vi.spyOn(voiceSessionManager, 'toggle').mockResolvedValue(undefined as any);
    const { VoiceSurface } = await import('./VoiceSurface');
    const screen = await renderVoiceSurfaceWithAdapter(
      React.createElement(VoiceSurface, { variant: 'sidebar' }),
      createGlobalSurfaceTestAdapter('realtime_codex'),
    );

    expect(screen.findByProps({
      accessibilityLabel: 'voiceAssistant.startVoice',
    }).props.disabled).toBe(true);
    expect(toggleSpy).not.toHaveBeenCalled();
    toggleSpy.mockRestore();
  });

  it('keeps direct sidebar Codex Start bound to the exact session without a global account binding', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    pathnameState.current = '/session/sidebar-direct-session';
    voiceSettingState.current = {
      providerId: 'realtime_codex',
      ui: {
        activityFeedEnabled: false,
        scopeDefault: 'session',
        surfaceLocation: 'sidebar',
      },
      providers: {
        realtime_codex: {
          schemaVersion: 2,
          config: { globalConnectedServices: null },
        },
      },
    };
    const currentVoiceTargetStore = await getVoiceTargetStore();
    currentVoiceTargetStore.setState({
      scope: 'global',
      lastFocusedSessionId: null,
      primaryActionSessionId: null,
      trackedSessionIds: [],
    });
    const {
      resetSessionSurfaceVisibilityForTests,
      setFocusedSessionId,
    } = await import('@/sync/domains/session/sessionSurfaceVisibility');
    resetSessionSurfaceVisibilityForTests();
    setFocusedSessionId('sidebar-direct-session');

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_codex',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { voiceSessionManager } = await import('@/voice/session/voiceSession');
    const toggleSpy = vi.spyOn(voiceSessionManager, 'toggle').mockResolvedValue(undefined as any);
    const { VoiceSurface } = await import('./VoiceSurface');
    const screen = await renderVoiceSurfaceWithAdapter(
      React.createElement(VoiceSurface, { variant: 'sidebar' }),
      createGlobalSurfaceTestAdapter('realtime_codex'),
    );

    const start = screen.findByProps({
      accessibilityLabel: 'voiceAssistant.startVoice',
    });
    expect(start.props.disabled).toBe(false);
    await pressTestInstanceAsync(start, 'voiceAssistant.startVoice');
    expect(toggleSpy).toHaveBeenCalledWith('sidebar-direct-session');
    toggleSpy.mockRestore();
  });

  it('does not turn session-scoped sidebar Voice into a global start when no exact session exists', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    pathnameState.current = '/';
    voiceSettingState.current = {
      providerId: 'realtime_codex',
      ui: {
        activityFeedEnabled: false,
        scopeDefault: 'session',
        surfaceLocation: 'sidebar',
      },
      providers: {
        realtime_codex: {
          schemaVersion: 2,
          config: {
            globalConnectedServices: {
              v: 1,
              bindingsByServiceId: {
                'openai-codex': {
                  source: 'connected',
                  selection: 'profile',
                  profileId: 'global-account-must-not-be-used',
                },
              },
            },
          },
        },
      },
    };
    const currentVoiceTargetStore = await getVoiceTargetStore();
    currentVoiceTargetStore.setState({
      scope: 'global',
      lastFocusedSessionId: null,
      primaryActionSessionId: null,
      trackedSessionIds: [],
    });
    const { resetSessionSurfaceVisibilityForTests } = await import(
      '@/sync/domains/session/sessionSurfaceVisibility'
    );
    resetSessionSurfaceVisibilityForTests();

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_codex',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { voiceSessionManager } = await import('@/voice/session/voiceSession');
    const toggleSpy = vi.spyOn(voiceSessionManager, 'toggle').mockResolvedValue(undefined as any);
    const { VoiceSurface } = await import('./VoiceSurface');
    const screen = await renderVoiceSurfaceWithAdapter(
      React.createElement(VoiceSurface, { variant: 'sidebar' }),
      createGlobalSurfaceTestAdapter('realtime_codex'),
    );

    const start = screen.findByProps({
      accessibilityLabel: 'voiceAssistant.startVoice',
    });
    expect(start.props.disabled).toBe(true);
    await act(async () => {
      start.props.onPress();
    });
    expect(toggleSpy).not.toHaveBeenCalled();
    toggleSpy.mockRestore();
  });

  it('starts a global-capable provider directly only from its explicit exact session surface', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    pathnameState.current = '/session/s1';
    voiceSettingState.current = {
      providerId: 'realtime_codex',
      ui: { activityFeedEnabled: false, scopeDefault: 'session', surfaceLocation: 'session' },
    };
    const currentVoiceTargetStore = await getVoiceTargetStore();
    currentVoiceTargetStore.setState({
      scope: 'global',
      lastFocusedSessionId: 'stale-session',
      primaryActionSessionId: 'different-tool-target',
      trackedSessionIds: [],
    });
    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_codex',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { voiceSessionManager } = await import('@/voice/session/voiceSession');
    const toggleSpy = vi.spyOn(voiceSessionManager, 'toggle').mockResolvedValue(undefined as any);
    const { VoiceSurface } = await import('./VoiceSurface');
    const screen = await renderVoiceSurfaceWithAdapter(
      React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }),
      createGlobalSurfaceTestAdapter('realtime_codex'),
    );

    await pressTestInstanceAsync(
      screen.findByProps({ accessibilityLabel: 'voiceAssistant.startVoice' }),
      'voiceAssistant.startVoice',
    );

    expect(toggleSpy).toHaveBeenCalledWith('s1');
    expect(toggleSpy).not.toHaveBeenCalledWith('');
    expect(screen.getTextContent()).toContain('voiceSurface.targetSession: the current session');
    expect(screen.getTextContent()).not.toContain('different-tool-target');
    toggleSpy.mockRestore();
  });

  it('keeps direct-session Connect recovery bound to the original session after navigation', async () => {
    vi.resetModules();
    routerPushSpy.mockReset();
    featureEnabledState['voice.agent'] = true;
    pathnameState.current = '/session/navigated-session-c';
    activeServerSnapshotState.current = {
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      generation: 2,
    };
    voiceSettingState.current = {
      providerId: 'realtime_codex',
      ui: { activityFeedEnabled: false, scopeDefault: 'session', surfaceLocation: 'session' },
    };
    storageState.current = {
      ...storageState.current,
      sessions: {
        'original-direct-session-b': {
          id: 'original-direct-session-b',
          serverId: 'server-b',
          updatedAt: 1,
          metadata: {
            machineId: 'machine-b',
            runtimeDescriptorV1: {
              v: 1,
              agentId: 'codex',
              provider: {
                backendMode: 'appServer',
                providerSessionId: 'thread-b',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceProfileId: 'account-b',
              },
            },
          },
        },
        'navigated-session-c': {
          id: 'navigated-session-c',
          serverId: 'server-c',
          updatedAt: 2,
          metadata: {
            machineId: 'machine-c',
            runtimeDescriptorV1: {
              v: 1,
              agentId: 'codex',
              provider: {
                backendMode: 'appServer',
                providerSessionId: 'thread-c',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceProfileId: 'account-c',
              },
            },
          },
        },
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_codex',
      sessionId: 'original-direct-session-b',
      status: 'error',
      mode: 'idle',
      canStop: false,
      errorCode: 'provider_auth_invalid',
      errorMessage: 'connected_service_auth_invalid',
      errorRecoveryAction: 'connect_agent',
      errorPresentation: 'error',
    });

    const { VoiceSurface } = await import('./VoiceSurface');
    const screen = await renderVoiceSurfaceWithAdapter(
      React.createElement(VoiceSurface, { variant: 'session', sessionId: 'navigated-session-c' }),
      createGlobalSurfaceTestAdapter(
        'realtime_codex',
        undefined,
        { pluginId: 'happier.agent.codex', localId: 'codex' },
      ),
    );

    await pressTestInstanceAsync(
      screen.findByProps({ testID: 'voice-surface-recovery:session' }),
      'voiceSurface.connectAgent',
    );

    expect(routerPushSpy).toHaveBeenCalledWith({
      pathname: '/(app)/settings/connected-services/account',
      params: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
        accountId: 'account-b',
        serverId: 'server-b',
        machineId: 'machine-b',
      },
    });
  });

  it('does not expose an enabled Connect action when the direct session exact recovery target is unavailable', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    pathnameState.current = '/session/direct-session-without-binding';
    voiceSettingState.current = {
      providerId: 'realtime_codex',
      ui: { activityFeedEnabled: false, scopeDefault: 'session', surfaceLocation: 'session' },
    };
    storageState.current = {
      ...storageState.current,
      sessions: {
        'direct-session-without-binding': {
          id: 'direct-session-without-binding',
          serverId: 'server-active',
          updatedAt: 1,
          metadata: {
            machineId: 'machine-active',
            runtimeDescriptorV1: {
              v: 1,
              agentId: 'codex',
              provider: {
                backendMode: 'appServer',
                providerSessionId: 'thread-without-binding',
              },
            },
          },
        },
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_codex',
      sessionId: 'direct-session-without-binding',
      status: 'error',
      mode: 'idle',
      canStop: false,
      errorCode: 'provider_auth_invalid',
      errorMessage: 'connected_service_auth_invalid',
      errorRecoveryAction: 'connect_agent',
      errorPresentation: 'error',
    });

    const { VoiceSurface } = await import('./VoiceSurface');
    const screen = await renderVoiceSurfaceWithAdapter(
      React.createElement(VoiceSurface, {
        variant: 'session',
        sessionId: 'direct-session-without-binding',
      }),
      createGlobalSurfaceTestAdapter(
        'realtime_codex',
        undefined,
        { pluginId: 'happier.agent.codex', localId: 'codex' },
      ),
    );

    const enabledConnectActions = screen
      .findAllByProps({ testID: 'voice-surface-recovery:session' })
      .filter((node) => node.props.disabled !== true);
    expect(enabledConnectActions).toHaveLength(0);
  });

  it('starts local voice agent from sidebar using voice home when no session is focused', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    pathnameState.current = '/';
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
      },
    };

    const currentVoiceTargetStore = await getVoiceTargetStore();
    currentVoiceTargetStore.setState({
      scope: 'global',
      lastFocusedSessionId: null,
      primaryActionSessionId: null,
      trackedSessionIds: [],
    });

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { voiceSessionManager } = await import('@/voice/session/voiceSession');
    const toggleSpy = vi.spyOn(voiceSessionManager, 'toggle').mockResolvedValue(undefined as any);

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const pressable = screen.findByProps({ accessibilityLabel: 'voiceAssistant.startVoice' });

    await pressTestInstanceAsync(pressable, 'voiceAssistant.startVoice');

    expect(toggleSpy).toHaveBeenCalledWith('');
    toggleSpy.mockRestore();
  });

  it('rebinds the sidebar open action to the current session route when no binding exists yet', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    routerPushSpy.mockReset();
    ensureVoiceBindingSpy.mockReset();
    pathnameState.current = '/session/s1';
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
      },
    };
    allSessionsState.current = [
      {
        id: 'persisted-local-voice-session',
        updatedAt: 100,
        metadata: {
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          summary: { text: 'Voice conversation' },
          voiceConversationBindingV1: {
            v: 1,
            adapterId: 'local_conversation',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            transcriptMode: 'native_session',
            targetSessionId: null,
            updatedAt: 1,
          },
        },
      },
    ];
    storageState.current = {
      ...storageState.current,
      sessions: {
        'persisted-local-voice-session': allSessionsState.current[0],
      },
    };

    ensureVoiceBindingSpy.mockResolvedValueOnce({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-root-s1',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    });

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    await pressTestInstanceAsync(
      screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.openConversation' }),
      'voiceSurface.a11y.openConversation',
    );

    expect(ensureVoiceBindingSpy).toHaveBeenCalledWith({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      requestedTargetSessionId: 's1',
    });
    expect(routerPushSpy).toHaveBeenCalledWith('/session/voice-root-s1');
  });

  it('does not disable the stop button while connecting (escape hatch)', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connecting',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findByProps({ accessibilityLabel: 'voiceAssistant.endVoice' }).props.disabled).toBe(false);
  });

  it('renders a teleport button for local voice agent sessions when enabled', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    teleportSpy.mockClear();
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'session', surfaceLocation: 'session' },
      providers: {
        local_conversation: { schemaVersion: 1, config: {
          conversationMode: 'agent',
          agent: { backend: 'daemon', stayInVoiceHome: false, teleportEnabled: true },
        } },
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));

    const teleport = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.teleport' });
    expect(teleport).toBeTruthy();

    await pressTestInstanceAsync(teleport, 'voiceSurface.a11y.teleport');

    expect(teleportSpy).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('does not dispatch redundant voice target scope updates when already aligned', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };

    // Ensure the store already matches scopeDefault.
    const currentVoiceTargetStore = await getVoiceTargetStore();
    currentVoiceTargetStore.setState({ scope: 'global' });

    let updates = 0;
    const unsub = currentVoiceTargetStore.subscribe(() => {
      updates += 1;
    });

    try {
      const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
      setVoiceSessionSnapshot({
        adapterId: 'realtime_elevenlabs',
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      });

      const { VoiceSurface } = await import('./VoiceSurface');

      const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

      expect(updates).toBe(0);

      await act(async () => {
        screen.tree.unmount();
      });
    } finally {
      unsub();
    }
  });

  it('does not violate hook ordering when provider setting toggles off', async () => {
    vi.resetModules();
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'session', surfaceLocation: 'session' },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));

    await act(async () => {
      voiceSettingState.current = { providerId: 'off', ui: { activityFeedEnabled: false, scopeDefault: 'session', surfaceLocation: 'session' } };
      screen.tree.update(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));
    });

    expect(screen.tree.toJSON()).toBeNull();
  });

  it('auto-selects surface placement when ui.surfaceLocation is auto', async () => {
    vi.resetModules();
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const sidebar = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    expect(sidebar.tree.toJSON()).not.toBeNull();

    const session = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));
    expect(session.tree.toJSON()).toBeNull();
  });

  it('does not render the session voice surface when auto placement prefers the sidebar even if teleport is available from an existing global voice-agent conversation', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    teleportSpy.mockClear();
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      providers: {
        local_conversation: { schemaVersion: 1, config: {
          conversationMode: 'agent',
          agent: { backend: 'daemon', stayInVoiceHome: false, teleportEnabled: true },
        } },
      },
    };

    const voiceSessionBindingStore = await getVoiceConversationBindingStore();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic',
      targetSessionId: 's1',
      updatedAt: 1,
    });

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));

    expect(screen.tree.toJSON()).toBeNull();
  });

  it('allows global-start providers to start from the sidebar even when no session is focused', async () => {
    vi.resetModules();
    voiceSettingState.current = createElevenLabsVoiceSettings({
      activityFeedEnabled: false,
      scopeDefault: 'global',
      surfaceLocation: 'auto',
    });
    const currentVoiceTargetStore = await getVoiceTargetStore();
    currentVoiceTargetStore.getState().setLastFocusedSessionId(null);

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findByProps({ accessibilityLabel: 'voiceAssistant.startVoice' }).props.disabled).toBe(false);
  });

  it('keeps the sidebar surface recoverable after a realtime disconnect by exposing stable status and toggle selectors', async () => {
    vi.resetModules();
    voiceSettingState.current = createElevenLabsVoiceSettings({
      activityFeedEnabled: false,
      scopeDefault: 'global',
      surfaceLocation: 'auto',
    });

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
      errorCode: 'transport_disconnect',
      errorMessage: 'realtime_transport_disconnected',
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findByProps({ testID: 'voice-surface-status:sidebar:disconnected' })).toBeTruthy();
    expect(screen.findByProps({ testID: 'voice-surface-toggle:sidebar' }).props.disabled).toBe(false);
    expect(screen.getTextContent()).toContain('settingsVoice.local.machineErrors.transport_disconnect');
  });

  it('renders the canonical recovery copy for newly structured microphone revocation errors', async () => {
    vi.resetModules();
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'error',
      mode: 'idle',
      canStop: true,
      errorCode: 'mic_permission_revoked',
      errorMessage: 'realtime_mic_permission_revoked',
    });

    const { VoiceSurface } = await import('./VoiceSurface');
    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.getTextContent()).toContain('settingsVoice.local.machineErrors.mic_permission_denied');
  });

  it('requires a focused session to start session-scoped providers from the sidebar', async () => {
    vi.resetModules();
    voiceSettingState.current = {
      providerId: 'local_direct',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };
    const currentVoiceTargetStore = await getVoiceTargetStore();
    currentVoiceTargetStore.getState().setLastFocusedSessionId(null);

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_direct',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findByProps({ accessibilityLabel: 'voiceAssistant.startVoice' }).props.disabled).toBe(true);
  });

  it('shows the sidebar transcript count from the bound hidden conversation session', async () => {
    vi.resetModules();
    voiceSettingState.current = createElevenLabsVoiceSettings({
      activityFeedEnabled: true,
      scopeDefault: 'global',
      surfaceLocation: 'auto',
    });

    storageState.current = {
      sessions: {
        'carrier-s1': createHydratedVoiceConversationSession('carrier-s1'),
      },
      sessionMessages: {
        'carrier-s1': {
          messages: [
            { id: 'm1', createdAt: 1, localId: 'm1', isSidechain: false, role: 'user', content: { type: 'text', text: 'first' } },
            {
              id: 'm2',
              createdAt: 2,
              localId: 'm2',
              isSidechain: false,
              role: 'agent',
              content: [{ type: 'text', text: 'second', uuid: 'u2', parentUUID: null }],
            },
          ],
        },
      },
      concurrentSessionListCacheByServerId: {},
    };
    const voiceSessionBindingStore = await getVoiceConversationBindingStore();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic',
      targetSessionId: 's1',
      updatedAt: 1,
    });

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: null,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    // Ensure count is not hard-coded to 0 for sidebar feed.
    const texts = screen.findAllByType('Text' as any).map((n) => String(n.props.children ?? ''));
    expect(texts).toContain('2');
  });

  it('orders sidebar transcript entries by createdAt and shows note entries from the same projection path', async () => {
    vi.resetModules();
    voiceSettingState.current = createElevenLabsVoiceSettings({
      activityFeedEnabled: true,
      scopeDefault: 'global',
      surfaceLocation: 'auto',
    });

    storageState.current = {
      sessions: {
        'carrier-s1': createHydratedVoiceConversationSession('carrier-s1'),
      },
      sessionMessages: {
        'carrier-s1': {
          messages: [
            {
              id: 'older',
              createdAt: 10,
              localId: 'older',
              isSidechain: false,
              role: 'agent',
              content: [{ type: 'text', text: 'older', uuid: 'u1', parentUUID: null }],
            },
            {
              id: 'new',
              createdAt: 30,
              localId: 'new',
              isSidechain: false,
              role: 'agent',
              content: [{ type: 'text', text: 'new', uuid: 'u2', parentUUID: null }],
            },
            {
              id: 'note',
              createdAt: 40,
              localId: 'note',
              isSidechain: false,
              role: 'agent',
              content: [{ type: 'text', text: '[Voice] Tool result: sendSessionMessage failed', uuid: 'u3', parentUUID: null }],
            },
            {
              id: 'old',
              createdAt: 20,
              localId: 'old',
              isSidechain: false,
              role: 'agent',
              content: [{ type: 'text', text: 'old', uuid: 'u4', parentUUID: null }],
            },
          ],
        },
      },
      concurrentSessionListCacheByServerId: {},
    };
    const voiceSessionBindingStore = await getVoiceConversationBindingStore();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic',
      targetSessionId: 's1',
      updatedAt: 1,
    });

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: null,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const toggle = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.toggleActivity' });
    await pressTestInstanceAsync(toggle, 'voiceSurface.a11y.toggleActivity');

    const eventTexts = screen.root
      .findAllByType('Text' as any)
      .filter((n) => n.props.numberOfLines === 3)
      .map((n) => String(n.props.children ?? ''));

    expect(eventTexts).toEqual([
      '[Voice] Tool result: sendSessionMessage failed',
      'new',
      'old',
      'older',
    ]);
  });

  it('auto-expands once per canonical voice attempt and respects manual collapse through reconnect and remount', async () => {
    vi.resetModules();
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: {
        activityFeedEnabled: true,
        activityFeedAutoExpandOnStart: true,
        scopeDefault: 'global',
        surfaceLocation: 'auto',
      },
    };
    const { resetVoiceActivityFeedExpansionForTests } = await import('./voiceActivityFeedExpansionStore');
    resetVoiceActivityFeedExpansionForTests();
    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    const { VoiceSurface } = await import('./VoiceSurface');
    let screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    await act(async () => {
      setVoiceSessionSnapshot({
        adapterId: 'realtime_elevenlabs',
        sessionId: 'voice-session-1',
        status: 'connecting',
        mode: 'idle',
        canStop: true,
      });
    });
    let toggle = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.toggleActivity' });
    expect(toggle.findByType('Ionicons' as any).props.name).toBe('chevron-down');

    await pressTestInstanceAsync(toggle, 'voiceSurface.a11y.toggleActivity');
    await act(async () => {
      setVoiceSessionSnapshot({
        adapterId: 'realtime_elevenlabs',
        sessionId: 'voice-session-1',
        status: 'connected',
        mode: 'listening',
        canStop: true,
      });
      setVoiceSessionSnapshot({
        adapterId: 'realtime_elevenlabs',
        sessionId: 'voice-session-1',
        status: 'connecting',
        mode: 'idle',
        canStop: true,
      });
    });
    toggle = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.toggleActivity' });
    expect(toggle.findByType('Ionicons' as any).props.name).toBe('chevron-forward');

    await act(async () => screen.unmount());
    screen = await renderVoiceSurface(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    toggle = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.toggleActivity' });
    expect(toggle.findByType('Ionicons' as any).props.name).toBe('chevron-forward');

    await act(async () => {
      setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
      setVoiceSessionSnapshot({
        adapterId: 'realtime_elevenlabs',
        sessionId: 'voice-session-1',
        status: 'connecting',
        mode: 'idle',
        canStop: true,
      });
    });
    toggle = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.toggleActivity' });
    expect(toggle.findByType('Ionicons' as any).props.name).toBe('chevron-down');
  });
});
