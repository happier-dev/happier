import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => {
    throw new Error('generic CLI fallback should not run after authoritative preflight unavailability');
  }),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock('@/agent/catalog/registry', () => ({
  AGENTS: {
    ohMyPi: {},
  },
}));

const { createConfiguredAcpProbeBackendMock } = vi.hoisted(() => ({
  createConfiguredAcpProbeBackendMock: vi.fn(async () => null),
}));

vi.mock('./configuredAcpProbeBackend', () => ({
  createConfiguredAcpProbeBackend: createConfiguredAcpProbeBackendMock,
}));

const { resolvePreflightSessionControlsProbeAdapterMock, probeModelsRawMock } = vi.hoisted(() => ({
  resolvePreflightSessionControlsProbeAdapterMock: vi.fn(),
  probeModelsRawMock: vi.fn(),
}));

vi.mock('./resolvePreflightSessionControlsProbeAdapter', () => ({
  resolvePreflightSessionControlsProbeAdapter: resolvePreflightSessionControlsProbeAdapterMock,
}));

import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

describe('probeAgentModelsBestEffort (authoritative preflight unavailable)', () => {
  beforeEach(() => {
    resetAgentModelsProbeCacheForTests();
    spawnMock.mockClear();
    createConfiguredAcpProbeBackendMock.mockClear();
    probeModelsRawMock.mockReset();
    resolvePreflightSessionControlsProbeAdapterMock.mockReset();
    resolvePreflightSessionControlsProbeAdapterMock.mockResolvedValue({
      failureCacheStrategy: 'cooldown',
      probeModelsRaw: probeModelsRawMock,
      cliModelsCommandArgs: ['--list-models'],
    });
  });

  it('does not turn provider-owned no-models unavailability into a static Default list', async () => {
    probeModelsRawMock.mockResolvedValueOnce(null);

    await expect(probeAgentModelsBestEffort({
      agentId: 'ohMyPi',
      cwd: '/repo',
      timeoutMs: 100,
    })).resolves.toEqual({
      agentId: 'ohMyPi',
      availableModels: [],
      supportsFreeform: false,
      source: 'unavailable',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
