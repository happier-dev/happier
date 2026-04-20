import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireCatalogEntryMock = vi.fn();
const loadBuiltInRuntimeOwnersMock = vi.fn();

vi.mock('@/backends/catalog', () => ({
  requireCatalogEntry: requireCatalogEntryMock,
}));

vi.mock('./catalog/builtIn/runtimeOwners', () => ({
  loadBuiltInRuntimeOwners: loadBuiltInRuntimeOwnersMock,
}));

vi.mock('@happier-dev/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/agents')>();
  return {
    ...actual,
    hasBuiltInAcpConfig: (agentId: string) => agentId === 'kiro',
  };
});

describe('createCatalogAcpBackend', () => {
  beforeEach(() => {
    requireCatalogEntryMock.mockReset();
    loadBuiltInRuntimeOwnersMock.mockReset();
  });

  it('resolves built-in generic ACP agents through the ACP runtime owner when the catalog entry has no ACP factory hook', async () => {
    const createRuntime = vi.fn(() => ({ kind: 'kiro-backend' }));
    requireCatalogEntryMock.mockReturnValue({
      id: 'kiro',
    });
    loadBuiltInRuntimeOwnersMock.mockResolvedValue({
      createRuntime,
    });

    const { createCatalogAcpBackend } = await import('./createCatalogAcpBackend');

    await expect(createCatalogAcpBackend('kiro', { cwd: '/tmp/workspace' })).resolves.toEqual({
      backend: { kind: 'kiro-backend' },
    });
    expect(loadBuiltInRuntimeOwnersMock).toHaveBeenCalledWith('kiro');
    expect(createRuntime).toHaveBeenCalledWith({ cwd: '/tmp/workspace' });
  });
});
