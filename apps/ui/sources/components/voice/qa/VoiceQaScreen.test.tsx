import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { resetVoiceQaStoreForTests, useVoiceQaStore } from '@/voice/qa/voiceQaStore';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { flushHookEffects, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installVoiceQaCommonModuleMocks } from './voiceQaScreenTestHelpers';

const voiceQaControllerMocks = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  clear: vi.fn(() => {}),
  sendPrompt: vi.fn(async () => {}),
  sendContextUpdate: vi.fn(async () => {}),
};
const recordedAudioTranscriptionControllerMocks = {
  transcribe: vi.fn<(
    params: Readonly<{
      sessionId?: string | null;
      uri: string;
      settings: unknown;
      decryptSecretValue?: (value: unknown) => string | null;
    }>,
  ) => Promise<string | null>>(async () => null),
};
const daemonRecordedAudioFallbackMocks = {
  transcribeRecordedAudio: vi.fn<(
    params: Readonly<{
      sessionId?: string | null;
      source: unknown;
      inputMimeType: string;
      packId: string | null;
      language: string | null;
      normalization?: unknown;
    }>,
  ) => Promise<Readonly<{ text: string; language: string | null; modelPackId: string | null }>>>(async () => ({
    text: 'hello explicit daemon stt',
    language: 'en',
    modelPackId: 'daemon-pack',
  })),
};
const daemonVoiceInferenceClientConstructorMock = vi.fn<(deps?: Record<string, unknown>) => void>();

type PassthroughComponentProps = Readonly<Record<string, unknown> & { children?: React.ReactNode }>;

function createPassthroughComponentMock(typeName: string) {
    return (props: PassthroughComponentProps) => React.createElement(typeName, props, props.children);
}

const expoRouterMock = createExpoRouterMock();

installVoiceQaCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            TextInput: 'TextInput',
            ScrollView: 'ScrollView',
            Pressable: 'Pressable',
            Platform: {
                OS: 'web',
                select: (spec: any) => spec?.web ?? spec?.default,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
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
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: createPassthroughComponentMock('RoundButton'),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: createPassthroughComponentMock('Item'),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createPassthroughComponentMock('ItemGroup'),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: createPassthroughComponentMock('ItemList'),
}));

vi.mock('@/voice/qa/voiceQaController', () => ({
  voiceQaController: voiceQaControllerMocks,
}));
vi.mock('@/voice/runtime/input/recordedAudioTranscriptionController', () => ({
  recordedAudioTranscriptionController: recordedAudioTranscriptionControllerMocks,
}));
vi.mock('@/voice/input/prepareDaemonVoiceInferenceSttSource', () => ({
  prepareDaemonVoiceInferenceSttSource: vi.fn(async () => ({
    source: {
      kind: 'web',
      file: new File([new Uint8Array([1, 2, 3])], 'recording.wav', { type: 'audio/wav' }),
    },
    inputMimeType: 'audio/wav',
    normalization: {
      inputTransport: 'upload_transfer',
      strategy: 'ui_pretranscoded_pcm16_fallback',
      systemFfmpegAllowed: false,
    },
  })),
}));
vi.mock('@/voice/runtime/daemonInference/DaemonVoiceInferenceClient', () => ({
  DaemonVoiceInferenceClient: class {
    constructor(deps?: Record<string, unknown>) {
      daemonVoiceInferenceClientConstructorMock(deps);
    }
  },
}));
vi.mock('@/voice/runtime/daemonInference/DaemonSttController', () => ({
  DaemonSttController: class {
    async transcribeRecordedAudio(params: any) {
      return await daemonRecordedAudioFallbackMocks.transcribeRecordedAudio(params);
    }
  },
}));

vi.mock('expo-router', () => expoRouterMock.module);

describe('VoiceQaScreen', () => {
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;

  beforeEach(() => {
    vi.clearAllMocks();
    expoRouterMock.state.router.setParams({
      voiceQaSessionId: undefined,
      voiceQaRecordedAudioDaemonSttPackId: undefined,
      voiceQaRecordedAudioDaemonMachineId: undefined,
      voiceQaRecordedAudioDaemonBasePath: undefined,
    });
    recordedAudioTranscriptionControllerMocks.transcribe.mockResolvedValue(null);
    daemonRecordedAudioFallbackMocks.transcribeRecordedAudio.mockResolvedValue({
      text: 'hello explicit daemon stt',
      language: 'en',
      modelPackId: 'daemon-pack',
    });
    daemonVoiceInferenceClientConstructorMock.mockReset();
    resetVoiceQaStoreForTests();
    useVoiceTargetStore.getState().setPrimaryActionSessionId(null);
    useVoiceTargetStore.getState().setLastFocusedSessionId(null);
    voiceSessionBindingStore.setState({
      ...voiceSessionBindingStore.getState(),
      runtimeBindingsByConversationSessionId: {},
      persistedBindingsByConversationSessionId: {},
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
        sessionMessages: {},
    } as any);
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:voice-qa-recording');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    standardCleanup();
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('renders without re-render loops when there is no active QA session yet', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const texts = tree.findAll((node) => String(node.type) === 'Text').map((node: any) => String(node.props.children));
    expect(texts).toContain('devVoiceQa.title');
    expect(useVoiceQaStore.getState().status).toBe('idle');
  });

  it('reacts to voice session binding updates and shows the open-conversation button', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    expect(tree.findAll((node) => String(node.props?.testID) === 'voiceQa.openConversation')).toHaveLength(0);

    await act(async () => {
      voiceSessionBindingStore.getState().bind({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice_session_1',
        targetSessionId: null,
        transcriptMode: 'synthetic',
        updatedAt: Date.now(),
      });
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    const openConversationNodes = tree.findAll((node) => String(node.props?.testID) === 'voiceQa.openConversation');
    expect(openConversationNodes.length).toBeGreaterThan(0);
  });

  it('refreshes persisted voice binding metadata into the QA surface after render', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    expect(tree.findAll((node) => String(node.props?.testID) === 'voiceQa.openConversation')).toHaveLength(0);

    await act(async () => {
      storage.setState({
        ...(storage.getState() as any),
        sessions: {
          ...((storage.getState() as any).sessions ?? {}),
          target_s1: {
            id: 'target_s1',
            updatedAt: 5,
            metadata: {
              name: 'target_s1',
            },
          },
          voice_session_1: {
            id: 'voice_session_1',
            updatedAt: 10,
            metadata: {
              systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
              voiceConversationBindingV1: {
                v: 1,
                adapterId: 'local_conversation',
                controlSessionId: '__voice_agent__',
                transcriptMode: 'native_session',
                targetSessionId: 'target_s1',
                updatedAt: 100,
              },
            },
          },
        },
      } as any);
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    const openConversationNodes = tree.findAll((node) => String(node.props?.testID) === 'voiceQa.openConversation');
    expect(openConversationNodes.length).toBeGreaterThan(0);

    const items = tree.findAll((node) => String(node.type) === 'Item');
    const runtimeItem = items.find((node: any) => node.props.title === 'devVoiceQa.runtimeSession');
    expect(runtimeItem?.props.detail).toBe('Voice conversation');
  });

  it('shows the bound target session and hidden conversation session for local voice QA', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
    voiceSessionBindingStore.getState().bind({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice_session_1',
        targetSessionId: 'target_s1',
        transcriptMode: 'native_session',
        updatedAt: Date.now(),
    });
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const items = tree.findAll((node) => String(node.type) === 'Item');
    const targetItem = items.find((node: any) => node.props.title === 'devVoiceQa.targetSession');
    const runtimeItem = items.find((node: any) => node.props.title === 'devVoiceQa.runtimeSession');

    expect(targetItem?.props.detail).toBe('Selected session');
    expect(runtimeItem?.props.detail).toBe('Voice conversation');
  });

  it('falls back to generic human labels when session metadata only contains raw ids', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
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
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const items = tree.findAll((node) => String(node.type) === 'Item');
    const targetItem = items.find((node: any) => node.props.title === 'devVoiceQa.targetSession');
    const runtimeItem = items.find((node: any) => node.props.title === 'devVoiceQa.runtimeSession');

    expect(targetItem?.props.detail).toBe('Selected session');
    expect(runtimeItem?.props.detail).toBe('Voice conversation');
  });

  it('prefers the active QA target and runtime session details over drifting global bindings', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
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
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const items = tree.findAll((node) => String(node.type) === 'Item');
    const targetItem = items.find((node: any) => node.props.title === 'devVoiceQa.targetSession');
    const runtimeItem = items.find((node: any) => node.props.title === 'devVoiceQa.runtimeSession');

    expect(targetItem?.props.detail).toBe('Selected session');
    expect(runtimeItem?.props.detail).toBe('Voice conversation');
  });

  it('uses the translated voice-agent label for the global sentinel', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    useVoiceQaStore.setState((state: any) => ({
        ...state,
        provider: 'local_voice_agent',
        sessionId: '__voice_agent__',
        targetSessionId: '__voice_agent__',
        status: 'running',
    }));
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const items = tree.findAll((node) => String(node.type) === 'Item');
    const targetItem = items.find((node: any) => node.props.title === 'devVoiceQa.targetSession');

    expect(targetItem?.props.detail).toBe('voiceActivity.format.voiceAgent');
  });

  it('replaces the global voice sentinel with the active target session label', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
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
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const items = tree.findAll((node) => String(node.type) === 'Item');
    const targetItem = items.find((node: any) => node.props.title === 'devVoiceQa.targetSession');
    const runtimeItem = items.find((node: any) => node.props.title === 'devVoiceQa.runtimeSession');

    expect(targetItem?.props.detail).toBe('Session QA Voice Matrix');
    expect(runtimeItem?.props.detail).toBe('voice-agent');
  });

  it('uses the latest session id when start is pressed before the button rerenders', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const startButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.start');

    await act(async () => {
      sessionInput.props.onChangeText('session_latest');
      await pressTestInstanceAsync(startButton);
    });

    expect(voiceQaControllerMocks.start).toHaveBeenCalledWith({
      sessionId: 'session_latest',
      initialContext: '',
    });
  });

  it('uses the latest prompt when send is pressed before the button rerenders', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const promptInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.promptInput');
    const sendButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.send');

    await act(async () => {
      sessionInput.props.onChangeText('session_send');
      promptInput.props.onChangeText('prompt_latest');
      await pressTestInstanceAsync(sendButton);
    });

    expect(voiceQaControllerMocks.sendPrompt).toHaveBeenCalledWith({
      sessionId: 'session_send',
      prompt: 'prompt_latest',
    });
  });

  it('uses the latest session id when stop is pressed before the button rerenders', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const stopButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.stop');

    await act(async () => {
      sessionInput.props.onChangeText('session_stop_latest');
      await pressTestInstanceAsync(stopButton);
    });

    expect(voiceQaControllerMocks.stop).toHaveBeenCalledWith({
      sessionId: 'session_stop_latest',
    });
  });

  it('calls clear without routing through the busy action wrapper', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const clearButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.clear');

    await act(async () => {
      await pressTestInstanceAsync(clearButton);
    });

    expect(voiceQaControllerMocks.clear).toHaveBeenCalledTimes(1);
    expect(voiceQaControllerMocks.start).not.toHaveBeenCalled();
    expect(voiceQaControllerMocks.stop).not.toHaveBeenCalled();
  });

  it('opens the hidden conversation route for the bound runtime session', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice_session_qa_open',
      targetSessionId: 'target_s1',
      transcriptMode: 'native_session',
      updatedAt: Date.now(),
    });
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const openConversationButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.openConversation');

    await act(async () => {
      await pressTestInstanceAsync(openConversationButton);
    });

    expect(expoRouterMock.spies.push).toHaveBeenCalledWith('/session/voice_session_qa_open');
  });

  it('renders transcript and projected conversation entries from the QA stores', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
    useVoiceQaStore.getState().appendUser('user prompt');
    useVoiceQaStore.getState().appendAssistant('assistant reply');
    storage.setState({
      ...(storage.getState() as any),
      sessionMessages: {
        voice_hidden_runtime: {
          messages: [
            {
              id: 'proj_1',
              createdAt: 1,
              localId: 'proj_1',
              isSidechain: false,
              role: 'agent',
              content: [{ type: 'text', text: 'Assistant is speaking', uuid: 'proj_1', parentUUID: null }],
            },
            {
              id: 'proj_2',
              createdAt: 2,
              localId: 'proj_2',
              isSidechain: false,
              role: 'agent',
              content: [{ type: 'text', text: '[Voice] Tool result: sendSessionMessage succeeded', uuid: 'proj_2', parentUUID: null }],
            },
          ],
        },
      },
    } as any);
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice_hidden_runtime',
      targetSessionId: 'target_s1',
      transcriptMode: 'native_session',
      updatedAt: Date.now(),
    });
    useVoiceQaStore.setState((state: any) => ({
      ...state,
      runtimeSessionId: 'voice_hidden_runtime',
    }));

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const allText = tree.findAll((node) => String(node.type) === 'Text').map((node: any) => String(node.props.children));

    expect(allText).toContain('user');
    expect(allText).toContain('user prompt');
    expect(allText).toContain('assistant');
    expect(allText).toContain('assistant reply');
    expect(allText.some((text) => text.includes('Assistant is speaking'))).toBe(true);
    expect(allText.some((text) => text.includes('[Voice] Tool result: sendSessionMessage succeeded'))).toBe(true);
    expect(allText).not.toContain('devVoiceQa.transcriptEmpty');
    expect(allText).not.toContain('devVoiceQa.activityEmpty');
  });

  it('transcribes selected recorded audio through the QA seam and renders the returned text', async () => {
    recordedAudioTranscriptionControllerMocks.transcribe.mockResolvedValueOnce('hello daemon stt');

    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const daemonPackIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonPackIdInput');
    const daemonMachineIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonMachineIdInput');
    const daemonBasePathInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonBasePathInput');
    const fileInput = tree.find((node) => String(node.props?.['data-testid']) === 'voiceQa.recordedAudio.fileInput');
    const transcribeButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.transcribe');

    await act(async () => {
      sessionInput.props.onChangeText('session-daemon-stt');
      daemonPackIdInput.props.onChangeText('sherpa-onnx-stt-en-v1');
      daemonMachineIdInput.props.onChangeText('machine-daemon-stt');
      daemonBasePathInput.props.onChangeText('/tmp/voice-agent');
      fileInput.props.onChange({
        target: {
          files: [{ name: 'recording.wav', type: 'audio/wav' }],
          value: 'recording.wav',
        },
      });
    });

    await act(async () => {
      await pressTestInstanceAsync(transcribeButton);
    });

    expect(recordedAudioTranscriptionControllerMocks.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-daemon-stt',
        uri: 'blob:voice-qa-recording',
        settings: expect.objectContaining({
          experiments: true,
          featureToggles: expect.objectContaining({
            voice: true,
            'execution.runs': true,
            'voice.agent': true,
            'voice.daemonInference': true,
          }),
          voice: expect.objectContaining({
            providerId: 'local_conversation',
            assistantLanguage: 'en',
            adapters: expect.objectContaining({
              local_conversation: expect.objectContaining({
                conversationMode: 'agent',
                stt: expect.objectContaining({
                  provider: 'local_neural',
                  localNeural: expect.objectContaining({
                    assetId: 'sherpa-onnx-stt-en-v1',
                    language: 'en',
                    execution: 'daemon',
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    );

    const statusText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.status');
    const resultText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.result');

    expect(String(statusText.props.children)).toContain('success');
    expect(String(resultText.props.children)).toContain('hello daemon stt');
    expect((storage.getState() as any).settings?.voice?.adapters?.local_conversation?.stt?.localNeural?.assetId).toBe('sherpa-onnx-stt-en-v1');
    expect((storage.getState() as any).sessions?.['session-daemon-stt']).toMatchObject({
      id: 'session-daemon-stt',
      metadata: expect.objectContaining({
        machineId: 'machine-daemon-stt',
        path: '/tmp/voice-agent',
        host: 'voice-qa',
        name: 'Recorded audio daemon STT target',
      }),
    });
    expect((storage.getState() as any).sessionListRenderables?.['session-daemon-stt']).toMatchObject({
      id: 'session-daemon-stt',
      metadata: expect.objectContaining({
        machineId: 'machine-daemon-stt',
        path: '/tmp/voice-agent',
      }),
    });
    expect((storage.getState() as any).machines?.['machine-daemon-stt']).toEqual(expect.objectContaining({
      id: 'machine-daemon-stt',
      active: true,
      metadata: expect.objectContaining({
        host: 'voice-qa',
      }),
    }));
  });

  it('uses recorded-audio daemon route params for the explicit daemon fallback path', async () => {
    recordedAudioTranscriptionControllerMocks.transcribe.mockResolvedValueOnce(null);
    expoRouterMock.state.router.setParams({
      voiceQaSessionId: 'session-from-route',
      voiceQaRecordedAudioDaemonSttPackId: 'sherpa-onnx-stt-en-v1',
      voiceQaRecordedAudioDaemonMachineId: 'machine-from-route',
      voiceQaRecordedAudioDaemonBasePath: '/tmp/voice-from-route',
    });

    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const daemonPackIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonPackIdInput');
    const daemonMachineIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonMachineIdInput');
    const daemonBasePathInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonBasePathInput');
    const fileInput = tree.find((node) => String(node.props?.['data-testid']) === 'voiceQa.recordedAudio.fileInput');
    const transcribeButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.transcribe');

    expect(sessionInput.props.value).toBe('session-from-route');
    expect(daemonPackIdInput.props.value).toBe('sherpa-onnx-stt-en-v1');
    expect(daemonMachineIdInput.props.value).toBe('machine-from-route');
    expect(daemonBasePathInput.props.value).toBe('/tmp/voice-from-route');

    await act(async () => {
      fileInput.props.onChange({
        target: {
          files: [{ name: 'recording.wav', type: 'audio/wav' }],
          value: 'recording.wav',
        },
      });
    });

    await act(async () => {
      await pressTestInstanceAsync(transcribeButton);
    });

    expect(recordedAudioTranscriptionControllerMocks.transcribe).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-from-route',
    }));
    expect(daemonRecordedAudioFallbackMocks.transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-from-route',
      inputMimeType: 'audio/wav',
      packId: 'sherpa-onnx-stt-en-v1',
      language: 'en',
    }));
    const daemonClientDeps = daemonVoiceInferenceClientConstructorMock.mock.calls.at(-1)?.[0] as
      | { readMachineTargetForSession?: (sessionId: string) => { machineId: string; basePath: string } | null }
      | undefined;
    expect(daemonClientDeps?.readMachineTargetForSession?.('session-from-route')).toEqual({
      machineId: 'machine-from-route',
      basePath: '/tmp/voice-from-route',
    });
    expect((storage.getState() as any).sessions?.['session-from-route']).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        machineId: 'machine-from-route',
        path: '/tmp/voice-from-route',
      }),
    }));
    const statusText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.status');
    const resultText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.result');
    expect(String(statusText.props.children)).toContain('success');
    expect(String(resultText.props.children)).toContain('hello explicit daemon stt');
  });

  it('falls back to the explicit daemon QA path when the generic controller returns empty', async () => {
    recordedAudioTranscriptionControllerMocks.transcribe.mockResolvedValueOnce(null);

    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const daemonPackIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonPackIdInput');
    const daemonMachineIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonMachineIdInput');
    const daemonBasePathInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonBasePathInput');
    const fileInput = tree.find((node) => String(node.props?.['data-testid']) === 'voiceQa.recordedAudio.fileInput');
    const transcribeButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.transcribe');

    await act(async () => {
      sessionInput.props.onChangeText('session-daemon-fallback');
      daemonPackIdInput.props.onChangeText('sherpa-onnx-stt-en-v1');
      daemonMachineIdInput.props.onChangeText('machine-daemon-stt');
      daemonBasePathInput.props.onChangeText('/tmp/voice-agent');
      fileInput.props.onChange({
        target: {
          files: [{ name: 'recording.wav', type: 'audio/wav' }],
          value: 'recording.wav',
        },
      });
    });

    await act(async () => {
      await pressTestInstanceAsync(transcribeButton);
    });

    expect(daemonRecordedAudioFallbackMocks.transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-daemon-fallback',
      inputMimeType: 'audio/wav',
      packId: 'sherpa-onnx-stt-en-v1',
      language: 'en',
    }));
    expect(daemonVoiceInferenceClientConstructorMock).toHaveBeenCalledWith(expect.objectContaining({
      isRuntimeFeatureEnabled: expect.any(Function),
      readMachineTargetForSession: expect.any(Function),
    }));
    const daemonClientDeps = daemonVoiceInferenceClientConstructorMock.mock.calls.at(-1)?.[0] as
      | { readMachineTargetForSession?: (sessionId: string) => { machineId: string; basePath: string } | null }
      | undefined;
    expect(daemonClientDeps?.readMachineTargetForSession?.('session-daemon-fallback')).toEqual({
      machineId: 'machine-daemon-stt',
      basePath: '/tmp/voice-agent',
    });
    const statusText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.status');
    const resultText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.result');

    expect(String(statusText.props.children)).toContain('success');
    expect(String(resultText.props.children)).toContain('hello explicit daemon stt');
  });

  it('surfaces explicit daemon QA fallback failures instead of collapsing them to empty', async () => {
    recordedAudioTranscriptionControllerMocks.transcribe.mockResolvedValueOnce(null);
    daemonRecordedAudioFallbackMocks.transcribeRecordedAudio.mockRejectedValueOnce(new Error('daemon_rpc_failed'));

    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const daemonPackIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonPackIdInput');
    const daemonMachineIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonMachineIdInput');
    const daemonBasePathInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonBasePathInput');
    const fileInput = tree.find((node) => String(node.props?.['data-testid']) === 'voiceQa.recordedAudio.fileInput');
    const transcribeButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.transcribe');

    await act(async () => {
      sessionInput.props.onChangeText('session-daemon-error');
      daemonPackIdInput.props.onChangeText('sherpa-onnx-stt-en-v1');
      daemonMachineIdInput.props.onChangeText('machine-daemon-stt');
      daemonBasePathInput.props.onChangeText('/tmp/voice-agent');
      fileInput.props.onChange({
        target: {
          files: [{ name: 'recording.wav', type: 'audio/wav' }],
          value: 'recording.wav',
        },
      });
    });

    await act(async () => {
      await pressTestInstanceAsync(transcribeButton);
    });

    const statusText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.status');
    const resultText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.result');

    expect(String(statusText.props.children)).toContain('error');
    expect(String(resultText.props.children)).toContain('daemon_rpc_failed');
  });
});
