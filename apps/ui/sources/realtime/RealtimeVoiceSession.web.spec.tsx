import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installRealtimeCommonModuleMocks } from './realtimeTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

type ConfigureModulesOptions = Readonly<{
  globalLanguagePreference?: string | null;
  adapterLanguagePreference?: string | null;
  mappedLanguage?: string;
  startSessionResult?: string | null;
  fallbackConversationId?: string | null;
}>;

type TestConversationInstance = Readonly<{
  endSession: () => Promise<void>;
  getId: () => string | null;
  setMicMuted: (muted: boolean) => void;
  sendUserMessage: (message: string) => void;
  sendContextualUpdate: (message: string) => void;
}>;

const conversationEndSession = vi.fn(async () => {});
const conversationGetId = vi.fn(() => 'conv_1');
const conversationSendUserMessage = vi.fn();
const conversationSendContextualUpdate = vi.fn();
const conversationSetMicMuted = vi.fn();
const conversationInstance: TestConversationInstance = {
  endSession: conversationEndSession,
  getId: conversationGetId,
  sendUserMessage: conversationSendUserMessage,
  sendContextualUpdate: conversationSendContextualUpdate,
  setMicMuted: conversationSetMicMuted,
};
const conversationStartSession = vi.fn(async (_opts: any) => conversationInstance);
const setRealtimeStatus = vi.fn();
const setRealtimeMode = vi.fn();
const clearRealtimeModeDebounce = vi.fn();
const getElevenLabsCodeFromPreference = vi.fn((_preference?: string | null) => 'en');
const appendRealtimeVoiceTranscriptEvent = vi.fn();
const getBindingByControlSessionId = vi.fn((_controlSessionId: string) => null as any);
const ensureVoiceBinding = vi.fn(async (_params: any) => null);
const captureExceptionIfEnabledMock = vi.fn();
let lastStartSessionOptions: any = null;

const languagePreferences = {
  global: 'en' as string | null,
  adapter: null as string | null,
};

installRealtimeCommonModuleMocks({
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: {
        getState: () => ({
          settings: {
            voice: {
              assistantLanguage: languagePreferences.global,
              adapters: {
                realtime_elevenlabs: {
                  assistantLanguage: languagePreferences.adapter,
                },
              },
            },
          },
          setRealtimeStatus,
          setRealtimeMode,
          clearRealtimeModeDebounce,
        }),
      },
    });
  },
});

vi.mock('@elevenlabs/client', () => ({
  Conversation: {
    startSession: (opts: any) => {
      lastStartSessionOptions = opts;
      return conversationStartSession(opts);
    },
  },
}));

vi.mock('@/constants/Languages', () => ({
  getElevenLabsCodeFromPreference,
}));
vi.mock('./realtimeClientTools', () => ({
  realtimeClientTools: {},
}));
vi.mock('@/voice/binding/VoiceConversationBindingResolver', () => ({
  voiceConversationBindingResolver: {
    resolveByControlSessionId: (params: { controlSessionId: string }) =>
      getBindingByControlSessionId(params.controlSessionId),
  },
}));
vi.mock('@/voice/transcript/voiceConversationTranscript', () => ({
  appendVoiceConversationNoteText: vi.fn(),
  projectRealtimeVoiceTranscriptEvent: (params: any) => appendRealtimeVoiceTranscriptEvent(params),
}));
vi.mock('@/voice/binding/voiceConversationBindingRuntime', () => ({
  voiceSessionBindingManager: {
    ensureBound: (params: any) => ensureVoiceBinding(params),
    syncTargetSession: vi.fn(),
  },
}));
vi.mock('@/utils/system/sentry', () => ({
  captureExceptionIfEnabled: (...args: unknown[]) => captureExceptionIfEnabledMock(...args),
}));

function configureModules(options?: ConfigureModulesOptions) {
  languagePreferences.global = options?.globalLanguagePreference ?? 'en';
  languagePreferences.adapter = options?.adapterLanguagePreference ?? null;
  const resolvedConversationId = options?.fallbackConversationId ?? options?.startSessionResult ?? 'conv_1';
  conversationStartSession.mockImplementation(async () => conversationInstance);
  conversationEndSession.mockImplementation(async () => {});
  conversationGetId.mockImplementation(() => resolvedConversationId);
  getElevenLabsCodeFromPreference.mockImplementation(() => options?.mappedLanguage ?? 'en');

  return {
    conversation: {
      startSession: conversationStartSession,
      endSession: conversationEndSession,
      getId: conversationGetId,
      sendUserMessage: conversationSendUserMessage,
      sendContextualUpdate: conversationSendContextualUpdate,
    },
    setRealtimeStatus,
    setRealtimeMode,
    clearRealtimeModeDebounce,
    getElevenLabsCodeFromPreference,
  };
}

async function startSessionWithTimeout(
  session: Readonly<{
    startSession: (config: Readonly<{ sessionId: string; token: string; initialContext: string; textOnly?: boolean }>) => Promise<string | null>;
  }>,
  config: Readonly<{ sessionId: string; token: string; initialContext: string; textOnly?: boolean }>,
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('startSession timed out')), 2_000);
    session.startSession(config).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('RealtimeVoiceSession.web', () => {
  let root: renderer.ReactTestRenderer | null = null;
  let previousNavigator: Navigator | undefined;
  let previousMediaDevicesDescriptor: PropertyDescriptor | undefined;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn> | null = null;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

  function installNavigatorGetUserMedia(getUserMedia: () => Promise<unknown>) {
    previousNavigator = globalThis.navigator;
    const nav: any = previousNavigator ?? {};
    if (previousNavigator === undefined) {
      Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
    }
    previousMediaDevicesDescriptor = Object.getOwnPropertyDescriptor(nav, 'mediaDevices');
    Object.defineProperty(nav, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
  }

  async function mountSessionComponent() {
    const { RealtimeVoiceSession } = await import('./RealtimeVoiceSession.web');
    root = (await renderScreen(React.createElement(RealtimeVoiceSession))).tree;
    const { realtimeTransport } = await import('@/voice/runtime/realtime/RealtimeTransport');
    return realtimeTransport.getVoiceSession();
  }

  beforeEach(() => {
    vi.resetModules();
    conversationStartSession.mockReset();
    conversationEndSession.mockReset();
    conversationGetId.mockReset();
    conversationSendUserMessage.mockReset();
    conversationSendContextualUpdate.mockReset();
    conversationSetMicMuted.mockReset();
    setRealtimeStatus.mockReset();
    setRealtimeMode.mockReset();
    clearRealtimeModeDebounce.mockReset();
    getElevenLabsCodeFromPreference.mockReset();
    appendRealtimeVoiceTranscriptEvent.mockReset();
    getBindingByControlSessionId.mockReset();
    getBindingByControlSessionId.mockReturnValue(null);
    ensureVoiceBinding.mockReset();
    lastStartSessionOptions = null;
    configureModules();
    captureExceptionIfEnabledMock.mockReset();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    try {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
    } catch {
      // ignore
    } finally {
      root = null;
    }

    const nav: any = globalThis.navigator;
    if (previousNavigator === undefined) {
      try {
        // @ts-expect-error deleting test-only global navigator
        delete globalThis.navigator;
      } catch {
        // ignore
      }
    } else if (nav !== previousNavigator) {
      Object.defineProperty(globalThis, 'navigator', { value: previousNavigator, configurable: true });
    }

    const restoredNav: any = globalThis.navigator;
    if (restoredNav) {
      if (previousMediaDevicesDescriptor) {
        Object.defineProperty(restoredNav, 'mediaDevices', previousMediaDevicesDescriptor);
      } else {
        delete restoredNav.mediaDevices;
      }
    }

    previousNavigator = undefined;
    previousMediaDevicesDescriptor = undefined;
    consoleWarnSpy?.mockRestore();
    consoleWarnSpy = null;
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = null;
    vi.resetModules();
  });

  it('does not probe getUserMedia inside startSession (permission is centralized)', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error('should not be called');
    });
    installNavigatorGetUserMedia(getUserMedia);
    configureModules({ globalLanguagePreference: 'en', mappedLanguage: 'en' });

    const session = await mountSessionComponent();
    expect(session).not.toBeNull();

    const conversationId = await startSessionWithTimeout(session!, {
      sessionId: 's1',
      token: 't',
      initialContext: 'CTX',
    });

    expect(conversationId).toBe('conv_1');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('logs a sanitized registration failure when the voice session cannot be registered', async () => {
    const { realtimeTransport } = await import('@/voice/runtime/realtime/RealtimeTransport');
    const registerVoiceSessionSpy = vi.spyOn(realtimeTransport, 'registerVoiceSession').mockImplementation(() => {
      throw new Error('register_failed');
    });

    await mountSessionComponent();
    await act(async () => {});

    expect(captureExceptionIfEnabledMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionIfEnabledMock.mock.calls[0]?.[0]).toMatchObject({ message: 'register_failed' });
    expect(captureExceptionIfEnabledMock.mock.calls[0]?.[1]).toMatchObject({
      tags: {
        area: 'realtime_voice_session',
        platform: 'web',
      },
    });
    registerVoiceSessionSpy.mockRestore();
  });

  it('drops raw provider debug payloads before they can reach console logging', async () => {
    const previousDev = (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__;
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = true;
    const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    try {
      const session = await mountSessionComponent();
      await startSessionWithTimeout(session!, {
        sessionId: 's-debug',
        token: 'token_debug',
        initialContext: 'CTX',
      });
      const debugCallCountBefore = consoleDebugSpy.mock.calls.length;

      await act(async () => {
        lastStartSessionOptions.onDebug?.(new Error('TOP_SECRET_CONTEXT'));
      });

      const newDebugCalls = consoleDebugSpy.mock.calls.slice(debugCallCountBefore);
      const debugOutput = newDebugCalls
        .flatMap((call) => call.map((arg) => String(arg)))
        .join('\n');

      expect(debugOutput).not.toContain('TOP_SECRET_CONTEXT');
    } finally {
      consoleDebugSpy.mockRestore();
      (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = previousDev;
    }
  });

  it('passes mapped language and initial context into conversation start config', async () => {
    const { conversation, getElevenLabsCodeFromPreference } = configureModules({
      globalLanguagePreference: 'fr-pref',
      mappedLanguage: 'fr',
      startSessionResult: 'conv_lang',
    });

    const session = await mountSessionComponent();
    const conversationId = await startSessionWithTimeout(session!, {
      sessionId: 's-lang',
      token: 'token_lang',
      initialContext: 'CONTEXT_LANG',
    });

    expect(conversationId).toBe('conv_lang');
    expect(getElevenLabsCodeFromPreference).toHaveBeenCalledWith('fr-pref');
    expect(conversation.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationToken: 'token_lang',
        dynamicVariables: expect.objectContaining({
          sessionId: 's-lang',
          initialConversationContext: 'CONTEXT_LANG',
        }),
        overrides: expect.objectContaining({
          agent: {
            language: 'fr',
          },
        }),
      }),
    );
  });

  it('prefers adapter-specific language when configured (realtime_elevenlabs.assistantLanguage)', async () => {
    const { getElevenLabsCodeFromPreference } = configureModules({
      globalLanguagePreference: 'global-pref',
      adapterLanguagePreference: 'adapter-pref',
      mappedLanguage: 'fr',
      startSessionResult: 'conv_lang',
    });

    const session = await mountSessionComponent();
    await startSessionWithTimeout(session!, {
      sessionId: 's-lang',
      token: 'token_lang',
      initialContext: 'CONTEXT_LANG',
    });

    expect(getElevenLabsCodeFromPreference).toHaveBeenCalledWith('adapter-pref');
  });

  it('falls back to conversation.getId when startSession returns an empty id', async () => {
    const { conversation } = configureModules({
      startSessionResult: '',
      fallbackConversationId: 'conv_from_getId',
    });

    const session = await mountSessionComponent();
    const conversationId = await startSessionWithTimeout(session!, {
      sessionId: 's-fallback',
      token: 'token_fallback',
      initialContext: '',
    });

    expect(conversation.startSession).toHaveBeenCalledTimes(1);
    expect(conversation.getId).toHaveBeenCalled();
    expect(conversationId).toBe('conv_from_getId');
  });

  it('passes text-only mode into the provider start config when requested', async () => {
    const { conversation } = configureModules({
      startSessionResult: 'conv_text_only',
    });

    const session = await mountSessionComponent();
    await startSessionWithTimeout(session!, {
      sessionId: 's-text-only',
      token: 'token_text_only',
      initialContext: 'CONTEXT_TEXT_ONLY',
      textOnly: true,
      signedUrl: 'wss://signed.example',
    } as any);

    expect(conversation.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionType: 'websocket',
        signedUrl: 'wss://signed.example',
        textOnly: true,
        overrides: expect.objectContaining({
          conversation: {
            textOnly: true,
          },
        }),
      }),
    );
  });

  it('mirrors provider messages into the hidden voice conversation transcript binding', async () => {
    getBindingByControlSessionId.mockReturnValue({
      conversationSessionId: 'carrier-s1',
    });

    const session = await mountSessionComponent();
    await startSessionWithTimeout(session!, {
      sessionId: 's-transcript',
      token: 'token_transcript',
      initialContext: 'CTX',
    });

    await act(async () => {
      lastStartSessionOptions.onMessage?.({
        type: 'agent_response',
        agent_response_event: {
          agent_response: 'Hello from the web session',
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
  });

  it('records disconnect recovery through storage and the QA log', async () => {
    const session = await mountSessionComponent();
    await startSessionWithTimeout(session!, {
      sessionId: 's-disconnect',
      token: 'token_disconnect',
      initialContext: 'CTX',
    });

    await act(async () => {
      lastStartSessionOptions.onDisconnect?.();
    });

    expect(setRealtimeStatus).toHaveBeenCalledWith('disconnected');
    expect(setRealtimeMode).toHaveBeenCalledWith('idle', true);
    expect(clearRealtimeModeDebounce).toHaveBeenCalledTimes(1);
  });

  it('ends a superseded late ElevenLabs conversation before it can become active', async () => {
    const firstStart = createDeferred<TestConversationInstance>();
    const secondStart = createDeferred<TestConversationInstance>();
    const firstConversation: TestConversationInstance = {
      endSession: vi.fn(async () => {}),
      getId: vi.fn(() => 'conv_old'),
      setMicMuted: vi.fn(),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
    };
    const secondConversation: TestConversationInstance = {
      endSession: vi.fn(async () => {}),
      getId: vi.fn(() => 'conv_new'),
      setMicMuted: vi.fn(),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
    };
    conversationStartSession
      .mockImplementationOnce(async () => firstStart.promise)
      .mockImplementationOnce(async () => secondStart.promise);

    const session = await mountSessionComponent();
    const oldSessionStart = startSessionWithTimeout(session!, {
      sessionId: 's-old',
      token: 'token_old',
      initialContext: 'OLD',
    });
    const newSessionStart = startSessionWithTimeout(session!, {
      sessionId: 's-new',
      token: 'token_new',
      initialContext: 'NEW',
    });

    secondStart.resolve(secondConversation);
    await expect(newSessionStart).resolves.toBe('conv_new');

    firstStart.resolve(firstConversation);
    await expect(oldSessionStart).resolves.toBeNull();

    session!.sendTextMessage('still active');
    expect(firstConversation.endSession).toHaveBeenCalledTimes(1);
    expect(firstConversation.sendUserMessage).not.toHaveBeenCalled();
    expect(secondConversation.sendUserMessage).toHaveBeenCalledWith('still active');
  });

  it('cleans up transport-owned connecting state when the provider session component unmounts', async () => {
    const session = await mountSessionComponent();
    const { realtimeTransport } = await import('@/voice/runtime/realtime/RealtimeTransport');

    await startSessionWithTimeout(session!, {
      sessionId: 's-connecting',
      token: 'token_connecting',
      initialContext: 'CTX',
    });

    expect(realtimeTransport.getSessionSnapshot().status).toBe('connecting');

    await act(async () => {
      root?.unmount();
      root = null;
    });

    expect(realtimeTransport.getSessionSnapshot().status).toBe('disconnected');
    expect(setRealtimeStatus).toHaveBeenLastCalledWith('disconnected');
    expect(setRealtimeMode).toHaveBeenLastCalledWith('idle', true);
  });

  it('surfaces provider errors as recoverable QA entries without leaving realtime in error mode', async () => {
    const session = await mountSessionComponent();
    await startSessionWithTimeout(session!, {
      sessionId: 's-error',
      token: 'token_error',
      initialContext: 'CTX',
    });

    const previousDev = (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__;
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = true;
    try {
      await act(async () => {
        lastStartSessionOptions.onError?.(new Error('daemon unreachable'));
      });
    } finally {
      (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = previousDev;
    }

    expect(consoleWarnSpy).toHaveBeenCalledWith('Realtime voice not available:', 'provider_error');
    const warnOutput = consoleWarnSpy?.mock.calls.flat().map((arg) => String(arg)).join('\n') ?? '';
    expect(warnOutput).not.toContain('daemon unreachable');
    expect(setRealtimeStatus).toHaveBeenCalledWith('disconnected');
    expect(setRealtimeMode).toHaveBeenCalledWith('idle', true);
  });

  it('waits briefly for the conversation instance to remount before failing startSession', async () => {
    configureModules({ startSessionResult: 'conv_after_remount' });

    const session = await mountSessionComponent();
    expect(session).not.toBeNull();

    await act(async () => {
      root?.unmount();
      root = null;
    });

    const remountPromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await mountSessionComponent();
    })();

    const conversationId = await startSessionWithTimeout(session!, {
      sessionId: 's-after-remount',
      token: 'token_after_remount',
      initialContext: 'CTX',
    });

    await remountPromise;

    expect(conversationId).toBe('conv_after_remount');
  });

  it('fails startSession after component unmount because conversation instance is cleaned up', async () => {
    configureModules({ startSessionResult: 'conv_before_unmount' });

    const session = await mountSessionComponent();
    expect(session).not.toBeNull();

    await act(async () => {
      root?.unmount();
      root = null;
    });

    await expect(
      startSessionWithTimeout(session!, {
        sessionId: 's-after-unmount',
        token: 'token_after_unmount',
        initialContext: 'ignored',
      }),
    ).rejects.toThrow('Realtime voice session not initialized');
  });
});
