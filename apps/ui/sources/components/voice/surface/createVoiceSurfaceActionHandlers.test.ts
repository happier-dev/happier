import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  hapticsLight: vi.fn(),
  bargeIn: vi.fn(async () => undefined),
  openSettings: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  toggle: vi.fn(async () => undefined),
  ensureBoundForOpenConversation: vi.fn(),
}));

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  return {
    ...actual,
    Linking: { ...actual.Linking, openSettings: state.openSettings },
    Platform: { ...actual.Platform, OS: 'ios' },
  };
});
vi.mock('@/voice/session/voiceSession', () => ({
  voiceSessionManager: {
    toggle: state.toggle,
    bargeIn: state.bargeIn,
    stop: state.stop,
    interrupt: vi.fn(),
    setMuted: vi.fn(),
  },
}));
vi.mock('@/components/ui/theme/haptics', () => ({ hapticsLight: state.hapticsLight }));
vi.mock('@/voice/agent/teleportVoiceAgentToSessionRoot', () => ({ teleportVoiceAgentToSessionRoot: vi.fn() }));
vi.mock('@/voice/binding/voiceConversationBindingRuntime', () => ({
  voiceSessionBindingManager: {
    ensureBoundForOpenConversation: state.ensureBoundForOpenConversation,
  },
}));
vi.mock('@/utils/system/fireAndForget', () => ({ fireAndForget: (task: Promise<unknown>) => void task }));

function params(router = { push: vi.fn() }) {
  return {
    activeAdapterId: 'local_conversation',
    fallbackOpenConversationControlSessionId: null,
    openConversationSessionId: null,
    providerId: 'local_conversation',
    routeSessionId: 's1',
    router,
    sessionId: 's1',
    snapSessionId: 's1',
    variant: 'session' as const,
  };
}

describe('createVoiceSurfaceActionHandlers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retains the original Open Conversation trigger while asynchronous binding moves focus', async () => {
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    const router = { push: vi.fn() };
    let activeTrigger = 'open-conversation';
    let restoredTrigger: string | null = null;
    const navigateWithFocusReturn = vi.fn((navigate: () => void) => {
      restoredTrigger = activeTrigger;
      navigate();
    });
    const capturedTrigger = activeTrigger;
    const focusReturnToken = {
      navigate: vi.fn((navigate: () => void) => {
        restoredTrigger = capturedTrigger;
        navigate();
      }),
      cancel: vi.fn(),
    };
    const captureNavigationFocusReturn = vi.fn(() => focusReturnToken);
    let resolveBinding!: (value: Readonly<{ conversationSessionId: string }>) => void;
    state.ensureBoundForOpenConversation.mockImplementationOnce(() => new Promise((resolve) => {
      resolveBinding = resolve;
    }));

    createVoiceSurfaceActionHandlers({
      ...params(router),
      activeAdapterId: 'happier.agent.codex/realtime-codex',
      fallbackOpenConversationControlSessionId: 'control-session',
      openConversationSessionId: 'conversation-before-binding',
      providerId: 'happier.agent.codex/realtime-codex',
      captureNavigationFocusReturn,
      navigateWithFocusReturn,
    }).onOpenConversation();

    expect(captureNavigationFocusReturn).toHaveBeenCalledTimes(1);
    expect(navigateWithFocusReturn).not.toHaveBeenCalled();
    activeTrigger = 'different-control';
    resolveBinding({ conversationSessionId: 'conversation-after-binding' });
    await vi.waitFor(() => {
      expect(focusReturnToken.navigate).toHaveBeenCalledTimes(1);
    });
    expect(restoredTrigger).toBe('open-conversation');
    expect(navigateWithFocusReturn).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith('/session/conversation-after-binding');
  });

  it('opens Voice History when the active direct-media binding has no ordinary session destination', async () => {
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    const router = { push: vi.fn() };
    state.ensureBoundForOpenConversation.mockResolvedValueOnce({
      conversationSessionId: null,
    });

    createVoiceSurfaceActionHandlers({
      ...params(router),
      fallbackOpenConversationControlSessionId: 'global-voice-control',
      openConversationSessionId: 'voice-history-carrier',
      routeSessionId: null,
      sessionId: null,
      variant: 'sidebar',
    }).onOpenConversation();

    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/settings/voice-history');
    });
  });

  it('waits for the canonical interrupted transition before haptic feedback', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000);
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    createVoiceSurfaceActionHandlers(params()).onBargeIn();
    expect(state.bargeIn).toHaveBeenCalledWith('s1');
    expect(state.hapticsLight).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});
