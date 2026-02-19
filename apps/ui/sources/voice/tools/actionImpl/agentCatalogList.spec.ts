import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';

const machineCapabilitiesInvoke = vi.fn();

const state: any = {
  settings: {
    backendEnabledById: {
      gemini: false,
    },
  },
};

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => state,
  },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

vi.mock('@/sync/ops/capabilities', () => ({
  machineCapabilitiesInvoke: (...args: any[]) => machineCapabilitiesInvoke(...args),
}));

describe('agent catalog voice tools', () => {
  beforeEach(() => {
    machineCapabilitiesInvoke.mockReset();
    state.settings.backendEnabledById = { gemini: false };
    resetDynamicModelProbeCacheForTests();
  });

  it('filters disabled backends by default (includeDisabled=false)', async () => {
    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentBackendsForVoiceTool({ includeDisabled: false });
    const ids = (res?.items ?? []).map((i: any) => i.agentId);
    expect(ids).not.toContain('gemini');
  });

  it('includes disabled backends when includeDisabled=true', async () => {
    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentBackendsForVoiceTool({ includeDisabled: true });
    const gemini = (res?.items ?? []).find((i: any) => i.agentId === 'gemini');
    expect(gemini).toBeTruthy();
    expect(gemini.enabled).toBe(false);
  });

  it('prefers dynamic model list from machine preflight when machineId is provided', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            { id: 'claude-opus', name: 'Claude Opus', description: 'Opus' },
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
});
