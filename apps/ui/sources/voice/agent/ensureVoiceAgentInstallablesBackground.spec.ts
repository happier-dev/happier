import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

const ensureAgentInstallablesBackground = vi.fn(async (_args: unknown) => {});
const getActiveServerSnapshot = vi.fn(() => ({ serverId: 'server-a' }));
const storageGetState = vi.fn<() => any>();

vi.mock('@/capabilities/ensureAgentInstallablesBackground', () => ({
  ensureAgentInstallablesBackground: (args: unknown) => ensureAgentInstallablesBackground(args),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => getActiveServerSnapshot(),
}));

const storageMock = createStorageModuleStub({
  storage: {
    getState: () => storageGetState(),
  } as any,
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

describe('ensureVoiceAgentInstallablesBackground', () => {
  beforeEach(() => {
    ensureAgentInstallablesBackground.mockReset();
    getActiveServerSnapshot.mockReset();
    getActiveServerSnapshot.mockReturnValue({ serverId: 'server-a' });
    storageGetState.mockReset();
  });

  it('prefers visible lookup session metadata machine ids when the raw session metadata is stale', async () => {
    storageGetState.mockReturnValue({
      settings: { voice: { providers: { local_conversation: { schemaVersion: 1, config: {} } } } },
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

  it('uses the resolved session machine target before raw or visible metadata', async () => {
    storageGetState.mockReturnValue({
      settings: { voice: { providers: { local_conversation: { schemaVersion: 1, config: {} } } } },
      sessions: {
        s1: {
          id: 's1',
          active: false,
          metadata: { machineId: 'machine-raw', path: '/tmp/raw' },
        },
      },
      machines: {
        'machine-raw': {
          id: 'machine-raw',
          active: false,
          activeAt: 1,
          metadata: { host: 'raw.local' },
          replacedByMachineId: 'machine-target',
          replacedAt: 2,
        },
        'machine-target': {
          id: 'machine-target',
          active: true,
          activeAt: 3,
          metadata: { host: 'target.local' },
        },
      },
      getProjectForSession: (sessionId: string) =>
        sessionId === 's1'
          ? { key: { machineId: 'machine-target', rootPath: '/tmp/target' } }
          : null,
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
        machineId: 'machine-target',
        serverId: 'server-a',
        resumeSessionId: 's1',
      }),
    );
  });
});
