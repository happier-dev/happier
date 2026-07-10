import { describe, expect, it, vi } from 'vitest';

const { resolveModelsProbeVariantMock } = vi.hoisted(() => ({
  resolveModelsProbeVariantMock: vi.fn(() => 'legacy:variant'),
}));

const { resolveSessionControlsProbeVariantMock } = vi.hoisted(() => ({
  resolveSessionControlsProbeVariantMock: vi.fn(() => 'provider:variant'),
}));

vi.mock('@/agent/catalog/registry', () => ({
  AGENTS: {
    codex: {
      resolveSessionControlsProbeVariant: resolveSessionControlsProbeVariantMock,
      resolveModelsProbeVariant: resolveModelsProbeVariantMock,
    },
  },
}));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/tmp/happier-test-home',
  },
}));

vi.mock('./configuredAcpProbeCacheVariant', () => ({
  resolveConfiguredAcpProbeCacheVariant: vi.fn(async () => null),
}));

import { resolveAgentProbeVariant } from './resolveAgentProbeVariant';

describe('resolveAgentProbeVariant', () => {
  it('passes the stable probe kind to provider-owned cache variant hooks', async () => {
    const variant = await (resolveAgentProbeVariant as unknown as (params: Readonly<{
      agentId: 'codex';
      probeKind: 'configOptions';
      accountSettings: Readonly<Record<string, unknown>>;
    }>) => Promise<string>)({
      agentId: 'codex',
      probeKind: 'configOptions',
      accountSettings: { runtimeFlavor: 'app-server' },
    });

    expect(variant).toBe('provider:variant');
    expect(resolveSessionControlsProbeVariantMock).toHaveBeenCalledWith(expect.objectContaining({
      probeKind: 'configOptions',
      accountSettings: { runtimeFlavor: 'app-server' },
    }));
    expect(resolveModelsProbeVariantMock).not.toHaveBeenCalled();
  });
});
