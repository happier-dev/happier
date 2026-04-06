import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { installVoiceSessionBindingCommonModuleMocks } from './voiceSessionBindingTestHelpers';

type TestState = {
  settings: any;
  machines: Record<string, any>;
  sessions: Record<string, any>;
  sessionListViewData?: any;
  getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
};

let state: TestState;
const machineSpawnNewSession = vi.fn();
const refreshSessions = vi.fn();
const patchSessionMetadataWithRetry = vi.fn();
const ensureSessionVisibleForMessageRoute = vi.fn();

vi.mock('@/agents/registry/registryCore', () => ({
  isAgentId: (value: unknown) => typeof value === 'string' && value.trim().length > 0,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
}));

vi.mock('@/sync/domains/session/directSessions/readDirectSessionLink', () => ({
  readDirectSessionLink: () => null,
}));

installVoiceSessionBindingCommonModuleMocks({
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
          metadata: {
            happyHomeDir: '/Users/test/.happier',
          },
        },
      },
      sessions: {},
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
    }));
  });

  it('reuses cached visible metadata while waiting for a freshly spawned voice home session to hydrate', async () => {
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
        state.sessionListViewData = [
          {
            type: 'session',
            session: {
              id: 'voice-home-session',
              seq: 0,
              createdAt: 0,
              active: true,
              activeAt: 0,
              updatedAt: 1,
              archivedAt: null,
              metadataVersion: 0,
              agentStateVersion: 0,
              thinking: false,
              thinkingAt: 0,
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
          },
        ];
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
      metadata: {
        happyHomeDir: '/Users/target/.happier',
        host: 'target.local',
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

  it('reuses an existing voice conversation session when the cached visible metadata is fresh but raw metadata is stale', async () => {
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
    state.sessionListViewData = [
      {
        type: 'session',
        session: {
          id: 'voice-home-session',
          seq: 0,
          createdAt: 0,
          active: true,
          activeAt: 0,
          updatedAt: 10,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
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
      },
    ];

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('retires a legacy voice home session when cached visible metadata matches the target but raw metadata is stale', async () => {
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
    state.sessionListViewData = [
      {
        type: 'session',
        session: {
          id: 'legacy-session',
          seq: 0,
          createdAt: 0,
          active: false,
          activeAt: 0,
          updatedAt: 10,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
          presence: 'online',
          metadata: {
            machineId: 'machine-1',
            path: '/Users/test/.happier/voice-agent',
            directSessionV1: {
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
      },
      {
        type: 'session',
        session: {
          id: 'voice-home-session',
          seq: 0,
          createdAt: 0,
          active: true,
          activeAt: 0,
          updatedAt: 11,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
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
      },
    ];

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(patchSessionMetadataWithRetry.mock.calls.some(([sessionId]) => sessionId === 'legacy-session')).toBe(true);
  });

  it('recovers a late-spawned voice home session after webhook timeout even when metadata hydrates only after ensuring the session is visible', async () => {
    machineSpawnNewSession.mockResolvedValue({
      type: 'error',
      errorCode: 'SESSION_WEBHOOK_TIMEOUT',
      errorMessage: 'Session startup timed out',
    });
    refreshSessions.mockImplementation(async () => {
      state.sessions['late-session'] = {
        id: 'late-session',
        active: true,
        updatedAt: 2,
        metadata: {},
      };
    });
    ensureSessionVisibleForMessageRoute.mockImplementation(async (sessionId: string) => {
      if (sessionId !== 'late-session') return;
      state.sessionListViewData = [
        {
          type: 'session',
          session: {
            id: 'late-session',
            seq: 0,
            createdAt: 0,
            active: true,
            activeAt: 0,
            updatedAt: 2,
            archivedAt: null,
            metadataVersion: 0,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            metadata: {
              machineId: 'machine-1',
              path: '/Users/test/.happier/voice-agent',
            },
          },
        },
      ];
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('late-session');
    expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('late-session', { forceRefresh: true });
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
        'machine-target': {
          id: 'machine-target',
          active: true,
          metadata: {
            happyHomeDir: '/Users/target/.happier',
            host: 'target.local',
          },
        },
      },
      sessions: {},
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
    }));
  });

  it('reuses an existing voice conversation session when the cached visible metadata is fresh but raw metadata is stale', async () => {
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
    state.sessionListViewData = [
      {
        type: 'session',
        session: {
          id: 'voice-root-session',
          seq: 0,
          createdAt: 0,
          active: true,
          activeAt: 0,
          updatedAt: 10,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
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
      },
    ];
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
});
