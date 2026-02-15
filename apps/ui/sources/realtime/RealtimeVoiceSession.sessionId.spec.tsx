import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const modalAlert = vi.fn();

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

const useConversationMock = vi.fn((_opts: any) => ({
  startSession: (...args: any[]) => conversationStartSession(...args),
  getId: (...args: any[]) => conversationGetId(...args),
  endSession: (...args: any[]) => conversationEndSession(...args),
  sendUserMessage: vi.fn(),
  sendContextualUpdate: vi.fn(),
}));

vi.mock('@elevenlabs/react-native', () => ({
  useConversation: (opts: any) => useConversationMock(opts),
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
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'token_1' }),
    }));
  });

  afterEach(async () => {
    vi.resetModules();
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

    await Promise.race([
      startRealtimeSession('', 'ctx'),
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('startRealtimeSession timed out')), 2_000)),
    ]);

    const { realtimeClientTools } = await import('./realtimeClientTools');
    await realtimeClientTools.sendSessionMessage({ message: 'hello' });
    expect(sendMessage).toHaveBeenCalledWith('s1', 'hello');

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

    await Promise.race([
      startRealtimeSession('', 'ctx'),
      new Promise<void>((_resolve, reject) =>
        setTimeout(() => reject(new Error('startRealtimeSession timed out')), 2_000),
      ),
    ]);

    const { realtimeClientTools } = await import('./realtimeClientTools');
    await realtimeClientTools.sendSessionMessage({ message: 'hello' });
    expect(sendMessage).toHaveBeenCalledWith('s2', 'hello');

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

    await Promise.race([
      startRealtimeSession('s3', 'ctx'),
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('startRealtimeSession timed out')), 2_000)),
    ]);

    expect(useVoiceTargetStore.getState().primaryActionSessionId).toBe('s3');

    await act(async () => {
      tree.unmount();
    });
  });
});
