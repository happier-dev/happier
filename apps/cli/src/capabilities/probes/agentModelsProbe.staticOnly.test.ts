import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createCatalogAcpBackendMock } = vi.hoisted(() => ({
  createCatalogAcpBackendMock: vi.fn(),
}));

vi.mock('@/agent/acp/createCatalogAcpBackend', () => ({
  createCatalogAcpBackend: createCatalogAcpBackendMock,
}));

const { validateCatalogAcpProbeSpawnMock } = vi.hoisted(() => ({
  validateCatalogAcpProbeSpawnMock: vi.fn(async () => ({ ok: false })),
}));

vi.mock('./validateCatalogAcpProbeSpawn', () => ({
  validateCatalogAcpProbeSpawn: validateCatalogAcpProbeSpawnMock,
}));

import { probeAgentModelsBestEffort } from './agentModelsProbe';

describe('probeAgentModelsBestEffort (static-only providers)', () => {
  beforeEach(() => {
    createCatalogAcpBackendMock.mockReset();
    validateCatalogAcpProbeSpawnMock.mockClear();
  });

  it('does not start ACP backend for qwen model probing', async () => {
    createCatalogAcpBackendMock.mockRejectedValue(new Error('unexpected acp backend creation'));
    const res = await probeAgentModelsBestEffort({
      agentId: 'qwen',
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(res.provider).toBe('qwen');
    expect(res.source).toBe('static');
    expect(createCatalogAcpBackendMock).not.toHaveBeenCalled();
  });

  it('does not start ACP backend for kimi model probing', async () => {
    createCatalogAcpBackendMock.mockRejectedValue(new Error('unexpected acp backend creation'));
    const res = await probeAgentModelsBestEffort({
      agentId: 'kimi',
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(res.provider).toBe('kimi');
    expect(res.source).toBe('static');
    expect(createCatalogAcpBackendMock).not.toHaveBeenCalled();
  });

  it('falls back to curated static Claude model labels when dynamic probing is unavailable', async () => {
    const res = await probeAgentModelsBestEffort({
      agentId: 'claude',
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(res).toMatchObject({
      provider: 'claude',
      source: 'static',
      availableModels: expect.arrayContaining([
        { id: 'default', name: 'Default' },
        {
          id: 'claude-opus-4-6',
          name: 'Opus 4.6',
          description: expect.any(String),
        },
        {
          id: 'claude-sonnet-4-6',
          name: 'Sonnet 4.6',
          description: expect.any(String),
        },
      ]),
    });
    expect(createCatalogAcpBackendMock).not.toHaveBeenCalled();
  });
});
