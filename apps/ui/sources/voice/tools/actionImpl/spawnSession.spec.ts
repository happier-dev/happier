import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineSpawnNewSession = vi.fn(async (_params: any) => ({ type: 'success', sessionId: 's_new' }));
const getActiveServerSnapshot = vi.fn(() => ({ serverId: 'server-a' }));
const resolveEffectiveWindowsRemoteSessionLaunchMode = vi.fn((_params: any) => ({ mode: null }));
const postprocessSpawnedSession = vi.fn(async (_params: any) => {});
const resolveSpawnAgentIdFromState = vi.fn((_value: any) => 'claude');
const voiceTargetState = {
  primaryActionSessionId: null,
  lastFocusedSessionId: null,
};

const state: any = {
  sessions: {
    s_new: {
      id: 's_new',
      metadata: { summary: { text: 'Voice Workspace Label Probe' } },
    },
  },
  machines: {
    m1: {
      id: 'm1',
      metadata: { displayName: 'Leeroy MacBook Pro', host: 'leeroy-mbp' },
    },
  },
  settings: {
    recentMachinePaths: [
      { machineId: 'm1', path: '/Users/leeroy/projects/happier' },
    ],
  },
};

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => state,
  },
}));

vi.mock('@/sync/ops/machines', () => ({
  machineSpawnNewSession: (params: any) => machineSpawnNewSession(params),
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
});
