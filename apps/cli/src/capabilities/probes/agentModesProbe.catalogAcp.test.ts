import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createCatalogAcpBackendMock } = vi.hoisted(() => ({
  createCatalogAcpBackendMock: vi.fn(),
}));

vi.mock('@/agent/acp/createCatalogAcpBackend', () => ({
  createCatalogAcpBackend: createCatalogAcpBackendMock,
}));

const { validateCatalogAcpProbeSpawnMock } = vi.hoisted(() => ({
  validateCatalogAcpProbeSpawnMock: vi.fn(async () => ({ ok: true })),
}));

vi.mock('./validateCatalogAcpProbeSpawn', () => ({
  validateCatalogAcpProbeSpawn: validateCatalogAcpProbeSpawnMock,
}));

const { createConfiguredAcpProbeBackendMock } = vi.hoisted(() => ({
  createConfiguredAcpProbeBackendMock: vi.fn(async () => null),
}));

vi.mock('./configuredAcpProbeBackend', () => ({
  createConfiguredAcpProbeBackend: createConfiguredAcpProbeBackendMock,
}));

vi.mock('./resolvePreflightSessionControlsProbeAdapter', () => ({
  resolvePreflightSessionControlsProbeAdapter: vi.fn(async () => null),
}));

vi.mock('@/backends/catalog', () => ({
  AGENTS: {
    opencode: {
      getAcpRuntimeDefinitionBridge: async () => null,
    },
  },
}));

import { probeAgentModesBestEffort } from './agentModesProbe';

describe('probeAgentModesBestEffort (catalog ACP bridge)', () => {
  beforeEach(() => {
    createCatalogAcpBackendMock.mockReset();
    validateCatalogAcpProbeSpawnMock.mockClear();
    createConfiguredAcpProbeBackendMock.mockClear();
  });

  it('starts the catalog ACP backend for bridge-backed mode probing', async () => {
    const dispose = vi.fn(async () => undefined);
    createCatalogAcpBackendMock.mockResolvedValueOnce({
      backend: {
        startSession: async () => ({ sessionId: 'session-opencode' }),
        getSessionModeState: () => ({
          availableModes: [{ id: 'plan', name: 'Plan' }],
        }),
        getSessionConfigOptionsState: () => null,
        dispose,
      },
    });

    const result = await probeAgentModesBestEffort({
      agentId: 'opencode',
      cwd: '/repo/opencode-bridge-mode-probe',
      timeoutMs: 100,
    });

    expect(result).toEqual({
      provider: 'opencode',
      availableModes: [{ id: 'plan', name: 'Plan' }],
      source: 'dynamic',
    });
    expect(validateCatalogAcpProbeSpawnMock).toHaveBeenCalledWith('opencode');
    expect(createCatalogAcpBackendMock).toHaveBeenCalledWith('opencode', expect.objectContaining({
      cwd: '/repo/opencode-bridge-mode-probe',
    }));
    expect(dispose).toHaveBeenCalled();
  });
});
