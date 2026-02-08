import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

  function configureModules(options?: {
    languagePreference?: string | null;
    mappedLanguage?: string;
    startSessionResult?: string | null;
    fallbackConversationId?: string | null;
  }) {
    const conversation = {
      startSession: vi.fn(async () => options?.startSessionResult ?? 'conv_1'),
      endSession: vi.fn(async () => {}),
      getId: vi.fn(() => options?.fallbackConversationId ?? 'conv_1'),
      sendUserMessage: vi.fn(),
      sendContextualUpdate: vi.fn(),
    };

    const setRealtimeStatus = vi.fn();
    const setRealtimeMode = vi.fn();
    const clearRealtimeModeDebounce = vi.fn();
    const getElevenLabsCodeFromPreference = vi.fn(() => options?.mappedLanguage ?? 'en');

    vi.doMock('@elevenlabs/react', () => ({
      useConversation: () => conversation,
    }));

    vi.doMock('@/sync/storage', () => ({
      storage: {
        getState: () => ({
          settings: { voiceAssistantLanguage: options?.languagePreference ?? 'en' },
          setRealtimeStatus,
          setRealtimeMode,
          clearRealtimeModeDebounce,
        }),
      },
    }));

    vi.doMock('@/constants/Languages', () => ({
      getElevenLabsCodeFromPreference,
    }));

    return {
      conversation,
      setRealtimeStatus,
      setRealtimeMode,
      clearRealtimeModeDebounce,
      getElevenLabsCodeFromPreference,
    };
  }

  async function mountSessionComponent() {
    const { RealtimeVoiceSession } = await import('./RealtimeVoiceSession.web');
    await act(async () => {
      root = renderer.create(React.createElement(RealtimeVoiceSession));
    });
  }

  beforeEach(() => {
    vi.resetModules();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    try {
      if (root) {
        act(() => root?.unmount());
      }
    } catch {
      // ignore
    } finally {
      root = null;
    }

    const nav: any = globalThis.navigator;
    if (previousNavigator === undefined) {
      // Restore to "no navigator" if the test created one.
      try {
        // @ts-expect-error - deleting global navigator in tests
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
  });

  it('does not probe getUserMedia inside startSession (permission is centralized)', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error('should not be called');
    });
    installNavigatorGetUserMedia(getUserMedia);
    configureModules({ languagePreference: 'en', mappedLanguage: 'en' });
    const { getVoiceSession } = await import('./RealtimeSession');
    await mountSessionComponent();

    const session = getVoiceSession();
    expect(session).not.toBeNull();
    const conversationId = await session!.startSession({ sessionId: 's1', token: 't', initialContext: 'CTX' });
    expect(conversationId).toBe('conv_1');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('passes mapped language and initial context into conversation start config', async () => {
    const { conversation, getElevenLabsCodeFromPreference } = configureModules({
      languagePreference: 'fr-pref',
      mappedLanguage: 'fr',
      startSessionResult: 'conv_lang',
    });
    const { getVoiceSession } = await import('./RealtimeSession');
    await mountSessionComponent();

    const session = getVoiceSession();
    const conversationId = await session!.startSession({
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
        overrides: {
          agent: {
            language: 'fr',
          },
        },
      }),
    );
  });

  it('falls back to conversation.getId when startSession returns an empty id', async () => {
    const { conversation } = configureModules({
      startSessionResult: '',
      fallbackConversationId: 'conv_from_getId',
    });
    const { getVoiceSession } = await import('./RealtimeSession');
    await mountSessionComponent();

    const session = getVoiceSession();
    const conversationId = await session!.startSession({
      sessionId: 's-fallback',
      token: 'token_fallback',
      initialContext: '',
    });

    expect(conversation.startSession).toHaveBeenCalledTimes(1);
    expect(conversation.getId).toHaveBeenCalled();
    expect(conversationId).toBe('conv_from_getId');
  });

  it('fails startSession after component unmount because conversation instance is cleaned up', async () => {
    configureModules({ startSessionResult: 'conv_before_unmount' });
    const { getVoiceSession } = await import('./RealtimeSession');
    await mountSessionComponent();

    const session = getVoiceSession();
    expect(session).not.toBeNull();

    act(() => {
      root?.unmount();
      root = null;
    });

    await expect(
      session!.startSession({
        sessionId: 's-after-unmount',
        token: 'token_after_unmount',
        initialContext: 'ignored',
      }),
    ).rejects.toThrow('Realtime voice session not initialized');
  });
});
