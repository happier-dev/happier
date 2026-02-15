import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

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

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

const hydrateSpy = vi.fn(async () => {});
vi.mock('@/voice/persistence/hydrateVoiceAgentActivityFromCarrierSession', () => ({
  hydrateVoiceAgentActivityFromCarrierSession: () => hydrateSpy(),
}));

const voiceSettingState: { current: any } = {
  current: { providerId: 'realtime_elevenlabs', ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' } },
};

vi.mock('@/sync/domains/state/storage', () => ({
  useSetting: () => voiceSettingState.current,
}));

const allSessionsState: { current: any[] } = { current: [] };
vi.mock('@/sync/store/hooks', () => ({
  useAllSessions: () => allSessionsState.current,
}));

describe('VoiceSurface', () => {
  it('hydrates the global agent activity feed from the carrier transcript when persistence is enabled', async () => {
    vi.resetModules();
    hydrateSpy.mockClear();
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

  it('does not dispatch redundant voice target scope updates when already aligned', async () => {
    vi.resetModules();
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

    const pressables = tree.root.findAllByType('Pressable' as any);
    expect(pressables.length).toBe(1);
    expect(pressables[0].props.disabled).toBe(false);
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

    const pressables = tree.root.findAllByType('Pressable' as any);
    expect(pressables.length).toBe(1);
    expect(pressables[0].props.disabled).toBe(true);
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

    const clear = tree.root.findByProps({ accessibilityLabel: 'clear_voice_activity' });
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

    const toggle = tree.root.findByProps({ accessibilityLabel: 'toggle_voice_activity' });
    await act(async () => {
      toggle.props.onPress();
    });

    const eventTexts = tree.root
      .findAllByType('Text' as any)
      .filter((n) => n.props.numberOfLines === 3)
      .map((n) => String(n.props.children ?? ''));

    expect(eventTexts[0]).toContain('[Voice agent]');
    expect(eventTexts[0]).toContain('Error:');
    expect(eventTexts[0]).not.toContain(VOICE_AGENT_GLOBAL_SESSION_ID);
    expect(eventTexts[1]).toContain('new');
    expect(eventTexts[2]).toContain('old');
    expect(eventTexts[3]).toContain('older');
  });
});
