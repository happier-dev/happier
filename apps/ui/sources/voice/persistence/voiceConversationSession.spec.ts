import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { installVoiceStorageModuleMocks } from './installVoiceStorageModuleMocks';

type MachineContributionRegistryProjectionDescribeFn =
  typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;

const {
  machineContributionRegistryProjectionDescribe,
} = vi.hoisted(() => ({
  machineContributionRegistryProjectionDescribe: vi.fn<MachineContributionRegistryProjectionDescribeFn>(
    async () => ({ supported: false, reason: 'not-supported' }),
  ),
}));

type TestState = {
  settings: any;
  machines: Record<string, any>;
  sessions: Record<string, any>;
  sessionListRenderables?: Record<string, any>;
  sessionListIndexByServerId?: Record<string, any>;
  concurrentSessionListCacheByServerId?: Record<string, any>;
  getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
};

let state: TestState;
const machineSpawnNewSession = vi.fn();
const refreshSessions = vi.fn();
const patchSessionMetadataWithRetry = vi.fn();
const ensureSessionVisibleForMessageRoute = vi.fn();

vi.mock('@/agents/registry/registryCore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/registry/registryCore')>();
  return {
    ...actual,
    isAgentId: (value: unknown) => actual.isAgentId(value),
  };
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
  machineContributionRegistryProjectionDescribe: (...args: Parameters<MachineContributionRegistryProjectionDescribeFn>) =>
    machineContributionRegistryProjectionDescribe(...args),
}));

vi.mock('@/sync/domains/session/external/readExternalSessionLink', () => ({
  readExternalSessionLink: () => null,
}));

installVoiceStorageModuleMocks({
  storage: () => {
    return createStorageModuleStub({
      storage: {
        getState: () => state,
      },
    });
  },
});

vi.mock('@/sync/ops/machines', () => ({
  machineSpawnNewSession: (...args: any[]) => machineSpawnNewSession(...args),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessions: (...args: any[]) => refreshSessions(...args),
    patchSessionMetadataWithRetry: (...args: any[]) => patchSessionMetadataWithRetry(...args),
    ensureSessionVisibleForMessageRoute: (...args: any[]) => ensureSessionVisibleForMessageRoute(...args),
  },
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
  isMachineOnline: () => true,
}));

vi.mock('@/voice/runtime/voiceTargetStore', () => ({
  useVoiceTargetStore: {
    getState: () => ({
      primaryActionSessionId: null,
      lastFocusedSessionId: null,
    }),
  },
}));

describe('ensureVoiceConversationSessionForVoiceHome', () => {
  beforeEach(() => {
    vi.resetModules();
    machineSpawnNewSession.mockReset();
    refreshSessions.mockReset();
    patchSessionMetadataWithRetry.mockReset();
    ensureSessionVisibleForMessageRoute.mockReset();
    machineContributionRegistryProjectionDescribe.mockReset();
    machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });

    state = {
      settings: {
        lastUsedAgent: 'codex',
        recentMachinePaths: [
          {
            machineId: 'machine-1',
            path: '/Users/test/.happier/voice-agent',
          },
        ],
        voice: {
          adapters: {
            local_conversation: {
              agent: {
                machineTargetMode: 'auto',
                agentSource: 'session',
                voiceHomeSubdirName: 'voice-agent',
                rootSessionPolicy: 'keep_warm',
                maxWarmRoots: 1,
              },
            },
          },
        },
      },
      machines: {
        'machine-1': {
          id: 'machine-1',
          active: true,
          spawnReadinessStatus: 'ready',
          metadata: {
            happyHomeDir: '/Users/test/.happier',
          },
        },
      },
      sessions: {},
      sessionListRenderables: {},
      sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: {},
      getProjectForSession: () => null,
    };

    machineSpawnNewSession.mockImplementation(async (params: any) => {
      state.sessions['voice-home-session'] = {
        id: 'voice-home-session',
        active: true,
        updatedAt: 1,
        metadata: {
          machineId: params.machineId,
          path: params.directory,
        },
      };
      return { type: 'success', sessionId: 'voice-home-session' };
    });

    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, applyPatch: (metadata: any) => any) => {
      const session = state.sessions[sessionId];
      session.metadata = applyPatch(session.metadata ?? {});
    });
  });

  it('spawns on the preferred machine when auto mode has no active voice target session', async () => {
    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      directory: '/Users/test/.happier/voice-agent',
      serverId: 'server-1',
      spawnAttemptKey: expect.stringMatching(/^voice\.conversation\.home:/),
    }));
  });

  it('routes recent voice-home spawn targets through active machine replacements', async () => {
    state.settings.recentMachinePaths = [{
      machineId: 'machine-old',
      path: '/Users/test/.happier/voice-agent',
    }];
    state.machines = {
      'machine-old': {
        id: 'machine-old',
        active: false,
        replacedByMachineId: 'machine-new',
        replacedAt: 123,
        metadata: {},
      },
      'machine-new': {
        id: 'machine-new',
        active: true,
        spawnReadinessStatus: 'ready',
        metadata: {},
      },
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-new',
      directory: '/Users/test/.happier/voice-agent',
      serverId: 'server-1',
    }));
  });

  it('trims the agent source before choosing the spawned voice-home agent', async () => {
    state.settings.lastUsedAgent = 'claude';
    state.settings.voice.adapters.local_conversation.agent.agentSource = ' agent ';
    state.settings.voice.adapters.local_conversation.agent.agentId = 'codex';

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
      },
    }));
  });

  it('prefers the configured last-used backend target for voice-home spawning when agentSource stays on session', async () => {
    state.settings.lastUsedAgent = 'codex';
    state.settings.lastUsedBackendTarget = { kind: 'configuredAcpBackend', backendId: 'review-bot' };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot' }],
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
      },
    }));
  });

  it('does not treat the legacy customAcp voice-home fallback as permission to select a plugin backend from merged projection truth', async () => {
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

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('machine-1', expect.objectContaining({
      serverId: 'server-1',
      timeoutMs: 10_000,
    }));
    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'claude',
      },
    }));
  });

  it('falls back to the built-in last-used backend target when the stored configured backend is stale', async () => {
    state.settings.lastUsedAgent = 'codex';
    state.settings.lastUsedBackendTarget = { kind: 'configuredAcpBackend', backendId: 'stale-review-bot' };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot' }],
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
      },
    }));
  });

  it('uses the fixed machine target when the target mode is padded', async () => {
    state.machines['machine-2'] = {
      id: 'machine-2',
      active: true,
      spawnReadinessStatus: 'ready',
      metadata: {
        happyHomeDir: '/Users/fixed/.happier/',
      },
    };
    state.settings.voice.adapters.local_conversation.agent.machineTargetMode = ' fixed ';
    state.settings.voice.adapters.local_conversation.agent.machineTargetId = ' machine-2 ';

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-2',
      directory: '/Users/fixed/.happier/voice-agent',
      serverId: 'server-1',
    }));
  });

  it('reuses visible lookup metadata while waiting for a freshly spawned voice home session to hydrate', async () => {
    vi.useFakeTimers();
    try {
      machineSpawnNewSession.mockImplementation(async () => {
        state.sessions['voice-home-session'] = {
          id: 'voice-home-session',
          active: true,
          updatedAt: 1,
          metadata: null,
        };
        return { type: 'success', sessionId: 'voice-home-session' };
      });
      refreshSessions.mockImplementation(async () => {
        state.sessionListRenderables = {
          ...(state.sessionListRenderables ?? {}),
          'voice-home-session': {
            id: 'voice-home-session',
            active: true,
            updatedAt: 1,
            presence: 'online',
            metadata: {
              machineId: 'machine-1',
              path: '/Users/test/.happier/voice-agent',
              voiceConversationScopeV1: {
                v: 1,
                kind: 'voice_home',
              },
              systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            },
          },
        };
        state.sessionListIndexByServerId = {
          ...(state.sessionListIndexByServerId ?? {}),
          'server-1': [
            { type: 'session', sessionId: 'voice-home-session', serverId: 'server-1', serverName: 'Server 1' },
          ],
        };
      });

      const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');
      const pending = ensureVoiceConversationSessionForVoiceHome();

      await vi.advanceTimersByTimeAsync(15_000);

      await expect(pending).resolves.toBe('voice-home-session');
      expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
        machineId: 'machine-1',
        directory: '/Users/test/.happier/voice-agent',
        serverId: 'server-1',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to another available auto target when the sticky auto-target machine no longer resolves a voice-home directory', async () => {
    state.settings.voice.adapters.local_conversation.agent.autoTargetMachineId = 'stale-machine';
    state.machines['stale-machine'] = {
      id: 'stale-machine',
      active: true,
      spawnReadinessStatus: 'ready',
      metadata: {},
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      directory: '/Users/test/.happier/voice-agent',
      serverId: 'server-1',
    }));
  });

  it('falls back to another available auto target when the sticky auto-target machine is inactive', async () => {
    state.settings.voice.adapters.local_conversation.agent.autoTargetMachineId = 'stale-machine';
    state.machines['stale-machine'] = {
      id: 'stale-machine',
      active: false,
      metadata: {
        happyHomeDir: '/Users/stale/.happier',
      },
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      directory: '/Users/test/.happier/voice-agent',
      serverId: 'server-1',
    }));
  });

  it('uses the reachable target machine when the focused session metadata is stale after handoff', async () => {
    state.machines['machine-target'] = {
      id: 'machine-target',
      active: true,
      spawnReadinessStatus: 'ready',
      metadata: {
        happyHomeDir: '/Users/target/.happier',
        host: 'target.local',
      },
    };
    state.machines['machine-stale'] = {
      id: 'machine-stale',
      active: false,
      replacedByMachineId: 'machine-target',
      replacedAt: 123,
      metadata: {
        host: 'source.local',
      },
    };
    state.sessions['focus-session'] = {
      id: 'focus-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'source.local',
      },
    };
    state.getProjectForSession = (sessionId: string) =>
      sessionId === 'focus-session'
        ? {
            key: {
              machineId: 'machine-target',
              path: '/Users/test/workspace/rebound',
            },
          }
        : null;

    vi.doMock('@/voice/runtime/voiceTargetStore', () => ({
      useVoiceTargetStore: {
        getState: () => ({
          primaryActionSessionId: 'focus-session',
          lastFocusedSessionId: null,
        }),
      },
    }));

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-target',
      directory: '/Users/target/.happier/voice-agent',
      serverId: 'server-1',
    }));
  });

  it('reuses an existing voice conversation session when the visible lookup metadata is fresh but raw metadata is stale', async () => {
    state.sessions['voice-home-session'] = {
      id: 'voice-home-session',
      active: true,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/.happier/voice-agent-old',
        voiceConversationScopeV1: {
          v: 1,
          kind: 'voice_home',
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };
    state.sessionListRenderables = {
      ...(state.sessionListRenderables ?? {}),
      'voice-home-session': {
        id: 'voice-home-session',
        active: true,
        updatedAt: 10,
        presence: 'online',
        metadata: {
          machineId: 'machine-1',
          path: '/Users/test/.happier/voice-agent',
          voiceConversationScopeV1: {
            v: 1,
            kind: 'voice_home',
          },
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        },
      },
    };
    state.sessionListIndexByServerId = {
      ...(state.sessionListIndexByServerId ?? {}),
      'server-1': [
        { type: 'session', sessionId: 'voice-home-session', serverId: 'server-1', serverName: 'Server 1' },
      ],
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('retires a legacy voice home session when visible lookup metadata matches the target but raw metadata is stale', async () => {
    vi.doMock('@/voice/runtime/voiceTargetStore', () => ({
      useVoiceTargetStore: {
        getState: () => ({
          primaryActionSessionId: null,
          lastFocusedSessionId: null,
        }),
      },
    }));
    state.sessions['legacy-session'] = {
      id: 'legacy-session',
      active: false,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/.happier/voice-agent-old',
      },
    };
    state.sessions['voice-home-session'] = {
      id: 'voice-home-session',
      active: true,
      updatedAt: 11,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        voiceConversationScopeV1: {
          v: 1,
          kind: 'voice_home',
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };
    state.sessionListRenderables = {
      ...(state.sessionListRenderables ?? {}),
      'legacy-session': {
        id: 'legacy-session',
        active: false,
        updatedAt: 10,
        presence: 'online',
        metadata: {
          machineId: 'machine-1',
          path: '/Users/test/.happier/voice-agent',
          externalSessionV1: {
            v: 1,
            providerId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'remote-legacy',
            source: {
              kind: 'codexHome',
              home: 'user',
            },
          },
          voiceConversationScopeV1: {
            v: 1,
            kind: 'voice_home',
          },
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        },
      },
      'voice-home-session': {
        id: 'voice-home-session',
        active: true,
        updatedAt: 11,
        presence: 'online',
        metadata: {
          machineId: 'machine-1',
          path: '/Users/test/.happier/voice-agent',
          voiceConversationScopeV1: {
            v: 1,
            kind: 'voice_home',
          },
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        },
      },
    };
    state.sessionListIndexByServerId = {
      ...(state.sessionListIndexByServerId ?? {}),
      'server-1': [
        { type: 'session', sessionId: 'legacy-session', serverId: 'server-1', serverName: 'Server 1' },
        { type: 'session', sessionId: 'voice-home-session', serverId: 'server-1', serverName: 'Server 1' },
      ],
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(patchSessionMetadataWithRetry.mock.calls.some(([sessionId]) => sessionId === 'legacy-session')).toBe(true);
  });

  it('does not recover a timed-out voice home spawn by scanning unrelated late sessions', async () => {
    machineSpawnNewSession.mockResolvedValue({
      type: 'error',
      errorCode: 'SESSION_WEBHOOK_TIMEOUT',
      errorMessage: 'Session startup timed out',
    });
    refreshSessions.mockImplementation(async () => {
      state = {
        ...state,
        sessions: {
          ...state.sessions,
          'late-session': {
            id: 'late-session',
            active: true,
            updatedAt: 2,
            metadata: null,
          },
        },
      };
    });
    ensureSessionVisibleForMessageRoute.mockImplementation(async (sessionId: string) => {
      if (sessionId !== 'late-session') return;
      const nextRenderables = {
        ...(state.sessionListRenderables ?? {}),
        'late-session': {
          id: 'late-session',
          active: true,
          updatedAt: 2,
          presence: 'online',
          metadata: {
            machineId: 'machine-1',
            path: '/Users/test/.happier/voice-agent',
            voiceConversationScopeV1: {
              v: 1,
              kind: 'voice_home',
            },
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          },
        },
      };
      const nextIndexByServerId = {
        ...(state.sessionListIndexByServerId ?? {}),
        'server-1': [
          { type: 'session', sessionId: 'late-session', serverId: 'server-1', serverName: 'Server 1' },
        ],
      };
      state = {
        ...state,
        sessionListRenderables: nextRenderables,
        sessionListIndexByServerId: nextIndexByServerId,
      };
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'SESSION_WEBHOOK_TIMEOUT',
    });
    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'SESSION_WEBHOOK_TIMEOUT',
    });
    const firstSpawnOptions = machineSpawnNewSession.mock.calls[0]?.[0] as { spawnAttemptKey?: string };
    const secondSpawnOptions = machineSpawnNewSession.mock.calls[1]?.[0] as { spawnAttemptKey?: string };
    expect(firstSpawnOptions.spawnAttemptKey).toEqual(expect.stringMatching(/^voice\.conversation\.home:/));
    expect(secondSpawnOptions.spawnAttemptKey).toBe(firstSpawnOptions.spawnAttemptKey);
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(ensureSessionVisibleForMessageRoute).not.toHaveBeenCalled();
  });
});

describe('ensureVoiceConversationSessionForSessionRoot', () => {
  beforeEach(() => {
    vi.resetModules();
    machineSpawnNewSession.mockReset();
    refreshSessions.mockReset();
    patchSessionMetadataWithRetry.mockReset();
    ensureSessionVisibleForMessageRoute.mockReset();

    state = {
      settings: {
        lastUsedAgent: 'codex',
        recentMachinePaths: [],
        voice: {
          adapters: {
            local_conversation: {
              agent: {
                machineTargetMode: 'auto',
                agentSource: 'session',
                voiceHomeSubdirName: 'voice-agent',
              },
            },
          },
        },
      },
      machines: {
        'machine-stale': {
          id: 'machine-stale',
          active: false,
          replacedByMachineId: 'machine-target',
          replacedAt: 123,
          metadata: {
            host: 'source.local',
          },
        },
        'machine-target': {
          id: 'machine-target',
          active: true,
          spawnReadinessStatus: 'ready',
          metadata: {
            happyHomeDir: '/Users/target/.happier',
            host: 'target.local',
          },
        },
      },
      sessions: {},
      sessionListRenderables: {},
      sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: {},
      getProjectForSession: () => null,
    };

    machineSpawnNewSession.mockImplementation(async (params: any) => {
      state.sessions['voice-root-session'] = {
        id: 'voice-root-session',
        active: true,
        updatedAt: 1,
        metadata: {
          machineId: params.machineId,
          path: params.directory,
        },
      };
      return { type: 'success', sessionId: 'voice-root-session' };
    });

    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, applyPatch: (metadata: any) => any) => {
      const session = state.sessions[sessionId];
      session.metadata = applyPatch(session.metadata ?? {});
    });
  });

  it('spawns on the reachable target machine when the root session metadata machine id is stale after handoff', async () => {
    state.sessions['root-session'] = {
      id: 'root-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'source.local',
      },
    };
    state.getProjectForSession = (sessionId: string) =>
      sessionId === 'root-session'
        ? {
            key: {
              machineId: 'machine-target',
              path: '/Users/test/workspace/rebound',
            },
          }
        : null;

    const { ensureVoiceConversationSessionForSessionRoot } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionId: 'root-session' })).resolves.toBe('voice-root-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-target',
      directory: '/Users/test/workspace/rebound',
      serverId: 'server-1',
      spawnAttemptKey: expect.stringMatching(/^voice\.conversation\.session-root:/),
    }));
  });

  it('reuses an existing voice conversation session when the visible lookup metadata is fresh but raw metadata is stale', async () => {
    state.sessions['root-session'] = {
      id: 'root-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'source.local',
      },
    };
    state.sessions['voice-root-session'] = {
      id: 'voice-root-session',
      active: true,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/workspace/old',
        voiceConversationScopeV1: {
          v: 1,
          kind: 'voice_home',
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };
    state.sessionListRenderables = {
      ...(state.sessionListRenderables ?? {}),
      'voice-root-session': {
        id: 'voice-root-session',
        active: true,
        updatedAt: 10,
        presence: 'online',
        metadata: {
          machineId: 'machine-target',
          path: '/Users/test/workspace/rebound',
          voiceConversationScopeV1: {
            v: 1,
            kind: 'session_root',
            sessionRootId: 'root-session',
          },
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        },
      },
    };
    state.sessionListIndexByServerId = {
      ...(state.sessionListIndexByServerId ?? {}),
      'server-1': [
        { type: 'session', sessionId: 'voice-root-session', serverId: 'server-1', serverName: 'Server 1' },
      ],
    };
    state.getProjectForSession = (sessionId: string) =>
      sessionId === 'root-session'
        ? {
            key: {
              machineId: 'machine-target',
              rootPath: '/Users/test/workspace/rebound',
            },
          }
        : null;

    const { ensureVoiceConversationSessionForSessionRoot } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionId: 'root-session' })).resolves.toBe('voice-root-session');
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('does not recover a timed-out session-root voice spawn by scanning unrelated late sessions', async () => {
    state.sessions['root-session'] = {
      id: 'root-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'target.local',
      },
    };
    state.getProjectForSession = (sessionId: string) =>
      sessionId === 'root-session'
        ? {
            key: {
              machineId: 'machine-target',
              path: '/Users/test/workspace/rebound',
            },
          }
        : null;
    machineSpawnNewSession.mockResolvedValue({
      type: 'error',
      errorCode: 'SESSION_WEBHOOK_TIMEOUT',
      errorMessage: 'Session startup timed out',
    });
    refreshSessions.mockImplementation(async () => {
      state = {
        ...state,
        sessions: {
          ...state.sessions,
          'late-root-session': {
            id: 'late-root-session',
            active: true,
            updatedAt: 20,
            metadata: {
              machineId: 'machine-target',
              path: '/Users/test/workspace/rebound',
            },
          },
        },
      };
    });

    const { ensureVoiceConversationSessionForSessionRoot } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionId: 'root-session' })).rejects.toMatchObject({
      code: 'SESSION_WEBHOOK_TIMEOUT',
    });
    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionId: 'root-session' })).rejects.toMatchObject({
      code: 'SESSION_WEBHOOK_TIMEOUT',
    });
    const firstSpawnOptions = machineSpawnNewSession.mock.calls[0]?.[0] as { spawnAttemptKey?: string };
    const secondSpawnOptions = machineSpawnNewSession.mock.calls[1]?.[0] as { spawnAttemptKey?: string };
    expect(firstSpawnOptions.spawnAttemptKey).toEqual(expect.stringMatching(/^voice\.conversation\.session-root:/));
    expect(secondSpawnOptions.spawnAttemptKey).toBe(firstSpawnOptions.spawnAttemptKey);
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(ensureSessionVisibleForMessageRoute).not.toHaveBeenCalled();
  });
});
