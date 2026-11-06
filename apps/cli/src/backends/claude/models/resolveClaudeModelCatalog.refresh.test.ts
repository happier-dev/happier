import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetClaudeModelCatalogCacheForTests, resolveClaudeModelCatalogResolution } from './resolveClaudeModelCatalog';

beforeEach(resetClaudeModelCatalogCacheForTests);
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetClaudeModelCatalogCacheForTests(); });

it('forces discovery through a warm cache, shares refresh work, and retains the last observation on failure', async () => {
  let now = 1_000;
  const response = (id: string) => new Response(JSON.stringify({ data: [{ id }] }));
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(response('old'));
  vi.stubGlobal('fetch', fetchMock);
  const params = { timeoutMs: 1_000, processEnv: { ANTHROPIC_API_KEY: 'test-key' }, nowMs: () => now };
  const initial = await resolveClaudeModelCatalogResolution(params);
  expect(initial.models.map(model => model.id)).toEqual(['old']);
  now = 2_000;
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const refreshParams = { ...params, bypassCache: true };
  const first = resolveClaudeModelCatalogResolution(refreshParams);
  const second = resolveClaudeModelCatalogResolution(refreshParams);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  finish(response('new'));
  const refreshed = await first;
  expect(await second).toEqual(refreshed);
  expect(refreshed).toMatchObject({ observedAt: 2_000, models: [{ id: 'new' }] });
  now = 3_000;
  fetchMock.mockRejectedValueOnce(new Error('network unavailable'));
  const failed = await resolveClaudeModelCatalogResolution(refreshParams);
  expect(failed).toMatchObject({ observedAt: 2_000, refreshError: true, models: [{ id: 'new' }] });
  expect(await resolveClaudeModelCatalogResolution(params)).toEqual(failed);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('publishes the cached catalog observation time rather than session publication time', async () => {
  const { resolveClaudeSessionModelsState } = await import('../sessionControls/resolveClaudeSessionModelsState');
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-observation-key');
  vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '1');
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'observed' }] }))));
  await resolveClaudeModelCatalogResolution({ timeoutMs: 1_000, nowMs: () => 1_000 });
  const state = await resolveClaudeSessionModelsState({
    cwd: process.cwd(), timeoutMs: 1_000, currentModelId: 'observed', nowMs: () => 2_000,
    probeInstalledRuntimeCapabilities: async () => ({ supportsEffort: true, supportsUltracode: true }),
  });
  expect(state?.updatedAt).toBe(1_000);
});

it('retains a concurrent successful observation when another caller-owned refresh fails', async () => {
  const pending: Array<(response: Response) => void> = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => new Promise(resolve => pending.push(resolve))));
  let now = 1_000;
  const params = { timeoutMs: 5_000, processEnv: { ANTHROPIC_API_KEY: 'concurrent-key' }, nowMs: () => now };
  const first = resolveClaudeModelCatalogResolution({ ...params, signal: new AbortController().signal });
  const second = resolveClaudeModelCatalogResolution({ ...params, signal: new AbortController().signal });
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[0]!(new Response(JSON.stringify({ data: [{ id: 'gateway-model' }] })));
  const successful = await first;
  expect(successful).toMatchObject({ source: 'dynamic', observedAt: 1_000, models: [{ id: 'gateway-model' }] });
  now = 2_000;
  pending[1]!(new Response(null, { status: 503 }));
  const failed = await second;
  expect(failed).toEqual({ ...successful, refreshError: true });
  expect(await resolveClaudeModelCatalogResolution(params)).toEqual(failed);
});
