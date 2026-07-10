import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const requireCatalogEntryMock = vi.hoisted(() => vi.fn());

vi.mock('@/agent/catalog/registry', () => ({
  requireCatalogEntry: requireCatalogEntryMock,
}));

import { validateCatalogAcpProbeSpawn } from './validateCatalogAcpProbeSpawn';

const envKeys = ['PATH', 'HAPPIER_CODEX_ACP_BIN'] as const;
let envScope = createEnvKeyScope(envKeys);

afterEach(() => {
  requireCatalogEntryMock.mockReset();
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  vi.resetModules();
});

describe('validateCatalogAcpProbeSpawn', () => {
  it('does not require a daemon spawn prerequisite hook for Codex after B.7 daemon hook extraction', async () => {
    envScope.patch({
      PATH: '',
      HAPPIER_CODEX_ACP_BIN: '/missing/codex-acp',
    });

    requireCatalogEntryMock.mockReturnValue({
      id: 'codex',
      getAcpRuntimeDefinitionBridge: async () => null,
    });

    const result = await validateCatalogAcpProbeSpawn('codex');
    expect(result).toEqual({ ok: true });
  });

  it('passes provider-keyed ACP runtime selection to legacy daemon spawn prerequisites', async () => {
    const resolveRuntimePrerequisites = vi.fn(async () => ({ ok: true as const }));
    requireCatalogEntryMock.mockReturnValue({
      id: 'pi',
      getAcpBackendFactory: async () => () => ({ backend: {} }),
      getDaemonSpawnHooks: async () => ({
        resolveRuntimePrerequisites,
      }),
    });

    const result = await validateCatalogAcpProbeSpawn('pi');

    expect(result).toEqual({ ok: true });
    expect(resolveRuntimePrerequisites).toHaveBeenCalledWith({
      providerRuntimeSelection: { piBackendMode: 'acp' },
    });
  });
});
