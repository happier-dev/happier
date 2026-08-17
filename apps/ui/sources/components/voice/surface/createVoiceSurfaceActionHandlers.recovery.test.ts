import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceConnectRecoveryTarget } from './resolveVoiceConnectRecoveryTarget';

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

function params(recoveryAction: any, router = { push: vi.fn() }) {
  return {
    activeAdapterId: 'local_conversation',
    globalStartAuthorized: false,
    canMute: false,
    canStop: false,
    fallbackOpenConversationControlSessionId: null,
    openConversationSessionId: null,
    providerId: 'local_conversation',
    connectRecoveryTarget: { kind: 'default' as const },
    runtimeRecoveryTarget: {
      agentId: 'codex',
      pluginId: 'acme.installed-agent',
      machineId: 'm2',
      serverId: 'server1',
    },
    recoveryAction,
    routeSessionId: 's1',
    router,
    sessionId: 's1',
    snapSessionId: 's1',
    muted: false,
    startSessionId: 's1',
    variant: 'session' as const,
  };
}

describe('createVoiceSurfaceActionHandlers recovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens app voice settings for credential review', async () => {
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    const router = { push: vi.fn() };
    createVoiceSurfaceActionHandlers(params('review_credentials', router)).onRecover();
    expect(router.push).toHaveBeenCalledWith('/settings/voice');
  });

  it('records focus return through the canonical navigation owner before leaving for recovery', async () => {
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    const router = { push: vi.fn() };
    const navigateWithFocusReturn = vi.fn((navigate: () => void) => navigate());
    createVoiceSurfaceActionHandlers({
      ...params('review_credentials', router),
      navigateWithFocusReturn,
    }).onRecover();

    expect(navigateWithFocusReturn).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/settings/voice');
  });

  it('forwards the canonical selected service and account route for Connect recovery', async () => {
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    const router = { push: vi.fn() };
    createVoiceSurfaceActionHandlers({
      ...params('connect_agent', router),
      connectRecoveryTarget: {
        kind: 'exact',
        route: {
          pathname: '/(app)/settings/connected-services/account',
          params: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
            accountId: 'account-work',
          },
        },
      } satisfies VoiceConnectRecoveryTarget,
    }).onRecover();
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(app)/settings/connected-services/account',
      params: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
        accountId: 'account-work',
      },
    });
  });

  it('retains the existing Connected Services list for Connect recovery without selected context', async () => {
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    const router = { push: vi.fn() };
    createVoiceSurfaceActionHandlers(params('connect_agent', router)).onRecover();
    expect(router.push).toHaveBeenCalledWith('/settings/connected-services');
  });

  it('opens the canonical Voice binding setup when provider settings must be repaired', async () => {
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    const router = { push: vi.fn() };
    createVoiceSurfaceActionHandlers({
      ...params('connect_agent', router),
      connectRecoveryTarget: { kind: 'provider_settings' },
    }).onRecover();
    expect(router.push).toHaveBeenCalledWith('/settings/voice');
  });

  it('fails Connect recovery closed when selected context is stale or unavailable', async () => {
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    const router = { push: vi.fn() };
    createVoiceSurfaceActionHandlers({
      ...params('connect_agent', router),
      connectRecoveryTarget: { kind: 'unavailable' },
    }).onRecover();
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each([
    ['install_agent_runtime', 'install'],
    ['update_agent_runtime', 'update'],
  ] as const)('routes %s to the exact qualified Agent runtime target', async (action, installIntent) => {
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    const router = { push: vi.fn() };
    createVoiceSurfaceActionHandlers(params(action, router)).onRecover();
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(app)/settings/agents/[agentId]',
      params: {
        agentId: 'codex',
        pluginId: 'acme.installed-agent',
        machineId: 'm2',
        serverId: 'server1',
        installIntent,
      },
    });
  });

  it('fails Agent runtime recovery closed when exact target identity is unavailable', async () => {
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    const router = { push: vi.fn() };
    createVoiceSurfaceActionHandlers({
      ...params('update_agent_runtime', router),
      runtimeRecoveryTarget: null,
    }).onRecover();
    expect(router.push).not.toHaveBeenCalled();
  });

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
      ...params(null, router),
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
      ...params(null, router),
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

  it('opens platform settings for microphone permission recovery', async () => {
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    createVoiceSurfaceActionHandlers(params('open_settings')).onRecover();
    expect(state.openSettings).toHaveBeenCalledTimes(1);
  });

  it('retries through the canonical voice session manager', async () => {
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    createVoiceSurfaceActionHandlers(params('retry')).onRecover();
    expect(state.toggle).toHaveBeenCalledWith('s1');
  });

  it('waits for the canonical interrupted transition before haptic feedback', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000);
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    createVoiceSurfaceActionHandlers(params(null)).onBargeIn();
    expect(state.bargeIn).toHaveBeenCalledWith('s1');
    expect(state.hapticsLight).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});
