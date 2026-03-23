import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

type ConfigureModulesOptions = Readonly<{
  globalLanguagePreference?: string | null;
  adapterLanguagePreference?: string | null;
  mappedLanguage?: string;
  startSessionResult?: string | null;
  fallbackConversationId?: string | null;
}>;

const conversationStartSession = vi.fn(async () => 'conv_1');
const conversationEndSession = vi.fn(async () => {});
const conversationGetId = vi.fn(() => 'conv_1');
const conversationSendUserMessage = vi.fn();
const conversationSendContextualUpdate = vi.fn();
const setRealtimeStatus = vi.fn();
const setRealtimeMode = vi.fn();
const clearRealtimeModeDebounce = vi.fn();
const getElevenLabsCodeFromPreference = vi.fn((_preference?: string | null) => 'en');
const appendRealtimeVoiceTranscriptEvent = vi.fn();
const getBindingByControlSessionId = vi.fn((_controlSessionId: string) => null as any);
const ensureVoiceBinding = vi.fn(async (_params: any) => null);
let lastConversationOptions: any = null;
let conversationOptionsCalls: any[] = [];
let registeredVoiceSession: any = null;
let currentRealtimeControlSessionId: string | null = null;

const languagePreferences = {
  global: 'en' as string | null,
  adapter: null as string | null,
};

vi.mock('@elevenlabs/react', () => ({
  useConversation: (opts: any) => {
    lastConversationOptions = opts;
    conversationOptionsCalls.push(opts);
    return ({
      startSession: conversationStartSession,
      endSession: conversationEndSession,
      getId: conversationGetId,
      sendUserMessage: conversationSendUserMessage,
      sendContextualUpdate: conversationSendContextualUpdate,
    });
  },
}));

vi.mock('@/sync/domains/state/storage', async () => {
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
});

vi.mock('@/constants/Languages', () => ({
  getElevenLabsCodeFromPreference,
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
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
  conversationStartSession.mockImplementation(async () => options?.startSessionResult ?? 'conv_1');
  conversationEndSession.mockImplementation(async () => {});
  conversationGetId.mockImplementation(() => options?.fallbackConversationId ?? 'conv_1');
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
    lastConversationOptions = null;
    conversationOptionsCalls = [];
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
      }),
    );
    expect(conversationOptionsCalls.some((options) => options?.textOnly === true)).toBe(true);
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
      lastConversationOptions.onMessage?.({
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
