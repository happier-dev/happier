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

vi.mock('./configuredAcpProbeBackend', () => ({
  createConfiguredAcpProbeBackend: createConfiguredAcpProbeBackendMock,
}));

vi.mock('./preflightSessionControlsProbeEnvironment', () => ({
  withPreflightSessionControlsProbeEnvironment: async (
    _params: unknown,
    run: (environment: { env: NodeJS.ProcessEnv }) => Promise<unknown>,
  ) => await run({ env: { MATERIALIZED_PROBE_ENV: '1' } }),
}));

vi.mock('@/agent/catalog/registry', async () => {
  const { normalizeKimiAcpPythonSelector } = await import('@happier-dev/plugins-kimi/agent/acp/pythonSelectorEnv');
  const readKimiSelector = (accountSettings?: Record<string, unknown> | null) =>
    normalizeKimiAcpPythonSelector(accountSettings?.kimiAcpPythonSelector) ?? 'auto';

  return {
    AGENTS: {
      claude: {},
      opencode: {
        getAcpRuntimeDefinitionBridge: async () => null,
      },
      kimi: {
        getAcpBackendFactory: () => ({}),
        resolveModelsProbeVariant: ({ accountSettings }: { accountSettings?: Record<string, unknown> | null }) =>
          `kimi:${readKimiSelector(accountSettings)}`,
        resolveModelsProbeBackendOptions: ({ accountSettings }: { accountSettings?: Record<string, unknown> | null }) => {
          const selector = readKimiSelector(accountSettings);
          return selector === 'poll' ? { kimiAcpPythonSelector: selector } : {};
        },
      },
    },
  };
});

import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

describe('probeAgentModelsBestEffort (static-only providers)', () => {
  beforeEach(() => {
    resetAgentModelsProbeCacheForTests();
    createCatalogAcpBackendMock.mockReset();
    validateCatalogAcpProbeSpawnMock.mockClear();
    createConfiguredAcpProbeBackendMock.mockClear();
  });

  it('does not start ACP backend for unavailable qwen model probing', async () => {
    createCatalogAcpBackendMock.mockRejectedValue(new Error('unexpected acp backend creation'));
    const res = await probeAgentModelsBestEffort({
      agentId: 'qwen',
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(res.agentId).toBe('qwen');
    expect(res.source).toBe('unavailable');
    expect(res.availableModels).toEqual([]);
    expect(createCatalogAcpBackendMock).not.toHaveBeenCalled();
  });

  it('starts the ACP backend for kimi model probing', async () => {
    validateCatalogAcpProbeSpawnMock.mockResolvedValueOnce({ ok: true });
    createCatalogAcpBackendMock.mockResolvedValueOnce({
      backend: {
        startSession: async () => ({ sessionId: 'session-kimi' }),
        getSessionModelState: () => ({
          availableModels: [{ id: 'kimi-code/kimi-for-coding', name: 'Kimi for Coding' }],
        }),
        getSessionConfigOptionsState: () => null,
        dispose: vi.fn(async () => {}),
      },
    });

    const res = await probeAgentModelsBestEffort({
      agentId: 'kimi',
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(res.agentId).toBe('kimi');
    expect(res.source).toBe('dynamic');
    expect(res.availableModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'kimi-code/kimi-for-coding', name: 'Kimi for Coding' }),
    ]));
    expect(createCatalogAcpBackendMock).toHaveBeenCalled();
  });

  it('starts the ACP backend for bridge-backed model probing', async () => {
    validateCatalogAcpProbeSpawnMock.mockResolvedValueOnce({ ok: true });
    createCatalogAcpBackendMock.mockResolvedValueOnce({
      backend: {
        startSession: async () => ({ sessionId: 'session-opencode' }),
        getSessionModelState: () => ({
          availableModels: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' }],
        }),
        getSessionConfigOptionsState: () => null,
        dispose: vi.fn(async () => {}),
      },
    });

    const res = await probeAgentModelsBestEffort({
      agentId: 'opencode',
      cwd: `${process.cwd()}/opencode-bridge-model-probe`,
      timeoutMs: 100,
    });

    expect(res.agentId).toBe('opencode');
    expect(res.source).toBe('dynamic');
    expect(res.availableModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' }),
    ]));
    expect(createCatalogAcpBackendMock).toHaveBeenCalledWith('opencode', expect.objectContaining({
      cwd: `${process.cwd()}/opencode-bridge-model-probe`,
    }));
  });

  it('passes Kimi selector settings to ACP model probing and partitions the probe cache by selector', async () => {
    validateCatalogAcpProbeSpawnMock.mockResolvedValue({ ok: true });
    createCatalogAcpBackendMock.mockImplementation(async (_agentId: string, opts: Record<string, unknown>) => ({
      backend: {
        startSession: async () => ({ sessionId: 'session-kimi' }),
        getSessionModelState: () => ({
          availableModels: [
            opts.kimiAcpPythonSelector === 'poll'
              ? { id: 'poll-model', name: 'Poll model' }
              : { id: 'auto-model', name: 'Auto model' },
          ],
        }),
        getSessionConfigOptionsState: () => null,
        dispose: vi.fn(async () => {}),
      },
    }));

    const poll = await probeAgentModelsBestEffort({
      agentId: 'kimi',
      cwd: process.cwd(),
      timeoutMs: 100,
      accountSettings: { kimiAcpPythonSelector: 'poll' },
    });
    expect(poll.availableModels).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'poll-model', name: 'Poll model' },
    ]);

    const auto = await probeAgentModelsBestEffort({
      agentId: 'kimi',
      cwd: process.cwd(),
      timeoutMs: 100,
      accountSettings: { kimiAcpPythonSelector: 'auto' },
    });
    expect(auto.availableModels).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'auto-model', name: 'Auto model' },
    ]);

    expect(createCatalogAcpBackendMock).toHaveBeenNthCalledWith(1, 'kimi', expect.objectContaining({
      kimiAcpPythonSelector: 'poll',
    }));
    expect(createCatalogAcpBackendMock).toHaveBeenCalledTimes(2);
  });

  it('passes the materialized preflight environment to fallback catalog ACP model probing', async () => {
    validateCatalogAcpProbeSpawnMock.mockResolvedValueOnce({ ok: true });
    createCatalogAcpBackendMock.mockResolvedValueOnce({
      backend: {
        startSession: async () => ({ sessionId: 'session-kimi' }),
        getSessionModelState: () => ({
          availableModels: [{ id: 'env-model', name: 'Env model' }],
        }),
        getSessionConfigOptionsState: () => null,
        dispose: vi.fn(async () => {}),
      },
    });

    await probeAgentModelsBestEffort({
      agentId: 'kimi',
      cwd: process.cwd(),
      timeoutMs: 100,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      accountSettings: {},
    });

    expect(createCatalogAcpBackendMock).toHaveBeenCalledWith('kimi', expect.objectContaining({
      env: expect.objectContaining({ MATERIALIZED_PROBE_ENV: '1' }),
    }));
  });

  it('normalizes mixed-case Kimi poll selector settings before probing and cache partitioning', async () => {
    validateCatalogAcpProbeSpawnMock.mockResolvedValue({ ok: true });
    createCatalogAcpBackendMock.mockImplementation(async (_agentId: string, opts: Record<string, unknown>) => ({
      backend: {
        startSession: async () => ({ sessionId: 'session-kimi' }),
        getSessionModelState: () => ({
          availableModels: [
            opts.kimiAcpPythonSelector === 'poll'
              ? { id: 'poll-model', name: 'Poll model' }
              : { id: 'auto-model', name: 'Auto model' },
          ],
        }),
        getSessionConfigOptionsState: () => null,
        dispose: vi.fn(async () => {}),
      },
    }));

    const poll = await probeAgentModelsBestEffort({
      agentId: 'kimi',
      cwd: process.cwd(),
      timeoutMs: 100,
      accountSettings: { kimiAcpPythonSelector: ' POLL ' },
    });
    expect(poll.availableModels).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'poll-model', name: 'Poll model' },
    ]);

    const auto = await probeAgentModelsBestEffort({
      agentId: 'kimi',
      cwd: process.cwd(),
      timeoutMs: 100,
      accountSettings: { kimiAcpPythonSelector: 'auto' },
    });
    expect(auto.availableModels).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'auto-model', name: 'Auto model' },
    ]);

    expect(createCatalogAcpBackendMock).toHaveBeenNthCalledWith(1, 'kimi', expect.objectContaining({
      kimiAcpPythonSelector: 'poll',
    }));
    expect(createCatalogAcpBackendMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to curated static Claude model labels when dynamic probing is unavailable', async () => {
    const res = await probeAgentModelsBestEffort({
      agentId: 'claude',
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(res.agentId).toBe('claude');
    expect(res.source).toBe('static');
    expect(createConfiguredAcpProbeBackendMock).not.toHaveBeenCalled();

    expect(res.availableModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'default', name: 'Default' }),
      expect.objectContaining({
        id: 'claude-fable-5',
        name: 'Fable 5',
        description: expect.any(String),
        contextWindowTokens: 1_000_000,
      }),
      expect.objectContaining({
        id: 'claude-opus-4-8',
        name: 'Opus 4.8',
        description: expect.any(String),
        contextWindowTokens: 1_000_000,
      }),
      expect.objectContaining({
        id: 'claude-opus-4-7',
        name: 'Opus 4.7',
        description: expect.any(String),
        contextWindowTokens: 1_000_000,
      }),
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

    const opus = res.availableModels.find((model) => model.id === 'claude-opus-4-8') ?? null;
    expect(opus?.modelOptions?.some((opt) => opt.id === 'reasoning_effort')).toBe(true);
    expect(opus?.modelOptions?.[0]?.currentValue).toBe('high');
    expect(opus?.modelOptions?.[0]?.options?.some((opt) => opt.value === 'xhigh')).toBe(true);
    expect(createCatalogAcpBackendMock).not.toHaveBeenCalled();
  });
});
