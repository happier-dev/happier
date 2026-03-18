import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

const spawnSession = vi.fn();
const refreshSessions = vi.fn();
const patchSessionMetadataWithRetry = vi.fn();
const ensureSessionVisibleForMessageRoute = vi.fn();

const getActiveServerSnapshot = vi.fn(() => ({ serverId: 'server-a', serverUrl: 'http://localhost', generation: 1 }));

const state: any = {
  sessions: {},
  machines: {},
  machineListByServerId: {},
  settings: {
    lastUsedAgent: 'claude',
    recentMachinePaths: [{ machineId: 'm1', path: '/tmp/repo' }],
    voice: { adapters: { local_conversation: { agent: { agentSource: 'session' } } } },
  },
};

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => state,
  },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => getActiveServerSnapshot(),
}));

vi.mock('@/sync/ops/machines', () => ({
  machineSpawnNewSession: (opts: any) => spawnSession(opts),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessions: () => refreshSessions(),
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
    refreshSessions.mockReset();
    patchSessionMetadataWithRetry.mockReset();
    ensureSessionVisibleForMessageRoute.mockReset();
    getActiveServerSnapshot.mockClear();
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
        adapters: {
          local_conversation: {
            agent: {
              agentSource: 'session',
              machineTargetMode: 'auto',
              machineTargetId: null,
              voiceHomeSubdirName: 'voice-agent',
            },
          },
        },
      },
    };
  });

  it('findVoiceConversationSessionId picks the newest hidden system voice conversation session', async () => {
    const { findVoiceConversationSessionId } = await import('@/voice/sessionBinding/voiceConversationSession');

    state.sessions = {
      s1: { id: 's1', updatedAt: 5, metadata: { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } },
      s2: { id: 's2', updatedAt: 10, metadata: { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } },
      s3: { id: 's3', updatedAt: 999, metadata: { systemSessionV1: { v: 1, key: 'other', hidden: true } } },
    };

    expect(findVoiceConversationSessionId(state)).toBe('s2');
  });

  it('ensureVoiceConversationSessionId spawns and then marks the session as a hidden voice conversation', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/sessionBinding/voiceConversationSession');

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
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        serverId: 'server-a',
        transcriptStorage: 'persisted',
      }),
    );

    expect(state.sessions.sys_voice.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_conversation', hidden: true });
  });

  it('waits briefly for a late-hydrated global spawn target before failing', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/sessionBinding/voiceConversationSession');

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

  it('ignores an inactive fixed machine target and falls back to an active recent machine path', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/sessionBinding/voiceConversationSession');

    state.machines = {
      m_stale: { id: 'm_stale', active: false, metadata: { host: 'stale', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/stale', homeDir: '/home/u' } },
      m_active: { id: 'm_active', active: true, metadata: { host: 'active', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/active', homeDir: '/home/u' } },
    };
    state.settings.voice.adapters.local_conversation.agent.machineTargetMode = 'fixed';
    state.settings.voice.adapters.local_conversation.agent.machineTargetId = 'm_stale';
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

    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'm_active',
        directory: '/tmp/active/voice-agent',
        transcriptStorage: 'persisted',
      }),
    );
  });

  it('falls back to a recent path when the fixed machine target metadata is not hydrated yet', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/sessionBinding/voiceConversationSession');

    state.machines = {};
    state.settings.voice.adapters.local_conversation.agent.machineTargetMode = 'fixed';
    state.settings.voice.adapters.local_conversation.agent.machineTargetId = 'm_fixed';
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

    await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'm_fixed',
        directory: '/tmp/fixed-repo',
        transcriptStorage: 'persisted',
      }),
    );
  });

  it('ignores stale inactive recent-machine candidates and falls back to an active machine for voice home', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/sessionBinding/voiceConversationSession');

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
    const { ensureVoiceConversationSessionId } = await import('@/voice/sessionBinding/voiceConversationSession');

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
    state.settings.voice.adapters.local_conversation.agent.autoTargetMachineId = 'm_sticky';

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

  it('falls back to an available recent machine path when a sticky auto-selected voice machine is unavailable', async () => {
    vi.useFakeTimers();
    try {
      const { ensureVoiceConversationSessionId } = await import('@/voice/sessionBinding/voiceConversationSession');

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
      state.settings.voice.adapters.local_conversation.agent.autoTargetMachineId = 'm_sticky';
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

      await expect(ensureVoiceConversationSessionId()).resolves.toBe('sys_voice');
      await vi.advanceTimersByTimeAsync(5_100);
      expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
        machineId: 'm_other',
        directory: '/tmp/other/voice-agent',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves the voice-home spawn target from the active server machine list when the machine record map is empty', async () => {
    const { ensureVoiceConversationSessionId } = await import('@/voice/sessionBinding/voiceConversationSession');

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
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/sessionBinding/voiceConversationSession');

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

  it('recovers a late-created hidden voice conversation session after a session-root spawn timeout', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/sessionBinding/voiceConversationSession');

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

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionId: 's_user' })).resolves.toBe('sys_voice_repo_late');

    expect(refreshSessions).toHaveBeenCalled();
    expect(state.sessions.sys_voice_repo_late.metadata.systemSessionV1).toMatchObject({
      v: 1,
      key: 'voice_conversation',
      hidden: true,
    });
    expect(state.sessions.sys_voice_repo_late.metadata.voiceConversationScopeV1).toMatchObject({
      v: 1,
      kind: 'session_root',
      sessionRootId: 's_user',
    });
  });

  it('reuses an active hidden voice session only for the same session root', async () => {
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/sessionBinding/voiceConversationSession');

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
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/sessionBinding/voiceConversationSession');

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
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/sessionBinding/voiceConversationSession');

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
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/sessionBinding/voiceConversationSession');

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
      active: false,
      activeAt: 0,
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
    const { ensureVoiceConversationSessionId } = await import('@/voice/sessionBinding/voiceConversationSession');

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
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/sessionBinding/voiceConversationSession');

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
    const { ensureVoiceConversationSessionForSessionRoot } = await import('@/voice/sessionBinding/voiceConversationSession');

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
    const { ensureVoiceConversationSessionId } = await import('@/voice/sessionBinding/voiceConversationSession');

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
    const { ensureVoiceConversationSessionId } = await import('@/voice/sessionBinding/voiceConversationSession');

    state.settings.voice.adapters.local_conversation.agent.rootSessionPolicy = 'single';
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
    const { ensureVoiceConversationSessionId } = await import('@/voice/sessionBinding/voiceConversationSession');

    state.settings.voice.adapters.local_conversation.agent.rootSessionPolicy = 'keep_warm';
    state.settings.voice.adapters.local_conversation.agent.maxWarmRoots = 2;
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
