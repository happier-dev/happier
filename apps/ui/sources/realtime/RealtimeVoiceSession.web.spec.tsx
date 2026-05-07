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
  conversationId?: string | null;
}>;

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
const setRealtimeStatus = vi.fn();
const setRealtimeMode = vi.fn();
const clearRealtimeModeDebounce = vi.fn();
const getElevenLabsCodeFromPreference = vi.fn((_preference?: string | null) => 'en');
const appendRealtimeVoiceTranscriptEvent = vi.fn();
const getBindingByControlSessionId = vi.fn((_controlSessionId: string) => null as any);
const ensureVoiceBinding = vi.fn(async (_params: any) => null);
let lastStartSessionOptions: any = null;
let registeredVoiceSession: any = null;
let currentRealtimeControlSessionId: string | null = null;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

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

vi.mock('@elevenlabs/react', () => ({
  Conversation: {
    startSession: (opts: any) => {
      lastStartSessionOptions = opts;
      return conversationStartSession(opts);
    },
  },
  useConversation: (opts: any) => {
    return ({
      startSession: legacyHookStartSession,
      endSession: conversationEndSession,
      getId: conversationGetId,
      sendUserMessage: conversationSendUserMessage,
      sendContextualUpdate: conversationSendContextualUpdate,
    });
  },
}));

vi.mock('@/constants/Languages', () => ({
  getElevenLabsCodeFromPreference,
}));
vi.mock('./realtimeClientTools', () => ({
  realtimeClientTools: {},
}));
vi.mock('./RealtimeSession', () => ({
  registerVoiceSession: (session: any) => {
    registeredVoiceSession = session;
  },
  getVoiceSession: () => registeredVoiceSession,
  setCurrentRealtimeControlSessionId: (sessionId: string | null) => {
    currentRealtimeControlSessionId = sessionId;
  },
  getCurrentRealtimeControlSessionId: () => currentRealtimeControlSessionId,
}));
vi.mock('@/voice/sessionBinding/resolveVoiceSessionBinding', () => ({
  resolveVoiceSessionBindingByControlSessionId: (params: { controlSessionId: string }) =>
    getBindingByControlSessionId(params.controlSessionId),
}));
vi.mock('./realtimeVoiceTranscriptBridge', () => ({
  appendRealtimeVoiceTranscriptEvent: (params: any) => appendRealtimeVoiceTranscriptEvent(params),
}));
vi.mock('@/voice/sessionBinding/voiceSessionBindingRuntime', () => ({
  voiceSessionBindingManager: {
    ensureBound: (params: any) => ensureVoiceBinding(params),
    syncTargetSession: vi.fn(),
  },
}));

function configureModules(options?: ConfigureModulesOptions) {
  languagePreferences.global = options?.globalLanguagePreference ?? 'en';
  languagePreferences.adapter = options?.adapterLanguagePreference ?? null;
  const configuredConversationId = Object.prototype.hasOwnProperty.call(options ?? {}, 'conversationId')
    ? options?.conversationId ?? null
    : 'conv_1';
  conversationStartSession.mockImplementation(async () => conversationInstance);
  legacyHookStartSession.mockImplementation(async () => 'legacy_hook_conv');
  conversationEndSession.mockImplementation(async () => {});
  conversationGetId.mockImplementation(() => configuredConversationId);
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
    startSession: (config: Readonly<{ sessionId: string; token?: string; signedUrl?: string; initialContext: string; textOnly?: boolean }>) => Promise<string | null>;
  }>,
  config: Readonly<{ sessionId: string; token?: string; signedUrl?: string; initialContext: string; textOnly?: boolean }>,
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

describe('RealtimeVoiceSession.web', () => {
  let root: renderer.ReactTestRenderer | null = null;
  let previousNavigator: Navigator | undefined;
  let previousMediaDevicesDescriptor: PropertyDescriptor | undefined;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn> | null = null;

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
    const { getVoiceSession } = await import('./RealtimeSession');
    return getVoiceSession();
  }

  beforeEach(() => {
    vi.resetModules();
    conversationStartSession.mockReset();
    legacyHookStartSession.mockReset();
    conversationEndSession.mockReset();
    conversationGetId.mockReset();
    conversationSendUserMessage.mockReset();
    conversationSendContextualUpdate.mockReset();
    setRealtimeStatus.mockReset();
    setRealtimeMode.mockReset();
    clearRealtimeModeDebounce.mockReset();
    getElevenLabsCodeFromPreference.mockReset();
    appendRealtimeVoiceTranscriptEvent.mockReset();
    getBindingByControlSessionId.mockReset();
    getBindingByControlSessionId.mockReturnValue(null);
    ensureVoiceBinding.mockReset();
    lastStartSessionOptions = null;
    registeredVoiceSession = null;
    currentRealtimeControlSessionId = null;
    configureModules();
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

  it('starts through the current ElevenLabs Conversation API with mapped language and initial context', async () => {
    const { conversation, getElevenLabsCodeFromPreference } = configureModules({
      globalLanguagePreference: 'fr-pref',
      mappedLanguage: 'fr',
      conversationId: 'conv_lang',
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
        connectionType: 'webrtc',
        textOnly: false,
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
      conversationId: 'conv_lang',
    });

    const session = await mountSessionComponent();
    await startSessionWithTimeout(session!, {
      sessionId: 's-lang',
      token: 'token_lang',
      initialContext: 'CONTEXT_LANG',
    });

    expect(getElevenLabsCodeFromPreference).toHaveBeenCalledWith('adapter-pref');
  });

  it('returns null when the started conversation has no id', async () => {
    const { conversation } = configureModules({
      conversationId: null,
    });

    const session = await mountSessionComponent();
    const conversationId = await startSessionWithTimeout(session!, {
      sessionId: 's-fallback',
      token: 'token_fallback',
      initialContext: '',
    });

    expect(conversation.startSession).toHaveBeenCalledTimes(1);
    expect(conversation.getId).toHaveBeenCalled();
    expect(conversationId).toBeNull();
  });

  it('keeps the newer conversation active when an older start resolves later', async () => {
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

    const session = await mountSessionComponent();
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
  });

  it('passes text-only mode into the provider start config when requested', async () => {
    const { conversation } = configureModules({
      conversationId: 'conv_text_only',
    });

    const session = await mountSessionComponent();
    await startSessionWithTimeout(session!, {
      sessionId: 's-text-only',
      token: 'token_text_only',
      initialContext: 'CONTEXT_TEXT_ONLY',
      textOnly: true,
      signedUrl: 'wss://signed.example',
    });

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
    expect(conversation.startSession.mock.lastCall?.[0]).not.toHaveProperty('conversationToken');
  });

  it('mirrors provider messages into the hidden voice conversation transcript binding', async () => {
    getBindingByControlSessionId.mockReturnValueOnce({
      conversationSessionId: 'carrier-s1',
    });

    const session = await mountSessionComponent();
    await startSessionWithTimeout(session!, {
      sessionId: 's-transcript',
      token: 'token_transcript',
      initialContext: 'CTX',
    });

    await act(async () => {
      lastStartSessionOptions?.onMessage?.({
        source: 'ai',
        role: 'agent',
        message: 'Hello from the web session',
        event_id: 1,
      });
    });

    expect(appendRealtimeVoiceTranscriptEvent).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      payload: expect.objectContaining({
        role: 'agent',
        message: 'Hello from the web session',
      }),
    });
  });

  it('fails startSession after component unmount because conversation instance is cleaned up', async () => {
    configureModules({ conversationId: 'conv_before_unmount' });

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
