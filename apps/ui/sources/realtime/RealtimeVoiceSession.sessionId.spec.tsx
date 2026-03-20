import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const modalAlert = vi.fn();
const appendRealtimeVoiceTranscriptEvent = vi.fn();
const getBindingByControlSessionId = vi.fn((_controlSessionId: string) => null as any);
const ensureVoiceBinding = vi.fn(async (_params: any) => null);

vi.mock('@/modal', () => ({
  Modal: {
    alert: (...args: any[]) => modalAlert(...args),
    confirm: vi.fn(async () => false),
    prompt: vi.fn(async () => null),
  },
}));

vi.mock('@/text', () => ({ t: (key: string) => key }));

vi.mock('@/utils/platform/microphonePermissions', () => ({
  requestMicrophonePermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  showMicrophonePermissionDeniedAlert: vi.fn(),
}));

vi.mock('@/constants/Languages', () => ({
  getElevenLabsCodeFromPreference: () => 'en',
}));

vi.mock('./elevenlabs/elevenLabsApi', () => ({
  getElevenLabsApiBaseUrl: () => 'http://localhost:9999/v1',
  getElevenLabsApiTimeoutMs: () => 25,
}));

const conversationStartSession = vi.fn(async (..._args: any[]) => 'conv_1');
const conversationGetId = vi.fn((..._args: any[]) => null);
const conversationEndSession = vi.fn(async (..._args: any[]) => {});
let lastConversationOptions: any = null;

const useConversationMock = vi.fn((_opts: any) => ({
  startSession: conversationStartSession,
  getId: conversationGetId,
  endSession: conversationEndSession,
  sendUserMessage: vi.fn(),
  sendContextualUpdate: vi.fn(),
}));

vi.mock('@elevenlabs/react-native', () => ({
  useConversation: (opts: any) => {
    lastConversationOptions = opts;
    return useConversationMock(opts);
  },
}));

const state: any = {
  sessions: {
    s1: { id: 's1', metadata: {} },
    s2: { id: 's2', metadata: {} },
    s3: { id: 's3', metadata: {} },
  },
  settings: {
    voice: {
      providerId: 'realtime_elevenlabs',
      adapters: {
        realtime_elevenlabs: {
          assistantLanguage: null,
          billingMode: 'byo',
          byo: { agentId: 'agent_1', apiKey: { value: 'api_key_1' } },
        },
      },
    },
  },
  setRealtimeStatus: vi.fn(),
  setRealtimeMode: vi.fn(),
  clearRealtimeModeDebounce: vi.fn(),
};

vi.mock('@/sync/domains/state/storage', () => ({
  storage: { getState: () => state },
}));
vi.mock('@/voice/sessionBinding/resolveVoiceSessionBinding', () => ({
  resolveVoiceSessionBindingByControlSessionId: (params: { controlSessionId: string }) =>
    getBindingByControlSessionId(params.controlSessionId),
}));
vi.mock('@/voice/sessionBinding/voiceSessionBindingRuntime', () => ({
  voiceSessionBindingManager: {
    ensureBound: (params: any) => ensureVoiceBinding(params),
    syncTargetSession: vi.fn(),
  },
}));
vi.mock('./realtimeVoiceTranscriptBridge', () => ({
  appendRealtimeVoiceTranscriptEvent: (params: any) => appendRealtimeVoiceTranscriptEvent(params),
}));

const sendMessage = vi.fn(async (..._args: any[]) => {});

vi.mock('@/sync/sync', () => ({
  sync: {
    decryptSecretValue: (value: unknown) => {
      if (!value || typeof value !== 'object') return null;
      const maybeValue = (value as { value?: unknown }).value;
      return typeof maybeValue === 'string' ? maybeValue : null;
    },
    presentPaywall: vi.fn(async () => ({ success: true, purchased: false })),
    sendMessage: (...args: any[]) => sendMessage(...args),
    encryption: {
      getSessionEncryption: vi.fn(() => ({})),
    },
  },
}));

describe('RealtimeVoiceSession (native) sessionId tracking', () => {
  beforeEach(() => {
    modalAlert.mockReset();
    conversationStartSession.mockClear();
    conversationGetId.mockClear();
    conversationEndSession.mockClear();
    useConversationMock.mockClear();
    lastConversationOptions = null;
    appendRealtimeVoiceTranscriptEvent.mockReset();
    getBindingByControlSessionId.mockReset();
    getBindingByControlSessionId.mockReturnValue(null);
    ensureVoiceBinding.mockReset();
    sendMessage.mockReset();
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'token_1' }),
    }));
  });

  afterEach(async () => {
    vi.resetModules();
  });

  const startRealtimeSessionWithTimeout = (startRealtimeSession: (sessionId: string, initialContext?: string) => Promise<void>, sessionId: string, initialContext: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('startRealtimeSession timed out')), 2_000);
      startRealtimeSession(sessionId, initialContext).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  it('starts even when invoked with an empty session id and routes tool calls via voice target store', async () => {
    const { RealtimeVoiceSession } = await import('./RealtimeVoiceSession');
    const { startRealtimeSession } = await import('./RealtimeSession');
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    useVoiceTargetStore.getState().setScope('global');
    useVoiceTargetStore.getState().setPrimaryActionSessionId('s1');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<RealtimeVoiceSession />);
    });

    await startRealtimeSessionWithTimeout(startRealtimeSession, '', 'ctx');

    const { realtimeClientTools } = await import('./realtimeClientTools');
    await realtimeClientTools.sendSessionMessage({ message: 'hello' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.lastCall?.[0]).toBe('s1');
    expect(sendMessage.mock.lastCall?.[1]).toBe('hello');

    await act(async () => {
      tree.unmount();
    });
  });

  it('routes tool calls to the primary action session when voice scope is global', async () => {
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    useVoiceTargetStore.getState().setScope('global');
    useVoiceTargetStore.getState().setPrimaryActionSessionId('s2');

    const { RealtimeVoiceSession } = await import('./RealtimeVoiceSession');
    const { startRealtimeSession } = await import('./RealtimeSession');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<RealtimeVoiceSession />);
    });

    await startRealtimeSessionWithTimeout(startRealtimeSession, '', 'ctx');

    const { realtimeClientTools } = await import('./realtimeClientTools');
    await realtimeClientTools.sendSessionMessage({ message: 'hello' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.lastCall?.[0]).toBe('s2');
    expect(sendMessage.mock.lastCall?.[1]).toBe('hello');

    await act(async () => {
      tree.unmount();
    });
  });

  it('sets the primary action session when realtime voice starts with a sessionId', async () => {
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    useVoiceTargetStore.getState().setScope('global');
    useVoiceTargetStore.getState().setPrimaryActionSessionId(null);
    useVoiceTargetStore.getState().setLastFocusedSessionId(null);

    const { RealtimeVoiceSession } = await import('./RealtimeVoiceSession');
    const { startRealtimeSession } = await import('./RealtimeSession');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<RealtimeVoiceSession />);
    });

    await startRealtimeSessionWithTimeout(startRealtimeSession, 's3', 'ctx');

    expect(useVoiceTargetStore.getState().primaryActionSessionId).toBe('s3');

    await act(async () => {
      tree.unmount();
    });
  });

  it('records realtime provider message payloads for the text QA harness', async () => {
    const { resetVoiceQaStoreForTests, useVoiceQaStore } = await import('@/voice/qa/voiceQaStore');
    resetVoiceQaStoreForTests();
    useVoiceQaStore.getState().begin('realtime_elevenlabs', 's1');
    useVoiceQaStore.getState().setStatus('running');

    const { RealtimeVoiceSession } = await import('./RealtimeVoiceSession');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<RealtimeVoiceSession />);
    });

    expect(lastConversationOptions).toBeTruthy();

    await act(async () => {
      lastConversationOptions.onMessage?.({
        type: 'agent_response',
        transcript: 'I found the available backends.',
      });
    });

    const entries = useVoiceQaStore.getState().entries;
    expect(entries.some((entry) => entry.kind === 'provider.raw' && entry.text.includes('transcript: I found the available backends.'))).toBe(true);

    await act(async () => {
      tree.unmount();
    });
  });

  it('mirrors provider messages into the hidden voice conversation transcript binding', async () => {
    getBindingByControlSessionId.mockReturnValueOnce({
      conversationSessionId: 'carrier-s1',
    });

    const { RealtimeVoiceSession } = await import('./RealtimeVoiceSession');
    const { startRealtimeSession } = await import('./RealtimeSession');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<RealtimeVoiceSession />);
    });

    await startRealtimeSessionWithTimeout(startRealtimeSession, 's3', 'ctx');

    await act(async () => {
      lastConversationOptions.onMessage?.({
        type: 'agent_response',
        agent_response_event: {
          agent_response: 'Hello from ElevenLabs',
          event_id: 1,
        },
      });
    });

    expect(appendRealtimeVoiceTranscriptEvent).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      payload: expect.objectContaining({
        type: 'agent_response',
      }),
    });

    await act(async () => {
      tree.unmount();
    });
  });
});
