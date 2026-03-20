import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import type { VoiceSessionBinding } from '@/voice/sessionBinding/voiceSessionBindingTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const actual = await vi.importActual<any>('react-native');
  return {
    ...actual,
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Platform: { OS: 'web', select: (spec: any) => spec?.web ?? spec?.default },
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
  useUnistyles: () => ({
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
  }),
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
  StatusDot: (props: any) => React.createElement('StatusDot', props),
}));

vi.mock('@/components/ui/status/VoiceBars', () => ({
  VoiceBars: (props: any) => React.createElement('VoiceBars', props),
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

const toggleLocalVoiceTurnSpy = vi.fn(async (_sessionId: string) => {});
vi.mock('@/voice/local/localVoiceEngine', () => ({
  toggleLocalVoiceTurn: (sessionId: string) => toggleLocalVoiceTurnSpy(sessionId),
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

const routerPushSpy = vi.fn();
const pathnameState: { current: string } = { current: '/' };
vi.mock('expo-router', () => ({
  useRouter: () => ({
    push: (...args: any[]) => routerPushSpy(...args),
    navigate: (...args: any[]) => routerPushSpy(...args),
  }),
  usePathname: () => pathnameState.current,
}));

const hydrateSpy = vi.fn(async () => {});
const featureEnabledState: Record<string, boolean> = { 'voice.agent': true };
vi.mock('@/voice/persistence/hydrateVoiceAgentActivityFromCarrierSession', () => ({
  hydrateVoiceAgentActivityFromCarrierSession: () => hydrateSpy(),
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] ?? true,
}));

const voiceSettingState: { current: any } = {
  current: { providerId: 'realtime_elevenlabs', ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' } },
};
const storageState: { current: any } = { current: { sessions: {}, sessionListViewDataByServerId: {} } };

vi.mock('@/sync/domains/state/storage', () => ({
  useSetting: () => voiceSettingState.current,
  storage: {
    getState: () => storageState.current,
  },
}));

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
vi.mock('@/voice/sessionBinding/voiceSessionBindingRuntime', () => ({
  voiceSessionBindingManager: {
    ensureBound: (params: any) => ensureVoiceBindingSpy(params),
  },
}));

describe('VoiceSurface', () => {
  beforeEach(() => {
    pathnameState.current = '/';
    storageState.current = { sessions: {}, sessionListViewDataByServerId: {} };
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    const startButton = tree.root
      .findAllByType('Pressable' as any)
      .find((n: any) => n.props?.accessibilityLabel === 'voiceAssistant.label');
    expect(startButton).toBeTruthy();
    expect(startButton!.props.disabled).toBe(true);

    const texts = tree.root.findAllByType('Text' as any).map((node: any) => String(node.props.children));
    expect(texts).toContain('settingsVoice.local.conversation.resumability.disabledVoiceAgent');
  });

  it('hydrates the global agent activity feed from the carrier transcript when persistence is enabled', async () => {
    vi.resetModules();
    hydrateSpy.mockClear();
    featureEnabledState['voice.agent'] = true;
    pathnameState.current = '/';
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: true, scopeDefault: 'global', surfaceLocation: 'auto' },
      adapters: {
        local_conversation: {
          conversationMode: 'agent',
          agent: { transcript: { persistenceMode: 'persistent', epoch: 7 } },
        },
      },
    };

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    expect(hydrateSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    // Expect at least one Pressable (start/stop)
    expect(tree.root.findAllByType('Pressable' as any).length).toBeGreaterThan(0);
  });

  it('opens the hidden voice conversation session from the header icon when a binding exists', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    routerPushSpy.mockReset();
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };

    const { voiceSessionBindingStore } = await import('@/voice/sessionBinding/voiceSessionBindingStore');
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    const openConversation = tree.root.findByProps({ accessibilityLabel: 'common.open' });
    await act(async () => {
      openConversation.props.onPress?.();
    });

    expect(routerPushSpy).toHaveBeenCalledWith('/session/carrier-s1');
  });

  it('shows the hidden voice conversation icon when the binding appears after the surface renders', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    };

    const { voiceSessionBindingStore } = await import('@/voice/sessionBinding/voiceSessionBindingStore');
    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    expect(tree.root.findAllByProps({ accessibilityLabel: 'common.open' })).toHaveLength(0);

    await act(async () => {
      voiceSessionBindingStore.getState().bind({
        adapterId: 'realtime_elevenlabs',
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        conversationSessionId: 'carrier-s2',
        transcriptMode: 'synthetic',
        targetSessionId: 's2',
        updatedAt: 2,
      });
    });

    expect(tree.root.findAllByProps({ accessibilityLabel: 'common.open' })).toHaveLength(1);
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
      sessionListViewDataByServerId: {},
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    const renderedTree = JSON.stringify(tree.toJSON());
    expect(renderedTree).toContain('Ready and waiting');
    expect(renderedTree).not.toContain('s_target');
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    const openConversation = tree.root.findByProps({ accessibilityLabel: 'common.open' });
    const icon = tree.root
      .findAllByType('Ionicons' as any)
      .find((node: any) => node.props?.name === 'chatbubble-ellipses-outline');

    expect(openConversation).toBeTruthy();
    expect(icon).toBeTruthy();

    await act(async () => {
      openConversation.props.onPress?.();
    });

    expect(ensureVoiceBindingSpy).not.toHaveBeenCalled();
    expect(routerPushSpy).toHaveBeenCalledWith('/session/persisted-voice-session');
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'session', sessionId: 'voice-carrier' }));
    });

    expect(tree.toJSON()).toBeNull();
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'session', sessionId: 'voice-carrier-retired' }));
    });

    expect(tree.toJSON()).toBeNull();
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    expect(tree.root.findAllByProps({ accessibilityLabel: 'common.open' })).toHaveLength(0);
    expect(ensureVoiceBindingSpy).not.toHaveBeenCalled();
    expect(routerPushSpy).not.toHaveBeenCalled();
  });

  it('shows a slashed mic and allows barge-in when speaking (local voice)', async () => {
    vi.resetModules();
    featureEnabledState['voice.agent'] = true;
    toggleLocalVoiceTurnSpy.mockClear();
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    const bargeIn = tree.root.findByProps({ accessibilityLabel: 'voiceSurface.a11y.bargeIn' });
    expect(bargeIn).toBeTruthy();
    expect(typeof bargeIn.props.onPress).toBe('function');

    const micIcon = tree.root
      .findAllByType('Ionicons' as any)
      .find((n: any) => n.props?.name === 'mic-off-outline');
    expect(micIcon).toBeTruthy();

    await act(async () => {
      bargeIn.props.onPress?.();
    });
    expect(toggleLocalVoiceTurnSpy).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    const cancelTurn = tree.root.findByProps({ accessibilityLabel: 'voiceSurface.a11y.cancelTurn' });
    expect(cancelTurn).toBeTruthy();

    await act(async () => {
      cancelTurn.props.onPress?.();
    });

    expect(interruptSpy).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
    interruptSpy.mockRestore();
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    const pressable = tree.root
      .findAllByType('Pressable' as any)
      .find((n: any) => n.props?.accessibilityLabel === 'voiceAssistant.label' && typeof n.props?.onPress === 'function');
    expect(pressable).toBeTruthy();

    await act(async () => {
      pressable!.props.onPress?.();
    });

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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    const pressable = tree.root
      .findAllByType('Pressable' as any)
      .find((n: any) => n.props?.accessibilityLabel === 'voiceAssistant.label' && typeof n.props?.onPress === 'function');
    expect(pressable).toBeTruthy();

    await act(async () => {
      pressable!.props.onPress?.();
    });

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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    const openConversation = tree.root.findByProps({ accessibilityLabel: 'common.open' });
    await act(async () => {
      openConversation.props.onPress?.();
    });

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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    const stopButton = tree.root
      .findAllByType('Pressable' as any)
      .find((n: any) => n.props?.accessibilityLabel === 'voiceAssistant.tapToEnd' && typeof n.props?.onPress === 'function');
    expect(stopButton).toBeTruthy();
    expect(stopButton!.props.disabled).toBe(false);
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));
    });

    const teleport = tree.root.findByProps({ accessibilityLabel: 'voiceSurface.a11y.teleport' });
    expect(teleport).toBeTruthy();

    await act(async () => {
      teleport.props.onPress();
    });

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

      let tree!: renderer.ReactTestRenderer;
      await act(async () => {
        tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
      });

      expect(updates).toBe(0);

      await act(async () => {
        tree.unmount();
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));
    });

    await act(async () => {
      voiceSettingState.current = { providerId: 'off', ui: { activityFeedEnabled: false, scopeDefault: 'session', surfaceLocation: 'session' } };
      tree.update(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));
    });

    expect(tree.toJSON()).toBeNull();
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

    let sidebar!: renderer.ReactTestRenderer;
    await act(async () => {
      sidebar = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });
    expect(sidebar.toJSON()).not.toBeNull();

    let session!: renderer.ReactTestRenderer;
    await act(async () => {
      session = renderer.create(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));
    });
    expect(session.toJSON()).toBeNull();
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

    const { voiceSessionBindingStore } = await import('@/voice/sessionBinding/voiceSessionBindingStore');
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'session', sessionId: 's1' }));
    });

    expect(tree.toJSON()).toBeNull();
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    const toggleButton = tree.root
      .findAllByType('Pressable' as any)
      .find((node: any) => node.props?.accessibilityLabel === 'voiceAssistant.label');
    expect(toggleButton).toBeTruthy();
    expect(toggleButton?.props.disabled).toBe(false);
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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    const toggleButton = tree.root
      .findAllByType('Pressable' as any)
      .find((node: any) => node.props?.accessibilityLabel === 'voiceAssistant.label');
    expect(toggleButton).toBeTruthy();
    expect(toggleButton?.props.disabled).toBe(true);
  });

  it('shows correct sidebar activity count and allows clearing when events exist', async () => {
    vi.resetModules();
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: true, scopeDefault: 'global', surfaceLocation: 'auto' },
    };

    const { useVoiceActivityStore } = await import('@/voice/activity/voiceActivityStore');
    useVoiceActivityStore.setState((s) => ({
      ...s,
      eventsBySessionId: {
        s1: [
          { id: 'e1', ts: 1, sessionId: 's1', adapterId: 'realtime_elevenlabs', kind: 'status', status: 'connected', mode: 'idle' },
        ],
        s2: [
          { id: 'e2', ts: 2, sessionId: 's2', adapterId: 'realtime_elevenlabs', kind: 'user.text', text: 'hi' },
        ],
      },
    }));

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: null,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    // Ensure count is not hard-coded to 0 for sidebar feed.
    const texts = tree.root.findAllByType('Text' as any).map((n) => String(n.props.children ?? ''));
    expect(texts).toContain('2');

    const clear = tree.root.findByProps({ accessibilityLabel: 'voiceSurface.a11y.clearActivity' });
    expect(clear.props.disabled).toBe(false);

    await act(async () => {
      clear.props.onPress();
    });

    const state = useVoiceActivityStore.getState();
    expect(state.eventsBySessionId.s1).toEqual([]);
    expect(state.eventsBySessionId.s2).toEqual([]);
  });

  it('orders sidebar activity events by ts and formats agent label', async () => {
    vi.resetModules();
    voiceSettingState.current = {
      providerId: 'realtime_elevenlabs',
      ui: { activityFeedEnabled: true, scopeDefault: 'global', surfaceLocation: 'auto' },
    };

    const { useVoiceActivityStore } = await import('@/voice/activity/voiceActivityStore');
    useVoiceActivityStore.setState({
      eventsBySessionId: {
        s1: [{ id: 'a', ts: 20, sessionId: 's1', adapterId: 'realtime_elevenlabs', kind: 'assistant.text', text: 'old' }],
        [VOICE_AGENT_GLOBAL_SESSION_ID]: [
          { id: 'b', ts: 30, sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, adapterId: 'realtime_elevenlabs', kind: 'assistant.text', text: 'new' },
          {
            id: 'b2',
            ts: 40,
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            adapterId: 'realtime_elevenlabs',
            kind: 'error',
            errorMessage: `Session encryption not found for ${VOICE_AGENT_GLOBAL_SESSION_ID}`,
          },
        ],
        s2: [{ id: 'c', ts: 10, sessionId: 's2', adapterId: 'realtime_elevenlabs', kind: 'assistant.text', text: 'older' }],
      },
    } as any);

    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: 'realtime_elevenlabs',
      sessionId: null,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { VoiceSurface } = await import('./VoiceSurface');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(VoiceSurface, { variant: 'sidebar' }));
    });

    const toggle = tree.root.findByProps({ accessibilityLabel: 'voiceSurface.a11y.toggleActivity' });
    await act(async () => {
      toggle.props.onPress();
    });

    const eventTexts = tree.root
      .findAllByType('Text' as any)
      .filter((n) => n.props.numberOfLines === 3)
      .map((n) => String(n.props.children ?? ''));

    expect(eventTexts[0]).toContain('[voiceActivity.format.voiceAgent]');
    expect(eventTexts[0]).toContain('voiceActivity.format.error');
    expect(eventTexts[0]).not.toContain(VOICE_AGENT_GLOBAL_SESSION_ID);
    expect(eventTexts[1]).toContain('new');
    expect(eventTexts[2]).toContain('old');
    expect(eventTexts[3]).toContain('older');
  });
});
