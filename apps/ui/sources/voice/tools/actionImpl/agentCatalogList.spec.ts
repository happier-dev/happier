import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import {
  readDynamicModelProbeCache,
  resetDynamicModelProbeCacheForTests,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';

const machineCapabilitiesInvoke = vi.fn();

const state: any = {
  settings: {
    backendEnabledByTargetKey: {
      [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: false,
      [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'team-review' })]: false,
    },
    acpCatalogSettingsV1: {
      v: 2,
      backends: [{
        id: 'team-review',
        name: 'team-review',
        title: 'Team review',
        description: 'Custom team review backend',
        command: 'kiro-cli',
        args: ['acp'],
        env: {},
        transportProfile: 'kiro',
        capabilities: {
          supportsLoadSession: false,
          supportsModes: 'unknown',
          supportsModels: 'unknown',
          supportsConfigOptions: 'unknown',
          promptImageSupport: 'unknown',
        },
        createdAt: 1,
        updatedAt: 1,
      }],
    },
  },
};

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
            getState: () => state,
        } as typeof import('@/sync/domains/state/storage').storage,
});
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

vi.mock('@/sync/ops/capabilities', () => ({
  machineCapabilitiesInvoke: (...args: any[]) => machineCapabilitiesInvoke(...args),
}));

describe('agent catalog voice tools', () => {
  beforeEach(() => {
    machineCapabilitiesInvoke.mockReset();
    state.settings.backendEnabledByTargetKey = {
      [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: false,
      [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'team-review' })]: false,
    };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{
        id: 'team-review',
        name: 'team-review',
        title: 'Team review',
        description: 'Custom team review backend',
        command: 'kiro-cli',
        args: ['acp'],
        env: {},
        transportProfile: 'kiro',
        capabilities: {
          supportsLoadSession: false,
          supportsModes: 'unknown',
          supportsModels: 'unknown',
          supportsConfigOptions: 'unknown',
          promptImageSupport: 'unknown',
        },
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    resetDynamicModelProbeCacheForTests();
  });

  it('filters disabled backends by default (includeDisabled=false)', async () => {
    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentBackendsForVoiceTool({ includeDisabled: false });
    const targetKeys = (res?.items ?? []).map((i: any) => i.targetKey);
    expect(targetKeys).not.toContain('agent:gemini');
    expect(targetKeys).not.toContain('acpBackend:team-review');
  });

  it('includes disabled backends when includeDisabled=true', async () => {
    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentBackendsForVoiceTool({ includeDisabled: true });
    const gemini = (res?.items ?? []).find((i: any) => i.targetKey === 'agent:gemini');
    expect(gemini).toBeTruthy();
    expect(gemini.enabled).toBe(false);
    const configured = (res?.items ?? []).find((i: any) => i.targetKey === 'acpBackend:team-review');
    expect(configured).toBeTruthy();
    expect(configured.enabled).toBe(false);
  });

  it('applies limit to backend and model discovery results', async () => {
    const { listAgentBackendsForVoiceTool, listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const backends: any = await listAgentBackendsForVoiceTool({ includeDisabled: true, limit: 2 });
    expect(backends?.items).toHaveLength(2);

    const models: any = await listAgentModelsForVoiceTool({ agentId: 'claude', limit: 2 });
    expect(models?.items).toHaveLength(2);
  });

  it('uses curated static model labels instead of returning raw mode ids', async () => {
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const models: any = await listAgentModelsForVoiceTool({ agentId: 'claude', limit: 3 });

    expect(models?.items?.map((item: any) => item.label)).toEqual([
      'Default',
      'Opus 4.6',
      'Sonnet 4.6',
    ]);
  });

  it('prefers dynamic model list from machine preflight when machineId is provided', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            {
              id: 'claude-opus',
              name: 'Claude Opus',
              description: 'Opus',
              modelOptions: [{
                id: 'reasoning_effort',
                name: 'Thinking',
                type: 'select',
                currentValue: 'medium',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                ],
              }],
            },
          ],
          supportsFreeform: true,
        },
      },
    });

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });
    expect(machineCapabilitiesInvoke).toHaveBeenCalled();
    expect(res?.items?.map((m: any) => m.modelId)).toEqual(['default', 'claude-opus']);
    expect(res.supportsFreeform).toBe(true);
    expect(res.source).toBe('preflight');

    const cacheKey = buildDynamicModelProbeCacheKey({
      machineId: 'm1',
      targetKey: buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' }),
      serverId: 'server-a',
      cwd: null,
    });
    expect(cacheKey).toBeTruthy();
    const cacheEntry = cacheKey ? readDynamicModelProbeCache(cacheKey) : null;
    expect(cacheEntry?.kind).toBe('success');
    expect(cacheEntry?.kind === 'success' ? cacheEntry.value.availableModels : []).toEqual([
      { id: 'default', name: 'Default' },
      {
        id: 'claude-opus',
        name: 'Claude Opus',
        description: 'Opus',
        modelOptions: [{
          id: 'reasoning_effort',
          name: 'Thinking',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
          ],
        }],
      },
    ]);
  });

  it('caches dynamic model probes per machine/agent so repeated calls do not re-invoke the probe', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            { id: 'claude-opus', name: 'Claude Opus' },
          ],
          supportsFreeform: false,
        },
      },
    });

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });
    await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });

    expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(1);
  });

  it('probes configured ACP backend models through backendTargetKey', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            { id: 'model-review', name: 'Review Model' },
          ],
          supportsFreeform: true,
        },
      },
    });

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const params: Parameters<typeof listAgentModelsForVoiceTool>[0] & Readonly<{ backendTargetKey: string; limit: number }> = {
      backendTargetKey: 'acpBackend:team-review',
      machineId: 'm1',
      limit: 2,
    };
    const res: any = await listAgentModelsForVoiceTool({
      ...params,
    });

    expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
      'm1',
      {
        id: 'cli.customAcp',
        method: 'probeModels',
        params: {
          timeoutMs: 15_000,
          backendTarget: { kind: 'configuredAcpBackend', backendId: 'team-review' },
        },
      },
      { serverId: 'server-a' },
    );
    expect(res).toMatchObject({
      agentId: 'customAcp',
      machineId: 'm1',
      source: 'preflight',
      supportsFreeform: true,
      items: [
        { modelId: 'default', label: 'Default' },
        { modelId: 'model-review', label: 'Review Model' },
      ],
    });
  });

  it('rejects ambiguous customAcp model lookup without backendTargetKey', async () => {
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const res: any = await listAgentModelsForVoiceTool({
      agentId: 'customAcp',
      machineId: 'm1',
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
    });
    expect(machineCapabilitiesInvoke).not.toHaveBeenCalled();
  });
});
