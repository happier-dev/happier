import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { readAgentStructuredOutputCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { probeAgentModelsBestEffort, probeModelsFromAcpBackend, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';
import { assertExecutionRunStructuredOutputModelAllowed, readNativeExecutionRunOfferedModel } from '@/agent/runtime/bridges/executionRun/structuredOutputAdmission';

// The fixture imports the publication policy, which itself imports node:fs.
// Load it before registering that boundary to avoid a circular mock factory.
const { createBundledPluginPublicationFsFixture } = await vi.hoisted(async () => (
  await import('@/plugins/projection/registry/builtIn/locators.testkit')
));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return createBundledPluginPublicationFsFixture(actual);
});

describe('model probe structured output evidence', () => {
  beforeEach(() => {
    resetAgentModelsProbeCacheForTests();
    // The real executable resolver sees an existing executable; native observations below are the process boundary.
    vi.stubEnv('HAPPIER_CODEX_PATH', process.execPath);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('preserves explicit model support and stamps the native JSON contract only on offered models', async () => {
    const entry = readAgentCatalogSnapshot().catalogEntriesById.codex;
    if (!entry) throw new Error('Bundled Codex catalog fixture is unavailable');
    expect(readAgentStructuredOutputCapabilities(readAgentCatalogSnapshot().agentDefinitionsById.get('codex')?.richDefinition?.definition))
      .toMatchObject({ formats: ['json'] });
    // The raw native model observation is the process boundary; catalog projection and normalization stay real.
    const catalogEntry: AgentCatalogEntry = {
      ...entry,
      getPreflightSessionControlsProbeAdapter: async () => ({
        probeModelsRaw: async () => [
          { id: 'offered', name: 'Offered' },
          { id: 'unsupported', name: 'Unsupported', capabilities: { structuredOutput: 'unsupported', toolRoundTrips: 'supported' } },
          { id: 'unknown', name: 'Unknown', capabilities: { structuredOutput: 'unknown' } },
        ],
      }),
    };
    const result = await probeAgentModelsBestEffort({ agentId: 'codex', catalogEntry, cwd: '/structured-output-catalog' });

    expect(result.source).toBe('dynamic');
    expect(result.availableModels.find((model) => model.id === 'offered')).toMatchObject({
      capabilities: { structuredOutput: 'supported' },
    });
    expect(result.availableModels.find((model) => model.id === 'default')).toMatchObject({
      capabilities: { structuredOutput: 'supported' },
    });
    expect(result.availableModels.find((model) => model.id === 'unsupported')).toMatchObject({
      capabilities: { structuredOutput: 'unsupported', toolRoundTrips: 'supported' },
    });
    expect(result.availableModels.find((model) => model.id === 'unknown')).toMatchObject({
      capabilities: { structuredOutput: 'unknown' },
    });
  });

  it('preserves explicit ACP evidence without borrowing a native Agent contract', async () => {
    const models = await probeModelsFromAcpBackend({
      backend: {
        startSession: async () => ({ sessionId: 'configured-session' }),
        dispose: async () => {},
        getSessionModelState: () => ({ availableModels: [
          { id: 'default', name: 'Default', capabilities: { structuredOutput: 'unsupported' } },
          { id: 'configured', name: 'Configured' },
          { id: 'explicit', name: 'Explicit', capabilities: { structuredOutput: 'supported' } },
        ] }),
      },
      timeoutMs: 1000,
    });
    expect(models?.find((model) => model.id === 'configured')).not.toHaveProperty('capabilities');
    expect(models?.find((model) => model.id === 'explicit')).toMatchObject({ capabilities: { structuredOutput: 'supported' } });
    expect(models?.find((model) => model.id === 'default')).toMatchObject({ capabilities: { structuredOutput: 'unsupported' } });
  });

  it('distinguishes an unavailable native model read from unsupported structured output', async () => {
    const entry = readAgentCatalogSnapshot().catalogEntriesById.codex;
    if (!entry) throw new Error('Bundled Codex catalog fixture is unavailable');
    let available = true;
    const catalogEntry: AgentCatalogEntry = { ...entry, getPreflightSessionControlsProbeAdapter: async () => ({
      // The native process can become unavailable after the picker observed it.
      probeModelsRaw: async () => available ? [{ id: 'gpt-6-luna', name: 'Luna' }] : null,
    }) };
    const backendTarget = { kind: 'builtInAgent' as const, agentId: 'codex' };
    const catalog = await probeAgentModelsBestEffort({ agentId: 'codex', backendTarget, catalogEntry, cwd: '/picker-read' });
    expect(catalog.availableModels.find(model => model.id === 'gpt-6-luna'))
      .toMatchObject({ capabilities: { structuredOutput: 'supported' } });
    const readNativeOfferedModel: NonNullable<Parameters<typeof assertExecutionRunStructuredOutputModelAllowed>[0]['readNativeOfferedModel']>
      = request => readNativeExecutionRunOfferedModel({ ...request, catalogEntry });
    await expect(assertExecutionRunStructuredOutputModelAllowed({ backendTarget, modelId: 'gpt-6-luna',
      cwd: '/review-read-supported', readNativeOfferedModel })).resolves.toBeUndefined();

    available = false;
    const lastGood = await probeAgentModelsBestEffort({ agentId: 'codex', backendTarget, catalogEntry,
      cwd: '/review-read-supported', bypassCache: true });
    expect(lastGood).toMatchObject({ refreshError: true, availableModels: expect.arrayContaining([
      expect.objectContaining({ id: 'gpt-6-luna', capabilities: { structuredOutput: 'supported' } }),
    ]) });
    await expect(assertExecutionRunStructuredOutputModelAllowed({ backendTarget, modelId: 'gpt-6-luna',
      cwd: '/review-read-supported', readNativeOfferedModel })).resolves.toBeUndefined();
    await expect(assertExecutionRunStructuredOutputModelAllowed({ backendTarget, modelId: 'gpt-6-luna',
      cwd: '/review-read-unavailable', readNativeOfferedModel }))
      .rejects.toMatchObject({ code: 'model_catalog_unavailable', details: { modelId: 'gpt-6-luna' } });
  });

  it('returns the published context window after refresh failure without promoting unknown structured output', async () => {
    const entry = readAgentCatalogSnapshot().catalogEntriesById.codex;
    if (!entry) throw new Error('Bundled Codex catalog fixture is unavailable');
    let available = true;
    const model = { id: 'voice-model', name: 'Voice model', contextWindowTokens: 32_768,
      capabilities: { structuredOutput: 'unknown' as const } };
    const catalogEntry: AgentCatalogEntry = { ...entry, getPreflightSessionControlsProbeAdapter: async () => ({
      // Native process observation only; the real probe publishes last-good evidence.
      probeModelsRaw: async () => available ? [model] : null,
    }) };
    const native = { backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
      modelId: model.id, cwd: '/voice-published-window', catalogEntry };
    const readNativeOfferedModel = (request: Parameters<typeof readNativeExecutionRunOfferedModel>[0]) =>
      readNativeExecutionRunOfferedModel({ ...request, catalogEntry });
    await expect(readNativeExecutionRunOfferedModel(native)).resolves.toMatchObject(model);
    await expect(assertExecutionRunStructuredOutputModelAllowed({ ...native, readNativeOfferedModel }))
      .rejects.toMatchObject({ code: 'model_structured_output_unsupported' });
    available = false;
    // Refresh through the same preflight owner so its resolved plugin/runtime
    // context addresses the observation published by the native reader.
    const { invokeCliPreflightMethod } = await import('./agentPreflight');
    const lastGood = await invokeCliPreflightMethod('codex', 'probeModels', {
      backendTarget: native.backendTarget, cwd: native.cwd, bypassCache: true,
    }, { agentCatalogEntry: catalogEntry, accountContext: { credentials: null, accountSettings: null } }, {});
    expect(lastGood).toMatchObject({ ok: true, result: {
      refreshError: true, availableModels: expect.arrayContaining([expect.objectContaining(model)]),
    } });
    await expect(readNativeExecutionRunOfferedModel(native)).resolves.toMatchObject(model);
    await expect(assertExecutionRunStructuredOutputModelAllowed({ ...native, readNativeOfferedModel }))
      .rejects.toMatchObject({ code: 'model_structured_output_unsupported' });
  });

  it.each(['unknown', 'unsupported'] as const)('preserves explicit native default %s evidence', async structuredOutput => {
    const entry = readAgentCatalogSnapshot().catalogEntriesById.codex;
    if (!entry) throw new Error('Bundled Codex catalog fixture is unavailable');
    const catalogEntry: AgentCatalogEntry = { ...entry, getPreflightSessionControlsProbeAdapter: async () => ({
      probeModelsRaw: async () => [{ id: 'default', name: 'Native default', capabilities: { structuredOutput } }],
    }) };
    const observed = await readNativeExecutionRunOfferedModel({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      modelId: 'default', cwd: '/explicit-native-default', catalogEntry });
    expect(observed?.capabilities?.structuredOutput).toBe(structuredOutput);
  });

  it('isolates two Accounts reading the same native occurrence and working directory', async () => {
    const entry = readAgentCatalogSnapshot().catalogEntriesById.codex;
    if (!entry) throw new Error('Bundled Codex catalog fixture is unavailable');
    // Only the raw native observation is substituted; the real offered-model
    // reader, probe variant, cache and normalization compose below it.
    const catalogEntry: AgentCatalogEntry = { ...entry, getPreflightSessionControlsProbeAdapter: async () => ({
      probeModelsRaw: async input => [{ id: 'offered', name: String(input.accountSettings?.fixtureAccount),
        capabilities: { structuredOutput: input.accountSettings?.fixtureAccount === 'first' ? 'supported' : 'unsupported' } }],
    }) };
    const native = { backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' }, modelId: 'offered',
      cwd: '/same-native-cwd', runtimeCacheKey: 'same-native-occurrence', catalogEntry };
    await expect(readNativeExecutionRunOfferedModel({ ...native, accountSettings: { fixtureAccount: 'first' },
      promptCredentials: { token: 'native-first-account', encryption: null } }))
      .resolves.toMatchObject({ name: 'first', capabilities: { structuredOutput: 'supported' } });
    await expect(readNativeExecutionRunOfferedModel({ ...native, accountSettings: { fixtureAccount: 'second' },
      promptCredentials: { token: 'native-second-account', encryption: null } }))
      .resolves.toMatchObject({ name: 'second', capabilities: { structuredOutput: 'unsupported' } });
  });

  it('marks a normalization-created default placeholder as unknown, not an offered model', async () => {
    const models = await probeModelsFromAcpBackend({
      backend: {
        startSession: async () => ({ sessionId: 'placeholder-session' }), dispose: async () => {},
        getSessionModelState: () => ({ availableModels: [{ id: 'configured', name: 'Configured' }] }),
      },
      timeoutMs: 1000,
    });
    expect(models?.find(model => model.id === 'default')).toMatchObject({ capabilities: { structuredOutput: 'unknown' } });
  });
});
