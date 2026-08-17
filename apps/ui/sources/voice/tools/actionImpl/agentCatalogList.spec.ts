import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { buildBackendTargetKeyV2, FeaturesResponseSchema } from '@happier-dev/protocol';
import {
  primeServerFeaturesSnapshot,
  resetServerFeaturesClientForTests,
  type ServerFeaturesSnapshot,
} from '@/sync/api/capabilities/serverFeaturesClient';
import {
  readDynamicModelProbeCache,
  resetDynamicModelProbeCacheForTests,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import type { MachineContributionRegistryProjectionDescribeResult } from '@/sync/ops/machineContributionRegistryProjection';
import type { machineCapabilitiesInvoke as machineCapabilitiesInvokeFn } from '@/sync/ops/capabilities';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

type MachineContributionRegistryProjectionDescribeFn = typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;

const machineCapabilitiesInvoke = vi.fn<typeof machineCapabilitiesInvokeFn>();
const describeProviderModelsMock = vi.fn();
let providerSettingsReadCount = 0;
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

function createProviderModelsProjection() {
  return {
    status: 'success',
    agentTargetKey: 'backend:claude',
    groups: [{
      connectionId: 'pc_work', providerName: 'Gateway', connectionName: 'Work',
      connectionRole: 'named', connectionDisplayNameMode: 'custom', connectionRevision: 1,
      authorization: { authorized: true }, manualModelPolicy: 'allowed', supportsFreeformModelIds: true,
      suppressedConnectedServiceIds: [], modelLoadAction: 'descriptor_absent',
      rows: [{
        ref: { agentTargetKey: 'backend:claude', providerConnectionId: 'pc_work', modelId: 'provider-model' },
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
        getState: () => state,
      } as typeof import('@/sync/domains/state/storage').storage,
    });
  },
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
  machineContributionRegistryProjectionDescribe: (...args: Parameters<MachineContributionRegistryProjectionDescribeFn>) =>
    machineContributionRegistryProjectionDescribeMock(...args),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

vi.mock('@/sync/ops/capabilities', () => ({
  machineCapabilitiesInvoke: (...args: Parameters<typeof machineCapabilitiesInvokeFn>) => machineCapabilitiesInvoke(...args),
}));
vi.mock('@/providers/rpc/client', () => ({
  describeProviderModels: (...args: any[]) => describeProviderModelsMock(...args),
}));

describe('agent catalog voice tools', () => {
  beforeEach(() => {
    primeProvidersFeatureSnapshot('enabled');
    machineCapabilitiesInvoke.mockReset();
    describeProviderModelsMock.mockReset();
    describeProviderModelsMock.mockResolvedValue({ status: 'success', agentTargetKey: 'backend:claude', groups: [] });
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
    providerSettingsReadCount = 0;
    Object.defineProperty(state.settings, 'providerSettingsV1', {
      configurable: true,
      enumerable: false,
      get: () => {
        providerSettingsReadCount += 1;
        return undefined;
      },
    });
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
    expect(providerSettingsReadCount).toBeGreaterThan(0);
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
    expect(providerSettingsReadCount).toBe(0);
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
    expect(providerSettingsReadCount).toBe(0);

    rejectFeatureFetch(new Error('network unavailable'));
    const result: any = await resultPromise;
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'native' }),
    ]));
    expect(result.items.some((item: any) => item.providerConnectionId != null)).toBe(false);
    expect(describeProviderModelsMock).not.toHaveBeenCalled();
    expect(providerSettingsReadCount).toBe(0);
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
    providerSettingsReadCount = 0;

    const disabledResult: any = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId: 'm1' });

    expect(disabledResult.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'native' }),
    ]));
    expect(disabledResult.items.some((item: any) => (
      item.providerConnectionId !== undefined && item.providerConnectionId !== null
    ))).toBe(false);
    expect(machineCapabilitiesInvoke).not.toHaveBeenCalled();
    expect(describeProviderModelsMock).not.toHaveBeenCalled();
    expect(providerSettingsReadCount).toBe(0);
  });

  it('uses daemon merged projection titles for discovered/plugin backend labels when machineId is provided', async () => {
    state.settings.backendEnabledByTargetKey = {
      ...state.settings.backendEnabledByTargetKey,
      'backend:plugin-review-bot': true,
    };

    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
      supported: true,
      projection: {
        v: 1,
        agentsById: {
          'plugin:review-bot': {
            id: 'plugin:review-bot',
            title: 'Review Bot Plugin',
            subtitle: undefined,
            channel: 'plugin',
            isBuiltIn: false,
          },
        },
        backendsById: {
          'plugin-review-bot': {
            id: 'plugin-review-bot',
            backendId: 'plugin-review-bot',
            agentId: 'plugin:review-bot',
            title: 'Review Bot (plugin)',
            subtitle: undefined,
            catalogAgentId: undefined,
            iconAgentId: undefined,
          },
        },
      },
    });

    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentBackendsForVoiceTool({ includeDisabled: true, machineId: 'm1' } as any);
    const pluginItem = (res?.items ?? []).find((i: any) => i.targetKey === 'backend:plugin-review-bot');
    expect(pluginItem).toBeTruthy();
    expect(pluginItem.label).toBe('Review Bot (plugin)');
  });

  it('returns a coherent plugin backend item and model-list roundtrip when a runtime carrier is projected', async () => {
    state.settings.backendEnabledByTargetKey = {
      ...state.settings.backendEnabledByTargetKey,
      'backend:plugin-review-bot': true,
    };

    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
      supported: true,
      projection: {
        v: 1,
        agentsById: {
          'plugin:review-bot': {
            id: 'plugin:review-bot',
            title: 'Review Bot Plugin',
            subtitle: undefined,
            channel: 'plugin',
            isBuiltIn: false,
            catalogAgentId: 'claude',
            iconAgentId: 'claude',
          },
        },
        backendsById: {
          'plugin-review-bot': {
            id: 'plugin-review-bot',
            backendId: 'plugin-review-bot',
            agentId: 'plugin:review-bot',
            title: 'Review Bot (plugin)',
            subtitle: undefined,
            catalogAgentId: 'claude',
            iconAgentId: 'claude',
          },
        },
      },
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
    const pluginItem = (backends?.items ?? []).find((i: any) => i.targetKey === 'backend:plugin-review-bot');
    expect(pluginItem).toBeTruthy();
    expect(pluginItem.agentId).toBe('claude');
    expect(pluginItem.supportsModelSelection).toBe(true);

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
          backendTarget: { kind: 'builtInAgent', agentId: 'plugin-review-bot' },
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

  it('does not advertise model selection for plugin backends without a runtime carrier', async () => {
    state.settings.backendEnabledByTargetKey = {
      ...state.settings.backendEnabledByTargetKey,
      'backend:plugin-review-bot': true,
    };

    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
      supported: true,
      projection: {
        v: 1,
        agentsById: {
          'plugin:review-bot': {
            id: 'plugin:review-bot',
            title: 'Review Bot Plugin',
            subtitle: undefined,
            channel: 'plugin',
            isBuiltIn: false,
          },
        },
        backendsById: {
          'plugin-review-bot': {
            id: 'plugin-review-bot',
            backendId: 'plugin-review-bot',
            agentId: 'plugin:review-bot',
            title: 'Review Bot (plugin)',
            subtitle: undefined,
            catalogAgentId: undefined,
            iconAgentId: undefined,
          },
        },
      },
    });

    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const backends: any = await listAgentBackendsForVoiceTool({ includeDisabled: true, machineId: 'm1' } as any);
    const pluginItem = (backends?.items ?? []).find((i: any) => i.targetKey === 'backend:plugin-review-bot');
    expect(pluginItem).toBeTruthy();
    expect(pluginItem.agentId).toBeUndefined();
    expect(pluginItem.supportsModelSelection).toBe(false);
    expect(pluginItem.supportsFreeformModels).toBe(false);
  });

  it('filters disabled backends by default (includeDisabled=false)', async () => {
    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentBackendsForVoiceTool({ includeDisabled: false });
    const targetKeys = (res?.items ?? []).map((i: any) => i.targetKey);
    expect(targetKeys).not.toContain('backend:gemini');
    expect(targetKeys).not.toContain('backend:team-review:configured:team-review');
  });

  it('includes disabled backends when includeDisabled=true', async () => {
    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const res: any = await listAgentBackendsForVoiceTool({ includeDisabled: true });
    const gemini = (res?.items ?? []).find((i: any) => i.targetKey === 'backend:gemini');
    expect(gemini).toBeTruthy();
    expect(gemini.enabled).toBe(false);
    expect(gemini.uiConnectedService).toEqual({
      serviceId: 'gemini',
      label: 'Google Gemini',
      connectRoute: null,
    });
    const configured = (res?.items ?? []).find((i: any) => i.targetKey === 'backend:team-review:configured:team-review');
    expect(configured).toBeTruthy();
    expect(configured.enabled).toBe(false);
    expect(configured.agentId).toBeUndefined();
    expect(configured.uiConnectedService).toBeNull();
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
      'backend:claude': false,
      'backend:codex': false,
      'backend:opencode': false,
      'backend:antigravity': false,
      'backend:gemini': false,
      'backend:auggie': false,
      'backend:qwen': false,
      'backend:kimi': false,
      'backend:kilo': false,
      'backend:kiro': false,
      'backend:cursor': false,
      'backend:ohMyPi': false,
      'backend:pi': false,
      'backend:copilot': false,
      'backend:team-review:configured:team-review': false,
      'backend:plugin-review-bot': true,
    };

    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
      supported: true,
      projection: {
        v: 1,
        agentsById: {
          'plugin:review-bot': {
            id: 'plugin:review-bot',
            title: 'Review Bot Plugin',
            subtitle: undefined,
            channel: 'plugin',
            isBuiltIn: false,
            catalogAgentId: 'claude',
            iconAgentId: 'claude',
          },
        },
        backendsById: {
          'plugin-review-bot': {
            id: 'plugin-review-bot',
            backendId: 'plugin-review-bot',
            agentId: 'plugin:review-bot',
            title: 'Review Bot (plugin)',
            subtitle: undefined,
            catalogAgentId: 'claude',
            iconAgentId: 'claude',
          },
        },
      },
    });

    const { listAgentBackendsForVoiceTool } = await import('./agentCatalogList');
    const backends: any = await listAgentBackendsForVoiceTool({ includeDisabled: true, limit: 200, machineId: 'm1' } as any);
    const pluginIndex = backends?.items?.findIndex((item: any) => item.targetKey === 'backend:plugin-review-bot') ?? -1;
    const firstDisabledIndex = backends?.items?.findIndex((item: any) => item.enabled === false) ?? -1;
    expect(backends?.items?.[pluginIndex]).toMatchObject({
      targetKey: 'backend:plugin-review-bot',
      label: 'Review Bot (plugin)',
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
      supportsFreeform: true,
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
      targetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }),
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
      targetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }),
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
  });
});
