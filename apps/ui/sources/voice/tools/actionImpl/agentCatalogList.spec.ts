import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import {
  AgentsBackendsListOutputSchema,
  buildBackendTargetKeyV2,
  FeaturesResponseSchema,
} from '@happier-dev/protocol';
import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import type { MachineContributionRegistryProjectionDescribeResult } from '@/sync/ops/machineContributionRegistryProjection';
import type { machineCapabilitiesInvoke as machineCapabilitiesInvokeFn } from '@/sync/ops/capabilities';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

type MachineContributionRegistryProjectionDescribeFn = typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;

const machineCapabilitiesInvoke = vi.fn<typeof machineCapabilitiesInvokeFn>();
const describeProviderModelsMock = vi.fn();
const machineContributionRegistryProjectionDescribeMock = vi.fn<MachineContributionRegistryProjectionDescribeFn>(
  async () => ({ supported: false, reason: 'not-supported' }),
);

const state: any = {
  settings: {
    backendEnabledByTargetKey: {
      [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]: false,
      [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'team-review', configuredBackendId: 'team-review' })]: false,
    },
    acpCatalogSettingsV1: {
      v: 2,
      backends: [{
        id: 'team-review',
        name: 'team-review',
        title: 'Team review',
        description: 'Custom team review backend',
        command: 'kiro-cli',
        args: ['acp'],
        env: {},
        transportProfile: 'kiro',
        capabilities: {
          supportsLoadSession: false,
          supportsModes: 'unknown',
          supportsModels: 'unknown',
          supportsConfigOptions: 'unknown',
          promptImageSupport: 'unknown',
        },
        createdAt: 1,
        updatedAt: 1,
      }],
    },
  },
};

type ProvidersFeatureSnapshotMode = 'enabled' | 'disabled' | 'missing' | 'malformed' | 'unknown';

function primeProvidersFeatureSnapshot(mode: ProvidersFeatureSnapshotMode): void {
  resetServerFeaturesClientForTests();
  let snapshot: ServerFeaturesSnapshot;
  if (mode === 'malformed') {
    snapshot = { status: 'unsupported', reason: 'invalid_payload' };
  } else if (mode === 'unknown') {
    snapshot = { status: 'error', reason: 'network' };
  } else {
    snapshot = {
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: mode === 'missing' ? {} : { providers: { enabled: mode === 'enabled' } },
        capabilities: {},
      }),
    };
  }
  primeServerFeaturesSnapshot({ serverId: 'server-a', snapshot });
}

function createProviderModelsProjection(freeformPolicy: Readonly<{
  manualModelPolicy?: 'allowed' | 'catalog-only';
  supportsFreeformModelIds?: boolean;
}> = {}) {
  return {
    status: 'success',
    agentTargetKey: 'agent:happier.agent.claude/claude',
    groups: [{
      connectionId: 'pc_work', providerName: 'Gateway', connectionName: 'Work',
      connectionRole: 'named', connectionDisplayNameMode: 'custom', connectionRevision: 1,
      authorization: { authorized: true },
      manualModelPolicy: freeformPolicy.manualModelPolicy ?? 'allowed',
      supportsFreeformModelIds: freeformPolicy.supportsFreeformModelIds ?? true,
      suppressedConnectedServiceIds: [], modelLoadAction: 'descriptor_absent',
      rows: [{
        ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: 'pc_work', modelId: 'provider-model' },
        descriptor: { id: 'provider-model', name: 'Provider model' },
        sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
        compatibility: { result: { status: 'verified' }, compatibilityFingerprint: 'compatibility:v1:voice', confirmed: true },
        endpointHealth: 'available', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
      }],
    }],
  };
}

installVoiceToolActionImplCommonModuleMocks({
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: {
        getState: () => ({ ...state }),
      } as typeof import('@/sync/domains/state/storage').storage,
    });
  },
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'https://voice-test.invalid', runtimeOrigin: 'https://voice-test.invalid', generation: 1 }),
  getActiveServerHomeCarrier: () => null,
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
  machineContributionRegistryProjectionDescribe: (...args: Parameters<MachineContributionRegistryProjectionDescribeFn>) =>
    machineContributionRegistryProjectionDescribeMock(...args),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSettingsGet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSettingsSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    resetMachineProjectionReadsForTests: () => {},
}));

vi.mock('@/sync/ops/capabilities', () => ({
  machineCapabilitiesInvoke: (...args: Parameters<typeof machineCapabilitiesInvokeFn>) => machineCapabilitiesInvoke(...args),
}));
vi.mock('@/providers/rpc/client', () => ({
  describeProviderModels: (...args: any[]) => describeProviderModelsMock(...args),
}));

// These owners reach the storage graph; initialize after the fixture installer
// has registered its options rather than selecting its default storage branch.
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const {
  readDynamicModelProbeCache,
  writeDynamicModelProbeCacheSuccess,
  DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS,
  resetDynamicModelProbeCacheForTests,
} = await import('@/sync/domains/models/dynamicModelProbeCache');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');

describe('agent catalog voice tools', () => {
  beforeEach(() => {
    clearDaemonMergedProjectionCacheForTests();
    primeProvidersFeatureSnapshot('enabled');
    machineCapabilitiesInvoke.mockReset();
    describeProviderModelsMock.mockReset();
    describeProviderModelsMock.mockResolvedValue({ status: 'success', agentTargetKey: 'agent:happier.agent.claude/claude', groups: [] });
    machineContributionRegistryProjectionDescribeMock.mockReset();
    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({ supported: false, reason: 'not-supported' });
    state.settings.backendEnabledByTargetKey = {
      [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]: false,
      [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'team-review', configuredBackendId: 'team-review' })]: false,
    };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{
        id: 'team-review',
        name: 'team-review',
        title: 'Team review',
        description: 'Custom team review backend',
        command: 'kiro-cli',
        args: ['acp'],
        env: {},
        transportProfile: 'kiro',
        capabilities: {
          supportsLoadSession: false,
          supportsModes: 'unknown',
          supportsModels: 'unknown',
          supportsConfigOptions: 'unknown',
          promptImageSupport: 'unknown',
        },
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    resetDynamicModelProbeCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists Provider models with exact connection identity through the neutral session projection', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: { ok: true, result: { availableModels: [{ id: 'native', name: 'Native' }], supportsFreeform: false } },
    });
    describeProviderModelsMock.mockResolvedValue(createProviderModelsProjection());
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const result: any = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'native', providerConnectionId: null }),
      expect.objectContaining({ modelId: 'provider-model', providerConnectionId: 'pc_work', providerName: 'Gateway · Work' }),
    ]));
    // The native probe refuses freeform ids, so this is the Provider side of the
    // two-sided policy alone deciding that an unlisted id is still a real model.
    expect(result.supportsFreeform).toBe(true);
  });

  it.each([
    ['the Provider refuses manual ids', { manualModelPolicy: 'catalog-only' as const }],
    ['the Agent refuses unverifiable ids', { supportsFreeformModelIds: false }],
  ])('keeps freeform closed when %s', async (_label, freeformPolicy) => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: { ok: true, result: { availableModels: [{ id: 'native', name: 'Native' }], supportsFreeform: false } },
    });
    describeProviderModelsMock.mockResolvedValue(createProviderModelsProjection(freeformPolicy));
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const result: any = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'provider-model', providerConnectionId: 'pc_work' }),
    ]));
    expect(result.supportsFreeform).toBe(false);
  });

  it.each([
    'disabled',
    'missing',
    'malformed',
    'unknown',
  ] as const)('returns a native-only model list without Provider work when the feature snapshot is %s', async (mode) => {
    primeProvidersFeatureSnapshot(mode);
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: { ok: true, result: { availableModels: [{ id: 'native', name: 'Native' }], supportsFreeform: false } },
    });
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const result: any = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'native' }),
    ]));
    expect(result.items.some((item: any) => (
      item.providerConnectionId !== undefined && item.providerConnectionId !== null
    ))).toBe(false);
    expect(describeProviderModelsMock).not.toHaveBeenCalled();
  });

  it('does no Provider work while the feature decision is loading and fails closed on a network error', async () => {
    resetServerFeaturesClientForTests();
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: { ok: true, result: { availableModels: [{ id: 'native', name: 'Native' }], supportsFreeform: false } },
    });
    let rejectFeatureFetch: (reason?: unknown) => void = () => undefined;
    const featureFetch = new Promise<Response>((_resolve, reject) => {
      rejectFeatureFetch = reject;
    });
    const fetchSpy = vi.fn(async () => await featureFetch);
    vi.stubGlobal('fetch', fetchSpy);
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const resultPromise = listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    expect(describeProviderModelsMock).not.toHaveBeenCalled();

    rejectFeatureFetch(new Error('network unavailable'));
    const result: any = await resultPromise;
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'native' }),
    ]));
    expect(result.items.some((item: any) => item.providerConnectionId != null)).toBe(false);
    expect(describeProviderModelsMock).not.toHaveBeenCalled();
  });

  it('does not retain Provider rows when a cached native probe is reused after the feature closes', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: { ok: true, result: { availableModels: [{ id: 'native', name: 'Native' }], supportsFreeform: false } },
    });
    describeProviderModelsMock.mockResolvedValue(createProviderModelsProjection());
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const enabledResult: any = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });
    expect(enabledResult.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerConnectionId: 'pc_work', modelId: 'provider-model' }),
    ]));

    primeProvidersFeatureSnapshot('disabled');
    machineCapabilitiesInvoke.mockClear();
    describeProviderModelsMock.mockClear();

    const disabledResult: any = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });

    expect(disabledResult.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'native' }),
    ]));
    expect(disabledResult.items.some((item: any) => (
      item.providerConnectionId !== undefined && item.providerConnectionId !== null
    ))).toBe(false);
    expect(machineCapabilitiesInvoke).not.toHaveBeenCalled();
    expect(describeProviderModelsMock).not.toHaveBeenCalled();
  });

  it('uses daemon merged projection titles for discovered/plugin backend labels when machineId is provided', async () => {
    state.settings.backendEnabledByTargetKey = {
      ...state.settings.backendEnabledByTargetKey,
      'agent:acme.review/review-bot': true,
    };

    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
      supported: true,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
          'plugin-review-bot': {
            id: 'plugin-review-bot',
            identity: { pluginId: 'acme.review', localId: 'review-bot' },
            title: 'Review Bot Plugin',
            // V2 addresses the plugin backend through its Agent.
            settingsBackendId: 'plugin-review-bot',
            subtitle: undefined,
            channel: 'plugin',
            isBuiltIn: false,
            providerOwnedEnvironmentKeys: [],
          },
        },
      }),
    });

    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentBackendsForVoiceTool({ includeDisabled: true, machineId: 'm1' } as any);
    const pluginItem = (res?.items ?? []).find((i: any) => i.targetKey === 'agent:acme.review/review-bot');
    expect(pluginItem).toBeTruthy();
    expect(pluginItem.label).toBe('Review Bot Plugin');
  });

  it('returns a coherent plugin backend item and model-list roundtrip when a runtime carrier is projected', async () => {
    state.settings.backendEnabledByTargetKey = {
      ...state.settings.backendEnabledByTargetKey,
      'agent:acme.review/review-bot': true,
    };

    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
      supported: true,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
          'plugin-review-bot': {
            id: 'plugin-review-bot',
            identity: { pluginId: 'acme.review', localId: 'review-bot' },
            title: 'Review Bot Plugin',
            // V2 addresses the plugin backend through its Agent.
            settingsBackendId: 'plugin-review-bot',
            subtitle: undefined,
            channel: 'plugin',
            isBuiltIn: false,
            providerOwnedEnvironmentKeys: [],
            catalogAgentId: 'claude',
            iconAgentId: 'claude',
          },
        },
      }),
    });

    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            { id: 'review-model', name: 'Review Model' },
          ],
          supportsFreeform: true,
        },
      },
    });

    const { listAgentBackendsForVoiceTool, listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const backends: any = await listAgentBackendsForVoiceTool({ includeDisabled: true, machineId: 'm1' } as any);
    const pluginItem = (backends?.items ?? []).find((i: any) => i.targetKey === 'agent:acme.review/review-bot');
    expect(pluginItem).toBeTruthy();
    expect(pluginItem.agentId).toBe('claude');

    const models: any = await listAgentModelsForVoiceTool({
      agentId: pluginItem.agentId,
      backendTargetKey: pluginItem.targetKey,
      machineId: 'm1',
      limit: 2,
    });

    expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
      'm1',
      {
        id: 'cli.claude',
        method: 'probeModels',
        params: {
          timeoutMs: 15_000,
        },
      },
      { serverId: 'server-a' },
    );
    expect(models).toMatchObject({
      agentId: 'claude',
      machineId: 'm1',
      source: 'preflight',
      supportsFreeform: true,
      items: [
        { modelId: 'default', label: 'Default' },
        { modelId: 'review-model', label: 'Review Model' },
      ],
    });
  });

  it('lists models for an externally installed Agent that has no bundled carrier', async () => {
    state.settings.backendEnabledByTargetKey = {
      ...state.settings.backendEnabledByTargetKey,
      'agent:acme.review/agents/reviewer': true,
    };

    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
      supported: true,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
          'acme-review': {
            id: 'acme-review',
            identity: { pluginId: 'acme.review', localId: 'agents/reviewer' },
            title: 'Acme Review',
            subtitle: undefined,
            channel: 'plugin',
            isBuiltIn: false,
            providerOwnedEnvironmentKeys: [],
          },
        },
      }),
    });

    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            { id: 'acme-large', name: 'Acme Large' },
          ],
          supportsFreeform: true,
        },
      },
    });

    const { listAgentBackendsForVoiceTool, listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const backends: any = await listAgentBackendsForVoiceTool({ includeDisabled: true, machineId: 'm1' } as any);
    const pluginItem = (backends?.items ?? []).find((i: any) => i.targetKey === 'agent:acme.review/agents/reviewer');
    expect(pluginItem).toBeTruthy();
    expect(pluginItem.agentId).toBe('acme-review');

    const models: any = await listAgentModelsForVoiceTool({
      agentId: pluginItem.agentId,
      backendTargetKey: pluginItem.targetKey,
      machineId: 'm1',
    });

    expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
      'm1',
      {
        id: 'cli.acme-review',
        method: 'probeModels',
        params: {
          timeoutMs: 15_000,
        },
      },
      { serverId: 'server-a' },
    );
    expect(models).toMatchObject({
      agentId: 'acme-review',
      machineId: 'm1',
      source: 'preflight',
      supportsFreeform: true,
      items: [
        { modelId: 'default', label: 'Default' },
        { modelId: 'acme-large', label: 'Acme Large' },
      ],
    });
  });

  it('round-trips a qualified external Agent catalog target through model discovery', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [{ id: 'acme-large', name: 'Acme Large' }],
          supportsFreeform: true,
        },
      },
    });

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const models: any = await listAgentModelsForVoiceTool({
      agentId: 'acme-review',
      backendTargetKey: 'agent:acme.review/agents/reviewer',
      machineId: 'm1',
    });

    expect(models).not.toMatchObject({ ok: false });
    expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
      'm1',
      {
        id: 'cli.acme-review',
        method: 'probeModels',
        params: { timeoutMs: 15_000 },
      },
      { serverId: 'server-a' },
    );
    expect(models).toMatchObject({
      agentId: 'acme-review',
      machineId: 'm1',
      source: 'preflight',
      supportsFreeform: true,
      items: [
        { modelId: 'default', label: 'Default' },
        { modelId: 'acme-large', label: 'Acme Large' },
      ],
    });
  });

  it('rejects an external backend target without an explicit runtime carrier', async () => {
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const models: any = await listAgentModelsForVoiceTool({
      backendTargetKey: 'backend:acme-review',
      machineId: 'm1',
    });

    expect(models).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
    });
    expect(machineCapabilitiesInvoke).not.toHaveBeenCalled();
  });

  it('filters disabled backends by default (includeDisabled=false)', async () => {
    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentBackendsForVoiceTool({ includeDisabled: false });
    const targetKeys = (res?.items ?? []).map((i: any) => i.targetKey);
    expect(targetKeys).not.toContain('agent:happier.agent.gemini/gemini');
    expect(targetKeys).not.toContain('backend:team-review:configured:team-review');
  });

  it('includes disabled backends when includeDisabled=true', async () => {
    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentBackendsForVoiceTool({ includeDisabled: true });
    const gemini = (res?.items ?? []).find((i: any) => i.targetKey === 'agent:happier.agent.gemini/gemini');
    expect(gemini).toBeTruthy();
    expect(gemini.enabled).toBe(false);
    expect(gemini).toMatchObject({
      agentId: 'gemini',
      identity: { pluginId: 'happier.agent.gemini', localId: 'gemini' },
    });
    const configured = (res?.items ?? []).find((i: any) => i.targetKey === 'backend:team-review:configured:team-review');
    expect(configured).toBeTruthy();
    expect(configured.enabled).toBe(false);
    expect(configured.agentId).toBeUndefined();
    expect(configured).toMatchObject({ backendId: 'team-review' });
    expect(configured).not.toHaveProperty('identity');
  });

  it('projects canonical backend inventory rows with Agent identities', async () => {
    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');

    const output = await listAgentBackendsForVoiceTool({ includeDisabled: true });
    const parsed = AgentsBackendsListOutputSchema.safeParse(output);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.items).toContainEqual(expect.objectContaining({
      targetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    }));
    expect(parsed.data.items).toContainEqual(expect.objectContaining({
      targetKey: 'backend:team-review:configured:team-review',
      backendId: 'team-review',
    }));
    expect(parsed.data.items.find((item) => item.backendId === 'team-review')).not.toHaveProperty('identity');
  });

  it('applies limit to backend and model discovery results', async () => {
    const { listAgentBackendsForVoiceTool, listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const backends: any = await listAgentBackendsForVoiceTool({ includeDisabled: true, limit: 2 });
    expect(backends?.items).toHaveLength(2);

    const models: any = await listAgentModelsForVoiceTool({ agentId: 'claude', limit: 2 });
    expect(models?.items).toHaveLength(2);
  });

  it('prioritizes enabled plugin backends ahead of disabled built-ins when limiting discovery results', async () => {
    state.settings.backendEnabledByTargetKey = {
      'agent:happier.agent.claude/claude': false,
      'agent:happier.agent.codex/codex': false,
      'agent:happier.agent.opencode/opencode': false,
      'agent:happier.agent.antigravity/antigravity': false,
      'agent:happier.agent.gemini/gemini': false,
      'agent:happier.agent.auggie/auggie': false,
      'agent:happier.agent.qwen/qwen': false,
      'agent:happier.agent.kimi/kimi': false,
      'agent:happier.agent.kilo/kilo': false,
      'agent:happier.agent.kiro/kiro': false,
      'agent:happier.agent.cursor/cursor': false,
      'agent:happier.agent.ohmypi/ohmypi': false,
      'agent:happier.agent.pi/pi': false,
      'agent:happier.agent.copilot/copilot': false,
      'backend:team-review:configured:team-review': false,
      'agent:acme.review/review-bot': true,
    };

    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
      supported: true,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
          'plugin-review-bot': {
            id: 'plugin-review-bot',
            identity: { pluginId: 'acme.review', localId: 'review-bot' },
            title: 'Review Bot Plugin',
            // V2 addresses the plugin backend through its Agent.
            settingsBackendId: 'plugin-review-bot',
            subtitle: undefined,
            channel: 'plugin',
            isBuiltIn: false,
            providerOwnedEnvironmentKeys: [],
            catalogAgentId: 'claude',
            iconAgentId: 'claude',
          },
        },
      }),
    });

    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const backends: any = await listAgentBackendsForVoiceTool({ includeDisabled: true, limit: 200, machineId: 'm1' } as any);
    const pluginIndex = backends?.items?.findIndex((item: any) => item.targetKey === 'agent:acme.review/review-bot') ?? -1;
    const firstDisabledIndex = backends?.items?.findIndex((item: any) => item.enabled === false) ?? -1;
    expect(backends?.items?.[pluginIndex]).toMatchObject({
      targetKey: 'agent:acme.review/review-bot',
      label: 'Review Bot Plugin',
      agentId: 'claude',
      enabled: true,
    });
    expect(pluginIndex).toBeGreaterThanOrEqual(0);
    expect(firstDisabledIndex).toBeGreaterThan(pluginIndex);
  });

  it('uses curated static model labels instead of returning raw mode ids', async () => {
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const models: any = await listAgentModelsForVoiceTool({ agentId: 'claude', limit: 3 });

    expect(models?.items?.[0]).toMatchObject({ modelId: 'default', label: 'Default' });
    expect(models?.items?.slice(1).map((item: any) => item.label)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/opus|sonnet/i),
      ]),
    );
    expect(models?.items?.slice(1).every((item: any) => item.label !== item.modelId)).toBe(true);
  });

  it('uses the explicit compat model fallback for configured ACP backends when no machine probe runs', async () => {
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const res: any = await listAgentModelsForVoiceTool({
      backendTargetKey: 'acpBackend:team-review',
      limit: 3,
    });

    expect(res).toMatchObject({
      source: 'static',
      supportsFreeform: false,
      items: [
        { modelId: 'default', label: 'Default' },
      ],
    });
    expect(res).not.toHaveProperty('agentId');
  });

  it('prefers dynamic model list from machine preflight when machineId is provided', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            {
              id: 'claude-opus',
              name: 'Claude Opus',
              description: 'Opus',
              modelOptions: [{
                id: 'reasoning_effort',
                name: 'Thinking',
                type: 'select',
                currentValue: 'medium',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                ],
              }],
            },
          ],
          supportsFreeform: true,
        },
      },
    });

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });
    expect(machineCapabilitiesInvoke).toHaveBeenCalled();
    expect(res?.items?.map((m: any) => m.modelId)).toEqual(['default', 'claude-opus']);
    expect(res.supportsFreeform).toBe(true);
    expect(res.source).toBe('preflight');

    const cacheKey = buildDynamicModelProbeCacheKey({
      machineId: 'm1',
      targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }),
      providerConnectionId: null,
      serverId: 'server-a',
      cwd: null,
    });
    expect(cacheKey).toBeTruthy();
    const cacheEntry = cacheKey ? readDynamicModelProbeCache(cacheKey) : null;
    expect(cacheEntry?.kind).toBe('success');
    expect(cacheEntry?.kind === 'success' ? cacheEntry.value.availableModels : []).toEqual([
      { id: 'default', name: 'Default' },
      {
        id: 'claude-opus',
        name: 'Claude Opus',
        description: 'Opus',
        modelOptions: [{
          id: 'reasoning_effort',
          name: 'Thinking',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
          ],
        }],
      },
    ]);
  });

  it('does not expose a selectable Default model when machine preflight reports unavailable', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [],
          supportsFreeform: false,
          source: 'unavailable',
        },
      },
    });

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });

    expect(machineCapabilitiesInvoke).toHaveBeenCalled();
    expect(res).toMatchObject({
      agentId: 'claude',
      machineId: 'm1',
      source: 'unavailable',
      supportsFreeform: false,
      items: [],
      unavailable: true,
    });

    const cacheKey = buildDynamicModelProbeCacheKey({
      machineId: 'm1',
      targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }),
      providerConnectionId: null,
      serverId: 'server-a',
      cwd: null,
    });
    expect(cacheKey).toBeTruthy();
    const cacheEntry = cacheKey ? readDynamicModelProbeCache(cacheKey) : null;
    expect(cacheEntry?.kind).toBe('success');
    expect(cacheEntry?.kind === 'success' ? cacheEntry.cacheable : true).toBe(false);
    expect(cacheEntry?.kind === 'success' ? cacheEntry.value.unavailable : false).toBe(true);
  });

  it('returns an unavailable empty model list when the dynamic model probe is unsupported', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: false,
      reason: 'not-supported',
    } as any);

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });

    expect(machineCapabilitiesInvoke).toHaveBeenCalled();
    expect(res).toMatchObject({
      agentId: 'claude',
      machineId: 'm1',
      source: 'unavailable',
      supportsFreeform: false,
      items: [],
      unavailable: true,
    });
  });

  it('returns an unavailable empty model list when the dynamic model probe returns non-ok', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: false,
        errorCode: 'agent_unavailable',
        errorMessage: 'agent_unavailable',
      },
    } as any);

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });

    expect(machineCapabilitiesInvoke).toHaveBeenCalled();
    expect(res).toMatchObject({
      agentId: 'claude',
      machineId: 'm1',
      source: 'unavailable',
      supportsFreeform: false,
      items: [],
      unavailable: true,
    });
  });

  it('caches dynamic model probes per machine/agent so repeated calls do not re-invoke the probe', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            { id: 'claude-opus', name: 'Claude Opus' },
          ],
          supportsFreeform: false,
        },
      },
    });

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });
    await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });

    expect(machineCapabilitiesInvoke).toHaveBeenCalledTimes(1);
  });

  it('probes configured ACP backend models through backendTargetKey', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            { id: 'model-review', name: 'Review Model' },
          ],
          supportsFreeform: true,
        },
      },
    });

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const params: Parameters<typeof listAgentModelsForVoiceTool>[0] & Readonly<{ backendTargetKey: string; limit: number }> = {
      backendTargetKey: 'acpBackend:team-review',
      machineId: 'm1',
      limit: 2,
    };
    const res: any = await listAgentModelsForVoiceTool({
      ...params,
    });

    expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
      'm1',
      {
        id: 'cli.configuredAcp',
        method: 'probeModels',
        params: {
          timeoutMs: 15_000,
          backendTarget: { kind: 'configuredAcpBackend', backendId: 'team-review' },
        },
      },
      { serverId: 'server-a' },
    );
    expect(res).toMatchObject({
      machineId: 'm1',
      source: 'preflight',
      supportsFreeform: true,
      items: [
        { modelId: 'default', label: 'Default' },
        { modelId: 'model-review', label: 'Review Model' },
      ],
    });
    expect(res).not.toHaveProperty('agentId');
  });

  it('probes configured ACP backend models through the canonical V2 backendTargetKey', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            { id: 'model-review', name: 'Review Model' },
          ],
          supportsFreeform: true,
        },
      },
    });

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentModelsForVoiceTool({
      backendTargetKey: 'backend:team-review:configured:team-review',
      machineId: 'm1',
      limit: 2,
    } as any);

    expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
      'm1',
      {
        id: 'cli.configuredAcp',
        method: 'probeModels',
        params: {
          timeoutMs: 15_000,
          backendTarget: { kind: 'configuredAcpBackend', backendId: 'team-review' },
        },
      },
      { serverId: 'server-a' },
    );
    expect(res).toMatchObject({
      machineId: 'm1',
      source: 'preflight',
      supportsFreeform: true,
      items: [
        { modelId: 'default', label: 'Default' },
        { modelId: 'model-review', label: 'Review Model' },
      ],
    });
    expect(res).not.toHaveProperty('agentId');
  });

  it('accepts a matching legacy configured ACP flavor carrier when probing configured backend models', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            { id: 'model-review', name: 'Review Model' },
          ],
          supportsFreeform: true,
        },
      },
    });

    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentModelsForVoiceTool({
      agentId: 'acp:team-review',
      backendTargetKey: 'backend:team-review:configured:team-review',
      machineId: 'm1',
      limit: 2,
    } as any);

    expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
      'm1',
      {
        id: 'cli.configuredAcp',
        method: 'probeModels',
        params: {
          timeoutMs: 15_000,
          backendTarget: { kind: 'configuredAcpBackend', backendId: 'team-review' },
        },
      },
      { serverId: 'server-a' },
    );
    expect(res).toMatchObject({
      machineId: 'm1',
      source: 'preflight',
      supportsFreeform: true,
      items: [
        { modelId: 'default', label: 'Default' },
        { modelId: 'model-review', label: 'Review Model' },
      ],
    });
    expect(res).not.toHaveProperty('agentId');
  });

  it('rejects ambiguous customAcp model lookup without backendTargetKey', async () => {
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');

    const res: any = await listAgentModelsForVoiceTool({
      agentId: 'customAcp',
      machineId: 'm1',
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
    });
    expect(machineCapabilitiesInvoke).not.toHaveBeenCalled();
  });  it('keeps provider-owned nonpersistent discovery nonpersistent in the shared cache', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({ supported: true, response: { ok: true, result: {
      availableModels: [{ id: 'provider-model', name: 'Provider model' }],
      supportsFreeform: true, source: 'dynamic', cacheable: false,
    } } });
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const result = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });
    expect(result).toMatchObject({ source: 'preflight', items: expect.arrayContaining([expect.objectContaining({ modelId: 'provider-model', label: 'Provider model' })]) });
    const key = buildDynamicModelProbeCacheKey({ machineId: 'm1', targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }), providerConnectionId: null, serverId: 'server-a', cwd: null })!;
    expect(readDynamicModelProbeCache(key)).toMatchObject({ kind: 'success', cacheable: false });
  });

  it('uses a newer daemon last-good observation on failure without renewing its age', async () => {
    const key = buildDynamicModelProbeCacheKey({ machineId: 'm1', targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }), providerConnectionId: null, serverId: 'server-a', cwd: null })!;
    const previousAt = Date.now() - DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS - 1000;
    const observedAt = previousAt + 500;
    writeDynamicModelProbeCacheSuccess(key, { availableModels: [{ id: 'old', name: 'Old' }], supportsFreeform: true }, previousAt);
    machineCapabilitiesInvoke.mockResolvedValue({ supported: true, response: { ok: true, result: {
      availableModels: [{ id: 'newer', name: 'Newer' }], supportsFreeform: true,
      source: 'dynamic', cacheable: false, refreshError: true, observedAt,
    } } });
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    expect(await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' })).toMatchObject({
      refreshError: true, items: expect.arrayContaining([expect.objectContaining({ modelId: 'newer', label: 'Newer' })]),
    });
    expect(readDynamicModelProbeCache(key)).toMatchObject({ updatedAt: observedAt });
  });

  it('distinguishes intentional static policy from a failed discovery fallback', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({ supported: true, response: { ok: true, result: {
      availableModels: [{ id: 'policy-model', name: 'Policy model' }], supportsFreeform: true,
      source: 'static', refreshError: false, cacheable: false,
    } } });
    const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
    const result = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });
    expect(result).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ modelId: 'policy-model', label: 'Policy model' })]) });
    expect(result).not.toHaveProperty('refreshError');
    resetDynamicModelProbeCacheForTests();
    machineCapabilitiesInvoke.mockRejectedValue(new Error('offline'));
    expect(await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' })).toMatchObject({ source: 'unavailable', refreshError: true });
  });

});
