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

const { createConfiguredAcpProbeBackendMock } = vi.hoisted(() => ({
  createConfiguredAcpProbeBackendMock: vi.fn(async () => null),
}));

vi.mock('./createConfiguredAcpProbeBackend', () => ({
  createConfiguredAcpProbeBackend: createConfiguredAcpProbeBackendMock,
}));

vi.mock('@/backends/catalog', () => ({
  AGENTS: { claude: {} },
}));

import { probeAgentModelsBestEffort } from './agentModelsProbe';

describe('probeAgentModelsBestEffort (static-only providers)', () => {
  beforeEach(() => {
    createCatalogAcpBackendMock.mockReset();
    validateCatalogAcpProbeSpawnMock.mockClear();
    createConfiguredAcpProbeBackendMock.mockClear();
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

    expect(res.provider).toBe('claude');
    expect(res.source).toBe('static');
    expect(createConfiguredAcpProbeBackendMock).not.toHaveBeenCalled();

    expect(res.availableModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'default', name: 'Default' }),
      expect.objectContaining({
        id: 'claude-opus-4-6',
        name: 'Opus 4.6',
        description: expect.any(String),
      }),
      expect.objectContaining({
        id: 'claude-sonnet-4-6',
        name: 'Sonnet 4.6',
        description: expect.any(String),
      }),
    ]));

    const opus = res.availableModels.find((model) => model.id === 'claude-opus-4-6') ?? null;
    expect(opus?.modelOptions?.some((opt) => opt.id === 'reasoning_effort')).toBe(true);
    expect(createCatalogAcpBackendMock).not.toHaveBeenCalled();
  });
});
