import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

const machineSpawnNewSession = vi.fn(async (params: any) => ({
  type: 'success',
  sessionId: 's_new',
  spawnAttemptCustody: {
    status: 'completed',
    userAttemptId: params.userAttemptId,
    spawnNonce: 'nonce-s-new',
    targetFingerprint: 'target-s-new',
  },
}));
const getActiveServerSnapshot = vi.fn(() => ({ serverId: 'server-a' }));
const resolveEffectiveWindowsRemoteSessionLaunchMode = vi.fn((_params: any) => ({ mode: null }));
const postprocessSpawnedSession = vi.fn(async (_params: any) => {});
const resolveSpawnAgentIdFromState = vi.fn((_value: any) => 'claude');
const voiceTargetState = {
  primaryActionSessionId: null,
  lastFocusedSessionId: null,
};

function createState(): any {
  return {
    sessions: {
      s_new: {
        id: 's_new',
        metadata: { summary: { text: 'Voice Workspace Label Probe' } },
      },
    },
    machines: {
      m1: {
        id: 'm1',
        active: true,
        activeAt: Date.now(),
        spawnReadinessStatus: 'ready',
        metadata: { displayName: 'Leeroy MacBook Pro', host: 'leeroy-mbp' },
        daemonState: { startedWithCliVersion: '0.2.10-dev.41' },
      },
    },
    settings: {
      recentMachinePaths: [
        { machineId: 'm1', path: '/Users/leeroy/projects/happier' },
      ],
    },
  };
}

let state: any = createState();

installVoiceToolActionImplCommonModuleMocks({
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: {
        getState: () => state,
      } as typeof import('@/sync/domains/state/storage').storage,
    });
  },
});

vi.mock('@/sync/ops/machines', () => ({
  machineSpawnNewSession: (params: any) => machineSpawnNewSession(params),
  machineSpawnNewSessionUntilResolved: (params: any) => machineSpawnNewSession(params),
  completeMachineSpawnAttemptCustody: vi.fn(async () => true),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => getActiveServerSnapshot(),
}));

vi.mock('@/voice/runtime/voiceTargetStore', () => ({
  useVoiceTargetStore: {
    getState: () => voiceTargetState,
  },
}));

vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode', () => ({
  resolveEffectiveWindowsRemoteSessionLaunchMode: (params: any) => resolveEffectiveWindowsRemoteSessionLaunchMode(params),
}));

vi.mock('./spawnSessionPostProcess', () => ({
  postprocessSpawnedSession: (params: any) => postprocessSpawnedSession(params),
}));

vi.mock('./spawnSessionAgent', () => ({
  resolveSpawnAgentIdFromState: (value: any) => resolveSpawnAgentIdFromState(value),
}));

describe('spawnSessionForVoiceTool', () => {
  beforeEach(() => {
    state = createState();
    machineSpawnNewSession.mockClear();
    postprocessSpawnedSession.mockClear();
    getActiveServerSnapshot.mockClear();
    resolveEffectiveWindowsRemoteSessionLaunchMode.mockClear();
    resolveSpawnAgentIdFromState.mockClear();
    voiceTargetState.primaryActionSessionId = null;
    voiceTargetState.lastFocusedSessionId = null;
  });

  it('spawns from the explicit path and returns human-readable target and session labels', async () => {
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result: any = await spawnSessionForVoiceTool({
      path: '/Users/leeroy/projects/happier',
      tag: 'voice-qa',
    });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      directory: '/Users/leeroy/projects/happier',
    }));
    const spawnRequest = machineSpawnNewSession.mock.calls[0]?.[0] as { userAttemptId: string };
    expect(postprocessSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's_new',
      serverId: 'server-a',
      firstTurnLocalId: `voice-spawn-first-turn:${spawnRequest.userAttemptId}`,
    }));
    expect(result).toMatchObject({
      type: 'success',
      sessionId: 's_new',
      session: {
        id: 's_new',
        title: 'Voice Workspace Label Probe',
      },
      target: {
        label: 'happier — Leeroy MacBook Pro',
      },
    });
  });

  it('does not apply tag or first input to a session rejoined from a different spawn attempt', async () => {
    machineSpawnNewSession.mockResolvedValueOnce({
      type: 'success',
      sessionId: 's_new',
      spawnAttemptCustody: {
        status: 'completed',
        userAttemptId: 'different-attempt',
        spawnNonce: 'different-nonce',
        targetFingerprint: 'target-a',
      },
    });
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      path: '/Users/leeroy/projects/happier',
      tag: 'must-not-apply',
      initialMessage: 'must not send',
    });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      userAttemptId: expect.stringMatching(/^ui-session-attempt-/),
    }));
    expect(postprocessSpawnedSession).not.toHaveBeenCalled();
  });

  it('hands the initial message to a compatible daemon instead of post-spawn processing', async () => {
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      path: '/Users/leeroy/projects/happier',
      initialMessage: 'start durably',
    });

    const spawnRequest = machineSpawnNewSession.mock.calls[0]?.[0] as {
      userAttemptId: string;
      pendingFirstInput?: unknown;
    };
    expect(spawnRequest.pendingFirstInput).toEqual({
      text: 'start durably',
      localId: `voice-spawn-first-turn:${spawnRequest.userAttemptId}`,
    });
    expect(postprocessSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      initialMessage: null,
    }));
  });

  it('falls back to the freshest recent target when no explicit path is provided', async () => {
    state.settings.recentMachinePaths = [
      { machineId: 'm1', path: 'C:/Repo/.worktrees/Feature-Auth' },
    ];
    state.sessions = {
      ...state.sessions,
      s_windows_old: {
        id: 's_windows_old',
        updatedAt: 100,
        metadata: { machineId: 'm1', path: 'C:/Repo/.worktrees/Feature-Auth' },
      },
      s_windows_new: {
        id: 's_windows_new',
        updatedAt: 250,
        metadata: { machineId: 'm1', path: 'c:\\repo\\.worktrees\\feature-auth\\' },
      },
    };

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      directory: 'C:/Repo/.worktrees/Feature-Auth',
    }));
  });

  it('fails when an explicit host cannot be resolved instead of falling back to another machine', async () => {
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      host: 'missing-host',
      path: '/Users/leeroy/projects/happier',
    });

    expect(machineSpawnNewSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'error',
      errorCode: 'host_not_found',
      errorMessage: 'host_not_found',
      host: 'missing-host',
    });
  });

  it('returns ambiguity instead of picking the first same-host machine for explicit voice host requests', async () => {
    state.machines = {
      m_old: {
        id: 'm_old',
        active: true,
        activeAt: Date.now(),
        spawnReadinessStatus: 'ready',
        metadata: { displayName: 'Old', host: 'leeroy-mbp' },
      },
      m_current: {
        id: 'm_current',
        active: true,
        activeAt: Date.now(),
        spawnReadinessStatus: 'ready',
        metadata: { displayName: 'Current', host: 'leeroy-mbp' },
      },
    };
    state.settings.recentMachinePaths = [
      { machineId: 'm_current', path: '/Users/leeroy/projects/current' },
    ];

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      host: 'leeroy-mbp',
      path: '/Users/leeroy/projects/current',
    });

    expect(machineSpawnNewSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'error',
      errorCode: 'host_ambiguous',
      errorMessage: 'host_ambiguous',
      host: 'leeroy-mbp',
    });
  });

  it('selects the unique requested host when voice provides only host and path', async () => {
    state.machines = {
      m_voice: {
        id: 'm_voice',
        active: true,
        activeAt: Date.now(),
        spawnReadinessStatus: 'ready',
        metadata: { displayName: 'Voice Host', host: 'voice-host' },
      },
    };
    state.settings.recentMachinePaths = [];

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      host: 'voice-host',
      path: '/Users/leeroy/projects/voice',
    });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_voice',
      directory: '/Users/leeroy/projects/voice',
    }));
    expect(result).toMatchObject({
      type: 'success',
      sessionId: 's_new',
    });
  });

  it('switches away from the fallback target when a different host resolves uniquely', async () => {
    state.machines = {
      m_fallback: {
        id: 'm_fallback',
        active: true,
        activeAt: Date.now(),
        spawnReadinessStatus: 'ready',
        metadata: { displayName: 'Fallback Host', host: 'fallback-host' },
      },
      m_requested: {
        id: 'm_requested',
        active: true,
        activeAt: Date.now(),
        spawnReadinessStatus: 'ready',
        metadata: { displayName: 'Requested Host', host: 'requested-host' },
      },
    };
    state.settings.recentMachinePaths = [
      { machineId: 'm_fallback', path: '/Users/leeroy/projects/fallback' },
    ];

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      host: 'requested-host',
      path: '/Users/leeroy/projects/requested',
    });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_requested',
      directory: '/Users/leeroy/projects/requested',
    }));
    expect(result).toMatchObject({
      type: 'success',
      sessionId: 's_new',
    });
  });

  it('keeps the fallback directory when a host-only request resolves uniquely to a different machine', async () => {
    state.machines = {
      m_fallback: {
        id: 'm_fallback',
        active: true,
        activeAt: Date.now(),
        spawnReadinessStatus: 'ready',
        metadata: { displayName: 'Fallback Host', host: 'fallback-host' },
      },
      m_requested: {
        id: 'm_requested',
        active: true,
        activeAt: Date.now(),
        spawnReadinessStatus: 'ready',
        metadata: { displayName: 'Requested Host', host: 'requested-host' },
      },
    };
    state.settings.recentMachinePaths = [
      { machineId: 'm_fallback', path: '/Users/leeroy/projects/fallback' },
    ];

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      host: 'requested-host',
    });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_requested',
      directory: '/Users/leeroy/projects/fallback',
    }));
    expect(result).toMatchObject({
      type: 'success',
      sessionId: 's_new',
    });
  });

  it('returns host ambiguity for duplicate ready host matches even with an explicit path', async () => {
    state.machines = {
      m_a: {
        id: 'm_a',
        active: true,
        activeAt: Date.now(),
        spawnReadinessStatus: 'ready',
        metadata: { displayName: 'A', host: 'duplicate-host' },
      },
      m_b: {
        id: 'm_b',
        active: true,
        activeAt: Date.now(),
        spawnReadinessStatus: 'ready',
        metadata: { displayName: 'B', host: 'duplicate-host' },
      },
    };
    state.settings.recentMachinePaths = [];

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      host: 'duplicate-host',
      path: '/Users/leeroy/projects/voice',
    });

    expect(machineSpawnNewSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'error',
      errorCode: 'host_ambiguous',
      errorMessage: 'host_ambiguous',
      host: 'duplicate-host',
    });
  });

  it('does not spawn when the only matching machine is online but exact readiness is unknown', async () => {
    state.machines = {
      m_unknown: {
        id: 'm_unknown',
        active: true,
        activeAt: Date.now(),
        metadata: { displayName: 'Unknown Host', host: 'unknown-host' },
      },
    };
    state.settings.recentMachinePaths = [
      { machineId: 'm_unknown', path: '/Users/leeroy/projects/voice' },
    ];

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      host: 'unknown-host',
      path: '/Users/leeroy/projects/voice',
    });

    expect(machineSpawnNewSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'error',
      errorCode: 'spawn_target_unavailable',
      errorMessage: 'spawn_target_unavailable',
      machineId: 'm_unknown',
      readinessStatus: 'unknown',
    });
  });
});
