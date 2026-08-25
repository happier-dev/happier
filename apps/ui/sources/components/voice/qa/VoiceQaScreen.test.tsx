import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import {
  readLocalConversationVoiceSettings,
  voiceSettingsParse,
} from '@/sync/domains/settings/voiceSettings';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { resetVoiceQaStoreForTests, useVoiceQaStore } from '@/voice/qa/voiceQaStore';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import {
  flushHookEffects,
  pressTestInstanceAsync,
  renderScreen as renderTestScreen,
  standardCleanup,
} from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installVoiceQaCommonModuleMocks } from './voiceQaScreenTestHelpers';
import {
  beginVoiceQaOutputTap,
  getVoiceQaOutputTapSnapshot,
  resetVoiceQaOutputTapForTests,
} from '@/voice/qa/voiceQaOutputTap';
import { daemonSpeechStreamDiagnostics } from '@/voice/runtime/daemonInference/daemonSpeechStreamDiagnostics';
import {
  clearMachineRpcPeerMediationReceiptsForTest,
  recordMachineRpcPeerMediationReceipt,
} from '@/sync/domains/machines/peer/mediation/rpc/receiptLog';

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
const outputFixturePlaybackMocks = {
  play: vi.fn(async () => {}),
  stop: vi.fn(() => {}),
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

async function renderScreen(element: React.ReactElement) {
  const { AuthProvider } = await import('@/auth/context/AuthContext');
  return await renderTestScreen(
    <AuthProvider initialCredentials={{ token: 'voice-qa-token', secret: 'voice-qa-secret' }}>
      {element}
    </AuthProvider>,
  );
}

installVoiceQaCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            TextInput: 'TextInput',
            ScrollView: 'ScrollView',
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

vi.mock('@/sync/api/session/apiSocket', () => ({
  apiSocket: {
    getSocketId: vi.fn(() => ''),
  },
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
vi.mock('@/voice/qa/voiceQaOutputFixturePlayback', () => ({
  voiceQaOutputFixturePlayback: outputFixturePlaybackMocks,
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
  const originalDebug = process.env.EXPO_PUBLIC_DEBUG;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_DEBUG = '1';
    resetVoiceQaOutputTapForTests();
    clearMachineRpcPeerMediationReceiptsForTest();
    vi.clearAllMocks();
    expoRouterMock.state.router.setParams({
      voiceQaSessionId: undefined,
      voiceQaMode: undefined,
      voiceQaTransportRoute: undefined,
      voiceQaOutputCapture: undefined,
      voiceQaOutputFixtureUrl: undefined,
      voiceQaOutputCancelMs: undefined,
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
    const voice = voiceSettingsParse({
      providerId: 'local_conversation',
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { conversationMode: 'agent' },
        },
      },
    });
    storage.setState({
      settings: settingsParse({
        ...(storage.getState() as any).settings,
        voiceSettingsV1: voice,
        voice,
      }),
        sessionMessages: {},
    } as any);
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:voice-qa-recording');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.EXPO_PUBLIC_DEBUG = originalDebug;
    resetVoiceQaOutputTapForTests();
    clearMachineRpcPeerMediationReceiptsForTest();
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
    const items = tree.findAll((node) => String(node.type) === 'Item');
    expect(items.find((node: any) => node.props.title === 'devVoiceQa.targetSession')?.props.detail)
      .toBe('voiceSurface.noTarget');
    expect(items.find((node: any) => node.props.title === 'devVoiceQa.runtimeSession')?.props.detail)
      .toBe('common.none');
    const mediaSnapshot = JSON.parse(String(
      tree.find((node) => String(node.props?.testID) === 'voiceQa.media.snapshot').props.children,
    ));
    expect(mediaSnapshot).toMatchObject({
      status: 'disconnected',
      configuredProviderId: 'local_conversation',
      machineControlPortAuthorized: false,
      directLoopbackEndpointReady: false,
      accountProfileReady: false,
      activeServerSocketReady: false,
      serverRoute: {
        activeServerId: expect.any(String),
        activeServerUrl: expect.any(String),
        rpcDirectPeerEnabled: null,
      },
      machineRpcReceipts: [],
    });
  });

  it('projects bounded voice machine-RPC routing receipts into dev QA evidence', async () => {
    recordMachineRpcPeerMediationReceipt({
      receipt: 'machine_rpc_fell_back_to_server',
      method: 'daemon.voice.speech.transcribe.upload.init',
      reasonCode: 'loopback_unavailable',
      requestId: 'rpc-qa-1',
    });
    recordMachineRpcPeerMediationReceipt({
      receipt: 'machine_rpc_fell_back_to_server',
      method: 'daemon.unrelated.operation',
      reasonCode: 'not-relevant',
    });

    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const { tree } = await renderScreen(<VoiceQaScreen />);
    const snapshot = JSON.parse(String(
      tree.find((node) => String(node.props?.testID) === 'voiceQa.media.snapshot').props.children,
    ));

    expect(snapshot.machineRpcReceipts).toEqual([{
      receipt: 'machine_rpc_fell_back_to_server',
      method: 'daemon.voice.speech.transcribe.upload.init',
      reasonCode: 'loopback_unavailable',
      requestId: 'rpc-qa-1',
    }]);
  });

  it('surfaces live daemon streaming transport diagnostics for QA evidence', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const before = daemonSpeechStreamDiagnostics.snapshot().jsonRpcCompatibilitySelections;
    const { tree } = await renderScreen(<VoiceQaScreen />);

    await act(async () => {
      daemonSpeechStreamDiagnostics.record({
        sessionId: `qa-compat-${before}`,
        machineId: 'machine-qa',
        transport: 'json_rpc_compat',
      });
    });

    const snapshot = JSON.parse(String(
      tree.find((node) => String(node.props?.testID) === 'voiceQa.daemonSpeechTransport.snapshot').props.children,
    ));
    expect(snapshot.jsonRpcCompatibilitySelections).toBe(before + 1);
    expect(snapshot.lastTransport).toBe('json_rpc_compat');
    warn.mockRestore();
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
        lifetime: 'runtime_attempt',
        targetSessionId: null,
        transcriptMode: 'synthetic',
        updatedAt: Date.now(),
      });
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    const openConversationNodes = tree.findAll((node) => String(node.props?.testID) === 'voiceQa.openConversation');
    expect(openConversationNodes.length).toBeGreaterThan(0);
    const mediaSnapshot = JSON.parse(String(
      tree.find((node) => String(node.props?.testID) === 'voiceQa.media.snapshot').props.children,
    ));
    expect(mediaSnapshot.runtimeSessionId).toBe('voice_session_1');
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
    expect(runtimeItem?.props.detail).toBe('devVoiceQa.runtimeSession');
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

    expect(targetItem?.props.detail).toBe('devVoiceQa.targetSession');
    expect(runtimeItem?.props.detail).toBe('devVoiceQa.runtimeSession');
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

    expect(targetItem?.props.detail).toBe('devVoiceQa.targetSession');
    expect(runtimeItem?.props.detail).toBe('devVoiceQa.runtimeSession');
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

    expect(targetItem?.props.detail).toBe('devVoiceQa.targetSession');
    expect(runtimeItem?.props.detail).toBe('devVoiceQa.runtimeSession');
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
    storage.setState((state: any) => ({
        settings: {
            ...state.settings,
            voice: {
                ...state.settings?.voice,
                privacy: {
                    ...state.settings?.voice?.privacy,
                    shareSessionSummary: true,
                },
            },
        },
        sessions: {
            ...(state.sessions ?? {}),
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
    } as any));
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

  it('keeps stable target and runtime labels privacy-safe across preferred-metadata lifecycles', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const targetSessionId = 'stable_target';
    const runtimeSessionId = 'stable_runtime';
    const serverId = 'voice-qa-label-server';

    storage.setState((state: any) => ({
      settings: {
        ...state.settings,
        voice: {
          ...state.settings?.voice,
          privacy: {
            ...state.settings?.voice?.privacy,
            shareSessionSummary: false,
            shareFilePaths: false,
          },
        },
      },
      sessions: {
        ...(state.sessions ?? {}),
        [targetSessionId]: {
          id: targetSessionId,
          serverId,
          presence: 1,
          metadata: {
            summaryText: 'Raw private target summary',
            path: '/Users/alice/raw-private-target',
          },
        },
        [runtimeSessionId]: {
          id: runtimeSessionId,
          serverId,
          presence: 1,
          metadata: {
            name: runtimeSessionId,
          },
        },
      },
      sessionListRenderables: {
        ...(state.sessionListRenderables ?? {}),
        [targetSessionId]: {
          id: targetSessionId,
          metadata: {
            summaryText: 'Preferred private target summary',
            path: '/Users/alice/preferred-private-target',
          },
        },
        [runtimeSessionId]: {
          id: runtimeSessionId,
          metadata: {
            name: 'Preferred runtime label',
          },
        },
      },
      sessionListIndexByServerId: {
        ...(state.sessionListIndexByServerId ?? {}),
        [serverId]: [
          { type: 'session', sessionId: targetSessionId, serverId, serverName: 'Voice QA labels' },
          { type: 'session', sessionId: runtimeSessionId, serverId, serverName: 'Voice QA labels' },
        ],
      },
      concurrentSessionListCacheByServerId: {},
    } as any));
    useVoiceQaStore.setState((state: any) => ({
      ...state,
      provider: 'local_voice_agent',
      sessionId: '__voice_agent__',
      targetSessionId,
      runtimeSessionId,
      status: 'running',
    }));

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const readLabel = (title: string) => tree
      .findAll((node) => String(node.type) === 'Item')
      .find((node: any) => node.props.title === title)
      ?.props.detail;

    expect(readLabel('devVoiceQa.targetSession')).toBe('devVoiceQa.targetSession');
    expect(readLabel('devVoiceQa.runtimeSession')).toBe('devVoiceQa.runtimeSession');

    await act(async () => {
      storage.setState((state: any) => ({
        sessionListRenderables: {
          ...state.sessionListRenderables,
          [targetSessionId]: {
            ...state.sessionListRenderables[targetSessionId],
            metadata: {
              name: 'Updated offline target label',
              summaryText: 'Updated preferred target summary',
              path: '/Users/alice/updated-private-target',
            },
          },
          [runtimeSessionId]: {
            ...state.sessionListRenderables[runtimeSessionId],
            metadata: {
              name: 'Updated runtime label',
              summaryText: 'Updated preferred runtime summary',
            },
          },
        },
      } as any));
    });
    expect(readLabel('devVoiceQa.targetSession')).toBe('devVoiceQa.targetSession');
    expect(readLabel('devVoiceQa.runtimeSession')).toBe('devVoiceQa.runtimeSession');

    await act(async () => {
      storage.setState((state: any) => ({
        settings: {
          ...state.settings,
          voice: {
            ...state.settings.voice,
            privacy: {
              ...state.settings.voice?.privacy,
              shareSessionSummary: true,
              shareFilePaths: false,
            },
          },
        },
      } as any));
    });
    expect(readLabel('devVoiceQa.targetSession')).toBe('Updated preferred target summary');
    expect(readLabel('devVoiceQa.runtimeSession')).toBe('Updated preferred runtime summary');

    await act(async () => {
      storage.setState((state: any) => {
        const sessionListRenderables = { ...state.sessionListRenderables };
        delete sessionListRenderables[targetSessionId];
        delete sessionListRenderables[runtimeSessionId];
        return {
          sessions: {
            ...state.sessions,
            [targetSessionId]: {
              ...state.sessions[targetSessionId],
              presence: 1,
              metadata: { name: 'Raw offline target label' },
            },
            [runtimeSessionId]: {
              ...state.sessions[runtimeSessionId],
              presence: 1,
              metadata: { name: 'Raw offline runtime label' },
            },
          },
          sessionListRenderables,
        } as any;
      });
    });
    expect(readLabel('devVoiceQa.targetSession')).toBe('Raw offline target label');
    expect(readLabel('devVoiceQa.runtimeSession')).toBe('Raw offline runtime label');

    await act(async () => {
      storage.setState((state: any) => ({
        settings: {
          ...state.settings,
          voice: {
            ...state.settings.voice,
            privacy: {
              ...state.settings.voice?.privacy,
              shareSessionSummary: false,
              shareFilePaths: false,
            },
          },
        },
      } as any));
    });
    expect(readLabel('devVoiceQa.targetSession')).toBe('devVoiceQa.targetSession');
    expect(readLabel('devVoiceQa.runtimeSession')).toBe('devVoiceQa.runtimeSession');

    await act(async () => {
      storage.setState((state: any) => {
        const sessions = { ...state.sessions };
        delete sessions[targetSessionId];
        delete sessions[runtimeSessionId];
        return { sessions } as any;
      });
    });
    expect(readLabel('devVoiceQa.targetSession')).toBe('devVoiceQa.targetSession');
    expect(readLabel('devVoiceQa.runtimeSession')).toBe('devVoiceQa.runtimeSession');
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

  it('uses the explicit dev-route media mode while preserving the normal start control', async () => {
    expoRouterMock.state.router.setParams({ voiceQaMode: 'media' });
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const startButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.start');

    await act(async () => {
      sessionInput.props.onChangeText('session_media');
      await pressTestInstanceAsync(startButton);
    });

    expect(voiceQaControllerMocks.start).toHaveBeenCalledWith({
      sessionId: 'session_media',
      initialContext: '',
      mode: 'media',
    });
  });

  it('passes the explicit dev-route server-relay requirement to the media attempt', async () => {
    expoRouterMock.state.router.setParams({
      voiceQaMode: 'media',
      voiceQaTransportRoute: 'server_relay',
    });
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const startButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.start');

    await act(async () => {
      sessionInput.props.onChangeText('session_relay');
      await pressTestInstanceAsync(startButton);
    });

    expect(voiceQaControllerMocks.start).toHaveBeenCalledWith({
      sessionId: 'session_relay',
      initialContext: '',
      mode: 'media',
      transportRouteRequirement: 'server_relay',
    });
  });

  it('enables bounded output evidence and plays a route fixture from a user gesture through the QA playback owner', async () => {
    expoRouterMock.state.router.setParams({
      voiceQaOutputCapture: '1',
      voiceQaOutputFixtureUrl: 'https://fixtures.invalid/output.wav',
    });
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const rendered = await renderScreen(<VoiceQaScreen />);

    await flushHookEffects({ cycles: 2, turns: 2 });
    expect(outputFixturePlaybackMocks.play).not.toHaveBeenCalled();
    const playFixtureButton = rendered.tree.find(
      (node) => String(node.props?.testID) === 'voiceQa.output.playFixture',
    );
    await pressTestInstanceAsync(playFixtureButton);
    expect(outputFixturePlaybackMocks.play).toHaveBeenCalledWith('https://fixtures.invalid/output.wav');

    await act(async () => {
      const handle = beginVoiceQaOutputTap({
        bytes: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 65, 86, 69]).buffer,
        format: 'wav',
      });
      handle.markPlaying();
      handle.markCompleted();
      await Promise.resolve();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).toBe('completed');
    const artifact = rendered.tree.find(
      (node) => String(node.props?.testID) === 'voiceQa.output.artifact',
    );
    const artifactBytes = rendered.tree.find(
      (node) => String(node.props?.testID) === 'voiceQa.output.artifactBytes',
    );
    expect(String(artifact.props.children)).toContain('"lifecycle":"completed"');
    expect(artifactBytes.props.children).toBe('UklGRgECAwRXQVZF');
  });

  it('can cancel fixture playback on a bounded dev-route timer', async () => {
    vi.useFakeTimers();
    expoRouterMock.state.router.setParams({
      voiceQaOutputCapture: '1',
      voiceQaOutputFixtureUrl: 'https://fixtures.invalid/output.wav',
      voiceQaOutputCancelMs: '25',
    });
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const rendered = await renderScreen(<VoiceQaScreen />);
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(outputFixturePlaybackMocks.stop).not.toHaveBeenCalled();
    const playFixtureButton = rendered.tree.find(
      (node) => String(node.props?.testID) === 'voiceQa.output.playFixture',
    );
    await pressTestInstanceAsync(playFixtureButton);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(outputFixturePlaybackMocks.stop).not.toHaveBeenCalled();
    await act(async () => {
      const handle = beginVoiceQaOutputTap({
        bytes: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 65, 86, 69]).buffer,
        format: 'wav',
      });
      handle.markPlaying();
      await Promise.resolve();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(outputFixturePlaybackMocks.stop).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
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
    storage.setState((state: any) => ({
      sessions: {
        ...state.sessions,
        voice_session_qa_open: {
          id: 'voice_session_qa_open',
          metadata: {},
        },
      },
    } as any));
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

  it('transcribes a complete explicit recorded-audio target without consulting configured runtime settings', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const configuredVoiceBeforeTranscription = storage.getState().settings.voice;
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

    expect(recordedAudioTranscriptionControllerMocks.transcribe).not.toHaveBeenCalled();
    expect(daemonRecordedAudioFallbackMocks.transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-daemon-stt',
      packId: 'sherpa-onnx-stt-en-v1',
    }));

    const statusText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.status');
    const resultText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.result');

    expect(String(statusText.props.children)).toContain('success');
    expect(String(resultText.props.children)).toContain('hello explicit daemon stt');
    expect(storage.getState().settings.voice).toEqual(configuredVoiceBeforeTranscription);
    expect((storage.getState() as any).sessions?.['session-daemon-stt']).toBeUndefined();
    expect((storage.getState() as any).sessionListRenderables?.['session-daemon-stt']).toBeUndefined();
    expect((storage.getState() as any).machines?.['machine-daemon-stt']).toBeUndefined();
  });

  it('uses recorded-audio daemon route params for the explicit daemon fallback path', async () => {
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

    expect(recordedAudioTranscriptionControllerMocks.transcribe).not.toHaveBeenCalled();
    expect(daemonRecordedAudioFallbackMocks.transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-from-route',
      inputMimeType: 'audio/wav',
      packId: 'sherpa-onnx-stt-en-v1',
      language: 'en',
    }));
    const daemonClientDeps = daemonVoiceInferenceClientConstructorMock.mock.calls.at(-1)?.[0] as
      | { resolveVoiceHomeDaemonMachineId?: () => string | null }
      | undefined;
    expect(daemonClientDeps?.resolveVoiceHomeDaemonMachineId?.()).toBe('machine-from-route');
    expect((storage.getState() as any).sessions?.['session-from-route']).toBeUndefined();
    const statusText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.status');
    const resultText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.result');
    expect(String(statusText.props.children)).toContain('success');
    expect(String(resultText.props.children)).toContain('hello explicit daemon stt');
  });

  it('uses the latest explicit daemon machine target after the screen rerenders', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const daemonPackIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonPackIdInput');
    const daemonMachineIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonMachineIdInput');
    const daemonBasePathInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonBasePathInput');
    const fileInput = tree.find((node) => String(node.props?.['data-testid']) === 'voiceQa.recordedAudio.fileInput');
    const transcribeButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.transcribe');

    await act(async () => {
      sessionInput.props.onChangeText('session-latest-target');
      daemonPackIdInput.props.onChangeText('sherpa-onnx-stt-en-v1');
      daemonMachineIdInput.props.onChangeText('machine-before-rerender');
      daemonBasePathInput.props.onChangeText('/repo/before-rerender');
      fileInput.props.onChange({
        target: {
          files: [{ name: 'recording.wav', type: 'audio/wav' }],
          value: 'recording.wav',
        },
      });
    });
    await act(async () => {
      daemonMachineIdInput.props.onChangeText('machine-after-rerender');
      daemonBasePathInput.props.onChangeText('/repo/after-rerender');
    });
    await act(async () => {
      await pressTestInstanceAsync(transcribeButton);
    });

    const daemonClientDeps = daemonVoiceInferenceClientConstructorMock.mock.calls.at(-1)?.[0] as
      | { resolveVoiceHomeDaemonMachineId?: () => string | null }
      | undefined;
    expect(daemonClientDeps?.resolveVoiceHomeDaemonMachineId?.()).toBe('machine-after-rerender');
    expect((storage.getState() as any).sessions?.['session-latest-target']).toBeUndefined();
  });

  it('restores temporarily primed recorded-audio settings when the QA screen unmounts mid-action', async () => {
    let resolveTranscription!: (value: string | null) => void;
    recordedAudioTranscriptionControllerMocks.transcribe.mockReturnValueOnce(new Promise((resolve) => {
      resolveTranscription = resolve;
    }));
    const baseline = {
      experiments: storage.getState().settings.experiments,
      featureToggles: storage.getState().settings.featureToggles,
      voiceSettingsV1: storage.getState().settings.voiceSettingsV1,
      voice: storage.getState().settings.voice,
    };
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const daemonPackIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonPackIdInput');
    const fileInput = tree.find((node) => String(node.props?.['data-testid']) === 'voiceQa.recordedAudio.fileInput');
    const transcribeButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.transcribe');

    await act(async () => {
      daemonPackIdInput.props.onChangeText('sherpa-onnx-stt-en-v1');
      fileInput.props.onChange({
        target: {
          files: [{ name: 'recording.wav', type: 'audio/wav' }],
          value: 'recording.wav',
        },
      });
    });
    await act(async () => {
      transcribeButton.props.onPress();
      await vi.waitFor(() => {
        expect(recordedAudioTranscriptionControllerMocks.transcribe).toHaveBeenCalledTimes(1);
      });
    });
    const primedSettings = storage.getState().settings;
    expect(readLocalConversationVoiceSettings(primedSettings.voice).stt.localNeural).toMatchObject({
      assetId: 'sherpa-onnx-stt-en-v1',
      execution: 'daemon',
    });
    expect(readLocalConversationVoiceSettings(primedSettings.voiceSettingsV1).stt.localNeural).toMatchObject({
      assetId: 'sherpa-onnx-stt-en-v1',
      execution: 'daemon',
    });

    await act(async () => {
      tree.unmount();
    });
    expect(storage.getState().settings).toMatchObject(baseline);

    resolveTranscription(null);
    await Promise.resolve();
  });

  it('uses the explicit daemon QA path directly when every target field is complete', async () => {
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
    expect(recordedAudioTranscriptionControllerMocks.transcribe).not.toHaveBeenCalled();
    expect(daemonVoiceInferenceClientConstructorMock).toHaveBeenCalledWith(expect.objectContaining({
      isRuntimeFeatureEnabled: expect.any(Function),
      resolveVoiceHomeDaemonMachineId: expect.any(Function),
    }));
    const daemonClientDeps = daemonVoiceInferenceClientConstructorMock.mock.calls.at(-1)?.[0] as
      | { resolveVoiceHomeDaemonMachineId?: () => string | null }
      | undefined;
    expect(daemonClientDeps?.resolveVoiceHomeDaemonMachineId?.()).toBe('machine-daemon-stt');
    const statusText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.status');
    const resultText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.result');

    expect(String(statusText.props.children)).toContain('success');
    expect(String(resultText.props.children)).toContain('hello explicit daemon stt');
  });

  it('surfaces explicit daemon QA fallback failures instead of collapsing them to empty', async () => {
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
    expect(recordedAudioTranscriptionControllerMocks.transcribe).not.toHaveBeenCalled();
  });
});
