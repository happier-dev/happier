import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import {
  bindVoiceRuntimeAttemptBinding,
  createVoiceRuntimeAttemptBindingOwner,
  voiceSessionBindingStore,
} from '@/voice/binding/voiceConversationBindingStore';
import { writeVoiceConversationBindingMetadata } from '@/voice/binding/voiceConversationBindingMetadata';
import { localVoiceRuntimeController } from '@/voice/local/localVoiceRuntimeController';
import {
  registerVoiceAdapters,
  resetVoiceAdapterRegistryForTests,
} from '@/voice/session/voiceAdapterRegistry';
import { resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import type { VoiceAdapterController } from '@/voice/session/types';

const localSearchParamsState = vi.hoisted(() => ({
  current: {} as Record<string, string | string[] | undefined>,
}));

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await vi.importActual<typeof import('@/dev/testkit/mocks/router')>(
    '@/dev/testkit/mocks/router',
  );
  return createExpoRouterMock({
    params: () => localSearchParamsState.current,
  }).module;
});

const {
  enqueuePendingMessage,
  markPendingDeliveryHandled,
} = vi.hoisted(() => ({
  enqueuePendingMessage: vi.fn(async (
    _sessionId: string,
    _text: string,
    _displayText: unknown,
    _metadata: unknown,
    options: Readonly<{ localId: string }>,
  ) => ({
    accepted: true,
    externalHandoffClaimed: true,
    localId: options.localId,
  })),
  markPendingDeliveryHandled: vi.fn(async () => {}),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    enqueuePendingMessage,
    markPendingDeliveryHandled,
  },
}));

const initialBindings = voiceSessionBindingStore.getState();
const initialStorageState = getStorage().getState();
const initialDev = (globalThis as { __DEV__?: boolean }).__DEV__;

function createAdapter(input: Readonly<{
  id: string;
  sendTextTurn?: VoiceAdapterController['sendTextTurn'];
}>): VoiceAdapterController {
  return {
    id: input.id,
    engineKind: 'local',
    start: async () => {},
    stop: async () => {},
    toggle: async () => {},
    interrupt: async () => {},
    setMuted: async () => {},
    sendContextUpdate: () => {},
    ...(input.sendTextTurn ? { sendTextTurn: input.sendTextTurn } : {}),
    getSnapshot: () => ({
      adapterId: input.id,
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    }),
  };
}

describe('foreground Voice text-turn QA bridge', () => {
  beforeEach(() => {
    getStorage().setState(initialStorageState, true);
    resetVoiceAdapterRegistryForTests();
    resetVoiceSessionStoreForTests();
    voiceSessionBindingStore.setState(initialBindings, true);
    enqueuePendingMessage.mockClear();
    markPendingDeliveryHandled.mockClear();
    localSearchParamsState.current = {};
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  });

  afterEach(() => {
    standardCleanup();
    vi.restoreAllMocks();
    resetVoiceAdapterRegistryForTests();
    resetVoiceSessionStoreForTests();
    getStorage().setState(initialStorageState, true);
    voiceSessionBindingStore.setState(initialBindings, true);
    localSearchParamsState.current = {};
    if (initialDev === undefined) {
      delete (globalThis as { __DEV__?: boolean }).__DEV__;
    } else {
      (globalThis as { __DEV__?: boolean }).__DEV__ = initialDev;
    }
  });

  it('rejects a persisted foreground binding when no local-agent attempt is active', async () => {
    const persistedBinding = {
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'persisted-voice-carrier',
      transcriptMode: 'native_session' as const,
      targetSessionId: null,
      updatedAt: 1,
    };
    const persistedSession = createSessionFixture({ id: persistedBinding.conversationSessionId });
    const persistedMetadata = persistedSession.metadata;
    if (!persistedMetadata) {
      throw new Error('foreground_voice_text_turn_qa_persisted_fixture_metadata_unavailable');
    }
    getStorage().setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [persistedBinding.conversationSessionId]: {
          ...persistedSession,
          metadata: writeVoiceConversationBindingMetadata({
            ...persistedMetadata,
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } as const,
          }, persistedBinding),
        },
      },
    }));
    const localSendTextTurn = vi.fn(async (params: Readonly<{ onAccepted(): Promise<void> }>) => {
      await params.onAccepted();
    });
    registerVoiceAdapters([createAdapter({ id: 'local_conversation', sendTextTurn: localSendTextTurn })]);

    const { dispatchForegroundVoiceTextTurnQa } = await import('./foregroundVoiceTextTurnQaBridge');

    await expect(dispatchForegroundVoiceTextTurnQa('Read the current issue')).rejects.toThrow(
      'foreground_voice_text_turn_qa_binding_unavailable',
    );

    expect(localSendTextTurn).not.toHaveBeenCalled();
    expect(enqueuePendingMessage).not.toHaveBeenCalled();
    expect(markPendingDeliveryHandled).not.toHaveBeenCalled();
  });

  it('keeps the current Triage foreground intact while using the active local conversation text-turn port', async () => {
    const foregroundTriage = Object.freeze({
      path: '/plugins/happier.triage/triage',
      issueTitle: 'Issue A',
    });
    const foregroundPort = Object.freeze({
      read: () => foregroundTriage,
    });
    const observedForegrounds: unknown[] = [];
    const localSendTextTurn = vi.fn(async (params: Readonly<{
      controlSessionId: string;
      conversationSessionId: string;
      text: string;
      localId: string;
      deliveryCommand: 'interrupt_and_send';
      onAccepted(): Promise<void>;
    }>) => {
      observedForegrounds.push(foregroundPort.read());
      await params.onAccepted();
    });
    const unrelatedSendTextTurn = vi.fn(async () => {});

    vi.spyOn(localVoiceRuntimeController, 'isAgentActive').mockImplementation(
      (sessionId) => sessionId === VOICE_AGENT_GLOBAL_SESSION_ID,
    );
    bindVoiceRuntimeAttemptBinding({
      binding: {
        adapterId: 'local_conversation',
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        conversationSessionId: 'voice-carrier-for-triage',
        lifetime: 'runtime_attempt',
        targetSessionId: null,
        transcriptMode: 'native_session',
        updatedAt: 1,
      },
      owner: createVoiceRuntimeAttemptBindingOwner(),
    });
    registerVoiceAdapters([
      createAdapter({ id: 'unrelated_voice', sendTextTurn: unrelatedSendTextTurn }),
      createAdapter({ id: 'local_conversation', sendTextTurn: localSendTextTurn }),
    ]);

    const { dispatchForegroundVoiceTextTurnQa } = await import('./foregroundVoiceTextTurnQaBridge');

    const binding = await dispatchForegroundVoiceTextTurnQa('Read the current issue');

    expect(binding).toMatchObject({ conversationSessionId: 'voice-carrier-for-triage' });
    expect(observedForegrounds).toEqual([foregroundTriage]);
    expect(foregroundPort.read()).toBe(foregroundTriage);
    expect(localSendTextTurn).toHaveBeenCalledWith({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-carrier-for-triage',
      text: 'Read the current issue',
      localId: expect.any(String),
      deliveryCommand: 'interrupt_and_send',
      onAccepted: expect.any(Function),
    });
    expect(unrelatedSendTextTurn).not.toHaveBeenCalled();
    expect(enqueuePendingMessage).toHaveBeenCalledWith(
      'voice-carrier-for-triage',
      'Read the current issue',
      undefined,
      expect.anything(),
      expect.objectContaining({
        deliveryMode: 'external_handoff',
        requestedAction: { v: 1, kind: 'send_now' },
      }),
    );
    expect(markPendingDeliveryHandled).toHaveBeenCalledOnce();
  });

  it('retries the same query after the active attempt starts, then dedupes by the resolved attempt', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const localSendTextTurn = vi.fn(async (params: Readonly<{
      conversationSessionId: string;
      onAccepted(): Promise<void>;
    }>) => {
      await params.onAccepted();
    });
    registerVoiceAdapters([createAdapter({ id: 'local_conversation', sendTextTurn: localSendTextTurn })]);
    localSearchParamsState.current = {
      happier_voice_e2e_text_turn: 'Read the current issue',
    };

    const { useForegroundVoiceTextTurnQaBridge } = await import('./useForegroundVoiceTextTurnQaBridge');
    const hook = await renderHook(() => {
      useForegroundVoiceTextTurnQaBridge();
      return null;
    });
    await flushHookEffects({ cycles: 4, turns: 4 });

    expect(localSendTextTurn).not.toHaveBeenCalled();

    const isAgentActive = vi.spyOn(localVoiceRuntimeController, 'isAgentActive').mockImplementation(
      (sessionId) => sessionId === VOICE_AGENT_GLOBAL_SESSION_ID,
    );
    bindVoiceRuntimeAttemptBinding({
      binding: {
        adapterId: 'local_conversation',
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        conversationSessionId: 'voice-carrier-attempt-a',
        lifetime: 'runtime_attempt',
        targetSessionId: null,
        transcriptMode: 'native_session',
        updatedAt: 1,
      },
      owner: createVoiceRuntimeAttemptBindingOwner(),
    });
    await act(async () => {
      setVoiceSessionSnapshot({
        adapterId: 'local_conversation',
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        status: 'connected',
        mode: 'idle',
        canStop: true,
      });
    });
    await flushHookEffects({ cycles: 4, turns: 4 });

    expect(localSendTextTurn).toHaveBeenCalledTimes(1);
    expect(localSendTextTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      conversationSessionId: 'voice-carrier-attempt-a',
      text: 'Read the current issue',
    }));

    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });
    await flushHookEffects({ cycles: 4, turns: 4 });
    expect(localSendTextTurn).toHaveBeenCalledTimes(1);

    isAgentActive.mockReturnValue(false);
    await act(async () => {
      setVoiceSessionSnapshot({
        adapterId: 'local_conversation',
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      });
    });
    bindVoiceRuntimeAttemptBinding({
      binding: {
        adapterId: 'local_conversation',
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        conversationSessionId: 'voice-carrier-attempt-b',
        lifetime: 'runtime_attempt',
        targetSessionId: null,
        transcriptMode: 'native_session',
        updatedAt: 2,
      },
      owner: createVoiceRuntimeAttemptBindingOwner(),
    });
    isAgentActive.mockReturnValue(true);
    await act(async () => {
      setVoiceSessionSnapshot({
        adapterId: 'local_conversation',
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        status: 'connected',
        mode: 'idle',
        canStop: true,
      });
    });
    await flushHookEffects({ cycles: 4, turns: 4 });

    expect(localSendTextTurn).toHaveBeenCalledTimes(2);
    expect(localSendTextTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      conversationSessionId: 'voice-carrier-attempt-b',
      text: 'Read the current issue',
    }));

    await hook.unmount();
    consoleError.mockClear();
  });

  it('does not enqueue the same active-attempt query again while its first dispatch is unsettled', async () => {
    let releaseFirstDispatch!: () => void;
    const firstDispatchReleased = new Promise<void>((resolve) => {
      releaseFirstDispatch = resolve;
    });
    const localSendTextTurn = vi.fn(async (params: Readonly<{
      conversationSessionId: string;
      onAccepted(): Promise<void>;
    }>) => {
      await firstDispatchReleased;
      await params.onAccepted();
    });
    registerVoiceAdapters([createAdapter({ id: 'local_conversation', sendTextTurn: localSendTextTurn })]);
    vi.spyOn(localVoiceRuntimeController, 'isAgentActive').mockImplementation(
      (sessionId) => sessionId === VOICE_AGENT_GLOBAL_SESSION_ID,
    );
    bindVoiceRuntimeAttemptBinding({
      binding: {
        adapterId: 'local_conversation',
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        conversationSessionId: 'voice-carrier-pending-attempt',
        lifetime: 'runtime_attempt',
        targetSessionId: null,
        transcriptMode: 'native_session',
        updatedAt: 1,
      },
      owner: createVoiceRuntimeAttemptBindingOwner(),
    });
    localSearchParamsState.current = {
      happier_voice_e2e_text_turn: 'Read the current issue',
    };
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const { useForegroundVoiceTextTurnQaBridge } = await import('./useForegroundVoiceTextTurnQaBridge');
    const hook = await renderHook(() => {
      useForegroundVoiceTextTurnQaBridge();
      return null;
    });
    await flushHookEffects({ cycles: 4, turns: 4 });

    expect(localSendTextTurn).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVoiceSessionSnapshot({
        adapterId: 'local_conversation',
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        status: 'connected',
        mode: 'listening',
        canStop: true,
      });
    });
    await flushHookEffects({ cycles: 4, turns: 4 });

    expect(localSendTextTurn).toHaveBeenCalledTimes(1);

    releaseFirstDispatch();
    await flushHookEffects({ cycles: 4, turns: 4 });

    await act(async () => {
      setVoiceSessionSnapshot({
        adapterId: 'local_conversation',
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        status: 'connected',
        mode: 'speaking',
        canStop: true,
      });
    });
    await flushHookEffects({ cycles: 4, turns: 4 });

    expect(localSendTextTurn).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });
});
