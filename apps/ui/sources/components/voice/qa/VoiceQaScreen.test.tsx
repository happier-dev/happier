import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { resetVoiceQaStoreForTests, useVoiceQaStore } from '@/voice/qa/voiceQaStore';
import { useVoiceActivityStore } from '@/voice/activity/voiceActivityStore';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { voiceSessionBindingStore } from '@/voice/sessionBinding/voiceSessionBindingStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const voiceQaControllerMocks = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  clear: vi.fn(() => {}),
  sendPrompt: vi.fn(async () => {}),
  sendContextUpdate: vi.fn(async () => {}),
};

vi.mock('react-native', async () => {
  const actual = await vi.importActual<any>('react-native');
  return {
    ...actual,
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    Platform: { OS: 'web', select: (spec: any) => spec?.web ?? spec?.default },
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
  useUnistyles: () => ({
    theme: {
      colors: {
        text: '#000',
        textSecondary: '#666',
        surface: '#fff',
        surfaceHigh: '#f5f5f5',
        divider: '#ddd',
        groupped: { background: '#fafafa' },
        input: { placeholder: '#999' },
        button: { primary: { background: '#000', tint: '#fff' } },
      },
    },
  }),
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/sync/store/hooks', () => ({
  useLocalSetting: () => 1,
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
  RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
  ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));

vi.mock('@/voice/qa/voiceQaController', () => ({
  voiceQaController: voiceQaControllerMocks,
}));

describe('VoiceQaScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVoiceQaStoreForTests();
    useVoiceActivityStore.setState({ eventsBySessionId: {}, maxEventsPerSession: 200 });
    useVoiceTargetStore.getState().setPrimaryActionSessionId(null);
    useVoiceTargetStore.getState().setLastFocusedSessionId(null);
    voiceSessionBindingStore.setState({
      ...voiceSessionBindingStore.getState(),
      bindingsByConversationSessionId: {},
    });
    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
    storage.setState({
      settings: {
        ...(storage.getState() as any).settings,
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      },
    } as any);
  });

  it('renders without re-render loops when there is no active QA session yet', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<VoiceQaScreen />);
    });

    const texts = tree.root.findAll((node) => String(node.type) === 'Text').map((node: any) => String(node.props.children));
    expect(texts).toContain('devVoiceQa.title');
    expect(useVoiceQaStore.getState().status).toBe('idle');
  });

  it('reacts to voice session binding updates and shows the open-conversation button', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
      tree = renderer.create(<VoiceQaScreen />);
      await Promise.resolve();
    });

    expect(tree.root.findAll((node) => String(node.props?.testID) === 'voiceQa.openConversation')).toHaveLength(0);

    await act(async () => {
      voiceSessionBindingStore.getState().bind({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice_session_1',
        targetSessionId: null,
        transcriptMode: 'synthetic',
        updatedAt: Date.now(),
      });
      await Promise.resolve();
    });

    const openConversationNodes = tree.root.findAll((node) => String(node.props?.testID) === 'voiceQa.openConversation');
    expect(openConversationNodes.length).toBeGreaterThan(0);
  });

  it('shows the bound target session and hidden conversation session for local voice QA', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
      voiceSessionBindingStore.getState().bind({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice_session_1',
        targetSessionId: 'target_s1',
        transcriptMode: 'native_session',
        updatedAt: Date.now(),
      });
      tree = renderer.create(<VoiceQaScreen />);
      await Promise.resolve();
    });

    const items = tree.root.findAll((node) => String(node.type) === 'Item');
    const targetItem = items.find((node: any) => node.props.title === 'devVoiceQa.targetSession');
    const runtimeItem = items.find((node: any) => node.props.title === 'devVoiceQa.runtimeSession');

    expect(targetItem?.props.detail).toBe('Selected session');
    expect(runtimeItem?.props.detail).toBe('Voice conversation');
  });

  it('falls back to generic human labels when session metadata only contains raw ids', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      storage.setState({
        ...(storage.getState() as any),
        sessions: {
          ...((storage.getState() as any).sessions ?? {}),
          target_s1: {
            id: 'target_s1',
            metadata: {
              name: 'target_s1',
            },
          },
          voice_session_1: {
            id: 'voice_session_1',
            metadata: {
              name: 'voice_session_1',
            },
          },
        },
      } as any);
      useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
      voiceSessionBindingStore.getState().bind({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice_session_1',
        targetSessionId: 'target_s1',
        transcriptMode: 'native_session',
        updatedAt: Date.now(),
      });
      tree = renderer.create(<VoiceQaScreen />);
      await Promise.resolve();
    });

    const items = tree.root.findAll((node) => String(node.type) === 'Item');
    const targetItem = items.find((node: any) => node.props.title === 'devVoiceQa.targetSession');
    const runtimeItem = items.find((node: any) => node.props.title === 'devVoiceQa.runtimeSession');

    expect(targetItem?.props.detail).toBe('Selected session');
    expect(runtimeItem?.props.detail).toBe('Voice conversation');
  });

  it('prefers the active QA target and runtime session details over drifting global bindings', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      useVoiceQaStore.setState((state: any) => ({
        ...state,
        provider: 'local_voice_agent',
        sessionId: '__voice_agent__',
        status: 'running',
        targetSessionId: 'target_s1',
        runtimeSessionId: 'voice_session_1',
      }));
      useVoiceTargetStore.getState().setPrimaryActionSessionId('voice_session_2');
      voiceSessionBindingStore.getState().bind({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice_session_2',
        targetSessionId: 'voice_session_2',
        transcriptMode: 'native_session',
        updatedAt: Date.now(),
      });
      setVoiceSessionSnapshot({
        adapterId: 'local_conversation',
        sessionId: 'voice_session_2',
        status: 'connected',
        mode: 'thinking',
        canStop: true,
      });
      tree = renderer.create(<VoiceQaScreen />);
      await Promise.resolve();
    });

    const items = tree.root.findAll((node) => String(node.type) === 'Item');
    const targetItem = items.find((node: any) => node.props.title === 'devVoiceQa.targetSession');
    const runtimeItem = items.find((node: any) => node.props.title === 'devVoiceQa.runtimeSession');

    expect(targetItem?.props.detail).toBe('Selected session');
    expect(runtimeItem?.props.detail).toBe('Voice conversation');
  });

  it('uses the translated voice-agent label for the global sentinel', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      useVoiceQaStore.setState((state: any) => ({
        ...state,
        provider: 'local_voice_agent',
        sessionId: '__voice_agent__',
        targetSessionId: '__voice_agent__',
        status: 'running',
      }));
      tree = renderer.create(<VoiceQaScreen />);
      await Promise.resolve();
    });

    const items = tree.root.findAll((node) => String(node.type) === 'Item');
    const targetItem = items.find((node: any) => node.props.title === 'devVoiceQa.targetSession');

    expect(targetItem?.props.detail).toBe('voiceActivity.format.voiceAgent');
  });

  it('replaces the global voice sentinel with the active target session label', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      storage.setState({
        sessions: {
          ...((storage.getState() as any).sessions ?? {}),
          s_current: {
            id: 's_current',
            metadata: {
              summaryText: 'Session QA Voice Matrix',
            },
          },
          hidden_voice_conversation: {
            id: 'hidden_voice_conversation',
            metadata: {
              name: 'voice-agent',
            },
          },
        },
      } as any);
      useVoiceQaStore.setState((state: any) => ({
        ...state,
        provider: 'local_voice_agent',
        sessionId: '__voice_agent__',
        targetSessionId: '__voice_agent__',
        runtimeSessionId: 'hidden_voice_conversation',
        status: 'running',
      }));
      useVoiceTargetStore.getState().setPrimaryActionSessionId('s_current');
      tree = renderer.create(<VoiceQaScreen />);
      await Promise.resolve();
    });

    const items = tree.root.findAll((node) => String(node.type) === 'Item');
    const targetItem = items.find((node: any) => node.props.title === 'devVoiceQa.targetSession');
    const runtimeItem = items.find((node: any) => node.props.title === 'devVoiceQa.runtimeSession');

    expect(targetItem?.props.detail).toBe('Session QA Voice Matrix');
    expect(runtimeItem?.props.detail).toBe('voice-agent');
  });

  it('uses the latest session id when start is pressed before the button rerenders', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<VoiceQaScreen />);
    });

    const sessionInput = tree.root.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const startButton = tree.root.find((node) => String(node.props?.testID) === 'voiceQa.start');

    await act(async () => {
      sessionInput.props.onChangeText('session_latest');
      await startButton.props.onPress();
    });

    expect(voiceQaControllerMocks.start).toHaveBeenCalledWith({
      sessionId: 'session_latest',
      initialContext: '',
    });
  });

  it('uses the latest prompt when send is pressed before the button rerenders', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<VoiceQaScreen />);
    });

    const sessionInput = tree.root.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const promptInput = tree.root.find((node) => String(node.props?.testID) === 'voiceQa.promptInput');
    const sendButton = tree.root.find((node) => String(node.props?.testID) === 'voiceQa.send');

    await act(async () => {
      sessionInput.props.onChangeText('session_send');
      promptInput.props.onChangeText('prompt_latest');
      await sendButton.props.onPress();
    });

    expect(voiceQaControllerMocks.sendPrompt).toHaveBeenCalledWith({
      sessionId: 'session_send',
      prompt: 'prompt_latest',
    });
  });

});
