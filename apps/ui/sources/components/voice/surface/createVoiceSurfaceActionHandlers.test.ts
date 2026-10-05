import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  hapticsLight: vi.fn(),
  bargeIn: vi.fn(async () => undefined),
  openSettings: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  toggle: vi.fn(async () => undefined),
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

  it('waits for the canonical interrupted transition before haptic feedback', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000);
    const { createVoiceSurfaceActionHandlers } = await import('./createVoiceSurfaceActionHandlers');
    createVoiceSurfaceActionHandlers(params()).onBargeIn();
    expect(state.bargeIn).toHaveBeenCalledWith('s1');
    expect(state.hapticsLight).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});
