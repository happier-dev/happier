import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceConnectRecoveryTarget } from '@/components/voice/surface/resolveVoiceConnectRecoveryTarget';
import type { VoiceSurfaceRecovery } from '@/components/voice/surface/resolveVoiceSurfaceRecovery';

const state = vi.hoisted(() => ({
  openSettings: vi.fn(async () => undefined),
  retry: vi.fn(async () => undefined),
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
    retry: state.retry,
    toggle: state.toggle,
    bargeIn: vi.fn(),
    stop: vi.fn(),
    interrupt: vi.fn(),
    setMuted: vi.fn(),
  },
}));
vi.mock('@/utils/system/fireAndForget', () => ({ fireAndForget: (task: Promise<unknown>) => void task }));

const RUNTIME_TARGET = {
  agentId: 'codex',
  pluginId: 'acme.installed-agent',
  machineId: 'm2',
  serverId: 'server1',
} as const;

function context(overrides: Partial<{
  connectRecoveryTarget: VoiceConnectRecoveryTarget;
  runtimeRecoveryTarget: typeof RUNTIME_TARGET | null;
  attemptSessionId: string | null;
  startSessionId: string | null;
  globalStartAuthorized: boolean;
}> = {}) {
  return {
    connectRecoveryTarget: { kind: 'default' as const },
    runtimeRecoveryTarget: RUNTIME_TARGET,
    attemptSessionId: 's1',
    startSessionId: 's1',
    globalStartAuthorized: false,
    ...overrides,
  };
}

async function dispatch(
  recoveryAction: any,
  navigate: (href: unknown) => void = vi.fn(),
  overrides: Parameters<typeof context>[0] = {},
  setupIncomplete = false,
) {
  const { createVoiceAttemptRecoveryDispatch } = await import('./voiceAttemptRecovery');
  return createVoiceAttemptRecoveryDispatch({
    recoveryAction,
    setupIncomplete,
    context: context(overrides),
    navigate,
  });
}

describe('the one Voice recovery dispatch every placement fires', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens app voice settings for credential review', async () => {
    const navigate = vi.fn();
    (await dispatch('review_credentials', navigate))();
    expect(navigate).toHaveBeenCalledWith({
      pathname: '/settings/voice/conversations',
      params: { focus: 'provider' },
    });
  });

  it('opens the canonical execution-machine settings section for an unavailable machine', async () => {
    const navigate = vi.fn();
    (await dispatch('select_execution_machine', navigate))();
    expect(navigate).toHaveBeenCalledWith({
      pathname: '/settings/voice/conversations',
      params: { focus: 'execution_machine' },
    });
  });

  it('forwards the canonical selected service and account route for Connect recovery', async () => {
    const navigate = vi.fn();
    const route = {
      pathname: '/(app)/settings/connected-services/account',
      params: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
        accountId: 'account-work',
      },
    } as const;
    (await dispatch('connect_agent', navigate, {
      connectRecoveryTarget: { kind: 'exact', route } satisfies VoiceConnectRecoveryTarget,
    }))();
    expect(navigate).toHaveBeenCalledWith(route);
  });

  it('retains the existing Connected Services list for Connect recovery without selected context', async () => {
    const navigate = vi.fn();
    (await dispatch('connect_agent', navigate))();
    expect(navigate).toHaveBeenCalledWith('/settings/connected-services');
  });

  it('opens the canonical Voice binding setup when provider settings must be repaired', async () => {
    const navigate = vi.fn();
    (await dispatch('connect_agent', navigate, {
      connectRecoveryTarget: { kind: 'provider_settings' },
    }))();
    expect(navigate).toHaveBeenCalledWith({
      pathname: '/settings/voice/conversations',
      params: { focus: 'provider' },
    });
  });

  it('fails Connect recovery closed when selected context is stale or unavailable', async () => {
    const navigate = vi.fn();
    (await dispatch('connect_agent', navigate, {
      connectRecoveryTarget: { kind: 'unavailable' },
    }))();
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['install_agent_runtime', 'install'],
    ['update_agent_runtime', 'update'],
  ] as const)('routes %s to the exact qualified Agent runtime target', async (action, installIntent) => {
    const navigate = vi.fn();
    (await dispatch(action, navigate))();
    expect(navigate).toHaveBeenCalledWith({
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
    const navigate = vi.fn();
    (await dispatch('update_agent_runtime', navigate, { runtimeRecoveryTarget: null }))();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens platform settings for microphone permission recovery', async () => {
    (await dispatch('open_settings'))();
    expect(state.openSettings).toHaveBeenCalledTimes(1);
  });

  it('retries through the canonical voice session manager', async () => {
    (await dispatch('retry'))();
    expect(state.retry).toHaveBeenCalledWith('s1');
  });

  it('retries the conversation the surface named rather than falling back to a global start', async () => {
    (await dispatch('retry', vi.fn(), {
      attemptSessionId: null,
      startSessionId: 'named-session',
      globalStartAuthorized: false,
    }))();
    expect(state.retry).toHaveBeenCalledWith('named-session');
  });

  it('refuses a retry that has no conversation to retry', async () => {
    (await dispatch('reconnect', vi.fn(), {
      attemptSessionId: null,
      startSessionId: null,
      globalStartAuthorized: false,
    }))();
    expect(state.retry).not.toHaveBeenCalled();
  });

  it('finishes an unfinished provider setup in Voice settings when nothing has failed yet', async () => {
    const navigate = vi.fn();
    (await dispatch(null, navigate, {}, true))();
    expect(navigate).toHaveBeenCalledWith({
      pathname: '/settings/voice/conversations',
      params: { focus: 'provider' },
    });
  });

  it('does nothing when there is neither a failure nor an unfinished setup', async () => {
    const navigate = vi.fn();
    (await dispatch(null, navigate))();
    expect(navigate).not.toHaveBeenCalled();
    expect(state.toggle).not.toHaveBeenCalled();
  });
});

describe('whether an offered Voice recovery can reach a remedy', () => {
  async function available(
    recovery: VoiceSurfaceRecovery | null,
    overrides: Parameters<typeof context>[0] = {},
  ) {
    const { resolveVoiceAttemptRecoveryAvailable } = await import('./voiceAttemptRecovery');
    return resolveVoiceAttemptRecoveryAvailable(recovery, context(overrides));
  }

  it('withholds Connect recovery whose account cannot be resolved', async () => {
    const recovery = { kind: 'connect_agent', labelKey: 'voiceSurface.connectAgent' } as const;
    expect(await available(recovery)).toBe(true);
    expect(await available(recovery, { connectRecoveryTarget: { kind: 'unavailable' } })).toBe(false);
  });

  it('withholds Agent runtime recovery without an exact runtime target', async () => {
    const recovery = { kind: 'install_agent_runtime', labelKey: 'voiceSurface.installAgentRuntime' } as const;
    expect(await available(recovery)).toBe(true);
    expect(await available(recovery, { runtimeRecoveryTarget: null })).toBe(false);
  });

  it('withholds a retry with no conversation and no global start authority', async () => {
    const recovery = { kind: 'retry', labelKey: 'common.retry' } as const;
    expect(await available(recovery, {
      attemptSessionId: null,
      startSessionId: null,
      globalStartAuthorized: true,
    })).toBe(true);
    expect(await available(recovery, {
      attemptSessionId: null,
      startSessionId: null,
      globalStartAuthorized: false,
    })).toBe(false);
  });

  it('keeps settings-shaped recoveries available', async () => {
    expect(await available({ kind: 'open_settings', labelKey: 'modals.openSettings' })).toBe(true);
    expect(await available({ kind: 'review_credentials', labelKey: 'voiceSurface.reviewCredentials' })).toBe(true);
    expect(await available(null)).toBe(false);
  });
});
