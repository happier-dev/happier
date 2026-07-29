import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
  GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
} from '@happier-dev/agents';

import { flushHookEffects } from '@/dev/testkit';
import { installVoiceAgentCommonModuleMocks } from '@/voice/agent/voiceAgentTestHelpers';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { buildVoiceSpawnUserAttemptId } from '@/voice/shared/voiceSpawnAttempt';

type CompletePendingMachineSpawnAttemptCustodyForSessionFn =
  typeof import('@/sync/ops/machines').completePendingMachineSpawnAttemptCustodyForSession;

const spawnSession = vi.fn();
const spawnTrustedHiddenSystemSession = vi.fn();
const completePendingMachineSpawnAttemptCustodyForSession =
  vi.fn<CompletePendingMachineSpawnAttemptCustodyForSessionFn>();
const refreshSessions = vi.fn();
const patchSessionMetadataWithRetry = vi.fn();
const ensureSessionVisibleForMessageRoute = vi.fn();
const loadDaemonMergedProjectionInputs = vi.fn();

const getActiveServerSnapshot = vi.fn(() => ({ serverId: 'server-a', serverUrl: 'http://localhost', generation: 1 }));

const state: any = {
  sessions: {},
  machines: {},
  machineListByServerId: {},
  settings: {
    lastUsedAgent: 'claude',
    recentMachinePaths: [{ machineId: 'm1', path: '/tmp/repo' }],
    voice: { providers: { local_conversation: { schemaVersion: 1, config: { agent: { agentSource: 'session' } } } } },
  },
};

const voiceHomeDirectory = '/tmp/.happier/voice-agent';
const exactConnectedServices = {
  v: 1 as const,
  bindingsByServiceId: {
    'openai-codex': {
      source: 'connected' as const,
      selection: 'profile' as const,
      profileId: 'codex-work',
    },
  },
};
const globalVoiceStartupMarker = {
  v: 1 as const,
  id: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
  revision: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
};

function enableCodexStartupInstructionsV1() {
  loadDaemonMergedProjectionInputs.mockResolvedValue({
    pluginProjectionV2: {
      v: 2,
      agentsById: {
        codex: {
          id: 'codex',
          capabilities: {
            sessions: {
              startupInstructions: { versions: [1] },
            },
          },
        },
      },
      backendsById: {
        codex: { id: 'codex', agentId: 'codex' },
      },
    },
  });
}

function createVoiceHomeCandidate(
  id: string,
  metadataOverrides: Record<string, unknown> = {},
) {
  return {
    id,
    active: true,
    updatedAt: 10,
    metadata: {
      path: voiceHomeDirectory,
      host: 'm1',
      machineId: 'm1',
      homeDir: '/home/u',
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: exactConnectedServices,
      permissionMode: 'default',
      systemSessionV1: {
        v: 1,
        key: 'voice_conversation',
        hidden: true,
      },
      voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
      voiceAgentStartupInstructionsV1: globalVoiceStartupMarker,
      ...metadataOverrides,
    },
  };
}

function installFreshVoiceHomeSpawn(sessionId = 'fresh_voice') {
  spawnSession.mockResolvedValue({ type: 'success', sessionId });
  refreshSessions.mockImplementation(async () => {
    state.sessions[sessionId] = {
      id: sessionId,
      active: true,
      updatedAt: 1,
      metadata: {
        path: voiceHomeDirectory,
        host: 'm1',
        machineId: 'm1',
        homeDir: '/home/u',
      },
    };
  });
  patchSessionMetadataWithRetry.mockImplementation(
    async (targetSessionId: string, updater: (m: any) => any) => {
      state.sessions[targetSessionId].metadata = updater(
        state.sessions[targetSessionId].metadata,
      );
    },
  );
}

installVoiceAgentCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => state,
            },
        });
    },
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => getActiveServerSnapshot(),
}));

vi.mock('@/sync/ops/machines', () => ({
  completePendingMachineSpawnAttemptCustodyForSession: (
    ...args: Parameters<CompletePendingMachineSpawnAttemptCustodyForSessionFn>
  ) => completePendingMachineSpawnAttemptCustodyForSession(...args),
  machineSpawnNewSession: (opts: any) => spawnSession(opts),
  machineSpawnTrustedHiddenSystemSession: (
    opts: any,
    startupInstructions: any,
  ) => spawnTrustedHiddenSystemSession(opts, startupInstructions),
}));

vi.mock('@/agents/backendCatalog/loadDaemonMergedProjectionInputs', () => ({
  loadDaemonMergedProjectionInputs: (...args: unknown[]) =>
    loadDaemonMergedProjectionInputs(...args),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessions: (...args: any[]) => refreshSessions(...args),
    ensureSessionVisibleForMessageRoute: (sessionId: string) => ensureSessionVisibleForMessageRoute(sessionId),
    patchSessionMetadataWithRetry: (sessionId: string, updater: (m: any) => any) =>
      patchSessionMetadataWithRetry(sessionId, updater),
  },
}));

describe('voiceConversationSession', () => {
  beforeEach(() => {
    const now = Date.now();
    vi.resetModules();
    spawnSession.mockReset();
    spawnTrustedHiddenSystemSession.mockReset();
    completePendingMachineSpawnAttemptCustodyForSession.mockReset();
    completePendingMachineSpawnAttemptCustodyForSession.mockResolvedValue(null);
    spawnTrustedHiddenSystemSession.mockImplementation(
      (opts: any, startupInstructions: any) => spawnSession({
        ...opts,
        agentSessionStartupInstructionsV1: startupInstructions,
      }),
    );
    refreshSessions.mockReset();
    patchSessionMetadataWithRetry.mockReset();
    ensureSessionVisibleForMessageRoute.mockReset();
    getActiveServerSnapshot.mockClear();
    loadDaemonMergedProjectionInputs.mockReset();
    loadDaemonMergedProjectionInputs.mockResolvedValue(null);
    useVoiceTargetStore.setState({ scope: 'global', primaryActionSessionId: null, trackedSessionIds: [], lastFocusedSessionId: null } as any);

    state.sessions = {};
    state.machines = {
      m1: {
        id: 'm1',
        active: true,
        activeAt: now,
        metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/.happier', homeDir: '/home/u' },
      },
    };
    state.machineListByServerId = {};
    state.settings = {
      lastUsedAgent: 'claude',
      recentMachinePaths: [{ machineId: 'm1', path: '/tmp/repo' }],
      voice: {
        executionMachine: { mode: 'auto', machineId: null, autoMachineId: null },
        providers: {
          local_conversation: { schemaVersion: 1, config: {
            agent: {
              agentSource: 'session',
              voiceHomeSubdirName: 'voice-agent',
            },
          } },
        },
      },
    };
  });

  it('findVoiceConversationSessionId picks the newest hidden system voice conversation session', async () => {
    const { findVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions = {
      s1: { id: 's1', updatedAt: 5, metadata: { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } },
      s2: { id: 's2', updatedAt: 10, metadata: { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } },
      s3: { id: 's3', updatedAt: 999, metadata: { systemSessionV1: { v: 1, key: 'other', hidden: true } } },
    };

    expect(findVoiceConversationSessionId(state)).toBe('s2');
  });

  it('ensureVoiceConversationSessionId spawns and then marks the session as a hidden voice conversation', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'm1',
        directory: '/tmp/.happier/voice-agent',
        approvedNewDirectoryCreation: true,
        backendTarget: { kind: 'backend', backendId: 'claude' },
        serverId: 'server-a',
        transcriptStorage: 'persisted',
      }),
    );
    expect(spawnTrustedHiddenSystemSession).not.toHaveBeenCalled();
    expect(spawnSession.mock.calls[0]?.[0])
      .not.toHaveProperty('agentSessionStartupInstructionsV1');

    expect(state.sessions.sys_voice.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_conversation', hidden: true });
  });

  it('sends global startup instructions only when the old/new daemon projection declares V1', async () => {
    const {
      ensureVoiceConversationSessionForVoiceHome,
    } = await import('@/voice/persistence/voiceConversationSession');
    loadDaemonMergedProjectionInputs.mockResolvedValue({
      pluginProjectionV2: {
        v: 2,
        agentsById: {
          codex: {
            id: 'codex',
            capabilities: {
              sessions: {
                startupInstructions: { versions: [1] },
              },
            },
          },
        },
        backendsById: {
          codex: { id: 'codex', agentId: 'codex' },
        },
      },
    });
    const isReusableSession = vi.fn(() => true);
    state.sessions.old_voice = {
      id: 'old_voice',
      active: true,
      updatedAt: 10,
      metadata: {
        path: '/tmp/.happier/voice-agent',
        host: 'm1',
        machineId: 'm1',
        homeDir: '/home/u',
        backendTarget: { kind: 'backend', backendId: 'codex' },
        permissionMode: 'default',
        systemSessionV1: {
          v: 1,
          key: 'voice_conversation',
          hidden: true,
        },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        voiceAgentStartupInstructionsV1: {
          v: 1,
          id: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
          revision: 0,
        },
      },
    };
    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        metadata: {
          path: '/tmp/.happier/voice-agent',
          host: 'm1',
          machineId: 'm1',
          homeDir: '/home/u',
        },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(
      async (sessionId: string, updater: (m: any) => any) => {
        state.sessions[sessionId].metadata = updater(
          state.sessions[sessionId].metadata,
        );
      },
    );

    await ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      permissionIntent: 'default',
      coldResumeStartupInstructionsEffective: false,
      isReusableSession,
    });

    expect(isReusableSession).not.toHaveBeenCalled();
    const spawnInput = spawnSession.mock.calls[0]?.[0];
    expect(spawnTrustedHiddenSystemSession).toHaveBeenCalledOnce();
    expect(spawnInput.agentSessionStartupInstructionsV1).toMatchObject({
      v: 1,
      id: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
      revision: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
    });
    expect(spawnInput.agentSessionStartupInstructionsV1.instructions)
      .toContain("Happier's global Voice agent");
    expect(state.sessions.sys_voice.metadata.voiceAgentStartupInstructionsV1)
      .toEqual({
        v: 1,
        id: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
        revision: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
      });
    expect(JSON.stringify(state.sessions.sys_voice.metadata))
      .not.toContain('Global Voice agent');
  });

  it('reuses an exact hidden voice-home session only when cold-resume startup instructions are effective', async () => {
    const {
      ensureVoiceConversationSessionForVoiceHome,
    } = await import('@/voice/persistence/voiceConversationSession');
    enableCodexStartupInstructionsV1();
    state.sessions.exact_voice = createVoiceHomeCandidate('exact_voice');
    patchSessionMetadataWithRetry.mockImplementation(
      async (sessionId: string, updater: (m: any) => any) => {
        state.sessions[sessionId].metadata = updater(
          state.sessions[sessionId].metadata,
        );
      },
    );
    const isReusableSession = vi.fn(() => true);

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: exactConnectedServices,
      permissionIntent: 'default',
      coldResumeStartupInstructionsEffective: true,
      isReusableSession,
    })).resolves.toBe('exact_voice');

    expect(isReusableSession).toHaveBeenCalledOnce();
    expect(isReusableSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'exact_voice',
      metadata: expect.objectContaining({
        connectedServices: exactConnectedServices,
        voiceAgentStartupInstructionsV1: globalVoiceStartupMarker,
      }),
    }));
    expect(spawnTrustedHiddenSystemSession).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('reuses and retires only exact Windows voice-home directory identities across separator spellings', async () => {
    const {
      ensureVoiceConversationSessionForVoiceHome,
    } = await import('@/voice/persistence/voiceConversationSession');
    enableCodexStartupInstructionsV1();
    state.machines.m1.metadata = {
      ...state.machines.m1.metadata,
      platform: 'win32',
      happyHomeDir: 'C:\\Users\\Alice\\.happier\\',
      homeDir: String.raw`C:\Users\Alice`,
    };
    state.sessions = {
      exact_voice: createVoiceHomeCandidate('exact_voice', {
        path: 'c:/users/alice/.happier/voice-agent/',
      }),
      sibling_voice: {
        ...createVoiceHomeCandidate('sibling_voice', {
          path: 'c:/users/alice/.happier/voice-agent2',
        }),
        updatedAt: 100,
      },
      legacy_equivalent: {
        id: 'legacy_equivalent',
        active: true,
        updatedAt: 200,
        metadata: {
          path: 'C:/USERS/ALICE/.HAPPIER/voice-agent',
          machineId: 'm1',
          directSessionV1: {
            v: 1,
            providerId: 'codex',
            machineId: 'm1',
            remoteSessionId: 'remote-legacy',
            source: { kind: 'codexHome', home: 'user' },
          },
          systemSessionV1: {
            v: 1,
            key: 'voice_conversation',
            hidden: true,
          },
        },
      },
    };
    patchSessionMetadataWithRetry.mockImplementation(
      async (sessionId: string, updater: (m: any) => any) => {
        state.sessions[sessionId].metadata = updater(
          state.sessions[sessionId].metadata,
        );
      },
    );
    const isReusableSession = vi.fn(() => true);

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: exactConnectedServices,
      permissionIntent: 'default',
      coldResumeStartupInstructionsEffective: true,
      isReusableSession,
    })).resolves.toBe('exact_voice');

    expect(isReusableSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'exact_voice',
    }));
    expect(isReusableSession).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sibling_voice',
    }));
    expect(state.sessions.legacy_equivalent.metadata.systemSessionV1).toMatchObject({
      v: 1,
      key: 'voice_conversation_retired',
      hidden: true,
    });
    expect(spawnTrustedHiddenSystemSession).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('keeps a Windows voice-home spawn directory operational while hashing its normalized identity', async () => {
    const {
      ensureVoiceConversationSessionId,
    } = await import('@/voice/persistence/voiceConversationSession');
    const operationalDirectory = String.raw`C:\Users\Alice\.happier\voice-agent`;
    state.machines.m1.metadata = {
      ...state.machines.m1.metadata,
      platform: 'win32',
      happyHomeDir: 'C:\\Users\\Alice\\.happier\\',
      homeDir: String.raw`C:\Users\Alice`,
    };
    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'windows_voice' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.windows_voice = {
        id: 'windows_voice',
        active: true,
        updatedAt: 1,
        metadata: {
          path: operationalDirectory,
          host: 'm1',
          machineId: 'm1',
          homeDir: String.raw`C:\Users\Alice`,
        },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(
      async (sessionId: string, updater: (m: any) => any) => {
        state.sessions[sessionId].metadata = updater(
          state.sessions[sessionId].metadata,
        );
      },
    );

    await expect(ensureVoiceConversationSessionId()).resolves.toBe('windows_voice');

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: operationalDirectory,
      userAttemptId: buildVoiceSpawnUserAttemptId({
        surface: 'voice_home',
        serverId: 'server-a',
        machineId: 'm1',
        directory: 'c:/users/alice/.happier/voice-agent',
        backendTarget: { kind: 'backend', backendId: 'claude' },
        requirements: null,
      }),
    }));
  });

  it('fresh-creates instead of reusing an exact hidden voice-home session without cold-resume proof', async () => {
    const {
      ensureVoiceConversationSessionForVoiceHome,
    } = await import('@/voice/persistence/voiceConversationSession');
    enableCodexStartupInstructionsV1();
    state.sessions.exact_voice = createVoiceHomeCandidate('exact_voice');
    installFreshVoiceHomeSpawn();
    const isReusableSession = vi.fn(() => true);

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: exactConnectedServices,
      permissionIntent: 'default',
      coldResumeStartupInstructionsEffective: false,
      isReusableSession,
    })).resolves.toBe('fresh_voice');

    expect(isReusableSession).not.toHaveBeenCalled();
    expect(spawnTrustedHiddenSystemSession).toHaveBeenCalledOnce();
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      directory: voiceHomeDirectory,
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: exactConnectedServices,
      permissionMode: 'default',
    }));
  });

  it('fresh-creates when every reusable hidden voice-home candidate mismatches one required identity field', async () => {
    const {
      ensureVoiceConversationSessionForVoiceHome,
    } = await import('@/voice/persistence/voiceConversationSession');
    enableCodexStartupInstructionsV1();
    state.sessions = {
      wrong_backend: createVoiceHomeCandidate('wrong_backend', {
        backendTarget: { kind: 'backend', backendId: 'claude' },
      }),
      wrong_profile: createVoiceHomeCandidate('wrong_profile', {
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'codex-personal',
            },
          },
        },
      }),
      wrong_group: createVoiceHomeCandidate('wrong_group', {
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'secondary',
              profileId: 'codex-work',
            },
          },
        },
      }),
      wrong_permission: createVoiceHomeCandidate('wrong_permission', {
        permissionMode: 'read-only',
      }),
      wrong_startup_id: createVoiceHomeCandidate('wrong_startup_id', {
        voiceAgentStartupInstructionsV1: {
          ...globalVoiceStartupMarker,
          id: 'happier.other_voice_agent',
        },
      }),
      wrong_startup_revision: createVoiceHomeCandidate('wrong_startup_revision', {
        voiceAgentStartupInstructionsV1: {
          ...globalVoiceStartupMarker,
          revision: 0,
        },
      }),
      wrong_machine: createVoiceHomeCandidate('wrong_machine', {
        machineId: 'm2',
      }),
      wrong_directory: createVoiceHomeCandidate('wrong_directory', {
        path: '/tmp/.happier/other-voice-agent',
      }),
    };
    installFreshVoiceHomeSpawn();
    const isReusableSession = vi.fn(() => true);

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: exactConnectedServices,
      permissionIntent: 'default',
      coldResumeStartupInstructionsEffective: true,
      isReusableSession,
    })).resolves.toBe('fresh_voice');

    expect(isReusableSession).not.toHaveBeenCalled();
    expect(spawnTrustedHiddenSystemSession).toHaveBeenCalledOnce();
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      directory: voiceHomeDirectory,
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: exactConnectedServices,
      permissionMode: 'default',
    }));
  });

  it('fails closed before sending startup text when an old daemon projects no V1 capability', async () => {
    const {
      ensureVoiceConversationSessionForVoiceHome,
    } = await import('@/voice/persistence/voiceConversationSession');
    loadDaemonMergedProjectionInputs.mockResolvedValue({
      pluginProjectionV2: {
        v: 2,
        agentsById: { codex: { id: 'codex' } },
        backendsById: {
          codex: { id: 'codex', agentId: 'codex' },
        },
      },
    });

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      permissionIntent: 'default',
      coldResumeStartupInstructionsEffective: false,
      isReusableSession: () => false,
    })).rejects.toMatchObject({
      code: 'VOICE_AGENT_STARTUP_INSTRUCTIONS_UNSUPPORTED',
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('waits briefly for a late-hydrated global spawn target before failing', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.settings.recentMachinePaths = [];
    state.sessions = {};

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    setTimeout(() => {
      state.settings.recentMachinePaths = [{ machineId: 'm1', path: '/tmp/repo' }];
    }, 25);

    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'm1',
        directory: '/tmp/.happier/voice-agent',
      }),
    );
  });

  it('fails closed instead of roaming when the fixed machine target is inactive', async () => {
    vi.useFakeTimers();
    try {
      const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.machines = {
      m_stale: { id: 'm_stale', active: false, metadata: { host: 'stale', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/stale', homeDir: '/home/u' } },
      m_active: { id: 'm_active', active: true, metadata: { host: 'active', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/active', homeDir: '/home/u' } },
    };
    state.settings.voice.executionMachine = { mode: 'fixed', machineId: 'm_stale', autoMachineId: null };
    state.settings.recentMachinePaths = [{ machineId: 'm_active', path: '/tmp/repo-active' }];

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        metadata: { path: '/tmp/repo-active', host: 'active', machineId: 'm_active', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

      const pending = ensureVoiceConversationSessionId();
      const rejection = expect(pending).rejects.toMatchObject({ code: 'VOICE_CONVERSATION_TARGET_MISSING' });
      await flushHookEffects({ cycles: 1, advanceTimersMs: 5_100 });
      await rejection;
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when fixed-machine metadata is not hydrated instead of trusting a recent path', async () => {
    vi.useFakeTimers();
    try {
      const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.machines = {};
    state.settings.voice.executionMachine = { mode: 'fixed', machineId: 'm_fixed', autoMachineId: null };
    state.settings.recentMachinePaths = [
      { machineId: 'm_fixed', path: '/tmp/fixed-repo' },
      { machineId: 'm_other', path: '/tmp/other-repo' },
    ];

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        metadata: { path: '/tmp/fixed-repo', host: 'fixed', machineId: 'm_fixed', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

      const pending = ensureVoiceConversationSessionId();
      const rejection = expect(pending).rejects.toMatchObject({ code: 'VOICE_CONVERSATION_TARGET_MISSING' });
      await flushHookEffects({ cycles: 1, advanceTimersMs: 5_100 });
      await rejection;
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores stale inactive recent-machine candidates and falls back to an active machine for voice home', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.machines = {
      m_stale: {
        id: 'm_stale',
        active: false,
        metadata: { host: 'stale', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/stale', homeDir: '/home/u' },
      },
      m_active: {
        id: 'm_active',
        active: true,
        metadata: { host: 'active', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/active', homeDir: '/home/u' },
      },
    };
    state.settings.recentMachinePaths = [{ machineId: 'm_stale', path: '/tmp/stale-repo' }];
    state.sessions = {
      stale_session: {
        id: 'stale_session',
        updatedAt: 1,
        active: true,
        metadata: { path: '/tmp/stale-repo', host: 'stale', machineId: 'm_stale', homeDir: '/home/u' },
      },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 2,
        metadata: { path: '/tmp/active/voice-agent', host: 'active', machineId: 'm_active', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'm_active',
        directory: '/tmp/active/voice-agent',
        transcriptStorage: 'persisted',
      }),
    );
  });

  it('prefers the sticky auto-selected voice machine over a newer recent machine path', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.machines = {
      m_recent: {
        id: 'm_recent',
        active: true,
        activeAt: Date.now(),
        metadata: { host: 'recent', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/recent', homeDir: '/home/u' },
      },
      m_sticky: {
        id: 'm_sticky',
        active: true,
        activeAt: Date.now(),
        metadata: { host: 'sticky', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/sticky', homeDir: '/home/u' },
      },
    };
    state.settings.recentMachinePaths = [{ machineId: 'm_recent', path: '/tmp/recent-repo' }];
    state.settings.voice.executionMachine = { mode: 'auto', machineId: null, autoMachineId: 'm_sticky' };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        active: true,
        metadata: { path: '/tmp/sticky/voice-agent', host: 'sticky', machineId: 'm_sticky', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'm_sticky',
        directory: '/tmp/sticky/voice-agent',
      }),
    );
  });

  it('fails closed instead of roaming when a sticky auto-selected voice machine is unavailable', async () => {
    vi.useFakeTimers();
    try {
      const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

      state.machines = {
        m_sticky: {
          id: 'm_sticky',
          active: false,
          activeAt: 0,
          metadata: { host: 'sticky', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/sticky', homeDir: '/home/u' },
        },
        m_other: {
          id: 'm_other',
          active: true,
          activeAt: Date.now(),
          metadata: { host: 'other', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/other', homeDir: '/home/u' },
        },
      };
      state.settings.voice.executionMachine = { mode: 'auto', machineId: null, autoMachineId: 'm_sticky' };
      state.settings.recentMachinePaths = [{ machineId: 'm_other', path: '/tmp/other-repo' }];

      spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
      refreshSessions.mockImplementation(async () => {
        state.sessions.sys_voice = {
          id: 'sys_voice',
          updatedAt: 1,
          active: true,
          metadata: { path: '/tmp/other/voice-agent', host: 'other', machineId: 'm_other', homeDir: '/home/u' },
        };
      });
      patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
        state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
      });

      const pending = ensureVoiceConversationSessionId();
      const rejection = expect(pending).rejects.toMatchObject({ code: 'VOICE_CONVERSATION_TARGET_MISSING' });
      await flushHookEffects({ cycles: 1, advanceTimersMs: 5_100 });
      await rejection;
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves the voice-home spawn target from the active server machine list when the machine record map is empty', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.machines = {};
    state.machineListByServerId = {
      'server-a': [
        {
          id: 'm_server',
          active: true,
          activeAt: Date.now(),
          metadata: {
            host: 'server-machine',
            platform: 'darwin',
            happyCliVersion: '1',
            happyHomeDir: '/tmp/server-happy',
            homeDir: '/home/u',
          },
        },
      ],
    };
    state.settings.recentMachinePaths = [];

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 1,
        active: true,
        metadata: { path: '/tmp/server-happy/voice-agent', host: 'server-machine', machineId: 'm_server', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'm_server',
        directory: '/tmp/server-happy/voice-agent',
      }),
    );
  });

  it('ensureVoiceConversationSessionForSessionRoot spawns a hidden voice conversation session in the session project root', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.s_user = {
      id: 's_user',
      updatedAt: 1,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice_repo' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice_repo = {
        id: 'sys_voice_repo',
        updatedAt: 1,
        metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionId: 's_user' })).resolves.toBe('sys_voice_repo');
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      directory: '/tmp/repo',
      transcriptStorage: 'persisted',
    }));
    expect(state.sessions.sys_voice_repo.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_conversation', hidden: true });
    expect(state.sessions.sys_voice_repo.metadata.voiceConversationScopeV1).toMatchObject({
      v: 1,
      kind: 'session_root',
      sessionRootId: 's_user',
    });
  });

  it('reuses an exact session-root voice conversation across Windows separator spellings', async () => {
    const {
      ensureVoiceConversationSessionForSessionRoot,
    } = await import('@/voice/persistence/voiceConversationSession');
    state.sessions = {
      s_user: {
        id: 's_user',
        active: true,
        updatedAt: 1,
        metadata: {
          path: String.raw`C:\Workspace\Repo`,
          host: 'm1',
          machineId: 'm1',
          homeDir: String.raw`C:\Users\Alice`,
        },
      },
      exact_session_root_voice: {
        id: 'exact_session_root_voice',
        active: true,
        updatedAt: 10,
        metadata: {
          path: 'c:/workspace/repo/',
          host: 'm1',
          machineId: 'm1',
          homeDir: String.raw`C:\Users\Alice`,
          systemSessionV1: {
            v: 1,
            key: 'voice_conversation',
            hidden: true,
          },
          voiceConversationScopeV1: {
            v: 1,
            kind: 'session_root',
            sessionRootId: 's_user',
          },
        },
      },
    };
    patchSessionMetadataWithRetry.mockImplementation(
      async (sessionId: string, updater: (m: any) => any) => {
        state.sessions[sessionId].metadata = updater(
          state.sessions[sessionId].metadata,
        );
      },
    );

    await expect(ensureVoiceConversationSessionForSessionRoot({
      sessionId: 's_user',
    })).resolves.toBe('exact_session_root_voice');

    expect(refreshSessions).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('keeps a Windows session-root spawn directory operational while hashing its normalized identity', async () => {
    const {
      ensureVoiceConversationSessionForSessionRoot,
    } = await import('@/voice/persistence/voiceConversationSession');
    const operationalDirectory = String.raw`C:\Workspace\Repo`;
    state.sessions.s_user = {
      id: 's_user',
      active: true,
      updatedAt: 1,
      metadata: {
        path: operationalDirectory,
        host: 'm1',
        machineId: 'm1',
        homeDir: String.raw`C:\Users\Alice`,
      },
    };
    spawnSession.mockResolvedValue({
      type: 'success',
      sessionId: 'windows_session_root_voice',
    });
    refreshSessions.mockImplementation(async () => {
      state.sessions.windows_session_root_voice = {
        id: 'windows_session_root_voice',
        active: true,
        updatedAt: 2,
        metadata: {
          path: operationalDirectory,
          host: 'm1',
          machineId: 'm1',
          homeDir: String.raw`C:\Users\Alice`,
        },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(
      async (sessionId: string, updater: (m: any) => any) => {
        state.sessions[sessionId].metadata = updater(
          state.sessions[sessionId].metadata,
        );
      },
    );

    await expect(ensureVoiceConversationSessionForSessionRoot({
      sessionId: 's_user',
    })).resolves.toBe('windows_session_root_voice');

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: operationalDirectory,
      userAttemptId: buildVoiceSpawnUserAttemptId({
        surface: 'voice_session_root',
        serverId: 'server-a',
        machineId: 'm1',
        directory: 'c:/workspace/repo',
        backendTarget: { kind: 'backend', backendId: 'claude' },
        sessionId: 's_user',
      }),
    }));
  });

  it('does not claim an unverified same-directory session after an ambiguous spawn timeout', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.s_user = {
      id: 's_user',
      active: true,
      activeAt: 1,
      updatedAt: 1,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };

    spawnSession.mockResolvedValue({
      type: 'error',
      errorCode: 'session_webhook_timeout',
      errorMessage: 'Session startup timed out',
    });
    refreshSessions.mockImplementation(async () => {
      if (refreshSessions.mock.calls.length < 2) {
        return;
      }
      state.sessions.sys_voice_repo_late = {
        id: 'sys_voice_repo_late',
        active: true,
        activeAt: 2,
        updatedAt: 2,
        metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionId: 's_user' })).rejects.toMatchObject({
      code: 'session_webhook_timeout',
    });

    expect(refreshSessions).toHaveBeenCalledOnce();
    expect(refreshSessions).toHaveBeenCalledWith({ awaitSessionListHydration: true });
    expect(state.sessions.sys_voice_repo_late).toBeUndefined();
  });

  it('reuses an active hidden voice session only for the same session root', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.s_user_a = {
      id: 's_user_a',
      updatedAt: 1,
      active: true,
      activeAt: 1,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };
    state.sessions.s_user_b = {
      id: 's_user_b',
      updatedAt: 2,
      active: true,
      activeAt: 2,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };
    state.sessions.sys_voice_repo_a = {
      id: 'sys_voice_repo_a',
      active: true,
      activeAt: 100,
      updatedAt: 100,
      metadata: {
        path: '/tmp/repo',
        host: 'm1',
        machineId: 'm1',
        homeDir: '/home/u',
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceConversationScopeV1: { v: 1, kind: 'session_root', sessionRootId: 's_user_a' },
      },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice_repo_b' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice_repo_b = {
        id: 'sys_voice_repo_b',
        active: true,
        activeAt: 101,
        updatedAt: 101,
        metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionId: 's_user_b' })).resolves.toBe('sys_voice_repo_b');
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('reuses an active hidden voice session for the same session root', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.s_user = {
      id: 's_user',
      updatedAt: 1,
      active: true,
      activeAt: 1,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };
    state.sessions.sys_voice_repo = {
      id: 'sys_voice_repo',
      active: true,
      activeAt: 100,
      updatedAt: 100,
      metadata: {
        path: '/tmp/repo',
        host: 'm1',
        machineId: 'm1',
        homeDir: '/home/u',
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceConversationScopeV1: { v: 1, kind: 'session_root', sessionRootId: 's_user' },
      },
    };
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionId: 's_user' })).resolves.toBe('sys_voice_repo');
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('surfaces the underlying spawn error when creating a hidden voice conversation session for a target root fails', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.s_user = {
      id: 's_user',
      updatedAt: 1,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };

    spawnSession.mockResolvedValue({
      type: 'error',
      errorCode: 'daemon_rpc_unavailable',
      errorMessage: 'Daemon RPC is not available (RPC method not available).',
    });

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionId: 's_user' })).rejects.toMatchObject({
      message: 'Daemon RPC is not available (RPC method not available).',
      code: 'daemon_rpc_unavailable',
    });
  });

  it('fails fast when the target root machine daemon is offline', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');
    state.sessions.s_user = {
      id: 's_user',
      updatedAt: 1,
      active: true,
      activeAt: 1,
      presence: 'online',
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };
    state.machines.m1 = {
      id: 'm1',
      seq: 1,
      createdAt: 0,
      updatedAt: 0,
      active: true,
      activeAt: Date.now() - 5 * 60_000,
      revokedAt: null,
      metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/.happier', homeDir: '/home/u' },
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionId: 's_user' })).rejects.toMatchObject({
      message: 'Target machine daemon is offline. Start or reconnect the daemon before starting local voice.',
      code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE',
    });

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('does not reuse an inactive hidden voice home session as the runtime anchor', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.stale_voice = {
      id: 'stale_voice',
      active: false,
      activeAt: 10,
      updatedAt: 999,
      metadata: {
        path: '/tmp/.happier/voice-agent',
        host: 'm1',
        machineId: 'm1',
        homeDir: '/home/u',
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice_fresh' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice_fresh = {
        id: 'sys_voice_fresh',
        active: true,
        activeAt: 1000,
        updatedAt: 1000,
        metadata: { path: '/tmp/.happier/voice-agent', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice_fresh');
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('hydrates a missing target session before spawning a hidden voice conversation session for its root', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    ensureSessionVisibleForMessageRoute.mockImplementation(async (sessionId: string) => {
      if (sessionId !== 's_remote') throw new Error(`unexpected session ${sessionId}`);
      state.sessions.s_remote = {
        id: 's_remote',
        updatedAt: 1,
        metadata: { path: '/tmp/remote-repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice_remote' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice_remote = {
        id: 'sys_voice_remote',
        updatedAt: 1,
        metadata: { path: '/tmp/remote-repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionId: 's_remote' })).resolves.toBe('sys_voice_remote');
    expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('s_remote');
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      directory: '/tmp/remote-repo',
      transcriptStorage: 'persisted',
    }));
  });

  it('does not reuse an inactive hidden voice session for a target root', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.s_user = {
      id: 's_user',
      updatedAt: 1,
      active: true,
      activeAt: 1,
      metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
    };
    state.sessions.stale_voice_repo = {
      id: 'stale_voice_repo',
      active: false,
      activeAt: 10,
      updatedAt: 999,
      metadata: {
        path: '/tmp/repo',
        host: 'm1',
        machineId: 'm1',
        homeDir: '/home/u',
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice_repo_fresh' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice_repo_fresh = {
        id: 'sys_voice_repo_fresh',
        active: true,
        activeAt: 1000,
        updatedAt: 1000,
        metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionId: 's_user' })).resolves.toBe('sys_voice_repo_fresh');
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('retires an existing direct-linked voice conversation session and spawns a persisted replacement', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.sessions.legacy_direct = {
      id: 'legacy_direct',
      updatedAt: 20,
      metadata: {
        path: '/tmp/.happier/voice-agent',
        machineId: 'm1',
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'm1',
          remoteSessionId: 'remote-1',
          source: { kind: 'codexHome', home: 'user' },
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice_fresh' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice_fresh = {
        id: 'sys_voice_fresh',
        updatedAt: 21,
        metadata: { path: '/tmp/.happier/voice-agent', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice_fresh');

    expect(state.sessions.legacy_direct.metadata.systemSessionV1).toMatchObject({
      v: 1,
      key: 'voice_conversation_retired',
      hidden: true,
    });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      directory: '/tmp/.happier/voice-agent',
      transcriptStorage: 'persisted',
    }));
  });

  it('applies single-root policy by retiring older voice conversation sessions', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.settings.voice.providers.local_conversation.config.agent.rootSessionPolicy = 'single';
    state.sessions = {
      old1: { id: 'old1', updatedAt: 5, metadata: { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true }, path: '/tmp/x', machineId: 'm1' } },
      old2: { id: 'old2', updatedAt: 6, metadata: { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true }, path: '/tmp/y', machineId: 'm1' } },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 10,
        metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');

    expect(state.sessions.old1.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_conversation_retired', hidden: true });
    expect(state.sessions.old2.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_conversation_retired', hidden: true });
  });

  it('applies keep-warm policy by keeping only maxWarmRoots voice conversation sessions', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/persistence/voiceConversationSession');

    state.settings.voice.providers.local_conversation.config.agent.rootSessionPolicy = 'keep_warm';
    state.settings.voice.providers.local_conversation.config.agent.maxWarmRoots = 2;
    state.sessions = {
      keep: { id: 'keep', updatedAt: 99, metadata: { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true }, path: '/tmp/keep', machineId: 'm1' } },
      retire: { id: 'retire', updatedAt: 1, metadata: { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true }, path: '/tmp/retire', machineId: 'm1' } },
    };

    spawnSession.mockResolvedValue({ type: 'success', sessionId: 'sys_voice' });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice = {
        id: 'sys_voice',
        updatedAt: 100,
        metadata: { path: '/tmp/repo', host: 'm1', machineId: 'm1', homeDir: '/home/u' },
      };
    });
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');

    expect(state.sessions.keep.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_conversation', hidden: true });
    expect(state.sessions.retire.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_conversation_retired', hidden: true });
  });
});
