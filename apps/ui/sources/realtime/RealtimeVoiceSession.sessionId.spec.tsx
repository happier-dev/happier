import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installRealtimeCommonModuleMocks } from './realtimeTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const modalAlert = vi.fn();
const appendRealtimeVoiceTranscriptEvent = vi.fn();
const getBindingByControlSessionId = vi.fn((_controlSessionId: string) => null as any);
const ensureVoiceBinding = vi.fn(async (_params: any) => null);

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

const conversationEndSession = vi.fn<() => Promise<void>>(async () => {});
const conversationGetId = vi.fn<() => string | null>(() => 'conv_1');
const conversationSendUserMessage = vi.fn<(message: string) => void>();
const conversationSendContextualUpdate = vi.fn<(update: string) => void>();
const conversationInstance = {
  endSession: conversationEndSession,
  getId: conversationGetId,
  sendUserMessage: conversationSendUserMessage,
  sendContextualUpdate: conversationSendContextualUpdate,
};
const conversationStartSession = vi.fn<(opts: unknown) => Promise<typeof conversationInstance>>(async () => conversationInstance);
const legacyHookStartSession = vi.fn<(config: unknown) => Promise<string>>(async () => 'legacy_hook_conv');
let lastStartSessionOptions: any = null;
let lastLegacyHookOptions: any = null;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const useConversationMock = vi.fn((_opts: any) => ({
  startSession: legacyHookStartSession,
  getId: conversationGetId,
  endSession: conversationEndSession,
  sendUserMessage: conversationSendUserMessage,
  sendContextualUpdate: conversationSendContextualUpdate,
}));

vi.mock('@elevenlabs/client', () => ({
  Conversation: {
    startSession: (opts: any) => {
      lastStartSessionOptions = opts;
      return conversationStartSession(opts);
    },
  },
}));

vi.mock('@elevenlabs/react-native', () => ({
  useConversation: (opts: any) => {
    lastLegacyHookOptions = opts;
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

installRealtimeCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args: any[]) => modalAlert(...args),
                confirm: vi.fn(async () => false),
                prompt: vi.fn(async () => null),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: { getState: () => state },
        });
    },
});

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
    conversationStartSession.mockReset();
    legacyHookStartSession.mockReset();
    conversationGetId.mockReset();
    conversationEndSession.mockReset();
    conversationSendUserMessage.mockReset();
    conversationSendContextualUpdate.mockReset();
    conversationStartSession.mockImplementation(async () => conversationInstance);
    legacyHookStartSession.mockImplementation(async () => 'legacy_hook_conv');
    conversationGetId.mockImplementation(() => 'conv_1');
    conversationEndSession.mockImplementation(async () => {});
    useConversationMock.mockClear();
    lastStartSessionOptions = null;
    lastLegacyHookOptions = null;
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
    tree = (await renderScreen(<RealtimeVoiceSession />)).tree;

    await startRealtimeSessionWithTimeout(startRealtimeSession, '', 'ctx');

    expect(conversationStartSession).toHaveBeenCalledWith(expect.objectContaining({
      conversationToken: 'token_1',
      connectionType: 'webrtc',
      textOnly: false,
    }));
    expect(legacyHookStartSession).not.toHaveBeenCalled();

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
    tree = (await renderScreen(<RealtimeVoiceSession />)).tree;

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
    tree = (await renderScreen(<RealtimeVoiceSession />)).tree;

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
    const { startRealtimeSession } = await import('./RealtimeSession');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<RealtimeVoiceSession />)).tree;

    await startRealtimeSessionWithTimeout(startRealtimeSession, 's1', 'ctx');
    expect(lastStartSessionOptions).toBeTruthy();

    await act(async () => {
      lastStartSessionOptions.onMessage?.({
        source: 'ai',
        role: 'agent',
        message: 'I found the available backends.',
        event_id: 1,
      });
    });

    const entries = useVoiceQaStore.getState().entries;
    expect(entries.some((entry) => entry.kind === 'provider.raw' && entry.text.includes('message: I found the available backends.'))).toBe(true);

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
    tree = (await renderScreen(<RealtimeVoiceSession />)).tree;

    await startRealtimeSessionWithTimeout(startRealtimeSession, 's3', 'ctx');

    await act(async () => {
      lastStartSessionOptions.onMessage?.({
        source: 'ai',
        role: 'agent',
        message: 'Hello from ElevenLabs',
        event_id: 1,
      });
    });

    expect(appendRealtimeVoiceTranscriptEvent).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      payload: expect.objectContaining({
        role: 'agent',
        message: 'Hello from ElevenLabs',
      }),
    });

    await act(async () => {
      tree.unmount();
    });
  });

  it('keeps the newer conversation active when an older native start resolves later', async () => {
    type MockConversation = typeof conversationInstance;
    const firstDeferred = createDeferred<MockConversation>();
    const secondDeferred = createDeferred<MockConversation>();
    const firstConversation = {
      endSession: vi.fn<() => Promise<void>>(async () => {}),
      getId: vi.fn<() => string | null>(() => 'conv_old'),
      sendUserMessage: vi.fn<(message: string) => void>(),
      sendContextualUpdate: vi.fn<(update: string) => void>(),
    };
    const secondConversation = {
      endSession: vi.fn<() => Promise<void>>(async () => {}),
      getId: vi.fn<() => string | null>(() => 'conv_new'),
      sendUserMessage: vi.fn<(message: string) => void>(),
      sendContextualUpdate: vi.fn<(update: string) => void>(),
    };
    conversationStartSession
      .mockImplementationOnce(async () => firstDeferred.promise)
      .mockImplementationOnce(async () => secondDeferred.promise);

    const { RealtimeVoiceSession } = await import('./RealtimeVoiceSession');
    const { getVoiceSession } = await import('./RealtimeSession');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<RealtimeVoiceSession />)).tree;
    const session = getVoiceSession();
    expect(session).not.toBeNull();

    const firstStart = session!.startSession({
      sessionId: 's-old',
      token: 'token_old',
      initialContext: '',
    });
    const secondStart = session!.startSession({
      sessionId: 's-new',
      token: 'token_new',
      initialContext: '',
    });

    secondDeferred.resolve(secondConversation);
    await expect(secondStart).resolves.toBe('conv_new');

    firstDeferred.resolve(firstConversation);
    await expect(firstStart).resolves.toBeNull();

    session!.sendTextMessage('still active');

    expect(firstConversation.endSession).toHaveBeenCalledTimes(1);
    expect(firstConversation.sendUserMessage).not.toHaveBeenCalled();
    expect(secondConversation.endSession).not.toHaveBeenCalled();
    expect(secondConversation.sendUserMessage).toHaveBeenCalledWith('still active');

    await act(async () => {
      tree.unmount();
    });
  });
});
