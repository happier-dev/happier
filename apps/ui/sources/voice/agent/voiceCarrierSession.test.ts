import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

const spawnSession = vi.fn();
const refreshSessions = vi.fn();
const patchSessionMetadataWithRetry = vi.fn();

const getActiveServerSnapshot = vi.fn(() => ({ serverId: 'server-a', serverUrl: 'http://localhost', generation: 1 }));

const state: any = {
  sessions: {},
  machines: {},
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
    patchSessionMetadataWithRetry: (sessionId: string, updater: (m: any) => any) =>
      patchSessionMetadataWithRetry(sessionId, updater),
  },
}));

describe('voiceCarrierSession', () => {
  beforeEach(() => {
    vi.resetModules();
    spawnSession.mockReset();
    refreshSessions.mockReset();
    patchSessionMetadataWithRetry.mockReset();
    getActiveServerSnapshot.mockClear();
    useVoiceTargetStore.setState({ scope: 'global', primaryActionSessionId: null, trackedSessionIds: [], lastFocusedSessionId: null } as any);

    state.sessions = {};
    state.machines = {
      m1: { id: 'm1', metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/tmp/.happier', homeDir: '/home/u' } },
    };
    state.settings.lastUsedAgent = 'claude';
    state.settings.recentMachinePaths = [{ machineId: 'm1', path: '/tmp/repo' }];
    state.settings.voice.adapters.local_conversation.agent.voiceHomeSubdirName = 'voice-agent';
  });

  it('findVoiceCarrierSessionId picks the newest hidden system carrier session', async () => {
    const { findVoiceCarrierSessionId } = await import('./voiceCarrierSession');

    state.sessions = {
      s1: { id: 's1', updatedAt: 5, metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } },
      s2: { id: 's2', updatedAt: 10, metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } },
      s3: { id: 's3', updatedAt: 999, metadata: { systemSessionV1: { v: 1, key: 'other', hidden: true } } },
    };

    expect(findVoiceCarrierSessionId(state)).toBe('s2');
  });

  it('ensureVoiceCarrierSessionId spawns and then marks the session as hidden carrier', async () => {
    const { ensureVoiceCarrierSessionId } = await import('./voiceCarrierSession');

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

    await expect(ensureVoiceCarrierSessionId()).resolves.toBe('sys_voice');
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'm1',
        directory: '/tmp/.happier/voice-agent',
        agent: 'claude',
        serverId: 'server-a',
      }),
    );

    expect(state.sessions.sys_voice.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_carrier', hidden: true });
  });

  it('ensureVoiceCarrierSessionForSessionRoot spawns a carrier session in the session project root', async () => {
    const { ensureVoiceCarrierSessionForSessionRoot } = await import('./voiceCarrierSession');

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

    await expect(ensureVoiceCarrierSessionForSessionRoot({ sessionId: 's_user' })).resolves.toBe('sys_voice_repo');
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'm1', directory: '/tmp/repo' }));
    expect(state.sessions.sys_voice_repo.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_carrier', hidden: true });
  });

  it('applies single-root policy by retiring older carrier sessions', async () => {
    const { ensureVoiceCarrierSessionId } = await import('./voiceCarrierSession');

    state.settings.voice.adapters.local_conversation.agent.rootSessionPolicy = 'single';
    state.sessions = {
      old1: { id: 'old1', updatedAt: 5, metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true }, path: '/tmp/x', machineId: 'm1' } },
      old2: { id: 'old2', updatedAt: 6, metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true }, path: '/tmp/y', machineId: 'm1' } },
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

    await expect(ensureVoiceCarrierSessionId()).resolves.toBe('sys_voice');

    expect(state.sessions.old1.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_carrier_retired', hidden: true });
    expect(state.sessions.old2.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_carrier_retired', hidden: true });
  });

  it('applies keep-warm policy by keeping only maxWarmRoots carrier sessions', async () => {
    const { ensureVoiceCarrierSessionId } = await import('./voiceCarrierSession');

    state.settings.voice.adapters.local_conversation.agent.rootSessionPolicy = 'keep_warm';
    state.settings.voice.adapters.local_conversation.agent.maxWarmRoots = 2;
    state.sessions = {
      keep: { id: 'keep', updatedAt: 99, metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true }, path: '/tmp/keep', machineId: 'm1' } },
      retire: { id: 'retire', updatedAt: 1, metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true }, path: '/tmp/retire', machineId: 'm1' } },
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

    await expect(ensureVoiceCarrierSessionId()).resolves.toBe('sys_voice');

    expect(state.sessions.keep.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_carrier', hidden: true });
    expect(state.sessions.retire.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_carrier_retired', hidden: true });
  });
});
