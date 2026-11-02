import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { getAgentStaticModels } from '@happier-dev/agents';
import { ModelVisibilityRefV1Schema, serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import {
  RPC_METHODS,
  type DaemonProviderModelProjectionResponseV1,
} from '@happier-dev/protocol/rpc';
import {
  DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
  PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
  ProviderConnectionsCatalogV1Schema,
  ProviderConnectionsRowMutationV1Schema,
  sealProviderConnectionsContentV1,
  openProviderConnectionsContentV1,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import {
  CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1,
  ConnectedAccountCatalogRowMutationV1Schema,
  type ConnectedAccountCatalogRecordV1,
} from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

import {
  createProviderModelProjectionFixture,
  createProviderModelProjectionGroupFixture,
  createProviderSettingsHarness,
  createProviderSettingsAccountHarness,
  installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import {
  buildCustomProviderTemplate,
  createCustomProviderDraft,
} from '@/providers/authoring/state';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { resolveAgentNativeModels } from './agentModelVisibility';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';

describe('resolveAgentNativeModels', () => {
  it('uses the machine-observed Agent catalog instead of the static Default placeholder', () => {
    expect(resolveAgentNativeModels({
      runtimeAgentId: 'codex',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      modelVisibilityByRef: {},
      observedModels: [
        { id: 'default', name: 'Default' },
        { id: 'gpt-6-luna', name: 'GPT-6-Luna', description: 'Fast model' },
      ],
    })).toEqual([
      { id: 'default', name: 'Default', hidden: false },
      { id: 'gpt-6-luna', name: 'GPT-6-Luna', description: 'Fast model', hidden: false },
    ]);
  });
});

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  refresh: vi.fn(async () => {}),
  projectionRequestCount: 0,
  projection: {
    data: null as Extract<
      DaemonProviderModelProjectionResponseV1,
      { status: 'success' }
    > | null,
    loading: false,
    error: null as null | ReturnType<typeof createProviderErrorV1>,
  },
}));
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
const account = createProviderSettingsAccountHarness();
let serverId = '';
type ModelRow = Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }>['groups'][number]['rows'][number];

function createModelPageCatalog() {
  return ProviderConnectionsCatalogV1Schema.parse({
    ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
      ...createCustomProviderDraft('openai-responses'), name: 'Acme', baseUrl: 'https://acme.example/v1',
      requiresApiKey: false, catalog: 'manual',
    }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
    manualModelsByConnectionId: { pc_a: [{ id: 'model-a', name: 'Model A', addedAt: 1 }] },
  });
}

const routerPush = vi.hoisted(() => vi.fn());
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      pathname: '/settings/agents/codex/models',
      params: { agentId: 'codex' },
      router: { push: routerPush },
    }).module,
);

// The models are one section of the page's virtualized list; the recycler renders every row here.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
  const { createCapturingLegendListMock } =
    await import('@/dev/testkit/mocks/legendList');
  return createCapturingLegendListMock({
    original: await importOriginal<Record<string, unknown>>(),
  }).module;
});

// Warm the real Sync module after the transport leaves are installed, not inside a test hook's budget.
await loadSyncSingletonForTests();
// The menu reaches Provider transport through the shared UI graph. Import it
// only after the harness has installed the genuine RPC boundary.
const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
// Cold screen compilation belongs to collection, not an Account restore or
// interaction's timeout budget. Keep both screens real beneath the boundaries.
await import('./AgentModelsScreen');
await import('./AgentSettingsScreen');
// Load the real cache only after installing its machine-RPC transport boundary.
const {
  clearDaemonMergedProjectionCacheForTests,
  loadDaemonMergedProjectionCacheEntry,
} = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');

function selectBulkAction(screen: Awaited<ReturnType<typeof renderScreen>>, id: 'reset' | 'showAll') {
  const menu = screen.findAllByType(PageHeaderMenu).find(node => node.props.testID === 'provider-model-manager.menu');
  const action = menu?.props.actions.find((candidate: PageHeaderMenuAction) => candidate.id === id);
  if (!action) throw new Error(`Expected the Agent Models ${id} menu action`);
  expect(action.disabled).not.toBe(true);
  return action.onSelect();
}

describe('AgentModelsScreen provider settings safety', () => {
  it.each(['custom', 'gateway'] as const)('consumes Account source visibility and re-enables its real %s Models sheet', async kind => {
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const base = createModelPageCatalog();
    const hiddenRef = { agentTargetKey, providerConnectionId: 'pc_a', modelId: 'hidden-favorite' };
    const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...base,
      connections: kind === 'gateway' ? [{ ...base.connections[0]!,
        source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
        deployment: { kind: 'managedLocal' },
      }] : base.connections,
      modelPickerVisibilityByConnectionId: kind === 'custom' ? { pc_a: false } : {},
      modelVisibilityByRef: { [serializeModelVisibilityRefV1(ModelVisibilityRefV1Schema.parse({ scope: 'agent', ...hiddenRef }))]: 'hidden' },
      manualModelsByConnectionId: { pc_a: [{ id: 'model-a', name: 'Off source model', addedAt: 1 },
        { id: 'hidden-favorite', name: 'Hidden favorite model', addedAt: 1 }] },
    });
    serverId = (await account.restore({ catalog, machines: [],
      settings: { favoriteModelSelectionsV1: [{ selection: { v: 1, ref: hiddenRef, updatedAt: 1 } }] },
    })).serverId;
    await account.home.selectHomes([serverId]);
    await account.selectMachine(serverId, null, 'agents');
    const { installProviderConnectionsCatalogHttpBoundary } = await import('@/dev/testkit/harness/providerSettingsHarness');
    const stored = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId, catalog });
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    const screen = await renderScreen(<AgentModelsScreen agentTargetKey={agentTargetKey} runtimeAgentId={kind === 'gateway' ? null : 'codex'} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models-source-visibility:pc_a')).not.toBeNull());
    expect(screen.getTextContent()).not.toContain('Off source model');
    expect(screen.getTextContent()).not.toContain('Hidden favorite model');
    const toggle = screen.findAllByTestId('agent-models-source-visibility:pc_a').find(node => typeof node.props.onValueChange === 'function');
    expect(toggle?.props.value).toBe(false);
    await act(async () => { toggle?.props.onValueChange(true); });
    await waitForHomeGovernance(() => expect(stored.catalog.modelPickerVisibilityByConnectionId?.[ProviderConnectionIdSchema.parse('pc_a')]).toBe(true));
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Off source model'));
  });
  afterEach(async () => {
    standardCleanup();
    await account.reset();
  });
  beforeEach(async () => {
    providerHarness.reset();
    clearDaemonMergedProjectionCacheForTests();
    mocks.projection = { data: null, loading: false, error: null };
    mocks.projectionRequestCount = 0;
    mocks.mutate.mockReset();
    routerPush.mockReset();
    serverId = (
      await account.restore({
        serverIdentityId: 'srv_agent_models',
        catalog: createModelPageCatalog(),
        machines: providerHarness.state.machines,
        waivedActions: [
          ...Object.values(PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1),
          'providers.models.load',
          'providers.models.refresh',
          'connectedServices.accounts.purposeDefault.set',
        ],
      })
    ).serverId;
    await account.selectMachine(serverId, 'machine-a', 'agents');
    await account.home.selectHomes([serverId]);
    providerHarness.intercept(
      RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
      async () => {
        mocks.projectionRequestCount += 1;
        if (mocks.projection.loading && !mocks.projection.data)
          return await new Promise<never>(() => undefined);
        if (mocks.projection.error)
          return { status: 'error', error: mocks.projection.error };
        return (
          mocks.projection.data ??
          createProviderModelProjectionFixture({
            agentTargetKey: 'agent:happier.agent.codex/codex',
          })
        );
      },
    );
    providerHarness.intercept(
      RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE,
      async (request, next) =>
        (await mocks.mutate({
          serverId: request.serverId,
          request: request.payload,
        })) ?? (await next()),
    );
  });

    it('uses the canonical Administration exact target instead of the active-server fallback', async () => {
        const selectedServerId = await account.addHome({ name: 'Selected Agent Home', serverUrl: 'https://agent-models-selected.test',
            accountId: 'account-a', serverIdentityId: 'srv_agent_models_selected', active: false });
        await account.publishMachines(selectedServerId, [{ ...providerHarness.state.machines[0]!, id: 'machine-selected' }]);
        await account.selectMachine(selectedServerId, 'machine-selected', 'agents');
        const { useAgentAdministrationCatalog } = await import('./collection/useAgentAdministrationCatalog');
        const admission = await renderHook(() => useAgentAdministrationCatalog({ loadProjection: false }));
        expect(admission.getCurrent().targetSelection.selectedTarget).toEqual({
            serverIdentityId: 'srv_agent_models_selected', machineId: 'machine-selected',
        });
        expect(admission.getCurrent().targetSelection.state.kind).toBe('online');
        expect(admission.getCurrent().executionTarget?.machine.id).toBe('machine-selected');
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />);

        expect(screen.findByTestId('settings.agents.models.header')).not.toBeNull();
        await waitForHomeGovernance(() => expect(providerHarness.state.requests.length
            + account.home.artifacts(selectedServerId).list().length).toBeGreaterThan(0));
        expect(account.home.artifacts(selectedServerId).list()).toEqual([]);
        const projectionRequest = providerHarness.state.requests.find(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
        );
        expect(projectionRequest?.machineId).toBe('machine-selected');
        const { areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
        expect(areServerProfileIdentifiersEquivalent(projectionRequest!.serverId, selectedServerId)).toBe(true);
        expect(areServerProfileIdentifiersEquivalent(projectionRequest!.serverId, serverId)).toBe(false);
    });
  it('refuses unresolved selected-Home data instead of revealing the active Account catalog', async () => {
    const foreignServerId = await account.addHome({ name: 'Unresolved Agent Home',
      serverUrl: 'https://agent-models-unresolved.test', serverIdentityId: 'srv_agent_models_unresolved',
      accountId: 'foreign-account', active: false });
    await account.selectMachine(foreignServerId, 'missing-machine', 'agents');
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    const screen = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId="codex" />);
    expect(screen.findByTestId('settings.agents.models.header')).not.toBeNull();
    expect(screen.findByTestId('agent-models')).toBeNull();
    expect(providerHarness.state.requests).toEqual([]);
  });

  it('renders projected rows supplied through the shared Provider RPC boundary and real manager', async () => {
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    const { ProviderModelManager } =
      await import('@/providers/models/ProviderModelManager');
    mocks.projection.data = createProviderModelProjectionFixture({
      groups: [
        createProviderModelProjectionGroupFixture({
          rows: [
            {
              ref: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: 'pc_a',
                modelId: 'boundary-model',
              },
              descriptor: {
                id: 'boundary-model',
                name: 'Boundary agent model',
              },
              sources: { manual: false, static: false, probe: true },
              confidence: 'probe',
              compatibility: {
                result: {
                  status: 'verified',
                  selectedProtocol: 'openai-chat',
                  evidence: {
                    sourceUrls: ['https://example.com'],
                    verifiedAt: '2026-07-14',
                  },
                },
                compatibilityFingerprint: 'compatibility:v1:boundary',
                confirmed: true,
              },
              endpointHealth: 'available',
              catalog: { stale: false },
              loadState: 'loaded',
              visibility: 'visible',
            },
          ],
        }),
      ],
    });
    const screen = await renderScreen(
      <AgentModelsScreen
        agentTargetKey="agent:happier.agent.codex/codex"
        runtimeAgentId={null}
      />,
    );

    expect(
      screen.findByType(ProviderModelManager).props.groups[0].rows.find((row: ModelRow) => row.ref.modelId === 'boundary-model')?.descriptor.name,
    ).toBe('Boundary agent model');
  });
  it('shows the saved gateway identity with its packaged mark or canonical gateway fallback in the model source heading', async () => {
    const contributionKey = 'happier.provider.cliproxyapi/cliproxyapi';
    const declaration = readAccountProviderDeclarations({ kind: 'account' }).find(entry => entry.contributionKey === contributionKey)!;
    const identity = parseProviderContributionIdentityV1(contributionKey)!.identity;
    providerHarness.setResponse(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
        v: 2, generation: 1, familiesById: { providers: { family: 'providers', entriesById: {
          [contributionKey]: { id: contributionKey, pluginId: identity.pluginId, definition: declaration.definition,
            provenance: declaration.provenance, sourceKind: 'bundled' },
        } } },
      } }));
    const base = createModelPageCatalog();
    await account.restore({
      serverIdentityId: 'srv_agent_models',
      catalog: ProviderConnectionsCatalogV1Schema.parse({
        ...base,
        connections: [{ ...base.connections[0]!,
          source: { kind: 'contribution', contributionKey },
          deployment: { kind: 'managedLocal' },
        }],
      }),
      machines: providerHarness.state.machines,
    });
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    const { ProviderIcon } = await import('@/providers/connection/ProviderIcon');
    const { Icon } = await import('@/components/ui/icons/Icon');
    const { PROVIDER_GATEWAY_ICON } = await import('@/components/settings/providers/collection/providerCollectionModel');
    const screen = await renderScreen(
      <AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />,
    );
    await waitForHomeGovernance(() => {
      const mark = screen.findAllByType(ProviderIcon).find(node => node.props.contributionKey === contributionKey);
      expect(mark).toBeDefined();
      // Packaged brand artwork takes precedence over the resolver's glyph.
      // Inspect the visible identity, so a neutral fallback cannot silently pass.
      expect(mark!.findAllByType('Image').length > 0
        || mark!.findAllByType(Icon).some(node => node.props.name === PROVIDER_GATEWAY_ICON)).toBe(true);
    });
  });
  it('names a plugin Agent from its exact admitted catalog entry without another daemon read', async () => {
    mocks.projection.data = createProviderModelProjectionFixture({ agentTargetKey: 'agent:acme.review/provider' });
    providerHarness.intercept(
      RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      async () => ({
        protocolVersion: 1,
        projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
      }),
    );
    const loaded = await loadDaemonMergedProjectionCacheEntry({
      machineId: 'machine-a',
      serverId,
    });
    expect(
      loaded?.kind,
      loaded?.kind === 'error' ? loaded.reason : undefined,
    ).toBe('ready');
    const readsBefore = providerHarness.state.requests.filter(
      (request) =>
        request.method ===
        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
    ).length;
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    const screen = await renderScreen(
      <AgentModelsScreen
        agentTargetKey="agent:acme.review/provider"
        runtimeAgentId="provider"
      />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('agent-models')).not.toBeNull(),
    );
    expect(screen.getTextContent()).toContain('Acme Review Provider');
    expect(
      providerHarness.state.requests.filter(
        (request) =>
          request.method ===
          RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      ),
    ).toHaveLength(readsBefore);
  });
  it.each(['none', 'online', 'offline'] as const)(
    'keeps Account models, visibility and favorite/default markers available with an %s machine selection', async (machineState) => {
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const selection = {
      v: 1,
      ref: { agentTargetKey, providerConnectionId: 'pc_a', modelId: 'model-a' },
      updatedAt: 1,
    };
    const catalog = ProviderConnectionsCatalogV1Schema.parse({
      ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
      connections: [
        {
          v: 1,
          id: 'pc_a',
          source: {
            kind: 'custom',
            template: buildCustomProviderTemplate({
              ...createCustomProviderDraft('openai-responses'),
              name: 'Account source',
              baseUrl: 'https://custom.example/v1',
              requiresApiKey: false,
              catalog: 'manual',
            }),
          },
          role: 'named',
          displayName: 'My source',
          displayNameMode: 'custom',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      manualModelsByConnectionId: {
        pc_a: [
          { id: 'model-a', name: 'Account model', addedAt: 1 },
          { id: 'model-b', name: 'Account model B', addedAt: 1 },
        ],
      },
    });
    serverId = (
      await account.restore({
        accountId: 'account-models',
        catalog,
        machines: machineState === 'none' ? [] : providerHarness.state.machines.map(machine => ({
          ...machine, active: machineState === 'online', activeAt: machineState === 'online' ? Date.now() : 0,
        })),
        settings: {
          providerDefaultModelSelectionsByAgentTargetKeyV1: {
            [agentTargetKey]: selection,
          },
          favoriteModelSelectionsV1: [{ selection }],
        },
        waivedActions: ['providers.defaults.set'],
      })
    ).serverId;
    await account.home.selectHomes([serverId]);
    await account.selectMachine(serverId, machineState === 'none' ? null : 'machine-a', 'agents');
    if (machineState === 'online') {
      // The daemon boundary supplies the same Account rows plus runtime facts; keep the projection policy real.
      const { projectAccountProviderModelsV1 } = await import('@happier-dev/protocol/providers/catalog/accountModelProjectionV1');
      const { readAccountProviderDeclarations, readAccountAgentProviderRequirements } = await import('@/providers/catalog/accountProviderDeclarations');
      providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, async () => projectAccountProviderModelsV1({
        catalog: ProviderConnectionsCatalogV1Schema.parse({ ...catalog, connections: [...catalog.connections, { ...catalog.connections[0]!, id: 'pc_retired' }],
          manualModelsByConnectionId: { pc_a: [{ id: 'model-a', name: 'Account model', addedAt: 1 },
            { id: 'removed', name: 'Removed manual machine model', addedAt: 1 }],
            pc_retired: [{ id: 'retired', name: 'Retired machine catalog model', addedAt: 1 }] },
          modelVisibilityByRef: { [serializeModelVisibilityRefV1(ModelVisibilityRefV1Schema.parse({ scope: 'agent', agentTargetKey,
            providerConnectionId: 'pc_a', modelId: 'model-a' }))]: 'hidden' } }),
        definitions: readAccountProviderDeclarations({ kind: 'account' }), agent: readAccountAgentProviderRequirements(agentTargetKey, { kind: 'account' }),
        request: { agentTargetKey, mode: 'management' },
      }));
    }
    const { storage } = await import('@/sync/domains/state/storage');
    expect(
      storage.getState().settings
        .providerDefaultModelSelectionsByAgentTargetKeyV1[agentTargetKey],
    ).toEqual(selection);
    expect(
      storage.getState().settings.currentFavoriteModelSelectionsV1,
    ).toHaveLength(1);
    let settingsVersion = 1;
    account.home.answer(serverId, 'POST /v2/account/settings', {
      select: (input) => {
        const mutation = AccountSettingsV2UpdateRequestSchema.parse(input);
        expect(mutation.expectedVersion).toBe(settingsVersion);
        expect(mutation.content?.t).toBe('plain');
        settingsVersion += 1;
        account.home.answer(serverId, 'GET /v2/account/settings', {
          body: {
            version: settingsVersion,
            content: mutation.content,
          },
        });
        return { body: { success: true, version: settingsVersion } };
      },
    });
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    const screen = await renderScreen(
      <AgentModelsScreen
        agentTargetKey={agentTargetKey}
        runtimeAgentId="codex"
      />,
    );
    await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models')).not.toBeNull());
    expect(screen.getTextContent()).toContain('Account model');
    expect(screen.getTextContent()).toContain('Account model B');
    expect(screen.getTextContent()).not.toContain('Retired machine catalog model');
    expect(screen.getTextContent()).not.toContain('Removed manual machine model');
    const { ProviderModelManager } = await import('@/providers/models/ProviderModelManager');
    expect(screen.findByType(ProviderModelManager).props.groups[0].rows.find(
      (row: ModelRow) => row.ref.modelId === 'model-a')?.visibility).toBe('visible');
    expect(
      screen.findByTestId('provider-model-manager.favorite'),
    ).not.toBeNull();
    expect(
      screen.findByTestId('provider-model-manager.default'),
    ).not.toBeNull();
    expect(
      screen.findByTestId('agent-models-source-visibility:pc_a'),
    ).not.toBeNull();
    expect(providerHarness.state.requests.filter(request => (
      request.method !== RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION
      && request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
    ))).toEqual([]);
    // Setting the default is the row menu's rare operation for that exact model.
    const defaultControl = screen
      .findAllByType(PageHeaderMenu)
      .find((node) =>
        node.props.accessibilityLabel?.includes('Account model B'),
      )
      ?.props.actions.find((action: PageHeaderMenuAction) => action.id === 'setDefault');
    expect(defaultControl).toBeDefined();
    await act(async () => {
      await defaultControl?.onSelect();
    });
    await waitForHomeGovernance(() =>
      expect(
        storage.getState().settings
          .providerDefaultModelSelectionsByAgentTargetKeyV1[agentTargetKey]
          ?.ref,
      ).toEqual({
        agentTargetKey,
        providerConnectionId: 'pc_a',
        modelId: 'model-b',
      }),
    );
    expect(providerHarness.state.requests.filter(request => (
      request.method !== RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION
      && request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
    ))).toEqual([]);
  });
  it('shows the exact Account default on the Agent Session-default Model row without a machine', async () => {
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const catalog = ProviderConnectionsCatalogV1Schema.parse({
      ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
      connections: [
        {
          v: 1,
          id: 'pc_b',
          source: {
            kind: 'custom',
            template: buildCustomProviderTemplate({
              ...createCustomProviderDraft('openai-responses'),
              name: 'Other source',
              baseUrl: 'https://other.example/v1',
              requiresApiKey: false,
              catalog: 'manual',
            }),
          },
          role: 'named',
          displayName: 'Other connection',
          displayNameMode: 'custom',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          v: 1,
          id: 'pc_a',
          source: {
            kind: 'custom',
            template: buildCustomProviderTemplate({
              ...createCustomProviderDraft('openai-responses'),
              name: 'Account source',
              baseUrl: 'https://custom.example/v1',
              requiresApiKey: false,
              catalog: 'manual',
            }),
          },
          role: 'named',
          displayName: 'My source',
          displayNameMode: 'custom',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      manualModelsByConnectionId: {
        pc_b: [{ id: 'same-model', name: 'Other model', addedAt: 1 }],
        pc_a: [{ id: 'same-model', name: 'Account default model', addedAt: 1 }],
      },
    });
    serverId = (
      await account.restore({
        accountId: 'account-summary',
        catalog,
        machines: [],
        settings: {
          providerDefaultModelSelectionsByAgentTargetKeyV1: {
            [agentTargetKey]: {
              v: 1,
              ref: {
                agentTargetKey,
                providerConnectionId: 'pc_a',
                modelId: 'same-model',
              },
              updatedAt: 1,
            },
          },
        },
      })
    ).serverId;
    await account.home.selectHomes([serverId]);
    await account.selectMachine(serverId, null, 'agents');
    const { storage } = await import('@/sync/domains/state/storage');
    expect(
      storage.getState().settings
        .providerDefaultModelSelectionsByAgentTargetKeyV1[agentTargetKey]?.ref,
    ).toEqual({
      agentTargetKey,
      providerConnectionId: 'pc_a',
      modelId: 'same-model',
    });
    const { AgentSettingsScreen } = await import('./AgentSettingsScreen');
    const { AppPaneProvider } =
      await import('@/components/appShell/panes/AppPaneProvider');
    const screen = await renderScreen(
      <AppPaneProvider>
        <AgentSettingsScreen />
      </AppPaneProvider>,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('settings.agents.detail.defaultModel'),
      ).not.toBeNull(),
    );
    await waitForHomeGovernance(() =>
      expect(screen.getTextContent()).toContain('Account default model'),
    );
    expect(screen.getTextContent()).toContain('My source');
    expect(screen.getTextContent()).not.toContain('Other model');
    expect(providerHarness.state.requests).toEqual([]);
  });
  it('counts what the model picker shows on the Session-default Models row without a machine', async () => {
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const native = getAgentStaticModels('codex');
    const hiddenNativeKey = serializeModelVisibilityRefV1({
      scope: 'agent',
      agentTargetKey,
      providerConnectionId: null,
      modelId: native[0]!.id,
    });
    const hiddenProviderKey = serializeModelVisibilityRefV1(ModelVisibilityRefV1Schema.parse({
      scope: 'agent',
      agentTargetKey,
      providerConnectionId: 'pc_a',
      modelId: 'model-b',
    }));
    const catalog = ProviderConnectionsCatalogV1Schema.parse({
      ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
      connections: [
        {
          v: 1,
          id: 'pc_a',
          source: {
            kind: 'custom',
            template: buildCustomProviderTemplate({
              ...createCustomProviderDraft('openai-responses'),
              name: 'Account source',
              baseUrl: 'https://custom.example/v1',
              requiresApiKey: false,
              catalog: 'manual',
            }),
          },
          role: 'named',
          displayName: 'My source',
          displayNameMode: 'custom',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      manualModelsByConnectionId: {
        pc_a: [
          { id: 'model-a', name: 'Model A', addedAt: 1 },
          { id: 'model-b', name: 'Model B', addedAt: 1 },
        ],
      },
      modelVisibilityByRef: {
        [hiddenNativeKey]: 'hidden',
        [hiddenProviderKey]: 'hidden',
      },
    });
    serverId = (
      await account.restore({
        accountId: 'account-count',
        catalog,
        machines: [],
      })
    ).serverId;
    await account.home.selectHomes([serverId]);
    await account.selectMachine(serverId, null, 'agents');
    const { AgentSettingsScreen } = await import('./AgentSettingsScreen');
    const { AppPaneProvider } =
      await import('@/components/appShell/panes/AppPaneProvider');
    const screen = await renderScreen(
      <AppPaneProvider>
        <AgentSettingsScreen />
      </AppPaneProvider>,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('settings.agents.detail.models')).not.toBeNull(),
    );
    // The picker shows every native model but the hidden one, and Model A from the shown source.
    await vi.waitFor(
      () =>
        expect(screen.getTextContent()).toContain(
          `${native.length} shown · 2 hidden`,
        ),
      { timeout: 10_000 },
    );
    expect(providerHarness.state.requests).toEqual([]);
  });

  it('persists an Agent account-purpose profile selection through the canonical Account catalog', async () => {
    await account.selectMachine(serverId, null, 'agents');
    let record: Extract<ConnectedAccountCatalogRecordV1, { key: 'purposes' }> = {
      key: 'purposes', value: { v: 1, bindings: [] },
    };
    let revision = 1;
    const path = `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`;
    account.home.answer(serverId, `GET ${path}`, { select: () => ({ body: {
      status: 'present', revision, content: { t: 'plain', v: record },
    } }) });
    account.home.answer(serverId, `POST ${path}`, { select: input => {
      const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(input);
      expect(mutation.expectedRevision).toBe(revision);
      if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'purposes')
        throw new Error('Expected canonical plain purpose catalog');
      record = mutation.content.v;
      return { body: { status: 'updated', revision: ++revision, cursor: revision } };
    } });
    const { AgentSettingsScreen } = await import('./AgentSettingsScreen');
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
    const screen = await renderScreen(<AppPaneProvider><AgentSettingsScreen /></AppPaneProvider>);
    await waitForHomeGovernance(() => expect(screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]?.props.disabled).toBe(false));
    const chooser = screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!;
    const target = { kind: 'account' as const,
      account: { service: chooser.props.declaration.service, accountId: 'selected-profile' } };
    await act(async () => chooser.props.onChange(target, null));
    await waitForHomeGovernance(() => expect(record.value.bindings).toContainEqual({
      purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
        purpose: chooser.props.declaration.purpose }, target,
    }));
    // The page may read its machine inventory; saving an Account purpose must issue no other daemon operation.
    expect(providerHarness.state.requests.filter(request =>
      request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
    )).toEqual([]);
  });
  it.each(['plain', 'e2ee'] as const)(
    'persists the %s custom source widget through admitted Account CAS',
    async (mode) => {
      const secret = new Uint8Array(32).fill(31);
      const material =
        mode === 'e2ee' ? { type: 'legacy' as const, secret } : null;
      let catalog = ProviderConnectionsCatalogV1Schema.parse({
        ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        manualModelsByConnectionId: { pc_a: [{ id: 'model-a', name: 'Model A', addedAt: 1 }] },
        connections: ['pc_a', 'pc_b'].map((id) => ({
          v: 1,
          id,
          source:
            id === 'pc_a'
              ? {
                  kind: 'custom',
                  template: buildCustomProviderTemplate({
                    ...createCustomProviderDraft('openai-responses'),
                    name: 'Custom source',
                    baseUrl: 'https://custom.example/v1',
                    requiresApiKey: false,
                    catalog: 'manual',
                  }),
                }
              : { kind: 'contribution', contributionKey: 'acme.plugin/acme' },
          role: 'named',
          displayName: id,
          displayNameMode: 'custom',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        })),
      });
      serverId = (
        await account.restore({
          catalog,
          machines: [],
          accountId: `account-source-widget-${mode}`,
          waivedActions: ['providers.models.source_visibility.set'],
          features: createRootLayoutFeaturesResponse({
            features: { providers: { enabled: true } },
          }),
          ...(mode === 'e2ee' ? { e2eeSecret: secret } : {}),
        })
      ).serverId;
      await account.home.selectHomes([serverId]);
      await account.selectMachine(serverId, null, 'agents');
      let revision = 1;
      account.home.answer(
        serverId,
        `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`,
        {
          select: () => ({
            body: {
              status: 'present',
              revision,
              content: sealProviderConnectionsContentV1({
                mode,
                material,
                catalog,
              }),
            },
          }),
        },
      );
      account.home.answer(
        serverId,
        `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`,
        {
          select: (input) => {
            const mutation =
              ProviderConnectionsRowMutationV1Schema.parse(input);
            expect(mutation.expectedRevision).toBe(revision);
            const opened = openProviderConnectionsContentV1({
              mode,
              material,
              content: mutation.content,
            });
            if (opened.status !== 'opened')
              throw new Error('Expected an admitted Account catalog');
            catalog = opened.catalog;
            revision += 1;
            return { body: { status: 'updated', revision, cursor: revision } };
          },
        },
      );
      mocks.projection.data = createProviderModelProjectionFixture({
        groups: ['pc_a', 'pc_b'].map((connectionId) =>
          createProviderModelProjectionGroupFixture({
            connectionId,
            rows: [
              {
                ref: {
                  agentTargetKey: 'agent:happier.agent.codex/codex',
                  providerConnectionId: connectionId,
                  modelId: 'model-a',
                },
                descriptor: { id: 'model-a', name: 'Model A' },
                sources: { manual: true, static: false, probe: false },
                confidence: 'manual',
                compatibility: {
                  result: {
                    status: 'verified',
                    selectedProtocol: 'openai-chat',
                    evidence: {
                      sourceUrls: ['https://example.com'],
                      verifiedAt: '2026-07-14',
                    },
                  },
                  compatibilityFingerprint:
                    'compatibility:v1:source-visibility',
                  confirmed: true,
                },
                endpointHealth: 'available',
                catalog: { stale: false },
                loadState: 'loaded',
                visibility: 'visible',
              },
            ],
          }),
        ),
      });
      const { AgentModelsScreen } = await import('./AgentModelsScreen');
      const screen = await renderScreen(
        <AgentModelsScreen
          agentTargetKey="agent:happier.agent.codex/codex"
          runtimeAgentId={null}
        />,
      );
      await waitForHomeGovernance(() =>
        expect(screen.findByTestId('agent-models')).not.toBeNull(),
      );
      const control = () =>
        screen
          .findAllByTestId('agent-models-source-visibility:pc_a')
          .find((node) => typeof node.props.onValueChange === 'function');
      await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Model A'));
      await waitForHomeGovernance(() => expect(control()?.props.value).toBe(true));
      expect(
        screen.findByTestId('agent-models-source-visibility:pc_b'),
      ).toBeNull();
      await act(async () => {
        control()?.props.onValueChange(false);
      });
      await waitForHomeGovernance(() =>
        expect(control()?.props.value).toBe(false),
      );
      expect(catalog.modelPickerVisibilityByConnectionId).toEqual({
        pc_a: false,
      });
      expect(mocks.mutate).not.toHaveBeenCalled();
      if (mode === 'e2ee') {
        const withdrawnChoice = control()?.props.onValueChange;
        expect(typeof withdrawnChoice).toBe('function');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { getServerProfileById } =
          await import('@/sync/domains/server/serverProfiles');
        const home = getServerProfileById(serverId)!;
        const credentials = await TokenStorage.getCredentialsForServerUrl(
          home.serverUrl,
          { serverId },
        );
        if (!credentials)
          throw new Error('Expected the encrypted fixture credential');
        const rowWrites = () =>
          account.home
            .requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)
            .filter(
              (request) =>
                ProviderConnectionsRowMutationV1Schema.safeParse(request.input)
                  .success,
            );
        const writes = rowWrites().length;
        expect(writes).toBe(1);
        // Secure-store reads and its genuine mutation event both now report keyless
        // credentials; catalog admission and the mounted widget remain real.
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
          token: credentials.token,
        });
        try {
          await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(
              home.serverUrl,
              { serverId },
              { token: credentials.token },
            );
          });
          expect(control()).toBeUndefined();
          expect(screen.findByTestId('agent-models')).toBeNull();
          expect(screen.getTextContent()).not.toContain('Model A');
          await act(async () => {
            withdrawnChoice?.(true);
          });
          expect(rowWrites()).toHaveLength(writes);
        } finally {
          credentialRead.mockRestore();
        }
      }
    },
  );
  it('retires the source error when Account B has no custom source leaf', async () => {
    const catalog = ProviderConnectionsCatalogV1Schema.parse({
      ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
      connections: [
        {
          v: 1,
          id: 'pc_a',
          source: {
            kind: 'custom',
            template: buildCustomProviderTemplate({
              ...createCustomProviderDraft('openai-chat'),
              name: 'Custom source',
              baseUrl: 'https://custom.example/v1',
              requiresApiKey: false,
              catalog: 'manual',
            }),
          },
          role: 'named',
          displayName: 'Custom source',
          displayNameMode: 'custom',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    account.home.answer(serverId, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, {
      body: {
        status: 'present',
        revision: 1,
        content: { t: 'plain', v: catalog },
      },
    });
    const { refreshProviderCatalog } =
      await import('@/sync/engine/settings/providerCatalogEngine');
    await refreshProviderCatalog({ serverId, accountId: 'account-a' });
    let writes = 0;
    account.home.answer(
      serverId,
      `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`,
      {
        select: (input) => {
          const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
          expect(mutation.expectedRevision).toBe(1);
          expect(mutation.content).toMatchObject({
            t: 'plain',
            v: { modelPickerVisibilityByConnectionId: { pc_a: false } },
          });
          writes += 1;
          return { dispatchThenFail: true };
        },
      },
    );
    mocks.projection.data = createProviderModelProjectionFixture({
      groups: [
        createProviderModelProjectionGroupFixture({
          rows: [
            {
              ref: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: 'pc_a',
                modelId: 'model-a',
              },
              descriptor: { id: 'model-a', name: 'Model A' },
              sources: { manual: true, static: false, probe: false },
              confidence: 'manual',
              compatibility: {
                result: {
                  status: 'verified',
                  selectedProtocol: 'openai-chat',
                  evidence: {
                    sourceUrls: ['https://example.com'],
                    verifiedAt: '2026-07-14',
                  },
                },
                compatibilityFingerprint: 'compatibility:v1:source-retirement',
                confirmed: true,
              },
              endpointHealth: 'available',
              catalog: { stale: false },
              loadState: 'loaded',
              visibility: 'visible',
            },
          ],
        }),
      ],
    });
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    const screen = await renderScreen(
      <AgentModelsScreen
        agentTargetKey="agent:happier.agent.codex/codex"
        runtimeAgentId={null}
      />,
    );
    const control = () =>
      screen
        .findAllByTestId('agent-models-source-visibility:pc_a')
        .find((node) => typeof node.props.onValueChange === 'function');
    await waitForHomeGovernance(() =>
      expect(control()?.props.value).toBe(true),
    );
    await act(async () => {
      control()!.props.onValueChange(false);
    });
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId(
          'provider-error:provider_rpc_mutation_outcome_unknown',
        ),
      ).not.toBeNull(),
    );
    expect(writes).toBe(1);

    await act(async () => {
      await account.restore({
        accountId: 'account-b',
        catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        machines: providerHarness.state.machines,
        waivedActions: [
          ...Object.values(PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1),
          'providers.models.load',
          'providers.models.refresh',
        ],
      });
      // Publish the fixture Home's enabled Provider features after restoring B.
      await account.publishFeatures(
        serverId,
        createRootLayoutFeaturesResponse({
          features: { providers: { enabled: true } },
        }),
      );
      // Cold restoration also exposes the default saved Home. This page's feature
      // decision must use the test Home rather than a group containing that unserved Home.
      await account.home.selectHomes([serverId]);
      await account.selectMachine(serverId, 'machine-a', 'agents');
    });
    const { captureActiveServerAccountScopeLifetime } =
      await import('@/sync/domains/scope/activeServerAccountScope');
    expect(captureActiveServerAccountScopeLifetime()?.scope.accountId).toBe(
      'account-b',
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('agent-models')).not.toBeNull(),
    );
    expect(control()).toBeUndefined();
    expect(
      screen.findByTestId(
        'provider-error:provider_rpc_mutation_outcome_unknown',
      ),
    ).toBeNull();
    expect(writes).toBe(1);
  });
  it('keeps the Account model page and its bulk actions available with or without a selected machine', async () => {
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    const { ProviderModelManager } =
      await import('@/providers/models/ProviderModelManager');
    const listed = await renderScreen(
      <AgentModelsScreen
        agentTargetKey="agent:happier.agent.codex/codex"
        runtimeAgentId={null}
      />,
    );
    // Account controls live in the page menu; machine context belongs to list freshness.
    const host = listed.findByType(ProviderModelManager).props.page;
    expect(host?.header.props.actions.props.testID).toBe('provider-model-manager.menu');
    expect(host?.header.props.actions.props.actions.map((action: PageHeaderMenuAction) => action.id)).toEqual(['hideAll', 'reset']);
    const { MachineAdministrationTargetSelector } =
      await import('@/components/settings/machines/MachineAdministrationTargetSelector');
    expect(
      listed.findAllByType(MachineAdministrationTargetSelector),
    ).toHaveLength(0);

    await listed.unmount();
    await account.publishMachines(serverId, []);
    await account.selectMachine(serverId, null, 'agents');
    const noMachine = await renderScreen(
      <AgentModelsScreen
        agentTargetKey="agent:happier.agent.codex/codex"
        runtimeAgentId={null}
      />,
    );
    expect(
      noMachine.findByTestId('settings.agents.models.header'),
    ).not.toBeNull();
    expect(
      noMachine.findAllByType(MachineAdministrationTargetSelector),
    ).toHaveLength(0);
    expect(noMachine.findByType(ProviderModelManager).props.readOnly).toBe(false);
    expect(noMachine.findAllByType(PageHeaderMenu).find(node => node.props.testID === 'provider-model-manager.menu')
      ?.props.actions.map((action: PageHeaderMenuAction) => action.id)).toEqual(['hideAll', 'reset']);
  });

  it('waits for the initial Account catalog before showing an unreadable-catalog diagnostic', async () => {
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    const { Item } = await import('@/components/ui/lists/Item');
    const { storage } = await import('@/sync/domains/state/storage');
    const { getProviderCatalogSnapshot, resetProviderCatalogSnapshotsForTests } =
      await import('@/sync/store/settings/providerCatalogSnapshot');
    const scope = storage.getState().settingsScope;
    if (!scope) throw new Error('Expected restored Account scope');
    let releaseCatalog!: () => void;
    const respondAfter = new Promise<void>(resolve => { releaseCatalog = resolve; });
    account.home.answer(serverId, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, {
      respondAfter,
      body: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 99, connections: [] } } },
    });
    // Withdraw the prior test's hydrated snapshot, then hold only HTTP delivery open.
    resetProviderCatalogSnapshotsForTests();
    expect(getProviderCatalogSnapshot(scope)).toBeNull();
    const screen = await renderScreen(
      <AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />,
    );
    expect(getProviderCatalogSnapshot(scope)?.status).toBe('loading');
    expect(screen.findAllByType(Item).some(row => row.props.loading === true)).toBe(true);
    expect(screen.getTextContent()).not.toContain('Provider needs attention');
    expect(screen.findByTestId('agent-models')).toBeNull();
    await act(async () => { releaseCatalog(); });
    await waitForHomeGovernance(() => {
      expect(getProviderCatalogSnapshot(scope)?.status).toBe('unavailable');
      expect(screen.getTextContent()).toContain('Provider needs attention');
    });
    expect(screen.findAllByType(Item).some(row => row.props.loading === true)).toBe(false);
  });

  it('renders a read-only diagnostic for invalid Provider catalog content instead of a mutable default manager', async () => {
    account.home.answer(serverId, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, {
      body: {
        status: 'present',
        revision: 1,
        content: { t: 'plain', v: { v: 99, connections: [] } },
      },
    });
    const { refreshProviderCatalog } =
      await import('@/sync/engine/settings/providerCatalogEngine');
    await refreshProviderCatalog({ serverId, accountId: 'account-a' });
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    const screen = await renderScreen(
      <AgentModelsScreen
        agentTargetKey="agent:happier.agent.codex/codex"
        runtimeAgentId={null}
      />,
    );
    expect(screen.findByTestId('agent-models')).toBeNull();
    expect(screen.getTextContent()).toContain('Provider needs attention');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('keeps hydrated rows read-only through catalog refresh and transient failure, then withdraws unauthorized data', async () => {
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    const { ProviderModelManager } =
      await import('@/providers/models/ProviderModelManager');
    const { Switch } = await import('@/components/ui/forms/Switch');
    const { applyProviderCatalogSnapshot, beginProviderCatalogLoad } =
      await import('@/sync/store/settings/providerCatalogSnapshot');
    const { storage } = await import('@/sync/domains/state/storage');
    const catalog = ProviderConnectionsCatalogV1Schema.parse(
      DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    );
    serverId = (
      await account.restore({
        accountId: 'account-model-continuity',
        catalog,
        machines: [],
      })
    ).serverId;
    await account.home.selectHomes([serverId]);
    await account.selectMachine(serverId, null, 'agents');
    const ready = { status: 'ready' as const, revision: 1, catalog };
    const screen = await renderScreen(
      <AgentModelsScreen
        agentTargetKey="agent:happier.agent.codex/codex"
        runtimeAgentId="codex"
      />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('agent-models')).not.toBeNull(),
    );
    const catalogScope = storage.getState().settingsScope;
    if (!catalogScope) throw new Error('Expected restored Account scope');
    const firstRows =
      screen.findByType(ProviderModelManager).props.nativeModels;
    expect(firstRows.length).toBeGreaterThan(0);

    // Drive real catalog publication, not a mocked hook or model projection.
    await act(async () => {
      beginProviderCatalogLoad(catalogScope);
    });
    expect(screen.findByTestId('agent-models')).not.toBeNull();
    expect(screen.findByType(ProviderModelManager).props.nativeModels).toBe(
      firstRows,
    );
    expect(
      screen
        .findAllByType(Switch)
        .every((control) => control.props.disabled === true),
    ).toBe(true);
    expect(
      screen
        .findAllByType(PageHeaderMenu)
        .flatMap((menu) => menu.props.actions)
        .some((action) => action.id === 'setDefault'),
    ).toBe(false);
    expect(screen.findByTestId('provider-model-manager.hide-all')).toBeNull();

    await act(async () => {
      applyProviderCatalogSnapshot(
        catalogScope,
        { status: 'unavailable', reason: 'unreachable' },
        true,
      );
    });
    expect(screen.findByTestId('agent-models')).not.toBeNull();
    expect(
      screen
        .findAllByType(Switch)
        .every((control) => control.props.disabled === true),
    ).toBe(true);

    await act(async () => {
      applyProviderCatalogSnapshot(catalogScope, ready, true);
    });
    expect(
      screen
        .findAllByType(Switch)
        .some((control) => control.props.disabled !== true),
    ).toBe(true);

    await act(async () => {
      applyProviderCatalogSnapshot(
        catalogScope,
        { status: 'unavailable', reason: 'forbidden' },
        true,
      );
    });
    expect(screen.findByTestId('agent-models')).toBeNull();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('keeps Account models readable while optional machine facts load or fail', async () => {
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    mocks.projection = { data: null, loading: true, error: null };
    const loading = await renderScreen(
      <AgentModelsScreen
        agentTargetKey="agent:happier.agent.codex/codex"
        runtimeAgentId="codex"
      />,
    );
    await waitForHomeGovernance(() => expect(loading.findByTestId('agent-models')).not.toBeNull());
    expect(loading.getTextContent()).not.toContain(getAgentStaticModels('codex')[0]!.name);
    await loading.unmount();

    mocks.projection = {
      data: null,
      loading: false,
      error: createProviderErrorV1('provider_endpoint_unreachable'),
    };
    const failed = await renderScreen(
      <AgentModelsScreen
        agentTargetKey="agent:happier.agent.codex/codex"
        runtimeAgentId="codex"
      />,
    );
    await waitForHomeGovernance(() => expect(failed.findByTestId('agent-models')).not.toBeNull());
    await waitForHomeGovernance(() => expect(failed.getTextContent()).toContain('Provider is unreachable'));
  });

  it.each(['native visibility', 'agent reset', 'mixed bulk'] as const)(
    'reconciles a commit-then-reject %s once and reviews the current Agent Models surface',
    async (operation) => {
      const { AgentModelsScreen } = await import('./AgentModelsScreen');
      const { ProviderModelManager } =
        await import('@/providers/models/ProviderModelManager');
      const { Switch } = await import('@/components/ui/forms/Switch');
      const agentTargetKey = 'agent:happier.agent.codex/codex';
      const nativeModel = getAgentStaticModels('claude')[0]!;
      const nativeModelId = nativeModel.id;
      const nativeKey = serializeModelVisibilityRefV1({
        scope: 'agent',
        agentTargetKey,
        providerConnectionId: null,
        modelId: nativeModelId,
      });
      const providerKey = serializeModelVisibilityRefV1(ModelVisibilityRefV1Schema.parse({
        scope: 'agent',
        agentTargetKey,
        providerConnectionId: 'pc_a',
        modelId: 'provider-model',
      }));
      let catalog = ProviderConnectionsCatalogV1Schema.parse({
        ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: [
          {
            v: 1,
            id: 'pc_a',
            source: {
              kind: 'custom',
              template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'),
                name: 'Review source',
                baseUrl: 'https://review.example/v1',
                requiresApiKey: false,
                catalog: 'manual',
              }),
            },
            role: 'named',
            displayName: 'Review source',
            displayNameMode: 'custom',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        modelVisibilityByRef:
          operation === 'native visibility'
            ? {}
            : { [nativeKey]: 'hidden', [providerKey]: 'hidden' },
        manualModelsByConnectionId: { pc_a: [{ id: 'provider-model', name: 'Provider model', addedAt: 1 }] },
      });
      let revision = 2;
      let writes = 0;
      account.home.answer(
        serverId,
        `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`,
        {
          select: () => ({
            body: {
              status: 'present',
              revision,
              content: { t: 'plain', v: catalog },
            },
          }),
        },
      );
      const { refreshProviderCatalog } =
        await import('@/sync/engine/settings/providerCatalogEngine');
      await refreshProviderCatalog({ serverId, accountId: 'account-a' });
      account.home.answer(
        serverId,
        `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`,
        {
          select: (input) => {
            const mutation =
              ProviderConnectionsRowMutationV1Schema.parse(input);
            expect(mutation.expectedRevision).toBe(revision);
            if (mutation.content?.t !== 'plain')
              throw new Error('Expected plain Account catalog');
            catalog = ProviderConnectionsCatalogV1Schema.parse(
              mutation.content.v,
            );
            revision += 1;
            writes += 1;
            return { dispatchThenFail: true };
          },
        },
      );
      mocks.projection.data = createProviderModelProjectionFixture({
        groups: [
          createProviderModelProjectionGroupFixture({
            rows: [
              {
                ref: {
                  agentTargetKey: 'agent:happier.agent.codex/codex',
                  providerConnectionId: 'pc_a',
                  modelId: 'provider-model',
                },
                descriptor: { id: 'provider-model', name: 'Provider model' },
                sources: { manual: false, static: true, probe: false },
                confidence: 'verified_static',
                compatibility: {
                  result: {
                    status: 'verified',
                    selectedProtocol: 'openai-chat',
                    evidence: {
                      sourceUrls: ['https://example.com'],
                      verifiedAt: '2026-07-14',
                    },
                  },
                  compatibilityFingerprint: 'compatibility:v1:agent-review',
                  confirmed: true,
                },
                endpointHealth: 'available',
                catalog: { stale: false },
                loadState: 'loaded',
                visibility:
                  operation === 'mixed bulk' ? 'hidden_agent' : 'visible',
              },
            ],
          }),
        ],
      });
      const screen = await renderScreen(
        <AgentModelsScreen
          agentTargetKey="agent:happier.agent.codex/codex"
          runtimeAgentId="claude"
        />,
      );
      expect(mocks.projectionRequestCount).toBe(1);
      const manager = screen.findByType(ProviderModelManager);

      await act(async () => {
        if (operation === 'native visibility') {
          manager.props.onSetVisibility?.(
            {
              scope: 'agent',
              agentTargetKey: 'agent:happier.agent.codex/codex',
              providerConnectionId: null,
              modelId: nativeModelId,
            },
            true,
          );
        } else if (operation === 'agent reset') {
          selectBulkAction(screen, 'reset');
        } else {
          selectBulkAction(screen, 'showAll');
        }
        await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(2));
      });
      await act(async () => {
        await vi.waitFor(() =>
          expect(
            screen.findByTestId(
              'provider-error:provider_rpc_mutation_outcome_unknown',
            ),
          ).not.toBeNull(),
        );
      });

      expect(writes).toBe(1);
      expect(catalog.modelVisibilityByRef).toEqual(
        operation === 'native visibility' ? { [nativeKey]: 'hidden' } : {},
      );
      expect(mocks.mutate).not.toHaveBeenCalled();
      const reviewAction = screen.findByTestId(
        'provider-error-action:provider_rpc_mutation_outcome_unknown',
      );
      expect(reviewAction).not.toBeNull();
      expect(screen.getTextContent()).not.toContain('Retry');
      expect(screen.findByType(ProviderModelManager)).toBeDefined();

      await act(async () => {
        await reviewAction?.props.onPress?.();
        await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(3));
      });
      expect(writes).toBe(1);
      expect(
        screen
          .findAllByType(Switch)
          .find(
            (node) =>
              node.props.accessibilityLabel ===
              (nativeModel.name || nativeModel.id),
          )?.props.value,
      ).toBe(operation !== 'native visibility');
      expect(routerPush).not.toHaveBeenCalled();
    },
  );

  it('reviews an ambiguous model load on Agent Models without retaining load replay', async () => {
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    const { ProviderModelManager } =
      await import('@/providers/models/ProviderModelManager');
    mocks.projection.data = createProviderModelProjectionFixture({
      groups: [
        createProviderModelProjectionGroupFixture({
          modelLoadAction: 'available',
          rows: [
            {
              ref: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: 'pc_a',
                modelId: 'provider-model',
              },
              descriptor: { id: 'provider-model', name: 'Provider model' },
              sources: { manual: false, static: false, probe: true },
              confidence: 'probe',
              compatibility: {
                result: {
                  status: 'verified',
                  selectedProtocol: 'openai-chat',
                  evidence: {
                    sourceUrls: ['https://example.com'],
                    verifiedAt: '2026-07-14',
                  },
                },
                compatibilityFingerprint: 'compatibility:v1:agent-load-review',
                confirmed: true,
              },
              endpointHealth: 'available',
              catalog: { stale: false },
              loadState: 'unloaded',
              visibility: 'visible',
            },
          ],
        }),
      ],
    });
    providerHarness.intercept(
      RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
      async () => {
        throw new Error(
          'load acknowledgement lost while daemon work continues',
        );
      },
    );
    const screen = await renderScreen(
      <AgentModelsScreen
        agentTargetKey="agent:happier.agent.codex/codex"
        runtimeAgentId={null}
      />,
    );

    await act(async () => {
      screen
        .findByType(ProviderModelManager)
        .props.onLoadModel?.('pc_a', 'provider-model');
      await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(2));
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId(
            'provider-error:provider_rpc_mutation_outcome_unknown',
          ),
        ).not.toBeNull(),
      );
    });
    const reviewAction = screen.findByTestId(
      'provider-error-action:provider_rpc_mutation_outcome_unknown',
    );
    expect(reviewAction).not.toBeNull();
    expect(screen.getTextContent()).not.toContain('Retry');
    expect(screen.getTextContent()).not.toContain('Load model');
    expect(
      providerHarness.state.requests.filter(
        (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
      ),
    ).toHaveLength(1);

    await act(async () => {
      await reviewAction?.props.onPress?.();
      await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(3));
    });
    expect(
      providerHarness.state.requests.filter(
        (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
      ),
    ).toHaveLength(1);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('retries only projection refresh after an acknowledged settings mutation', async () => {
    const { AgentModelsScreen } = await import('./AgentModelsScreen');
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const nativeKey = serializeModelVisibilityRefV1({
      scope: 'agent',
      agentTargetKey,
      providerConnectionId: null,
      modelId: 'native-model',
    });
    let catalog = ProviderConnectionsCatalogV1Schema.parse({
      ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
      modelVisibilityByRef: { [nativeKey]: 'hidden' },
    });
    let revision = 2;
    let writes = 0;
    account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
      select: () => ({
        body: {
          status: 'present',
          revision,
          content: { t: 'plain', v: catalog },
        },
      }),
    });
    const { refreshProviderCatalog } =
      await import('@/sync/engine/settings/providerCatalogEngine');
    await refreshProviderCatalog({ serverId, accountId: 'account-a' });
    account.home.answer(
      serverId,
      `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`,
      {
        select: (input) => {
          const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
          expect(mutation.expectedRevision).toBe(revision);
          if (mutation.content?.t !== 'plain')
            throw new Error('Expected plain Account catalog');
          catalog = ProviderConnectionsCatalogV1Schema.parse(
            mutation.content.v,
          );
          revision += 1;
          writes += 1;
          return { body: { status: 'updated', revision, cursor: revision } };
        },
      },
    );
    mocks.projection.data = createProviderModelProjectionFixture({
      agentTargetKey: 'agent:happier.agent.codex/codex',
    });
    const screen = await renderScreen(
      <AgentModelsScreen
        agentTargetKey="agent:happier.agent.codex/codex"
        runtimeAgentId={null}
      />,
    );
    mocks.projection.error = createProviderErrorV1(
      'provider_endpoint_unavailable',
      {
        machineId: 'machine-a',
      },
    );

    await act(async () => {
      selectBulkAction(screen, 'reset');
      await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(2));
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId(
            'provider-error-action:provider_endpoint_unavailable',
          ),
        ).not.toBeNull(),
      );
    });
    expect(writes).toBe(1);
    expect(catalog.modelVisibilityByRef).toEqual({});
    expect(mocks.mutate).not.toHaveBeenCalled();
    const retryRefreshAction = screen.findByTestId(
      'provider-error-action:provider_endpoint_unavailable',
    );
    expect(retryRefreshAction).not.toBeNull();

    await act(async () => {
      await retryRefreshAction?.props.onPress?.();
      await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(3));
    });
    expect(writes).toBe(1);
  });
});
