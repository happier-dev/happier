import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
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

vi.mock('@/components/ui/status/VoiceBars', () => ({
    VoiceBars: createHostComponentMock('VoiceBars'),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: createHostComponentMock('Ionicons'),
}));

const localVoiceToggleTurnSpy = vi.fn(async (_sessionId: string) => {});
vi.mock('@/voice/local/localVoiceRuntimeController', () => ({
    localVoiceRuntimeController: {
        toggleTurn: (sessionId: string) => localVoiceToggleTurnSpy(sessionId),
    },
}));

const routerPushSpy = vi.fn();
const pathnameState: { current: string } = { current: '/' };

const featureEnabledState: Record<string, boolean> = { 'voice.agent': true };
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] ?? true,
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

const allSessionsState: { current: any[] } = { current: [] };
vi.mock('@/sync/store/hooks', () => ({
    useAllSessions: () => allSessionsState.current,
    useLocalSetting: () => 1,
}));

const teleportSpy = vi.fn(async (_args: any) => ({ ok: true }));
vi.mock('@/voice/agent/teleportVoiceAgentToSessionRoot', () => ({
    teleportVoiceAgentToSessionRoot: (args: any) => teleportSpy(args),
}));

const ensureVoiceBindingSpy = vi.fn(async (_params: any): Promise<VoiceSessionBinding | null> => null);
vi.mock('@/voice/binding/voiceConversationBindingRuntime', () => ({
    voiceSessionBindingManager: {
        ensureBound: (params: any) => ensureVoiceBindingSpy(params),
    },
}));

describe('VoiceSurface', () => {
  beforeEach(() => {
    pathnameState.current = '/';
    storageState.current = { sessions: {}, concurrentSessionListCacheByServerId: {} };
  });

  it('disables daemon local voice start when voice.agent is unavailable on the active server', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = false;
    pathnameState.current = '/';
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      adapters: {
        local_conversation: {
          conversationMode: 'agent',
          agent: { backend: 'daemon' },
        },
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const startButton = screen.findByProps({ accessibilityLabel: 'voiceAssistant.label' });
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findByProps({ accessibilityLabel: 'voiceAssistant.tapToEnd' }).props.disabled).toBe(false);
  });

  it('routes the stop control through voiceSessionManager.stop using the active voice session id', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      adapters: {
        local_conversation: { conversationMode: 'agent' },
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

    const { voiceSessionManager } = await import('@/voice/session/voiceSession');
    const stopSpy = vi.spyOn(voiceSessionManager, 'stop').mockResolvedValue(undefined as any);

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    await pressTestInstanceAsync(
      screen.findByProps({ accessibilityLabel: 'voiceAssistant.tapToEnd' }),
      'voiceAssistant.tapToEnd',
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

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

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    await pressTestInstanceAsync(screen.findByProps({ accessibilityLabel: 'common.open' }), 'common.open');

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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findAllByProps({ accessibilityLabel: 'common.open' })).toHaveLength(0);

    await act(async () => {
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

    expect(screen.findAllByProps({ accessibilityLabel: 'common.open' }).length).toBeGreaterThan(0);
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findAllByProps({ accessibilityLabel: 'common.open' })).toHaveLength(0);

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

    expect(screen.findAllByProps({ accessibilityLabel: 'common.open' }).length).toBeGreaterThan(0);
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findAllByProps({ accessibilityLabel: 'common.open' })).toHaveLength(0);

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

    expect(screen.findAllByProps({ accessibilityLabel: 'common.open' }).length).toBeGreaterThan(0);
    const texts = screen.findAllByType('Text' as any).map((n) => String(n.props.children ?? ''));
    expect(texts).toContain('2');
  });

  it('keeps the sidebar hidden conversation affordance when the current provider no longer matches the persisted binding adapter', async () => {
    vi.resetModules();
    await registerMockedStorageStateBridge();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: true, scopeDefault: 'global', surfaceLocation: 'auto' },
      adapters: {
        local_conversation: {
          conversationMode: 'agent',
        },
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

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

    expect(screen.findAllByProps({ accessibilityLabel: 'common.open' }).length).toBeGreaterThan(0);
    const texts = screen.findAllByType('Text' as any).map((n) => String(n.props.children ?? ''));
    expect(texts).toContain('2');
  });

  it('shows a human-readable target label instead of a raw target session id in the sidebar', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
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
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.getTextContent()).toContain('Ready and waiting');
    expect(screen.getTextContent()).not.toContain('s_target');
  });

  it('shows the visible lookup target label instead of stale raw session metadata in the sidebar', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
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
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.getTextContent()).toContain('Lookup target session summary');
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const openConversation = screen.findByProps({ accessibilityLabel: 'common.open' });
    const icon = screen.root
      .findAllByType('Ionicons' as any)
      .find((node: any) => node.props?.name === 'chatbubble-ellipses-outline');

    expect(openConversation).toBeTruthy();
    expect(icon).toBeTruthy();

    await pressTestInstanceAsync(openConversation, 'common.open');

    expect(ensureVoiceBindingSpy).not.toHaveBeenCalled();
    expect(routerPushSpy).toHaveBeenCalledWith('/session/persisted-voice-session');
  });

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
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'session', surfaceLocation: 'session' },
      adapters: {
        realtime_elevenlabs: {},
      },
    };
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's2' }));

    await pressTestInstanceAsync(screen.findByProps({ accessibilityLabel: 'common.open' }), 'common.open');

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
      adapters: {
        local_conversation: { conversationMode: 'agent', agent: { backend: 'daemon', teleportEnabled: true } },
      },
    };
    allSessionsState.current = [
      {
        id: 'voice-carrier',
        updatedAt: 1,
        metadata: {
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          path: '/Users/leeroy/.happier/voice-agent',
        },
      },
    ];

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: 'voice-carrier',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'session', sessionId: 'voice-carrier' }));

    expect(screen.tree.toJSON()).toBeNull();
  });

  it('does not render the session voice surface inside a retired hidden voice conversation session', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'session' },
      adapters: {
        local_conversation: { conversationMode: 'agent', agent: { backend: 'daemon', teleportEnabled: true } },
      },
    };
    allSessionsState.current = [
      {
        id: 'voice-carrier-retired',
        updatedAt: 1,
        metadata: {
          systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
          path: '/Users/leeroy/.happier/voice-agent',
        },
      },
    ];

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: 'voice-carrier-retired',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'session', sessionId: 'voice-carrier-retired' }));

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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findAllByProps({ accessibilityLabel: 'common.open' })).toHaveLength(0);
    expect(ensureVoiceBindingSpy).not.toHaveBeenCalled();
    expect(routerPushSpy).not.toHaveBeenCalled();
  });

  it('shows a slashed mic and allows barge-in when speaking (local voice)', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    localVoiceToggleTurnSpy.mockClear();
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      adapters: {
        local_conversation: { conversationMode: 'agent', tts: { bargeInEnabled: true } },
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const bargeIn = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.bargeIn' });
    expect(bargeIn).toBeTruthy();
    expect(typeof bargeIn.props.onPress).toBe('function');

    const micIcon = screen.root
      .findAllByType('Ionicons' as any)
      .find((n: any) => n.props?.name === 'mic-off-outline');
    expect(micIcon).toBeTruthy();

    await pressTestInstanceAsync(bargeIn, 'voiceSurface.a11y.bargeIn');
    expect(localVoiceToggleTurnSpy).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
  });

  it('renders a cancel-turn control while thinking and calls voiceSessionManager.interrupt', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      adapters: {
        local_conversation: { conversationMode: 'agent' },
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const cancelTurn = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.cancelTurn' });
    expect(cancelTurn).toBeTruthy();

    await pressTestInstanceAsync(cancelTurn, 'voiceSurface.a11y.cancelTurn');

    expect(interruptSpy).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
    interruptSpy.mockRestore();
  });

  it('renders a mute control for an active voice session and routes it through voiceSessionManager.setMuted', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      adapters: {
        local_conversation: { conversationMode: 'agent' },
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

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
      adapters: {
        local_conversation: { conversationMode: 'agent' },
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const unmute = screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.unmute' });
    expect(unmute).toBeTruthy();

    await pressTestInstanceAsync(unmute, 'voiceSurface.a11y.unmute');

    expect(setMutedSpy).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID, false);
    setMutedSpy.mockRestore();
  });

  it('starts local voice agent from sidebar using the focused session when one is available', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    pathnameState.current = '/session/s1';
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      adapters: {
        local_conversation: { conversationMode: 'agent' },
      },
    };

    useVoiceTargetStore.setState({ scope: 'global', lastFocusedSessionId: 'stale-session', primaryActionSessionId: null, trackedSessionIds: [] } as any);

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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const pressable = screen.findByProps({ accessibilityLabel: 'voiceAssistant.label' });

    await pressTestInstanceAsync(pressable, 'voiceAssistant.label');

    expect(toggleSpy).toHaveBeenCalledWith('s1');
    expect(toggleSpy).not.toHaveBeenCalledWith('');
    toggleSpy.mockRestore();
  });

  it('starts local voice agent from sidebar using voice home when no session is focused', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    pathnameState.current = '/';
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      adapters: {
        local_conversation: { conversationMode: 'agent' },
      },
    };

    useVoiceTargetStore.setState({ scope: 'global', lastFocusedSessionId: null, primaryActionSessionId: null, trackedSessionIds: [] } as any);

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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    const pressable = screen.findByProps({ accessibilityLabel: 'voiceAssistant.label' });

    await pressTestInstanceAsync(pressable, 'voiceAssistant.label');

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
      adapters: {
        local_conversation: { conversationMode: 'agent' },
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    await pressTestInstanceAsync(screen.findByProps({ accessibilityLabel: 'common.open' }), 'common.open');

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
      adapters: {
        local_conversation: { conversationMode: 'agent' },
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findByProps({ accessibilityLabel: 'voiceAssistant.tapToEnd' }).props.disabled).toBe(false);
  });

  it('renders a teleport button for local voice agent sessions when enabled', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    teleportSpy.mockClear();
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'session', surfaceLocation: 'session' },
      adapters: {
        local_conversation: {
          conversationMode: 'agent',
          agent: { backend: 'daemon', stayInVoiceHome: false, teleportEnabled: true },
        },
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));

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
    useVoiceTargetStore.setState({ scope: 'global' } as any);

    let updates = 0;
    const unsub = useVoiceTargetStore.subscribe(() => {
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

      const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));

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

    const sidebar = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    expect(sidebar.tree.toJSON()).not.toBeNull();

    const session = await renderScreen(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));
    expect(session.tree.toJSON()).toBeNull();
  });

  it('does not render the session voice surface when auto placement prefers the sidebar even if teleport is available from an existing global voice-agent conversation', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    teleportSpy.mockClear();
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
      adapters: {
        local_conversation: {
          conversationMode: 'agent',
          agent: { backend: 'daemon', stayInVoiceHome: false, teleportEnabled: true },
        },
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));

    expect(screen.tree.toJSON()).toBeNull();
  });

  it('allows global-start providers to start from the sidebar even when no session is focused', async () => {
    vi.resetModules();
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };
    useVoiceTargetStore.getState().setLastFocusedSessionId(null);

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findByProps({ accessibilityLabel: 'voiceAssistant.label' }).props.disabled).toBe(false);
  });

  it('keeps the sidebar surface recoverable after a realtime disconnect by exposing stable status and toggle selectors', async () => {
    vi.resetModules();
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };

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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findByProps({ testID: 'voice-surface-status:sidebar:disconnected' })).toBeTruthy();
    expect(screen.findByProps({ testID: 'voice-surface-toggle:sidebar' }).props.disabled).toBe(false);
    expect(screen.getTextContent()).toContain('settingsVoice.local.machineErrors.transport_disconnect');
  });

  it('requires a focused session to start session-scoped providers from the sidebar', async () => {
    vi.resetModules();
    voiceSettingState.current = {
      providerId: 'local_direct',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };
    useVoiceTargetStore.getState().setLastFocusedSessionId(null);

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_direct',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    expect(screen.findByProps({ accessibilityLabel: 'voiceAssistant.label' }).props.disabled).toBe(true);
  });

  it('shows the sidebar transcript count from the bound hidden conversation session', async () => {
    vi.resetModules();
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: true, scopeDefault: 'global', surfaceLocation: 'auto' },
    };

    storageState.current = {
      sessions: {},
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

    // Ensure count is not hard-coded to 0 for sidebar feed.
    const texts = screen.findAllByType('Text' as any).map((n) => String(n.props.children ?? ''));
    expect(texts).toContain('2');
  });

  it('orders sidebar transcript entries by createdAt and shows note entries from the same projection path', async () => {
    vi.resetModules();
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: true, scopeDefault: 'global', surfaceLocation: 'auto' },
    };

    storageState.current = {
      sessions: {},
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

    const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));

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
});
