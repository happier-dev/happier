import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentModelOptionSchema } from '@happier-dev/protocol';

vi.mock('@/agent/catalog/registry', () => ({
  AGENTS: {
    claude: {},
    ohMyPi: {},
  },
}));

const { createConfiguredAcpProbeBackendMock } = vi.hoisted(() => ({
  createConfiguredAcpProbeBackendMock: vi.fn(async () => null),
}));

vi.mock('./configuredAcpProbeBackend', () => ({
  createConfiguredAcpProbeBackend: createConfiguredAcpProbeBackendMock,
}));

const {
  resolvePreflightSessionControlsProbeAdapterMock,
  probeModelsRawMock,
  probeConfigOptionsRawMock,
} = vi.hoisted(() => ({
  resolvePreflightSessionControlsProbeAdapterMock: vi.fn(),
  probeModelsRawMock: vi.fn(),
  probeConfigOptionsRawMock: vi.fn(),
}));

vi.mock('./resolvePreflightSessionControlsProbeAdapter', () => ({
  resolvePreflightSessionControlsProbeAdapter: resolvePreflightSessionControlsProbeAdapterMock,
}));

import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';
import { probeAgentConfigOptionsBestEffort } from './agentConfigOptionsProbe';

/**
 * Exactly what a producing agent is allowed to publish (Claude's `ultracode`), built through the
 * canonical option contract so the probe is fed a real producer shape rather than a stand-in.
 */
const OVERRIDING_OPTION = AgentModelOptionSchema.parse({
  id: 'ultracode',
  name: 'Ultracode',
  description: 'Maximum coding effort. Forces XHigh Thinking effort while enabled.',
  type: 'boolean',
  currentValue: 'false',
  overridesWhenOn: { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' },
});

const EXPECTED_RULE = { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' };

describe('agent control probes preserve producer-declared option override rules', () => {
  beforeEach(() => {
    resetAgentModelsProbeCacheForTests();
    createConfiguredAcpProbeBackendMock.mockClear();
    probeModelsRawMock.mockReset();
    probeConfigOptionsRawMock.mockReset();
    resolvePreflightSessionControlsProbeAdapterMock.mockReset();
    resolvePreflightSessionControlsProbeAdapterMock.mockResolvedValue({
      failureCacheStrategy: 'cooldown',
      probeModelsRaw: probeModelsRawMock,
      probeConfigOptionsRaw: probeConfigOptionsRawMock,
    });
  });

  it('keeps descriptor-owned model facts on a dynamically probed model', async () => {
    probeModelsRawMock.mockResolvedValueOnce([{
      id: 'claude-opus-5',
      name: 'Opus 5',
      contextWindowTokens: 1_000_000,
      extendedContextModelId: 'claude-opus-5[1m]',
      modelOptions: [OVERRIDING_OPTION],
    }]);

    const result = await probeAgentModelsBestEffort({
      // A `dynamicProbe: 'auto'` agent: Claude's own catalog is `static-only`, so only an
      // auto-probing agent actually exercises the dynamic option normalizer.
      agentId: 'ohMyPi',
      cwd: '/repo',
      timeoutMs: 100,
    });

    expect(result.source).toBe('dynamic');
    const probed = result.availableModels.find((model) => model.id === 'claude-opus-5');
    expect(probed).toMatchObject({
      contextWindowTokens: 1_000_000,
      extendedContextModelId: 'claude-opus-5[1m]',
    });
    expect(probed?.modelOptions?.[0]?.overridesWhenOn).toEqual(EXPECTED_RULE);
  });

  it('keeps overridesWhenOn on a dynamically probed config option', async () => {
    probeConfigOptionsRawMock.mockResolvedValueOnce([OVERRIDING_OPTION]);

    const result = await probeAgentConfigOptionsBestEffort({
      agentId: 'claude',
      cwd: '/repo-config-options',
      timeoutMs: 100,
    });

    expect(result.source).toBe('dynamic');
    expect(result.configOptions[0]?.overridesWhenOn).toEqual(EXPECTED_RULE);
  });

  it('drops a probed rule the producer contract forbids rather than publishing it', async () => {
    probeModelsRawMock.mockResolvedValueOnce([{
      id: 'claude-opus-5',
      name: 'Opus 5',
      modelOptions: [{ ...OVERRIDING_OPTION, overridesWhenOn: { optionIds: [] } }],
    }]);

    const result = await probeAgentModelsBestEffort({
      // A `dynamicProbe: 'auto'` agent: Claude's own catalog is `static-only`, so only an
      // auto-probing agent actually exercises the dynamic option normalizer.
      agentId: 'ohMyPi',
      cwd: '/repo-invalid-rule',
      timeoutMs: 100,
    });

    expect(result.availableModels.find((model) => model.id === 'claude-opus-5')?.modelOptions?.[0])
      .not.toHaveProperty('overridesWhenOn');
  });
});
