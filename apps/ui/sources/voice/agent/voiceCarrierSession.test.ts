import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

const spawnSession = vi.fn();
const refreshSessions = vi.fn();
const patchSessionMetadataWithRetry = vi.fn();

const getActiveServerSnapshot = vi.fn(() => ({ serverId: 'server-a', serverUrl: 'http://localhost', generation: 1 }));

const state: any = {
  sessions: {},
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
    state.settings.lastUsedAgent = 'claude';
    state.settings.recentMachinePaths = [{ machineId: 'm1', path: '/tmp/repo' }];
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
        directory: '/tmp/repo',
        agent: 'claude',
        serverId: 'server-a',
      }),
    );

    expect(state.sessions.sys_voice.metadata.systemSessionV1).toMatchObject({ v: 1, key: 'voice_carrier', hidden: true });
  });
});

