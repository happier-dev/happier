import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureAgentInstallablesBackground = vi.fn(async (_args: unknown) => {});
const getActiveServerSnapshot = vi.fn(() => ({ serverId: 'server-a' }));
const storageGetState = vi.fn<() => any>();

vi.mock('@/capabilities/ensureAgentInstallablesBackground', () => ({
  ensureAgentInstallablesBackground: (args: unknown) => ensureAgentInstallablesBackground(args),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => getActiveServerSnapshot(),
}));

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => storageGetState(),
  },
}));

describe('ensureVoiceAgentInstallablesBackground', () => {
  beforeEach(() => {
    ensureAgentInstallablesBackground.mockReset();
    getActiveServerSnapshot.mockReset();
    getActiveServerSnapshot.mockReturnValue({ serverId: 'server-a' });
    storageGetState.mockReset();
  });

  it('prefers visible lookup session metadata machine ids when the raw session metadata is stale', async () => {
    storageGetState.mockReturnValue({
      settings: { voice: { adapters: { local_conversation: {} } } },
      sessions: {
        s1: {
          id: 's1',
          metadata: { machineId: 'machine-raw' },
        },
      },
      sessionListRenderables: {
        s1: {
          id: 's1',
          updatedAt: 1,
          metadata: { machineId: 'machine-cached', path: '/tmp/cached' },
        },
      },
      sessionListIndexByServerId: {
        'server-a': [
          { type: 'session', sessionId: 's1', serverId: 'server-a', serverName: 'Server A' },
        ],
      },
      concurrentSessionListCacheByServerId: {},
    });

    const { ensureVoiceAgentInstallablesBackground } = await import('./ensureVoiceAgentInstallablesBackground');

    await ensureVoiceAgentInstallablesBackground({ agentId: 'claude', sessionId: 's1' });

    expect(ensureAgentInstallablesBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude',
        machineId: 'machine-cached',
        serverId: 'server-a',
        resumeSessionId: 's1',
      }),
    );
  });
});
