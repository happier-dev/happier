import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key: string) => `t:${key}`,
  });
});

const state: any = {
  settings: {
    backendEnabledByTargetKey: {
      [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: false,
    },
  },
  sessions: {
      s1: {
        id: 's1',
        metadata: {
          machineId: 'm1',
        },
      },
    },
  sessionListRenderables: {},
  sessionListIndexByServerId: {},
  concurrentSessionListCacheByServerId: {},
};

const getMachineCapabilitiesSnapshot = vi.fn();
const machineContributionRegistryProjectionDescribeMock = vi.fn(async (..._args: unknown[]): Promise<any> => ({ supported: false, reason: 'not-supported' }));

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

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
  getMachineCapabilitiesSnapshot: (...args: any[]) => getMachineCapabilitiesSnapshot(...args),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
  machineContributionRegistryProjectionDescribe: (...args: any[]) => machineContributionRegistryProjectionDescribeMock(...args),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

describe('review engine voice tool', () => {
  beforeEach(() => {
    state.settings.backendEnabledByTargetKey = {
      [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: false,
    };
    state.sessions = {
      s1: {
        id: 's1',
        metadata: {
          machineId: 'm1',
        },
      },
    };
    state.machines = {};
    state.sessionListRenderables = {};
    state.sessionListIndexByServerId = {};
    state.concurrentSessionListCacheByServerId = {};
    state.getProjectForSession = undefined;
    getMachineCapabilitiesSnapshot.mockReset();
    machineContributionRegistryProjectionDescribeMock.mockReset();
    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({ supported: false, reason: 'not-supported' });
    getMachineCapabilitiesSnapshot.mockReturnValue({
      response: {
        results: {
          'tool.executionRuns': {
            ok: true,
            data: {
              backends: {
                codex: { available: true, intents: ['review'] },
                gemini: { available: false, intents: ['review'] },
                coderabbit: { available: true, intents: ['review'] },
              },
            },
          },
        },
      },
    });
  });

  it('filters disabled review engines by default', async () => {
    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const res: any = await listReviewEnginesForVoiceTool({ sessionId: 's1' });

    expect(res.items.map((item: any) => item.engineId)).toEqual(expect.arrayContaining(['codex', 'coderabbit']));
    expect(res.items.map((item: any) => item.engineId)).not.toContain('gemini');
  });

  it('uses the resolved backend catalog title for built-in review engine labels', async () => {
    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const res: any = await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true });

    const codex = (res.items ?? []).find((item: any) => item.engineId === 'codex');
    expect(codex).toBeTruthy();
    expect(codex.label).toBe('t:agentInput.agent.codex');
  });

  it('uses daemon merged projection titles for discovered/plugin review engine labels', async () => {
    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
      supported: true,
      projection: {
        v: 1,
        providersById: {
          'plugin:coderabbit': {
            providerId: 'plugin:coderabbit',
            title: 'CodeRabbit Plugin',
            subtitle: null,
            channel: 'plugin',
            isBuiltIn: false,
          },
        },
        backendsById: {
          coderabbit: {
            backendId: 'coderabbit',
            providerId: 'plugin:coderabbit',
            title: 'CodeRabbit (plugin)',
            subtitle: null,
            catalogAgentId: null,
            iconAgentId: null,
          },
        },
      },
    });

    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const res: any = await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true });

    const coderabbit = (res.items ?? []).find((item: any) => item.engineId === 'coderabbit');
    expect(coderabbit).toBeTruthy();
    expect(coderabbit.label).toBe('CodeRabbit (plugin)');
  });

  it('uses canonical backend keys when evaluating enabled state for discovered plugin review engines', async () => {
    state.settings.backendEnabledByTargetKey = {
      'backend:coderabbit': false,
    };
    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
      supported: true,
      projection: {
        v: 1,
        providersById: {
          'plugin:coderabbit': {
            providerId: 'plugin:coderabbit',
            title: 'CodeRabbit Plugin',
            subtitle: null,
            channel: 'plugin',
            isBuiltIn: false,
          },
        },
        backendsById: {
          coderabbit: {
            backendId: 'coderabbit',
            providerId: 'plugin:coderabbit',
            title: 'CodeRabbit (plugin)',
            subtitle: null,
            catalogAgentId: null,
            iconAgentId: null,
          },
        },
      },
    });

    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const res: any = await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true });

    const coderabbit = (res.items ?? []).find((item: any) => item.engineId === 'coderabbit');
    expect(coderabbit).toBeTruthy();
    expect(coderabbit.enabled).toBe(false);
  });

  it('includes disabled review engines when explicitly requested', async () => {
    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const res: any = await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true });

    const gemini = (res.items ?? []).find((item: any) => item.engineId === 'gemini');
    expect(gemini).toBeTruthy();
    expect(gemini.enabled).toBe(false);
  });

  it('prefers visible lookup session metadata over stale raw session metadata when resolving review engines', async () => {
    state.sessions.s1.metadata.machineId = 'raw-machine';
    state.sessionListRenderables = {
      s1: {
        id: 's1',
        updatedAt: 321,
        metadata: {
          machineId: 'lookup-machine',
          path: '/tmp/lookup',
        },
      },
    };
    state.sessionListIndexByServerId = {
      'server-a': [
        { type: 'session', sessionId: 's1', serverId: 'server-a', serverName: 'Server A' },
      ],
    };

    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    await listReviewEnginesForVoiceTool({ sessionId: 's1' });

    expect(getMachineCapabilitiesSnapshot).toHaveBeenCalledWith('lookup-machine', 'server-a');
  });

  it('loads review engine capabilities from the resolved session machine target before visible metadata', async () => {
    state.sessions.s1 = {
      id: 's1',
      active: false,
      metadata: {
        machineId: 'm-old',
        path: '/workspace/stale-repo',
      },
    };
    state.sessionListRenderables = {
      s1: {
        id: 's1',
        updatedAt: 321,
        metadata: {
          machineId: 'lookup-machine',
          path: '/tmp/lookup',
        },
      },
    };
    state.sessionListIndexByServerId = {
      'server-a': [
        { type: 'session', sessionId: 's1', serverId: 'server-a', serverName: 'Server A' },
      ],
    };
    state.machines = {
      'm-old': {
        id: 'm-old',
        active: false,
        activeAt: 1,
        replacedByMachineId: 'm-target',
        replacedAt: 2,
        metadata: { host: 'old.local' },
      },
      'm-target': {
        id: 'm-target',
        active: true,
        activeAt: 3,
        metadata: { host: 'target.local' },
      },
    };
    state.getProjectForSession = (sessionId: string) =>
      sessionId === 's1'
        ? { key: { machineId: 'm-target', rootPath: '/workspace/live-repo' } }
        : null;

    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    await listReviewEnginesForVoiceTool({ sessionId: 's1' });

    expect(getMachineCapabilitiesSnapshot).toHaveBeenCalledWith('m-target', 'server-a');
  });

  it('uses the owning server of the target session instead of the active server when resolving review engines', async () => {
    state.sessions.s_owned = {
      id: 's_owned',
      metadata: {
        machineId: 'raw-machine',
      },
    };
    state.sessionListRenderables = {
      s_owned: {
        id: 's_owned',
        updatedAt: 321,
        metadata: {
          machineId: 'lookup-machine',
          path: '/tmp/lookup',
        },
      },
    };
    state.sessionListIndexByServerId = {
      'server-owned': [
        { type: 'session', sessionId: 's_owned', serverId: 'server-owned', serverName: 'Server Owned' },
      ],
    };

    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    await listReviewEnginesForVoiceTool({ sessionId: 's_owned' });

    expect(getMachineCapabilitiesSnapshot).toHaveBeenCalledWith('lookup-machine', 'server-owned');
    expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('lookup-machine', expect.objectContaining({
      serverId: 'server-owned',
    }));
  });
});
