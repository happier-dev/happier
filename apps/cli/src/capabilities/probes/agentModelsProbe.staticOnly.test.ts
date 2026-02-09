import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createCatalogAcpBackendMock } = vi.hoisted(() => ({
  createCatalogAcpBackendMock: vi.fn(),
}));

vi.mock('@/agent/acp/createCatalogAcpBackend', () => ({
  createCatalogAcpBackend: createCatalogAcpBackendMock,
}));

import { probeAgentModelsBestEffort } from './agentModelsProbe';

describe('probeAgentModelsBestEffort (static-only providers)', () => {
  beforeEach(() => {
    createCatalogAcpBackendMock.mockReset();
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
});
