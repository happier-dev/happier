import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

type MachineContributionRegistryProjectionDescribeFn =
  typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;

const {
  machineContributionRegistryProjectionDescribe,
} = vi.hoisted(() => ({
  machineContributionRegistryProjectionDescribe: vi.fn<MachineContributionRegistryProjectionDescribeFn>(
    async () => ({ supported: false, reason: 'not-supported' }),
  ),
}));

const machineSpawnNewSession = vi.fn(async (_params: any) => ({ type: 'success', sessionId: 's_new' }));
const getActiveServerSnapshot = vi.fn(() => ({ serverId: 'server-a' }));
const resolveEffectiveWindowsRemoteSessionLaunchMode = vi.fn((_params: any) => ({ mode: null }));
const postprocessSpawnedSession = vi.fn(async (_params: any) => {});
const voiceTargetState = {
  primaryActionSessionId: null as string | null,
  lastFocusedSessionId: null as string | null,
};

function createBaseState(): any {
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
        metadata: { displayName: 'Leeroy MacBook Pro', host: 'leeroy-mbp' },
      },
    },
    settings: {
      recentMachinePaths: [
        { machineId: 'm1', path: '/Users/leeroy/projects/happier' },
      ],
    },
    sessionListRenderables: {},
    sessionListIndexByServerId: {},
    concurrentSessionListCacheByServerId: {},
  };
}

let state: any = createBaseState();

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
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => getActiveServerSnapshot(),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
  machineContributionRegistryProjectionDescribe: (...args: Parameters<MachineContributionRegistryProjectionDescribeFn>) =>
    machineContributionRegistryProjectionDescribe(...args),
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

describe('spawnSessionForVoiceTool', () => {
  beforeEach(() => {
    state = createBaseState();
    machineSpawnNewSession.mockClear();
    postprocessSpawnedSession.mockClear();
    getActiveServerSnapshot.mockClear();
    resolveEffectiveWindowsRemoteSessionLaunchMode.mockClear();
    machineContributionRegistryProjectionDescribe.mockReset();
    machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
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

  it('prefers the configured last-used backend target when no explicit agent override is provided', async () => {
    state.settings.lastUsedAgent = 'codex';
    state.settings.lastUsedBackendTarget = { kind: 'configuredAcpBackend', backendId: 'review-bot' };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot' }],
    };
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
    }));
  });

  it('does not treat the legacy customAcp fallback as permission to select a plugin backend from merged projection truth', async () => {
    state.settings.lastUsedAgent = 'customAcp';
    machineContributionRegistryProjectionDescribe.mockResolvedValue({
      supported: true,
      projection: {
        v: 1,
        providersById: {
          'acme.review.provider': {
            id: 'acme.review.provider',
            providerId: 'acme.review.provider',
            title: 'Acme Review Provider',
            channel: 'plugin',
            isBuiltIn: false,
            settingsBackendId: 'acme.review.backend',
          },
        },
        backendsById: {
          'acme.review.backend': {
            id: 'acme.review.backend',
            backendId: 'acme.review.backend',
            providerId: 'acme.review.provider',
            title: 'Acme Review Backend',
          },
        },
      },
    });

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({});

    expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('m1', expect.objectContaining({
      serverId: 'server-a',
      timeoutMs: 10_000,
    }));
    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'backend', backendId: 'claude' },
    }));
  });

  it('falls back to the last-used built-in target when the stored configured backend is stale', async () => {
    state.settings.lastUsedAgent = 'codex';
    state.settings.lastUsedBackendTarget = { kind: 'configuredAcpBackend', backendId: 'stale-review-bot' };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot' }],
    };
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'backend', backendId: 'codex' },
    }));
  });

  it('uses an explicit backendTargetKey for configured ACP backends instead of falling back to settings', async () => {
    state.settings.lastUsedAgent = 'claude';
    state.settings.lastUsedBackendTarget = { kind: 'builtInAgent', agentId: 'claude' };
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      backendTargetKey: 'acpBackend:review-bot',
      path: '/Users/leeroy/projects/happier',
    } as any);

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: expect.objectContaining({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }),
    }));
  });

  it('uses the canonical V2 backendTargetKey for configured ACP backends instead of falling back to settings', async () => {
    state.settings.lastUsedAgent = 'claude';
    state.settings.lastUsedBackendTarget = { kind: 'builtInAgent', agentId: 'claude' };
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      backendTargetKey: 'backend:review-bot:configured:review-bot',
      path: '/Users/leeroy/projects/happier',
    } as any);

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: expect.objectContaining({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }),
    }));
  });

  it('accepts a matching legacy configured ACP flavor carrier when a canonical configured backendTargetKey is provided', async () => {
    state.settings.lastUsedAgent = 'claude';
    state.settings.lastUsedBackendTarget = { kind: 'builtInAgent', agentId: 'claude' };
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      agentId: 'acp:review-bot',
      backendTargetKey: 'backend:review-bot:configured:review-bot',
      path: '/Users/leeroy/projects/happier',
    } as any);

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: expect.objectContaining({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }),
    }));
  });

  it('rejects the plain legacy customAcp carrier when a canonical configured backendTargetKey is provided', async () => {
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      agentId: 'customAcp',
      backendTargetKey: 'backend:review-bot:configured:review-bot',
      path: '/Users/leeroy/projects/happier',
    } as any);

    expect(machineSpawnNewSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'error',
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
    });
  });

  it('uses a canonical plugin backendTargetKey when the runtime carrier is explicit', async () => {
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      agentId: 'claude',
      backendTargetKey: 'backend:plugin-review-bot',
      path: '/Users/leeroy/projects/happier',
    } as any);

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'plugin-review-bot',
        sourceKind: 'built_in',
      },
    }));
  });

  it('prefers visible lookup session metadata when choosing a spawn target for the voice session', async () => {
    state.sessions = {
      ...state.sessions,
      s_spawn_target: {
        id: 's_spawn_target',
        metadata: {
          machineId: 'm_stale',
          path: '/Users/leeroy/projects/stale-target',
        },
      },
    };
    state.sessionListRenderables = {
      ...state.sessionListRenderables,
      s_spawn_target: {
        id: 's_spawn_target',
        updatedAt: 999,
        metadata: {
          machineId: 'm1',
          path: '/Users/leeroy/projects/happier',
        },
      },
    };
    state.sessionListIndexByServerId = {
      'server-a': [
        { type: 'session', sessionId: 's_spawn_target', serverId: 'server-a', serverName: 'Server A' },
      ],
    };
    voiceTargetState.primaryActionSessionId = 's_spawn_target';

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      directory: '/Users/leeroy/projects/happier',
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
