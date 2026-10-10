import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKey, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';

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
  sessionListRowsByServerId: {},
  ordinarySessionListMembershipByServerId: {},
  sessionListIndexByServerId: {},
  concurrentSessionListCacheByServerId: {},
};

const getMachineCapabilitiesSnapshot = vi.fn();
const machineContributionRegistryProjectionDescribeMock = vi.fn<typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe>(async () => ({ supported: false, reason: 'not-supported' }));

function createReviewProjection() {
  return PluginProjectionV2Schema.parse({
    v: 2,
    generation: 1,
    agentsById: {
      'plugin-review-bot': {
        id: 'plugin-review-bot',
        identity: { pluginId: 'acme.review', localId: 'review-bot' },
        settingsBackendId: 'plugin-review-bot',
        title: 'Review Bot Plugin',
        channel: 'plugin',
        isBuiltIn: false,
        providerOwnedEnvironmentKeys: [],
      },
    },
  });
}

function installReviewPluginCapabilities() {
  getMachineCapabilitiesSnapshot.mockReturnValue({ response: { results: {
    'tool.executionRuns': { ok: true, data: { backends: {
      'plugin-review-bot': { available: true, intents: ['review'] },
    } } },
  } } });
}

installVoiceToolActionImplCommonModuleMocks({
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: {
        getState: () => ({ ...state }),
      } as typeof import('@/sync/domains/state/storage').storage,
    });
  },
});

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
  getMachineCapabilitiesSnapshot: (...args: any[]) => getMachineCapabilitiesSnapshot(...args),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
  machineContributionRegistryProjectionDescribe: (...args: Parameters<typeof machineContributionRegistryProjectionDescribeMock>) => machineContributionRegistryProjectionDescribeMock(...args),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSettingsGet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSettingsSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    resetMachineProjectionReadsForTests: () => {},
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

// Initialize after the common fixture installer; its hoisted factory cannot
// select this fixture before the installer has executed.
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');

describe('review engine voice tool', () => {
  beforeEach(() => {
    resetAcpCatalogSnapshotsForTests();
    state.settingsScope = { serverId: 'server-a', accountId: 'account-a' };
    applyAcpCatalogSnapshot(state.settingsScope, { status: 'ready', record: { v: 1, definitions: [] }, revision: 1 }, true);
    clearDaemonMergedProjectionCacheForTests();
    state.settings.backendEnabledByTargetKey = {
      [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: false,
    };
    state.settings.acpCatalogSettingsV1 = { v: 2, backends: [] };
    state.sessions = {
      s1: {
        id: 's1',
        metadata: {
          machineId: 'm1',
        },
      },
    };
    state.machines = {};
    state.sessionListRowsByServerId = {};
    state.ordinarySessionListMembershipByServerId = {};
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

  it('reads configured review engine labels from the row and refuses unavailable facts without a settings root', async () => {
    const definition = AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review', command: 'review', createdAt: 1, updatedAt: 1 });
    const targetKey = resolveBackendTargetKeyV2({
      kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: definition.id,
    });
    delete state.settings.acpCatalogSettingsV1;
    applyAcpCatalogSnapshot(state.settingsScope, { status: 'ready', revision: 4, record: { v: 1, definitions: [definition] } }, true);
    getMachineCapabilitiesSnapshot.mockReturnValue({ response: { results: {
      'tool.executionRuns': { ok: true, data: { backends: { [targetKey]: { available: true, intents: ['review'] } } } },
    } } });
    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's1' })).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ engineId: targetKey, label: 'Row review' }),
    ]) });
    applyAcpCatalogSnapshot(state.settingsScope, { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's1' })).toMatchObject({ ok: false, errorCode: 'acp_catalog_unavailable' });
  });

  it('filters disabled review engines by default', async () => {
    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const res: any = await listReviewEnginesForVoiceTool({ sessionId: 's1' });

    expect(res.items.map((item: any) => item.engineId)).toEqual(expect.arrayContaining(['codex', 'coderabbit']));
    expect(res.items.map((item: any) => item.engineId)).not.toContain('gemini');
  });

  it('omits engines without exact-path support for a path-scoped review', async () => {
    getMachineCapabilitiesSnapshot.mockReturnValue({
      response: {
        results: {
          'tool.executionRuns': {
            ok: true,
            data: {
              backends: {
                codex: { available: true, intents: ['review'], reviewScopes: ['worktree', 'paths'] },
                coderabbit: { available: true, intents: ['review'], reviewScopes: ['worktree'] },
              },
            },
          },
        },
      },
    });

    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const res = await listReviewEnginesForVoiceTool({ sessionId: 's1', scope: 'paths' }) as {
      items: readonly { engineId: string }[];
    };

    expect(res.items.map((item) => item.engineId)).toContain('codex');
    expect(res.items.map((item) => item.engineId)).not.toContain('coderabbit');
  });

  it('offers a configured ACP review engine by its exact target key', async () => {
    const targetKey = 'backend:review-bot:configured:review-bot';
    applyAcpCatalogSnapshot(state.settingsScope, { status: 'ready', revision: 4, record: { v: 1, definitions: [AcpBackendDefinitionV1Schema.parse({
      id: 'review-bot', name: 'review-bot', title: 'Review Bot', command: 'review-bot',
      createdAt: 1, updatedAt: 1,
    })] } }, true);
    getMachineCapabilitiesSnapshot.mockReturnValue({ response: { results: {
      'tool.executionRuns': { ok: true, data: { backends: {
        [targetKey]: { available: true, intents: ['review'], title: 'Review Bot' },
      } } },
    } } });

    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const result = await listReviewEnginesForVoiceTool({ sessionId: 's1' }) as {
      items: readonly { engineId: string; label: string; enabled: boolean }[];
    };

    expect(result.items).toContainEqual({ engineId: targetKey, label: 'Review Bot', enabled: true, capabilities: { structuredNarration: false } });
  });

  it('says which engines can narrate a walkthrough from the current Agent declaration, never from the engine id', async () => {
    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
      supported: true,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
          codex: {
            id: 'codex',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            isBuiltIn: true,
            capabilities: {
              executionRuns: { open: ['create'], checkpoint: false, stop: true },
              structuredOutput: { formats: ['json'] },
            },
          },
        },
      }),
    });
    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const res = await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true }) as {
      items: readonly { engineId: string; capabilities?: { structuredNarration: boolean } }[];
    };
    const codex = res.items.find((item) => item.engineId === 'codex');
    expect(codex?.capabilities).toEqual({ structuredNarration: true });
    for (const item of res.items) {
      expect(item.capabilities, item.engineId).toBeDefined();
    }
  });

  it('does not infer narration from a bundled engine id when its current declaration is unavailable', async () => {
    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const result = await listReviewEnginesForVoiceTool({ sessionId: 's1' }) as {
      items: readonly { engineId: string; capabilities: { structuredNarration: boolean } }[];
    };
    expect(result.items.find((item) => item.engineId === 'codex')?.capabilities)
      .toEqual({ structuredNarration: false });
  });

  it('uses the resolved backend catalog title for built-in review engine labels', async () => {
    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const res: any = await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true });

    const codex = (res.items ?? []).find((item: any) => item.engineId === 'codex');
    expect(codex).toBeTruthy();
    expect(codex.label).toBe('t:agentInput.agent.codex');
  });

  it('uses daemon merged projection titles for discovered/plugin review engine labels', async () => {
    installReviewPluginCapabilities();
    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
      supported: true,
      projection: PluginProjectionV2Schema.parse({
        ...createReviewProjection(),
        agentsById: {
          'plugin-review-bot': {
            ...createReviewProjection().agentsById['plugin-review-bot'],
            capabilities: {
              executionRuns: { open: ['create'], checkpoint: false, stop: true },
              structuredOutput: { formats: ['json'] },
            },
          },
        },
      }),
    });

    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const res: any = await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true });

    expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m1', { serverId: 'server-a' });
    const plugin = (res.items ?? []).find((item: any) => item.engineId === 'plugin-review-bot');
    expect(plugin).toBeTruthy();
    expect(plugin.label).toBe('Review Bot Plugin');
    expect(plugin.capabilities).toEqual({ structuredNarration: true });
  });

  it('uses canonical backend keys when evaluating enabled state for discovered plugin review engines', async () => {
    installReviewPluginCapabilities();
    // The current projection proves the external carrier's qualified Agent target.
    state.settings.backendEnabledByTargetKey = {
      'agent:acme.review/review-bot': false,
    };
    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
      supported: true,
      projection: createReviewProjection(),
    });

    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const res: any = await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true });

    expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m1', { serverId: 'server-a' });
    const plugin = (res.items ?? []).find((item: any) => item.engineId === 'plugin-review-bot');
    expect(plugin).toBeTruthy();
    expect(plugin.enabled).toBe(false);
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
    state.sessionListRowsByServerId = {
      'server-a': {
        s1: {
          id: 's1',
          updatedAt: 321,
          metadata: {
            machineId: 'lookup-machine',
            path: '/tmp/lookup',
          },
        },
      },
    };
    state.ordinarySessionListMembershipByServerId = { 'server-a': ['s1'] };
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
    state.sessionListRowsByServerId = {
      'server-a': {
        s1: {
          id: 's1',
          updatedAt: 321,
          metadata: {
            machineId: 'lookup-machine',
            path: '/tmp/lookup',
          },
        },
      },
    };
    state.ordinarySessionListMembershipByServerId = { 'server-a': ['s1'] };
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
    state.sessionListRowsByServerId = {
      'server-owned': {
        s_owned: {
          id: 's_owned',
          updatedAt: 321,
          metadata: {
            machineId: 'lookup-machine',
            path: '/tmp/lookup',
          },
        },
      },
    };
    state.ordinarySessionListMembershipByServerId = { 'server-owned': ['s_owned'] };
    state.sessionListIndexByServerId = {
      'server-owned': [
        { type: 'session', sessionId: 's_owned', serverId: 'server-owned', serverName: 'Server Owned' },
      ],
    };

    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    await listReviewEnginesForVoiceTool({ sessionId: 's_owned', serverId: 'server-owned',
      acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
      backendEnabledByTargetKey: state.settings.backendEnabledByTargetKey });

    expect(getMachineCapabilitiesSnapshot).toHaveBeenCalledWith('lookup-machine', 'server-owned');
    expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('lookup-machine', expect.objectContaining({
      serverId: 'server-owned',
    }));
  });

  it('uses the captured Machine and Home for detached review discovery', async () => {
    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const result = await listReviewEnginesForVoiceTool({ sessionId: null, machineId: 'machine-detached',
      serverId: 'home-detached',
      acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
      backendEnabledByTargetKey: state.settings.backendEnabledByTargetKey });

    expect(result).toMatchObject({ sessionId: null, items: expect.any(Array) });
    expect(getMachineCapabilitiesSnapshot).toHaveBeenCalledWith('machine-detached', 'home-detached');
    expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-detached',
      expect.objectContaining({ serverId: 'home-detached' }));
  });

  it('refuses detached review discovery without its Machine or Home instead of using active context', async () => {
    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    expect(await listReviewEnginesForVoiceTool({ sessionId: null, serverId: 'home-detached' }))
      .toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
    expect(await listReviewEnginesForVoiceTool({ sessionId: null, machineId: 'machine-detached' }))
      .toMatchObject({ ok: false, errorCode: 'server_not_selected' });
    expect(getMachineCapabilitiesSnapshot).not.toHaveBeenCalled();
    expect(machineContributionRegistryProjectionDescribeMock).not.toHaveBeenCalled();
  });
});
