import { afterEach, expect, it } from 'vitest';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';
import { SpawnFailureError } from '@/processes/spawnFailure/classifySpawnFailure';
import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';

afterEach(resetAgentModelsProbeCacheForTests);

it('reads current-only source observations without probing and still accepts an explicit changed observation', async () => {
  let probes = 0;
  let modelId = 'first';
  const catalogEntry = {
    id: 'example.current-only/agent', cliSubcommand: 'example.current-only/agent', vendorResumeSupport: 'unsupported',
    getPreflightSessionControlsProbeAdapter: async () => ({ probeModelsRaw: async () => {
      probes++;
      return [{ id: modelId, name: modelId }];
    } }),
  } satisfies AgentCatalogEntry;
  const input = { agentId: catalogEntry.id, catalogEntry, cwd: process.cwd() };
  const cold = await probeAgentModelsBestEffort({ ...input, currentOnly: true });
  expect(cold.source).toBe('unavailable');
  expect(probes).toBe(0);
  const first = await probeAgentModelsBestEffort(input);
  expect(first.availableModels.some(model => model.id === 'first')).toBe(true);
  expect(await probeAgentModelsBestEffort({ ...input, currentOnly: true })).toEqual(first);
  expect(probes).toBe(1);
  modelId = 'changed';
  const changed = await probeAgentModelsBestEffort({ ...input, bypassCache: true });
  expect(changed.availableModels.some(model => model.id === 'changed')).toBe(true);
  expect(await probeAgentModelsBestEffort({ ...input, currentOnly: true })).toEqual(changed);
  expect(probes).toBe(2);
});

it.each([
  ['dynamic', 'dynamic'],
  ['dynamic', 'static'],
  ['dynamic', undefined],
  ['static', 'dynamic'],
] as const)(
  'retains a last-good %s catalog after an external Agent reports a failed %s refresh',
  async (initialSource, source) => {
    let observation: unknown = {
      availableModels: [{ id: 'working', name: 'Working model' }], source: initialSource, observedAt: 42,
    };
    // The external plugin is the boundary; the host parser, cache and publication remain real.
    const catalogEntry = {
      id: 'example.refresh/agent', cliSubcommand: 'example.refresh/agent', vendorResumeSupport: 'unsupported',
      getPreflightSessionControlsProbeAdapter: async () => ({ probeModelsRaw: async () => observation }),
    } satisfies AgentCatalogEntry;
    const params = { agentId: catalogEntry.id, catalogEntry, cwd: process.cwd() };
    const initial = AgentModelsProbeObservationSchema.parse(await probeAgentModelsBestEffort(params));
    expect(initial.availableModels.map(model => model.id)).toContain('working');
    const spawnFailure = { reason: 'other', errno: 'ENOENT' } as const;
    for (const failure of [
      { refreshError: true, spawnFailure },
      { refreshError: true },
      { spawnFailure },
      { refreshError: false, spawnFailure },
      { availableModels: [{ id: 'invalid-model-without-name' }], spawnFailure },
    ]) {
      observation = { availableModels: [], ...(source ? { source } : {}), observedAt: 99, ...failure };
      const failed = AgentModelsProbeObservationSchema.parse(await probeAgentModelsBestEffort({ ...params, bypassCache: true }));
      expect(failed).toMatchObject({ source: initial.source, refreshError: true, cacheable: false,
        observedAt: initial.observedAt, availableModels: initial.availableModels });
      expect(failed.spawnFailure).toEqual(failure.spawnFailure);
      expect(await probeAgentModelsBestEffort(params)).toEqual(failed);
    }
    observation = { availableModels: [], source: 'dynamic', observedAt: 84 };
    const recovered = await probeAgentModelsBestEffort({ ...params, bypassCache: true });
    expect(recovered).toMatchObject({ source: 'dynamic', availableModels: [], observedAt: 84 });
    expect(recovered).not.toHaveProperty('spawnFailure');
    expect(recovered).not.toHaveProperty('refreshError');
    expect(recovered).not.toHaveProperty('cacheable', false);
    expect(await probeAgentModelsBestEffort(params)).toEqual(recovered);
  },
);

it('refreshes a contributed Agent catalog once, retaining its last observation after failure', async () => {
  let models: unknown = [{ id: 'old', name: 'Old' }];
  let probes = 0;
  // An independently contributed plugin supplies this boundary; normalization and cache remain real.
  const catalogEntry = {
    id: 'example.models/agent', cliSubcommand: 'example.models/agent', vendorResumeSupport: 'unsupported',
    getPreflightSessionControlsProbeAdapter: async () => ({
      probeModelsRaw: async () => { probes += 1; if (models instanceof Error) throw models; return models; },
    }),
  } satisfies AgentCatalogEntry;
  const params = { agentId: catalogEntry.id, catalogEntry, cwd: process.cwd() };
  const initial = await probeAgentModelsBestEffort(params);
  expect(initial.availableModels.map(model => model.id)).toEqual(['default', 'old']);
  models = [{ id: 'new', name: 'New' }];
  expect(await probeAgentModelsBestEffort(params)).toEqual(initial);
  const [fresh, shared] = await Promise.all([
    probeAgentModelsBestEffort({ ...params, bypassCache: true }),
    probeAgentModelsBestEffort({ ...params, bypassCache: true }),
  ]);
  expect(fresh.availableModels.map(model => model.id)).toEqual(['default', 'new']);
  expect(shared).toEqual(fresh);
  expect(probes).toBe(2);
  models = new SpawnFailureError(Object.assign(new Error('private executable path'), { code: 'EACCES' }), { syscall: 'spawn' });
  const failed = await probeAgentModelsBestEffort({ ...params, bypassCache: true });
  expect(failed).toMatchObject({ refreshError: true, cacheable: false, observedAt: fresh.observedAt,
    availableModels: fresh.availableModels, spawnFailure: { reason: 'other', errno: 'EACCES' } });
  expect(JSON.stringify(failed)).not.toContain('private executable path');
  expect(await probeAgentModelsBestEffort(params)).toEqual(failed);
  models = [];
  const recovered = await probeAgentModelsBestEffort({ ...params, bypassCache: true });
  expect(recovered).toMatchObject({
    source: 'dynamic', availableModels: [],
  });
  expect(recovered).not.toHaveProperty('spawnFailure');
});

it('preserves observation provenance and keeps last good dynamic rows over a degraded local catalog', async () => {
  let observation: unknown = { availableModels: [{ id: 'local', name: 'Local model' }], source: 'static', refreshError: true };
  const catalogEntry = {
    id: 'example.provenance/agent', cliSubcommand: 'example.provenance/agent', vendorResumeSupport: 'unsupported',
    getPreflightSessionControlsProbeAdapter: async () => ({ probeModelsRaw: async () => observation }),
  } satisfies AgentCatalogEntry;
  const params = { agentId: catalogEntry.id, catalogEntry, cwd: process.cwd(), bypassCache: true };
  const cold = await probeAgentModelsBestEffort(params);
  expect(cold).toMatchObject({ source: 'static', refreshError: true, cacheable: false,
    availableModels: expect.arrayContaining([{ id: 'local', name: 'Local model' }]) });
  expect(cold.observedAt).toBeUndefined();
  observation = { availableModels: [{ id: 'current', name: 'Current model' }], source: 'dynamic', observedAt: 42 };
  const current = await probeAgentModelsBestEffort(params);
  expect(current).toMatchObject({ source: 'dynamic', observedAt: 42,
    availableModels: expect.arrayContaining([{ id: 'current', name: 'Current model' }]) });
  observation = { availableModels: [{ id: 'local', name: 'Local model' }], source: 'static', refreshError: true };
  expect(await probeAgentModelsBestEffort(params)).toMatchObject({ source: 'dynamic', observedAt: 42,
    refreshError: true, cacheable: false, availableModels: current.availableModels });
});
