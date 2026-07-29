import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createConfiguredAcpProbeBackendMock } = vi.hoisted(() => ({
  createConfiguredAcpProbeBackendMock: vi.fn(async () => null),
}));

vi.mock('./configuredAcpProbeBackend', () => ({
  createConfiguredAcpProbeBackend: createConfiguredAcpProbeBackendMock,
}));

import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

describe('probeAgentModelsBestEffort (static-only providers)', () => {
  beforeEach(() => {
    resetAgentModelsProbeCacheForTests();
    createConfiguredAcpProbeBackendMock.mockClear();
  });

  it('does not start a hidden ACP backend when no canonical preflight model probe exists', async () => {
    const res = await probeAgentModelsBestEffort({
      agentId: 'qwen',
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(res).toMatchObject({
      agentId: 'qwen',
      source: 'unavailable',
      availableModels: [],
    });
  });

  it('falls back to curated static Claude model labels when dynamic probing is unavailable', async () => {
    const res = await probeAgentModelsBestEffort({
      agentId: 'claude',
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(res.agentId).toBe('claude');
    expect(res.availableModels.length).toBeGreaterThan(0);
    expect(res.source).toBe('static');
  });
});
