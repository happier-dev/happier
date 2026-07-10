import { describe, expect, it, vi } from 'vitest';

vi.mock('@/agent/catalog/registry', () => ({
  AGENTS: {
    copilot: {},
  },
}));

vi.mock('@/packagedRuntime/managedTools/requireAgentCliLaunchSpec', () => ({
  resolveAgentCliLaunchSpec: vi.fn(() => null),
}));

vi.mock('./resolvePreflightSessionControlsProbeAdapter', () => ({
  resolvePreflightSessionControlsProbeAdapter: vi.fn(async () => null),
}));

vi.mock('./configuredAcpProbeBackend', () => ({
  createConfiguredAcpProbeBackend: vi.fn(async () => null),
}));

import { probeAgentConfigOptionsBestEffort } from './agentConfigOptionsProbe';
import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';
import { probeAgentModesBestEffort } from './agentModesProbe';

describe('provider probes with missing CLI availability', () => {
  it('fails closed instead of returning static defaults', async () => {
    resetAgentModelsProbeCacheForTests();
    const cwd = '/repo/missing-copilot-cli';

    await expect(probeAgentModelsBestEffort({
      agentId: 'copilot',
      cwd,
      timeoutMs: 100,
    })).resolves.toEqual({
      agentId: 'copilot',
      availableModels: [],
      supportsFreeform: false,
      source: 'unavailable',
    });

    await expect(probeAgentModesBestEffort({
      agentId: 'copilot',
      cwd,
      timeoutMs: 100,
    })).resolves.toEqual({
      agentId: 'copilot',
      availableModes: [],
      source: 'unavailable',
    });

    await expect(probeAgentConfigOptionsBestEffort({
      agentId: 'copilot',
      cwd,
      timeoutMs: 100,
    })).resolves.toEqual({
      agentId: 'copilot',
      configOptions: [],
      source: 'unavailable',
    });
  });
});
