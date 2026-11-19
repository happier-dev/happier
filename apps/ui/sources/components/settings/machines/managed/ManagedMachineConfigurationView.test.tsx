import {
  applyManagedMachinePresetUpdateFixture,
  createManagedCpuOptionsFixture,
  createMachineProvisionerEditorManifestFixture,
  createEnabledMachinePluginIntentReadFixture,
  createPlainManagedMachinePresetFixture,
  createMachineProvisionerOptionsFixture,
  createDelegatedManagedPresetFixture,
  createManagedControllerMachineFixture as createMachineFixture,
} from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import * as React from 'react';
import { ManagedMachinePresetContentV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
  type HomeDomainAnswer,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import {
  renderHook,
  renderScreen,
  createDeferred,
  standardCleanup,
  flushHookEffects,
  reportPopoverContentLayout,
  withPopoverWebGlobals,
} from '@/dev/testkit';
import { findAllHostTestInstances, findTestInstanceByTypeContainingText } from '@/dev/testkit/render/renderScreen';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ProvisionerOptionsInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { Dimensions, Text } from 'react-native';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { MachineProvisionerOptionsResultV1, MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { MachineProvisionerContributionV1Schema, MachineProvisionerOptionsResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { MachinePresetItemV1Schema, MachineSetupV1Schema, type MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachinePresetEditContinuation, MachinePresetEditDraft } from './machinePresetEditDraft';
import { type PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { defineProtocolObject, defineProtocolNumber, defineProtocolString, defineProtocolUnion, defineProtocolLiteral } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';

const route = vi.hoisted(() => ({
  replace: vi.fn(),
  dispatch: vi.fn(),
  getState: vi.fn(),
  params: {} as Record<string, string>,
}));
const nativeBoundary = vi.hoisted(() => ({ rpc: vi.fn() }));
// The renderer has no physical page position. Keep the real viewport tracker and
// Collection windowing, supplying only the native layout measurement boundary.
vi.mock('@/components/widgets/nearViewport', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/widgets/nearViewport')>();
  const { createMeasuredNearViewportModuleMock } = await import('@/dev/testkit/mocks/nearViewport');
  return createMeasuredNearViewportModuleMock(actual);
});
vi.mock('@legendapp/list/react-native', async () => {
  const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
  return createLegendListModuleMock({ renderItems: true });
});
// Execution-host discovery is a platform boundary; its result may still be pending.
const runtimeHost = vi.hoisted(() => ({ current: null as 'browser' | 'native' | Promise<'browser' | 'native'> | null }));
vi.mock('@/utils/system/runtimeFetch', async importActual => {
  const actual = await importActual<typeof import('@/utils/system/runtimeFetch')>();
  return { ...actual, readRuntimeFetchHost: (input: RequestInfo | URL) => runtimeHost.current
    ? Promise.resolve(runtimeHost.current) : actual.readRuntimeFetchHost(input) };
});
let restoreViewport: (() => void) | undefined;
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () => {
    const { createServerScopedMachineRpcBoundaryMock } =
      await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(nativeBoundary.rpc);
  },
);
installApprovalCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
  reactNative: async () => {
    const [{ createCapturingFlatListMock }, { createReactNativeWebMock, createMeasuredViewMock }] = await Promise.all([
      import('@/dev/testkit/mocks/virtualizedList'),
      import('@/dev/testkit/mocks/reactNative'),
    ]);
    // Size choices use the native list boundary; its cells must mount to exercise selection.
    return createReactNativeWebMock({
      ...createCapturingFlatListMock({ renderItems: true }).module,
      View: createMeasuredViewMock({ width: 960, height: 600 }, testID => testID.endsWith(':stage')),
    });
  },
  router: async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      router: route,
      navigation: route,
      params: () => route.params,
    }).module,
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

function readProvisionerRequest(value: unknown) {
    const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(value);
    return ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : value);
}

/** Scenario responses sit behind the real Home custody, authorization and requester-box boundary. */
async function answerProvisionerAction(serverId: string, path: string, answer: HomeDomainAnswer, raw = false) {
    const actionId = ActionIdSchema.parse(path.slice('/v1/actions/'.length));
    if (actionId !== 'machines.provisioners.check' && actionId !== 'machines.provisioners.options') {
        harness.answer(serverId, path, answer);
        return;
    }
    await answerExternalActionAccountForHome(harness, serverId, {
        actionId, machineId: 'host', installationId: 'installation', tokenEpoch: 0,
        execute: async (_input, context) => {
            const selected = await answer.select?.(context.envelope, {
                signal: context.signal, url: path,
                init: { method: 'POST', headers: context.requestHeaders, signal: context.signal },
            }) ?? answer;
            await selected.respondAfter;
            await selected.bodyAfter;
            const execution = ExternalActionResponseEnvelopeV1Schema.parse(selected.body).execution;
            return execution.ok ? execution.result : execution;
        },
        failure: value => {
            const failure = ActionExecuteFailureSchema.safeParse(value);
            return failure.success ? failure.data : null;
        },
    });
    // Negative transport/envelope fixtures must still reach the real HTTP reader unchanged.
    if (raw) harness.answer(serverId, `POST ${path}`, answer);
}

async function addPresetHome(input: Parameters<typeof harness.addHome>[0]) {
    const serverId = await harness.addHome(input);
    if (input.accountEncryptionMode !== 'e2ee') harness.answer(serverId, '/v1/machines/presets/recipient-census', {
        body: { kind: 'ready', contentEncryptionMode: 'plain', recipients: [] },
    });
    return serverId;
}

const { resetScopedHomeActionExecutorsForTests } =
  await import('@/sync/ops/actions/scopedHomeActionExecutor');
await import('@/sync/ops/actions/defaultActionExecutor');
const { clearDaemonMergedProjectionCacheForTests, readCachedDaemonMergedProjectionCacheEntry } =
  await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { resetMachineProjectionReadsForTests } =
  await import('@/sync/ops/machineContributionRegistryProjection');
const { PLUGIN_MANIFEST: modalManifest } =
  await import('../../../../../../../packages/plugins/machine-modal/src/manifest');
const { ModalLaunchV1Schema } =
  await import('../../../../../../../packages/plugins/machine-modal/src/machine/schemas');
const { CUA_PLUGIN } =
  await import('../../../../../../../packages/plugins/machine-cua/src/manifest');
const { createCuaNativeClient } =
  await import('../../../../../../../packages/plugins/machine-cua/src/machine/nativeClient');
const { createCuaNativeFacts } =
  await import('../../../../../../../packages/plugins/machine-cua/src/machine/nativeFacts');
const { CuaLocalOptionsQueryV1Schema } =
  await import('../../../../../../../packages/plugins/machine-cua/src/machine/schemas');
const { normalizePluginActionInputHintsV2, PluginActionContributionV2Schema } =
  await import('@happier-dev/protocol/plugins/actions/v2');
const { formatManagedSizeBytes } =
  await import('./managedConfigurationPresentation');
beforeEach(async () => {
  await harness.reset();
  resetScopedHomeActionExecutorsForTests();
  route.replace.mockReset();
  route.dispatch.mockReset();
  route.getState.mockReset();
  route.params = {};
  nativeBoundary.rpc.mockReset();
  const { storage } = await import('@/sync/domains/state/storage');
  storage.setState({ machines: {}, machineDisplayById: {}, machinePresenceById: {}, machinePresenceByServerId: {},
    machineListByServerId: {}, machineRecordsByServerId: {}, machineListStatusByServerId: {} });
  clearDaemonMergedProjectionCacheForTests();
  resetMachineProjectionReadsForTests();
  const action = PluginProjectedActionV2Schema.parse({
    id: 'options',
    pluginId: provisioner.contribution.pluginId,
    occurrenceId: provisioner.occurrenceId,
    title: 'Native options',
    scopes: ['machine'],
    surfaces: ['cli', 'plugin'],
    execution: { target: 'daemon' },
    available: true,
    dangerLevel: 'safe',
  });
  const projection =
    DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        agentsById: {},
        diagnostics: [],
        installedPackagesById: {
          [action.pluginId]: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById[
              'acme.review'
            ],
            id: action.pluginId,
          },
        },
        actionsById: {
          [buildQualifiedPluginContributionKey({
            pluginId: action.pluginId,
            localId: action.id,
          })]: action,
        },
      },
    });
  nativeBoundary.rpc.mockImplementation(async (request: { method: string }) =>
    request.method ===
    RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
      ? projection
      : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
        ? {
            ok: true,
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          }
        : { ok: false, code: 'unsupported' },
  );
});
afterEach(() => {
  standardCleanup();
  runtimeHost.current = null;
  restoreViewport?.();
  restoreViewport = undefined;
});
const defaultController = { machineId: 'host', installationId: 'installation' };
const provisioner: MachineProvisionersListResultV1['provisioners'][number] = {
  contribution: { pluginId: 'custom.compute', localId: 'vm' },
  occurrenceId: 'occurrence',
  credentialPurposes: [],
  acquireExecutionTarget: 'daemon' as const,
  descriptor: {
    id: 'vm',
    title: 'Virtual machine',
    icon: 'server',
    resourceKind: 'VM',
    schemaVersion: 1,
    launchSchema: defineProtocolObject({ cpu: defineProtocolNumber({ integer: true, minimum: 1 }) }, { policy: 'closed' }).jsonSchema,
    resourceSchema: defineProtocolObject({}, { policy: 'closed' }).jsonSchema,
    platforms: ['linux'],
    prerequisites: [],
    billing: { location: 'cloud', stoppedBilling: 'billed' },
    retention: { supportedIntents: ['start', 'stop', 'delete'] },
    actions: {
      check: 'check',
      options: 'options',
      acquire: 'acquire',
      bootstrap: 'bootstrap',
      inspect: 'inspect',
      power: 'power',
      destroy: 'destroy',
    },
  },
};

/** Preset editors read the Account declaration rather than a controller's native catalog. */
async function publishPresetEditorDeclaration(serverId: string, manifest: PluginPortableReleaseManifestV1) {
  const { installBundledPluginUiDeclarationsForTests } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
  onTestFinished(installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
    packageName: '@test/preset-editor', displayName: manifest.displayName, hasMachineProvisioners: true,
    entriesById: {}, normalizedManifest: manifest }]));
  const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
    await import('@/sync/domains/plugins/availability/projection');
  onTestFinished(clearPluginAccountAvailabilityProjection);
  replacePluginAccountAvailabilityProjection({ scope: {
    serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner',
  }, snapshot: { availabilityCursor: 1,
    intentReads: [{ pluginId: manifest.id, response: createEnabledMachinePluginIntentReadFixture(manifest) }], materializations: [], snapshots: [] } });
}

describe('mounted managed configurator', () => {
  it('projects the pool owner answer before Use without deciding availability again', async () => {
    const { isManagedPoolUnavailableAtReview } = await import('./ManagedMachineConfigurationView');
    expect(isManagedPoolUnavailableAtReview({ availability: { state: 'known', connectedCount: 0, enabledCount: 1 } }, true)).toBe(true);
    expect(isManagedPoolUnavailableAtReview({ availability: { state: 'known', connectedCount: 1, enabledCount: 1 } }, true)).toBe(false);
    expect(isManagedPoolUnavailableAtReview({ availability: { state: 'unknown' } }, true)).toBe(false);
    expect(isManagedPoolUnavailableAtReview({ availability: { state: 'known', connectedCount: 0, enabledCount: 1 } }, false)).toBe(false);
  });

  it('authors and saves Docker Sandboxes template and name without native discovery', async () => {
    const { DOCKER_SANDBOXES_PLUGIN } = await import('../../../../../../../packages/plugins/machine-docker-sandboxes/src/manifest');
    const { installBundledPluginUiDeclarationsForTests } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
    const manifest = PluginPortableReleaseManifestV1Schema.parse(DOCKER_SANDBOXES_PLUGIN.manifest);
    onTestFinished(installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
      packageName: '@happier-dev/plugins-machine-docker-sandboxes', displayName: manifest.displayName, hasMachineProvisioners: true,
      entriesById: {}, normalizedManifest: manifest }]));
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://docker-preset-author.example.test',
      serverIdentityId: 'srv_docker_preset_author', accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, []);
    const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
      await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' };
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1,
      intentReads: [{ pluginId: manifest.id, response: createEnabledMachinePluginIntentReadFixture(manifest) }], materializations: [], snapshots: [] } });
    const declarations = await readPluginAccountAvailability(scope).ensureCurrentAccountExecutionDeclarations({ family: 'machineProvisioners' });
    if (declarations.kind !== 'available') throw new Error('Expected the bundled Docker declaration');
    const { projectAccountManagedProvisioners } = await import('@happier-dev/cli-common/machines/managed/provisioners');
    const selected = projectAccountManagedProvisioners(declarations.declarations).find(row => row.contribution.localId === 'docker-sandboxes');
    if (!selected) throw new Error('Expected the real local Docker descriptor');
    const { ManagedMachinePresetCreateInputV1Schema, PresetMutationResultV1Schema } =
      await import('@happier-dev/protocol/machines/managed/managedMachinePresetV1');
    harness.answer(serverId, '/v1/machines/presets/create', { select: value => ({
      body: PresetMutationResultV1Schema.parse({ kind: 'saved', preset: {
        ...ManagedMachinePresetCreateInputV1Schema.parse(value), revision: 1,
      } }),
    }) });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(selected.contribution)} presetOnly />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:templateId'), screen.getTextContent()).not.toBeNull());
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
      await act(async () => screen.changeTextByTestId('managed-config.field:templateId', 'docker.io/example/template:1'));
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
      await act(async () => screen.changeTextByTestId('managed-config.field:name', 'team-sandbox'));
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
      await screen.pressByTestIdAsync('managed-config.create');
      await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(1));
      const saved = ManagedMachinePresetCreateInputV1Schema.parse(harness.requestsFor('/v1/machines/presets/create')[0]?.input);
      if (saved.content.t !== 'plain') throw new Error('Expected plain preset content');
      expect(ManagedMachinePresetContentV1Schema.parse(saved.content.v).launch).toMatchObject({ provider: selected.contribution,
        choices: { templateId: 'docker.io/example/template:1', name: 'team-sandbox' } });
      expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(0);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(0);
      expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
      expect(nativeBoundary.rpc).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
  });

  it.each(['launch', 'credential', 'metadata-only'] as const)('authors a complete Agent37 preset launch without executable or native discovery (%s)', async mode => {
    const { PLUGIN_MANIFEST } = await import('../../../../../../../packages/plugins/machine-agent37/src/manifest');
    const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://agent37-preset-author.example.test',
      serverIdentityId: 'srv_agent37_preset_author', accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, []);
    await publishPresetEditorDeclaration(serverId, manifest);
    const { ACCOUNT_ID } = await import('../../../../../../../packages/plugins/machine-agent37/src/account');
    const account = { service: { pluginId: manifest.id, localId: ACCOUNT_ID }, accountId: 'agent37-preset-account' };
    const { QualifiedConnectedAccountListResponseV4Schema } = await import('@happier-dev/protocol/connect/qualified-connected-account-projections');
    harness.answer(serverId, '/v4/connect/qualified/accounts', { body: QualifiedConnectedAccountListResponseV4Schema.parse({ service: account.service, accounts: [{
      ref: account, status: 'connected', authenticationModeId: 'token', configurationReady: true,
      configurationRevision: 'selected-config', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [],
    }] }) });
    const { ManagedMachinePresetCreateInputV1Schema, PresetMutationResultV1Schema } =
      await import('@happier-dev/protocol/machines/managed/managedMachinePresetV1');
    harness.answer(serverId, '/v1/machines/presets/create', { select: value => ({
      body: PresetMutationResultV1Schema.parse({ kind: 'saved', preset: {
        ...ManagedMachinePresetCreateInputV1Schema.parse(value), revision: 1,
      } }),
    }) });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: 'agent37' })} presetOnly
      {...(mode === 'credential' ? { initialOptionsSelectors: { kind: 'default', size: '2-4', region: 'us' } } : {})} />);
    try {
      if (mode === 'metadata-only') {
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.prepare.switch')).not.toBeNull());
        expect(screen.findByTestId('managed-config.connect:cloud-api')).toBeNull();
        expect(nativeBoundary.rpc).not.toHaveBeenCalled();
        return;
      }
      await waitForHomeGovernance(() => expect(harness.requests.filter(request =>
        new URL(request.path, request.serverUrl).pathname === '/v4/connect/qualified/accounts').length).toBeGreaterThan(0));
      const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
      const readPicker = () => screen.tree.findAllByType(ActionInputFields).find(node => node.props.fields.some(
        (field: { path: string }) => node.props.resolveFieldTestID?.(field) === 'managed-config.credential:cloud-api'));
      await waitForHomeGovernance(() => expect(readPicker(), screen.getTextContent()).toBeDefined());
      const picker = readPicker();
      if (!picker) throw new Error('Expected the existing Account selector');
      await act(async () => picker.props.onPatch({ '0': account }));
      if (mode === 'launch') {
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:kind'), screen.getTextContent()).not.toBeNull());
        for (const [path, value] of Object.entries({ kind: 'default', size: '2-4', region: 'us' })) {
          await act(async () => screen.changeTextByTestId(`managed-config.field:${path}`, JSON.stringify(value)));
        }
      }
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
      await screen.pressByTestIdAsync('managed-config.create');
      await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(1));
      const saved = ManagedMachinePresetCreateInputV1Schema.parse(harness.requestsFor('/v1/machines/presets/create')[0]?.input);
      if (saved.content.t !== 'plain') throw new Error('Expected plain preset content');
      expect(ManagedMachinePresetContentV1Schema.parse(saved.content.v).launch).toMatchObject({
        provider: { pluginId: manifest.id, localId: 'agent37' }, choices: { kind: 'default', size: '2-4', region: 'us' },
        credentials: [{ purpose: { consumer: { pluginId: manifest.id, localId: 'agent37' }, purpose: 'cloud-api' }, account }],
      });
      expect(harness.requestsFor('/v4/connect/qualified/credential')).toHaveLength(0);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(0);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(0);
      expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
      expect(nativeBoundary.rpc).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
  });

  it.each([undefined, 'isolation'] as const)('asks Who can use it and Running at once only where the preset is not one machine\'s own (presetFor=%s)', async presetFor => {
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { DEVCONTAINER_PLUGIN } = await import('../../../../../../../packages/plugins/devcontainer/src/manifest');
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { installBundledPluginUiDeclarationsForTests } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
    const manifest = PluginPortableReleaseManifestV1Schema.parse(DEVCONTAINER_PLUGIN.manifest);
    onTestFinished(installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
      packageName: '@happier-dev/plugins-devcontainer', displayName: 'Docker container Machines', hasMachineProvisioners: true,
      entriesById: {}, normalizedManifest: manifest }]));
    const homeId = `srv_devcontainer_audience_${presetFor ?? 'page'}`;
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: `https://devcontainer-audience-${presetFor ?? 'page'}.example.test`,
      serverIdentityId: homeId, accountId: 'owner', currentAccount: true, teamsEnabled: false, machinePoolsEnabled: false });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, []);
    const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
      await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' };
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1,
      intentReads: [{ pluginId: manifest.id, response: createEnabledMachinePluginIntentReadFixture(manifest) }], materializations: [], snapshots: [] } });
    const declarations = await readPluginAccountAvailability(scope).ensureCurrentAccountExecutionDeclarations({ family: 'machineProvisioners' });
    if (declarations.kind !== 'available') throw new Error('Expected the bundled provisioner declaration');
    const { projectAccountManagedProvisioners } = await import('@happier-dev/cli-common/machines/managed/provisioners');
    const selected = projectAccountManagedProvisioners(declarations.declarations).find(row => row.contribution.pluginId === manifest.id);
    if (!selected) throw new Error('Expected the real Devcontainer descriptor');
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
        execution: { ok: true, result: { provisioners: [selected] } } } };
    } });
    // The add-sandbox sheet hosts this form: it takes the published footer as its own (lab add frame).
    const sheetFooter = vi.fn<(footer: React.ReactNode | null) => void>();
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(selected.contribution)} presetOnly
      {...(presetFor ? { presetFor, sheetFooter } : {})} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:configuration.image'), screen.getTextContent()).not.toBeNull());
      const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
      const audience = screen.tree.findAllByType(DropdownMenu).find(node => node.props.itemTrigger?.itemProps?.testID === 'managed-config.audience');
      // The add-sandbox sheet makes this machine's own preset (lab decision 3); Machines' New preset asks who can use it.
      if (presetFor === 'isolation') expect(audience).toBeUndefined();
      else expect(audience).toBeDefined();
      // Nor how many run at once: one machine's own sandbox preset leaves that to its Isolation, as its preset page does.
      if (presetFor === 'isolation') expect(screen.findByTestId('managed-config.limit')).toBeNull();
      else expect(screen.findByTestId('managed-config.limit')).not.toBeNull();
      if (presetFor === 'isolation') {
        // In a sheet the form is one column, and its Save is the sheet's footer rather than an aside card's.
        expect(screen.findByTestId('managed-config.receipt-aside')).toBeNull();
        const footer = sheetFooter.mock.calls.at(-1)?.[0];
        expect(footer).toBeTruthy();
        const footerScreen = await renderScreen(<>{footer}</>);
        try { expect(footerScreen.findByTestId('managed-config.create')).not.toBeNull(); }
        finally { await footerScreen.unmount(); }
        expect(screen.findByTestId('managed-config.create')).toBeNull();
      }
    } finally { await screen.unmount(); }
  });

  it.each(['account', 'team', 'saved-account'] as const)('authors and saves a Devcontainer preset without a controller, native tools, or an effect digest (%s)', async ownerKind => {
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { DEVCONTAINER_PLUGIN } = await import('../../../../../../../packages/plugins/devcontainer/src/manifest');
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { installBundledPluginUiDeclarationsForTests } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
    const manifest = PluginPortableReleaseManifestV1Schema.parse(DEVCONTAINER_PLUGIN.manifest);
    onTestFinished(installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
      packageName: '@happier-dev/plugins-devcontainer', displayName: 'Docker container Machines', hasMachineProvisioners: true,
      entriesById: {}, normalizedManifest: manifest }]));
    const homeId = `srv_devcontainer_author_${ownerKind}`;
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: `https://devcontainer-author-${ownerKind}.example.test`,
      serverIdentityId: homeId, accountId: 'owner', currentAccount: true,
      teamsEnabled: ownerKind === 'team', machinePoolsEnabled: ownerKind === 'team' });
    const poolId = '1a1bf092-44af-49c1-9af3-90d8c6b0f102';
    if (ownerKind === 'team') {
      const { teamSummaryFixture, teamCapabilitiesFixture } = await import('@/dev/testkit/fixtures/teamFixtures');
      const { TeamsPageV1Schema, TeamSummaryV1Schema } = await import('@happier-dev/protocol/teams');
      const team = TeamSummaryV1Schema.parse(teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: true }) }));
      harness.answer(serverId, '/v1/teams/list', { body: TeamsPageV1Schema.parse({ items: [team], nextCursor: null }) });
      harness.answer(serverId, '/v1/teams/get', { body: team });
      const { machinePoolActionEndpointPathV1 } = await import('@happier-dev/protocol/machines/pools/actionsV1');
      const { MachinePoolListOutputV1Schema } = await import('@happier-dev/protocol/machines/pools/v1');
      harness.answer(serverId, machinePoolActionEndpointPathV1('machines.pools.list'), { body: MachinePoolListOutputV1Schema.parse({ pools: [{
        pool: { id: poolId, name: { kind: 'available', label: { content: { t: 'plain', v: 'Build computers' }, recipientEnvelope: null } }, description: null, revision: 1, createdAt: 1, updatedAt: 1,
          audience: { kind: 'team', teamId: team.id }, members: [] }, availability: { state: 'unknown' },
        access: { canManage: true, canResolve: true, canViewMembers: true },
      }] }) });
    }
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, []);
    const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
      await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' };
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1,
      intentReads: [{ pluginId: manifest.id, response: createEnabledMachinePluginIntentReadFixture(manifest) }], materializations: [], snapshots: [] } });
    const declarations = await readPluginAccountAvailability(scope).ensureCurrentAccountExecutionDeclarations({ family: 'machineProvisioners' });
    if (declarations.kind !== 'available') throw new Error('Expected the bundled provisioner declaration');
    const { projectAccountManagedProvisioners } = await import('@happier-dev/cli-common/machines/managed/provisioners');
    const selected = projectAccountManagedProvisioners(declarations.declarations).find(row => row.contribution.pluginId === manifest.id);
    if (!selected) throw new Error('Expected the real Devcontainer descriptor');
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
        execution: { ok: true, result: { provisioners: [selected] } } } };
    } });
    const { ManagedMachinePresetCreateInputV1Schema, ManagedMachinePresetUpdateInputV1Schema, ManagedMachinePresetV1Schema,
      PresetMutationResultV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetV1');
    let retained: ReturnType<typeof createPlainManagedMachinePresetFixture> | undefined;
    if (ownerKind === 'saved-account') {
      const { readDevcontainerEffectReview } = await import('../../../../../../../packages/plugins/devcontainer/src/machine/effectReview');
      // The earlier save path stored the native review's launch, including its real derived digest.
      // Only image inspection is a process boundary; no controller or installed native tool is used by the editor.
      const reviewed = await readDevcontainerEffectReview({ docker: { kind: 'managedDependency', id: { pluginId: manifest.id, localId: 'docker' } },
        signal: new AbortController().signal, environment: {}, exec: { run: async () => ({
          termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } },
          stdout: new TextEncoder().encode(JSON.stringify([{ Id: 'sha256:captured-image', Config: {} }])),
          stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
        }) } }, { runtime: 'docker', configuration: { kind: 'image', image: 'ubuntu:22.04' } });
      retained = createPlainManagedMachinePresetFixture({ id: 'existing-container', homeId, revision: 3,
        name: 'Development container', owner: { kind: 'account', accountId: 'owner' },
        launch: { provider: selected.contribution, schemaVersion: selected.descriptor.schemaVersion, name: 'Development container',
          choices: { ...reviewed.launch, reviewedEffectDigest: reviewed.effectReview.reviewedEffectDigest } } });
      harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: retained } });
    }
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(selected.contribution)} presetId={retained?.id} presetOnly />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:configuration.image'), screen.getTextContent()).not.toBeNull());
      if (!retained) expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
      await act(async () => screen.changeTextByTestId('managed-config.field:configuration.image', 'ubuntu:24.04'));
      if (screen.findByTestId('managed-config.advanced')) await screen.pressByTestIdAsync('managed-config.advanced');
      await act(async () => screen.changeTextByTestId('managed-config.field:configuration.setupScript', 'apt-get update'));
      await act(async () => screen.changeTextByTestId('managed-config.field:workspaceFolder', '/home/owner/projects/website'));
      await act(async () => screen.changeTextByTestId('managed-config.setup.setup.input', 'echo ready'));
      if (ownerKind === 'team') {
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const menu = (testID: string) => screen.tree.findAllByType(DropdownMenu).find(node => node.props.itemTrigger?.itemProps?.testID === testID);
        await waitForHomeGovernance(() => expect(menu('managed-config.audience')?.props.items,
          JSON.stringify(harness.requests.filter(request => request.path.includes('teams') || request.path.includes('features')).map(request => ({ path: request.path, input: request.input }))))
          .toContainEqual(expect.objectContaining({ id: 'team-1' })));
        await act(async () => menu('managed-config.audience')?.props.onSelect('team-1'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.controller-target:pool')?.props.disabled).toBe(false));
        // A Team preset needs an authored target; authoring never resolves the empty pool to a controller.
        expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('managed-config.controller-target:pool');
        await waitForHomeGovernance(() => expect(menu('managed-config.controller-pool')?.props.items).toContainEqual(expect.objectContaining({ id: poolId })));
        await act(async () => menu('managed-config.controller-pool')?.props.onSelect(poolId));
      }
      const choices = { runtime: 'docker', workspaceFolder: '/home/owner/projects/website',
        configuration: { kind: 'image', image: 'ubuntu:24.04', setupScript: 'apt-get update' } };
      const setup = MachineSetupV1Schema.parse({ scripts: [{ body: 'echo ready' }] });
      const savePath = retained ? '/v1/machines/presets/update' : '/v1/machines/presets/create';
      harness.answer(serverId, savePath, { select: value => ({
        body: PresetMutationResultV1Schema.parse({ kind: 'saved', preset: {
          ...(retained ? applyManagedMachinePresetUpdateFixture(retained, ManagedMachinePresetUpdateInputV1Schema.parse(value))
            : ManagedMachinePresetCreateInputV1Schema.parse(value)), revision: retained ? retained.revision + 1 : 1,
        } }),
      }) });
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
      expect(screen.findByTestId('managed-config.field:reviewedEffectDigest')).toBeNull();
      expect(harness.requestsFor(savePath)).toHaveLength(0);
      await screen.pressByTestIdAsync('managed-config.create');
      await waitForHomeGovernance(() => expect(harness.requestsFor(savePath)).toHaveLength(1));
      await waitForHomeGovernance(() => expect(route.replace).toHaveBeenCalled());
      const request = harness.requestsFor(savePath)[0]?.input;
      const saved = retained ? ManagedMachinePresetUpdateInputV1Schema.parse(request).patch : ManagedMachinePresetCreateInputV1Schema.parse(request);
      if (!retained) expect(saved).toHaveProperty('owner', ownerKind === 'team' ? { kind: 'team', teamId: 'team-1' } : { kind: 'account', accountId: 'owner' });
      if (saved.content?.t !== 'plain') throw new Error('Plain saved preset content expected');
      const content = ManagedMachinePresetContentV1Schema.parse(saved.content.v);
      expect(content).toMatchObject({ setup,
        launch: { provider: selected.contribution, schemaVersion: selected.descriptor.schemaVersion, choices } });
      if (retained) expect(saved).toHaveProperty('controller', null);
      else expect(saved).not.toHaveProperty('controller');
      expect(content.launch?.choices).toEqual(choices);
      if (ownerKind === 'team') expect(saved).toHaveProperty('controllerPoolId', poolId);
      else if (!retained) expect(saved).not.toHaveProperty('controllerPoolId');
      expect(content).not.toHaveProperty('launch.choices.reviewedEffectDigest');
      expect(saved).not.toHaveProperty('effectReview');
      expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(0);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(0);
      expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
      const { machinePoolActionEndpointPathV1 } = await import('@happier-dev/protocol/machines/pools/actionsV1');
      expect(harness.requestsFor(machinePoolActionEndpointPathV1('machines.pools.resolve'))).toHaveLength(0);
      expect(nativeBoundary.rpc).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
  });

  it('saves and reads back exact Lima #131 fields from the Machines new-preset editor without a mounts edit', async () => {
    const { LIMA_PLUGIN } = await import('../../../../../../../packages/plugins/machine-lima/src/manifest');
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { installBundledPluginUiDeclarationsForTests } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
    const manifest = PluginPortableReleaseManifestV1Schema.parse(LIMA_PLUGIN.manifest);
    onTestFinished(installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
      packageName: '@happier-dev/plugins-machine-lima', displayName: 'Lima Machines', hasMachineProvisioners: true,
      entriesById: {}, normalizedManifest: manifest }]));
    const serverId = await addPresetHome({ name: 'Lima preset', serverUrl: 'https://lima-replay131.example.test',
      serverIdentityId: 'srv_lima_replay131', accountId: 'owner', currentAccount: true, accountEncryptionMode: 'plain' });
    const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
      await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' };
    replacePluginAccountAvailabilityProjection({ scope,
      snapshot: { availabilityCursor: 1, intentReads: [{ pluginId: manifest.id, response: createEnabledMachinePluginIntentReadFixture(manifest) }], materializations: [], snapshots: [] } });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({
      id: defaultController.machineId, installationId: defaultController.installationId,
    })]);
    const declarations = await readPluginAccountAvailability(scope)
      .ensureCurrentAccountExecutionDeclarations({ family: 'machineProvisioners' });
    if (declarations.kind !== 'available') throw new Error('Expected Lima provisioner declaration');
    const { projectAccountManagedProvisioners } = await import('@happier-dev/cli-common/machines/managed/provisioners');
    const selected = projectAccountManagedProvisioners(declarations.declarations)
      .find(row => row.contribution.pluginId === manifest.id);
    if (!selected) throw new Error('Expected real Lima provisioner');
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
        execution: { ok: true, result: { provisioners: [selected] } } } };
    } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
    const { ManagedMachinePresetCreateInputV1Schema, ManagedMachinePresetRecipientCensusInputV1Schema,
      ManagedMachinePresetRecipientCensusResultV1Schema, ManagedMachinePresetV1Schema, PresetMutationResultV1Schema } =
      await import('@happier-dev/protocol/machines/managed/managedMachinePresetV1');
    const persistedHolder: { preset: ReturnType<typeof ManagedMachinePresetV1Schema.parse> | null } = { preset: null };
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(selected.contribution)} presetOnly initialController={defaultController} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:store'), screen.getTextContent()).not.toBeNull());
      for (const [field, value] of Object.entries({ store: '/home/happier/.lima', image: 'https://images.example.test/lima.qcow2',
        cpus: '4', memoryGiB: '4', diskGiB: '100' })) {
        await act(async () => screen.changeTextByTestId(`managed-config.field:${field}`, value));
      }
      const form = screen.tree.findAllByType(ActionInputFields)[0]!;
      await act(async () => form.props.onPatch({ arch: 'x86_64', vmType: 'qemu' }));
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled, screen.getTextContent()).toBe(false));
      expect(form.props.input.mounts).toEqual([]);
      harness.answer(serverId, '/v1/machines/presets/recipient-census', { select: value => {
        ManagedMachinePresetRecipientCensusInputV1Schema.parse(value);
        return { body: ManagedMachinePresetRecipientCensusResultV1Schema.parse({
          kind: 'ready', contentEncryptionMode: 'plain', recipients: [],
        }) };
      } });
      harness.answer(serverId, '/v1/machines/presets/create', { select: value => {
        const input = ManagedMachinePresetCreateInputV1Schema.parse(value);
        const persisted = ManagedMachinePresetV1Schema.parse({ ...input, revision: 1 });
        persistedHolder.preset = persisted;
        return { body: PresetMutationResultV1Schema.parse({ kind: 'saved', preset: persisted }) };
      } });
      await screen.pressByTestIdAsync('managed-config.create');
      await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/recipient-census')).toHaveLength(1));
      await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(1));
      const request = ManagedMachinePresetCreateInputV1Schema.parse(harness.requestsFor('/v1/machines/presets/create')[0]?.input);
      expect(request).toMatchObject({ controller: defaultController, contentEncryptionMode: 'plain', recipients: [],
        content: { t: 'plain', v: { launch: { provider: selected.contribution,
          choices: { store: '/home/happier/.lima', image: 'https://images.example.test/lima.qcow2',
            arch: 'x86_64', vmType: 'qemu', cpus: 4, memoryGiB: 4, diskGiB: 100, mounts: [] } } } } });
      expect(request).not.toHaveProperty('launch');
      expect(request).not.toHaveProperty('setup');
      await waitForHomeGovernance(() => expect(route.replace).toHaveBeenCalled());
    } finally { await screen.unmount(); }
    const saved = persistedHolder.preset;
    if (!saved) throw new Error('Expected persisted Lima preset');
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
    const { createMachinePresetCollectionClient } = await import('@/sync/ops/machines/machinePresetCollectionClient');
    const readBack = await createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_lima_replay131')
      .read('machines.presets.get', { homeId: 'srv_lima_replay131', id: saved.id });
    if (readBack.kind !== 'succeeded' || readBack.value.kind !== 'found') throw new Error('Expected persisted Lima preset readback');
    expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(1);
    expect(readBack.value.preset).toMatchObject({ controller: defaultController, launch: { choices: {
      store: '/home/happier/.lima', image: 'https://images.example.test/lima.qcow2', arch: 'x86_64', vmType: 'qemu',
      cpus: 4, memoryGiB: 4, diskGiB: 100, mounts: [],
    } } });
    expect(harness.requests.filter(request => /machines\.provisioners\.(check|options)|machines\.managed\.acquire/.test(request.path))).toHaveLength(0);
  });

  it('keeps offline Pool recovery and gives manual Devcontainer choices a controller recovery', async () => {
    const { DEVCONTAINER_PLUGIN } = await import('../../../../../../../packages/plugins/devcontainer/src/manifest');
    const { installBundledPluginUiDeclarationsForTests } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
    const manifest = PluginPortableReleaseManifestV1Schema.parse(DEVCONTAINER_PLUGIN.manifest);
    onTestFinished(installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
      packageName: '@happier-dev/plugins-devcontainer', displayName: manifest.displayName, hasMachineProvisioners: true,
      entriesById: {}, normalizedManifest: manifest }]));
    const homeId = 'srv_docker_offline_pool';
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://docker-offline-pool.example.test',
      serverIdentityId: homeId, accountId: 'owner', currentAccount: true, machinePoolsEnabled: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, []);
    const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
      await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' };
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1,
      intentReads: [{ pluginId: manifest.id, response: createEnabledMachinePluginIntentReadFixture(manifest) }],
      materializations: [], snapshots: [] } });
    const declarations = await readPluginAccountAvailability(scope).ensureCurrentAccountExecutionDeclarations({ family: 'machineProvisioners' });
    if (declarations.kind !== 'available') throw new Error('Expected the Docker declaration');
    const { projectAccountManagedProvisioners } = await import('@happier-dev/cli-common/machines/managed/provisioners');
    const selected = projectAccountManagedProvisioners(declarations.declarations).find(row => row.contribution.pluginId === manifest.id);
    if (!selected) throw new Error('Expected the Docker provisioner');
    const choices = { runtime: 'docker', workspaceFolder: '/home/owner/projects/website',
      configuration: { kind: 'image', image: 'ubuntu:24.04' } };
    const poolId = '6be84651-2df7-4125-aac4-0d093217b198';
    const saved = createPlainManagedMachinePresetFixture({ id: 'docker-offline-pool', homeId, revision: 0,
      name: 'Docker container', owner: { kind: 'account', accountId: 'owner' }, controllerPoolId: poolId,
      launch: { provider: selected.contribution, schemaVersion: selected.descriptor.schemaVersion, name: 'Docker container', choices } });
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
    harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [saved] } });
    const { MachinePoolListOutputV1Schema } = await import('@happier-dev/protocol/machines/pools/v1');
    harness.answer(serverId, '/v1/machines/pools/list', { body: MachinePoolListOutputV1Schema.parse({ pools: [{
      pool: { id: poolId, name: { kind: 'available', label: { content: { t: 'plain', v: 'Docker pool' }, recipientEnvelope: null } },
        description: null, revision: 0, createdAt: 1, updatedAt: 1, audience: { kind: 'private' }, members: [] },
      availability: { state: 'known', connectedCount: 0, enabledCount: 1 },
      access: { canManage: true, canResolve: true, canViewMembers: true },
    }] }) });
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
        execution: { ok: true, result: { provisioners: [selected] } } } };
    } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { t } = await import('@/text');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(selected.contribution)} presetId={saved.id} />);
    try {
      await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('machinePresets.poolNoMachine')));
      await flushHookEffects();
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
      expect(screen.findByTestId('managed-config.form-unavailable')).toBeNull();
      expect(screen.findByTestId('managed-config.form-unavailable:action')).toBeNull();
      expect(screen.findByTestId('managed-config.error')).toBeNull();
      expect(screen.findByTestId('managed-config.retained-choice')).toBeNull();
      expect(screen.findByTestId('managed-config.field:configuration.image')).toBeNull();

      await screen.pressByTestIdAsync('managed-config.start-from:hand');
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.error')).not.toBeNull());
      expect(screen.getTextContent()).toContain(t('managedMachines.controller.requiredUnnamed'));
      expect(screen.findByTestId('managed-config.field:configuration.image')).toBeNull();
      await screen.pressByTestIdAsync('managed-config.error-action');
      await flushHookEffects();
      expect(screen.getTextContent()).toContain(t('managedMachines.controller.requiredUnnamed'));
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(0);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(0);
    } finally { await screen.unmount(); }
  });

  it.each(([
    { availability: { state: 'known', connectedCount: 0, enabledCount: 1 }, disabled: true },
    { availability: { state: 'known', connectedCount: 1, enabledCount: 1 }, disabled: false },
    { availability: { state: 'unknown' }, disabled: false },
    { availability: null, disabled: false },
  ] as const).flatMap(testCase => (['use', 'create'] as const).map(surface => ({ ...testCase, surface }))))(
    'projects shared availability into delegated pool $surface review ($availability.state, $disabled)', async ({ availability, disabled, surface }) => {
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://delegated-pool.example.test',
      serverIdentityId: 'srv_delegated_pool', accountId: 'owner', currentAccount: true, teamsEnabled: true, machinePoolsEnabled: true });
    const poolId = '6be84651-2df7-4125-aac4-0d093217b198';
    const saved = createPlainManagedMachinePresetFixture({ id: 'delegated-pool', homeId: 'srv_delegated_pool', revision: 0,
      name: 'Shared machine', owner: { kind: 'team', teamId: 'team-1' }, controllerPoolId: poolId,
      launch: { provider: provisioner.contribution, schemaVersion: 1, name: 'Shared machine', choices: { cpu: 2 } }, teamAcquireDelegated: true });
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createDelegatedManagedPresetFixture({
      preset: { ...saved.opened, launch: { provider: provisioner.contribution, schemaVersion: 1, name: 'Shared machine', choices: { cpu: 2 } } },
      descriptor: provisioner.descriptor, installationPublicKey: encodeBase64(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey, 'base64url'), custodianAccountId: 'custodian' }) } });
    const { MachinePoolListOutputV1Schema } = await import('@happier-dev/protocol/machines/pools/v1');
    harness.answer(serverId, '/v1/machines/pools/list', availability === null ? { status: 503, body: { error: 'unavailable' } } : { body: MachinePoolListOutputV1Schema.parse({ pools: [{ pool: { id: poolId,
      name: { kind: 'available', label: { content: { t: 'plain', v: 'Shared pool' }, recipientEnvelope: null } }, description: null,
      revision: 0, createdAt: 1, updatedAt: 1, audience: { kind: 'team', teamId: 'team-1' }, members: [] },
      availability, access: { canManage: false, canResolve: false, canViewMembers: false } }] }) });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { t } = await import('@/text');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} presetId={saved.id}
      {...(surface === 'use' ? { onUse: vi.fn() } : {})} />);
    const primaryTestId = surface === 'use' ? 'managed-config.use' : 'managed-config.create';
    try {
      if (availability === null) {
        const { storage } = await import('@/sync/domains/state/storage');
        const scopeServerId = resolveServerProfileScopeIdForIdentifier(serverId) ?? serverId;
        await waitForHomeGovernance(() => expect(storage.getState().machinePoolListStatusByServerId[scopeServerId]).toBe('error'));
      }
      await waitForHomeGovernance(() => expect(screen.findByTestId(primaryTestId)?.props.disabled).toBe(disabled));
      // Nothing is left to choose: the receipt is the page body, never an aside beside an empty column (TH MB-4).
      expect(screen.findByTestId('managed-config.receipt')).not.toBeNull();
      expect(screen.findByTestId('managed-config.receipt-aside')).toBeNull();
      if (disabled) expect(screen.getTextContent()).toContain(t('machinePresets.poolNoMachine'));
      else expect(screen.getTextContent()).not.toContain(t('machinePresets.poolNoMachine'));
    } finally { await screen.unmount(); }
  });

  it.each(['cold', 'ready-to-unavailable'] as const)('settles an unavailable delegated review without showing choices loading (%s)', async entry => {
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://delegated-refusal.example.test',
      serverIdentityId: 'srv_delegated_refusal', accountId: 'owner', currentAccount: true, teamsEnabled: true });
    const { teamSummaryFixture, teamCapabilitiesFixture } = await import('@/dev/testkit/fixtures/teamFixtures');
    const { TeamSummaryV1Schema } = await import('@happier-dev/protocol/teams');
    harness.answer(serverId, '/v1/teams/get', { body: TeamSummaryV1Schema.parse(teamSummaryFixture({ id: 'team-1', viewerRole: 'member', capabilities: teamCapabilitiesFixture({}) })) });
    const { ManagedMachinePresetGetResultV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetV1');
    const saved = createPlainManagedMachinePresetFixture({ id: 'delegated-refusal', homeId: 'srv_delegated_refusal', revision: 0,
      name: 'Shared machine', owner: { kind: 'team', teamId: 'team-1' }, controller: defaultController,
      launch: { provider: provisioner.contribution, schemaVersion: 1, name: 'Shared machine', choices: { cpu: 2 } },
      teamAcquireDelegated: true });
    let current = ManagedMachinePresetGetResultV1Schema.parse({ kind: 'found', preset: createDelegatedManagedPresetFixture({ preset: { ...saved.opened, launch: { provider: provisioner.contribution, schemaVersion: 1, name: 'Shared machine', choices: { cpu: 2 } } }, descriptor: provisioner.descriptor,
      installationPublicKey: encodeBase64(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey, 'base64url'), custodianAccountId: 'custodian' }) });
    const unavailable = ManagedMachinePresetGetResultV1Schema.parse({ kind: 'refused', code: 'provider_unavailable' });
    if (entry === 'cold') current = unavailable;
    harness.answer(serverId, '/v1/machines/presets/get', { select: () => ({ body: current }) });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const { t } = await import('@/text');
    const onCancel = vi.fn();
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} presetId={saved.id} onCancel={onCancel} />);
    try {
      if (entry === 'ready-to-unavailable') {
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create'), screen.getTextContent()).not.toBeNull());
        current = unavailable;
        await act(async () => publishHomeAccountChange(serverId, undefined, { source: 'socket', machineResourcesAffect: true }));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.error')).not.toBeNull());
        expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
      } else {
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-config.catalog'
          && node.props.diagnosticCode === 'provider_unavailable')).not.toHaveLength(0));
        expect(screen.findByTestId('managed-config.create')).toBeNull();
        const { PageHeader } = await import('@/components/ui/layout/PageHeader');
        const cancel = screen.tree.findByType(PageHeader).props.cancelAction;
        // The header draws Cancel from its `title`; without it the button renders with no words.
        expect(cancel?.title).toBe(t('common.cancel'));
        expect(cancel?.disabled).toBe(false);
        await act(async () => cancel.onPress());
        expect(onCancel).toHaveBeenCalledOnce();
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
      }
      expect(screen.getTextContent()).not.toContain(t('managedMachines.options.loading', { provider: 'Virtual machine' }));
      expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(0);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(0);
    } finally { await screen.unmount(); }
  });
  it.each([false, true])('requires saved recipe inputs before creation or composer use (composer: %s)', async composer => {
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: `https://recipe-inputs-${composer}.example.test`,
      serverIdentityId: 'srv_recipe_inputs', accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: defaultController.machineId,
      installationId: defaultController.installationId })]);
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
    const { MachineRecipeV1Schema } = await import('@happier-dev/protocol/machines/setup/machineRecipeV1');
    const ref = { pluginId: 'example.setup', recipeId: 'journal', revision: '1' };
    const recipe = { id: 'example.setup/journal', pluginId: ref.pluginId, pluginVersion: '1', definition: MachineRecipeV1Schema.parse({
      id: ref.recipeId, revision: ref.revision, title: 'Journal', inputSchema: { type: 'object',
        properties: { maximumUse: { type: 'string', minLength: 1 } }, required: ['maximumUse'], additionalProperties: false },
      inputHints: { fields: [{ path: 'maximumUse', title: 'Maximum disk use', widget: 'text', required: true }] }, steps: [],
    }) };
    onTestFinished(publishCommittedAppShellPluginUiProjection(() => ({ ...EMPTY_PLUGIN_UI_PROJECTION,
      machineRecipesById: { [recipe.id]: recipe } })));
    const saved = { id: 'needs-inputs', homeId: 'srv_recipe_inputs', revision: 1, name: 'Saved machine',
      owner: { kind: 'account', accountId: 'owner' }, controller: defaultController,
      launch: { provider: provisioner.contribution, schemaVersion: 1, name: 'Saved machine', choices: { cpu: 2 } },
      setup: { items: [{ kind: 'setupRecipe', selection: { ref, inputs: {} } }] } } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(saved) } });
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
      ['machines.provisioners.check', { available: true }],
      ['machines.provisioners.options', createManagedCpuOptionsFixture([{ id: 'small', title: 'Small', cpu: 2 }])],
    ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
    } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const onUse = vi.fn();
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} presetId={saved.id}
      initialController={defaultController} {...(composer ? { onUse } : {})} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.recipe-inputs')).not.toBeNull());
      expect(screen.findByTestId(composer ? 'managed-config.use' : 'managed-config.create')?.props.disabled).toBe(true);
      expect(onUse).not.toHaveBeenCalled();
      expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
    } finally { await screen.unmount(); }
  });
  it.each(['credential_unavailable', 'unavailable'])('presents the options failure %s in the shared form summary', async (code) => {
    const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://options-summary.example.test',
      serverIdentityId: 'srv_options_summary', accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({
      id: defaultController.machineId, installationId: defaultController.installationId,
    })]);
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
      ['machines.provisioners.check', { available: true }],
    ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
    } });
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId,
        execution: { ok: false, errorCode: code, error: code } } };
    } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { t } = await import('@/text');
    const { resolveActionExecutionFailureMessage } = await import('@/sync/ops/actions/resolveActionExecutionFailureMessage');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.error')).not.toBeNull());
      const expected = code === 'credential_unavailable'
        ? resolveActionExecutionFailureMessage({ ok: false, errorCode: code }, t('managedMachines.options.unavailable'))
        : t('managedMachines.options.unavailable');
      expect(screen.findByTestId('managed-config.summary')?.props).toBeDefined();
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.summary')?.props.accessibilityLabel).toContain(expected));
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
    } finally { await screen.unmount(); }
  });
  it.each([false, true])('keeps a thrown provider sign-in repair through the CLI error, configuration read and summary (remediation=%s)', async (withRemediation) => {
    const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const { PluginError } = await import('@happier-dev/plugin-sdk/errors');
    const { readPluginActionError } = await import('@happier-dev/protocol/plugins/actions/invocation');
    const { ManagedMachineControllerError } = await import('@happier-dev/cli-common/machines/managed');
    const { executeManagedProvisionerDiscovery } = await import('@happier-dev/cli-common/machines/managed/provisioners');
    const { normalizeActionExecutorThrownError } = await import('@happier-dev/protocol/actions/executor/resultProjection');
    const { ManagedMachineActionInputSchemasV1 } = await import('@happier-dev/protocol/machines/managed/actionsV1');
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://authored-options.example.test',
      serverIdentityId: 'srv_authored_options', accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({
      id: defaultController.machineId, installationId: defaultController.installationId,
    })]);
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
      ['machines.provisioners.check', { available: true }],
    ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
    } });
    // The HTTP boundary runs the shared CLI discovery/error owners; the provider handler is a real thrown SDK error.
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.options', { select: async value => {
      const request = readProvisionerRequest(value);
      try {
        await executeManagedProvisionerDiscovery({ actionId: 'machines.provisioners.options',
          value: ManagedMachineActionInputSchemasV1['machines.provisioners.options'].parse(request.input), entries: [provisioner],
          invoke: async () => {
            try {
              throw new PluginError({ code: 'credential_unavailable', message: '  Sign in to Docker: run sbx login  ',
                ...(withRemediation ? { remediation: { kind: 'retry' } as const } : {}),
                details: { privateNativeOutput: 'PRIVATE_PROVIDER_OUTPUT' } });
            } catch (error) {
              const failure = readPluginActionError(error);
              if (!failure) throw error;
              throw ManagedMachineControllerError.fromActionFailure({ ok: false, errorCode: failure.code,
                error: failure.message, details: failure.data }, 'machines.provisioners.options');
            }
          } });
        throw new Error('Expected provider options refusal');
      } catch (error) {
        return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId,
          execution: { ok: false, ...normalizeActionExecutorThrownError(error, 'machines.provisioners.options') } } };
      }
    } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { t } = await import('@/text');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.error')).not.toBeNull());
      expect(screen.findByTestId('managed-config.summary')?.props.accessibilityLabel)
        .toContain(`Sign in to Docker: run sbx login${withRemediation ? ` ${t('errors.tryAgain')}` : ''}`);
      expect(screen.getTextContent()).not.toContain('PRIVATE_PROVIDER_OUTPUT');
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
      expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
    } finally { await screen.unmount(); }
  });
  it('offers the refused options repair only on the controller that produced it', async () => {
    const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const { PluginError } = await import('@happier-dev/plugin-sdk/errors');
    const { readPluginActionError } = await import('@happier-dev/protocol/plugins/actions/invocation');
    const { ManagedMachineControllerError } = await import('@happier-dev/cli-common/machines/managed');
    const { normalizeActionExecutorThrownError } = await import('@happier-dev/protocol/actions/executor/resultProjection');
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://options-repair.example.test',
      serverIdentityId: 'srv_options_repair', accountId: 'owner', currentAccount: true });
    const other = { machineId: 'other', installationId: 'other-installation' };
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [defaultController, other].map(controller =>
      createMachineFixture({ id: controller.machineId, installationId: controller.installationId })));
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
      ['machines.provisioners.check', { available: true }],
    ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
    } });
    const pluginId = provisioner.contribution.pluginId;
    const failure = readPluginActionError(new PluginError({ code: 'credential_unavailable', message: 'Sign in to Docker',
      details: { available: false, code: 'credential_unavailable', status: 'Sign in to Docker',
        prerequisites: [{ requirement: { kind: 'managedDependency', id: { pluginId, localId: 'docker-sandboxes-cli' } },
        status: 'unavailable', reason: 'Sign in to Docker', repairAction: { action: { pluginId, localId: 'sign-in' }, input: {} } }] } }))!;
    const actionId = 'machines.provisioners.options';
    const error = ManagedMachineControllerError.fromActionFailure({ ok: false, errorCode: failure.code,
      error: failure.message, details: failure.data }, actionId);
    const execution = { ok: false, ...normalizeActionExecutorThrownError(error, actionId) };
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution } };
    } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.error')).not.toBeNull());
      const requirementId = buildQualifiedPluginContributionKey({ pluginId, localId: 'docker-sandboxes-cli' });
      const repairId = `managed-config.repair:managedDependency:${requirementId}`;
      expect(screen.findByTestId(repairId)?.props.onPress).toEqual(expect.any(Function));
      expect(screen.getTextContent()).toContain('Sign in to Docker');
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);

      const otherCheck = createDeferred<{ available: true }>();
      const otherOptions = createDeferred<ReturnType<typeof createManagedCpuOptionsFixture>>();
      const otherRead = vi.fn();
      await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
        const request = readProvisionerRequest(value);
        return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId, execution: { ok: true,
          result: { controller: other, provisioners: [{ ...provisioner, occurrenceId: 'other-occurrence' }] } } } };
      } });
      await answerExternalActionAccountForHome(harness, serverId, { ...other, actionId: 'machines.provisioners.check', tokenEpoch: 0,
        execute: () => otherCheck.promise });
      await answerExternalActionAccountForHome(harness, serverId, { ...other, actionId: 'machines.provisioners.options', tokenEpoch: 0,
        execute: () => { otherRead(); return otherOptions.promise; } });
      try {
        const chip = screen.tree.findAll(node => node.props.presentation === 'chip' && node.props.selection)[0];
        const target = chip?.props.selection.candidates.find((candidate: { target: { machineId: string } }) =>
          candidate.target.machineId === other.machineId)?.target;
        expect(target).toBeDefined();
        await act(async () => chip!.props.selection.selectTarget(target));
        await waitForHomeGovernance(() => expect(otherRead).toHaveBeenCalled());
        expect(screen.findByTestId('managed-config.error')).not.toBeNull();
        expect(screen.findByTestId(repairId)).toBeNull();
      } finally {
        await act(async () => {
          otherCheck.resolve({ available: true });
          otherOptions.resolve(createManagedCpuOptionsFixture([{ id: 'small', title: 'Small', cpu: 2 }]));
        });
      }
    } finally { await screen.unmount(); }
  });
  it('keeps a settled options failure through Retry and publishes only a changed answer', async () => {
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://options-retry.example.test',
      serverIdentityId: 'srv_options_retry', accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({
      id: defaultController.machineId, installationId: defaultController.installationId,
    })]);
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
      ['machines.provisioners.check', { available: true }],
    ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
    } });
    let reply = createDeferred<void>();
    let succeeds = false;
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.options', { select: async value => {
      const request = readProvisionerRequest(value);
      await reply.promise;
      return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId,
        execution: succeeds ? { ok: true, result: createManagedCpuOptionsFixture([{ id: 'small', title: 'Small', cpu: 2 }]) }
          : { ok: false, errorCode: 'action_failed', error: 'action_failed' } } };
    } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const commits = vi.fn();
    const screen = await renderScreen(<React.Profiler id="options-retry" onRender={commits}>
      <ManagedMachineConfigurationView serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} />
    </React.Profiler>);
    await act(async () => reply.resolve());
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.error')).not.toBeNull());
    await flushHookEffects();
    reply = createDeferred<void>();
    commits.mockClear();
    await screen.pressByTestIdAsync('managed-config.error-action');
    expect.soft(screen.findByTestId('managed-config.error')).not.toBeNull();
    expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
    expect.soft(commits).toHaveBeenCalledTimes(1);
    commits.mockClear();
    await act(async () => reply.resolve());
    await flushHookEffects();
    expect(screen.findByTestId('managed-config.error')).not.toBeNull();
    expect.soft(commits).toHaveBeenCalledTimes(0);
    reply = createDeferred<void>();
    succeeds = true;
    await screen.pressByTestIdAsync('managed-config.error-action');
    expect(screen.findByTestId('managed-config.error')).not.toBeNull();
    await act(async () => reply.resolve());
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.error')).toBeNull());
    await screen.unmount();
  });
  it('does not render a named controller page for another Machine publication and updates its controller name', () => withPopoverWebGlobals(async () => {
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://controller-selection.example.test',
      serverIdentityId: 'srv_controller_selection', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const controllerMachine = createMachineFixture({ id: defaultController.machineId, installationId: defaultController.installationId,
      metadata: { ...createMachineFixture().metadata!, displayName: 'Build computer' } });
    const otherMachine = createMachineFixture({ id: 'other', installationId: 'other-installation',
      metadata: { ...createMachineFixture().metadata!, displayName: 'Other computer' } });
    const publicationScope = { sourceServerId: serverId, sourceAccountId: 'owner' };
    const scopeServerId = resolveServerProfileScopeIdForIdentifier(serverId);
    const previousMachines = storage.getState().machineListByServerId[scopeServerId] ?? [];
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [controllerMachine, otherMachine]);
    expect(storage.getState().machineRecordsByServerId[scopeServerId]?.host?.installationId).toBe(defaultController.installationId);
    try {
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
      ['machines.provisioners.check', { available: true }],
      ['machines.provisioners.options', createManagedCpuOptionsFixture([{ id: 'small', title: 'Small', cpu: 2 }])],
    ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
    } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const commits = vi.fn();
    const screen = await renderScreen(<React.Profiler id="managed-controller" onRender={commits}>
      <ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)}
        initialController={defaultController} />
    </React.Profiler>);
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.sizes:small')).not.toBeNull());
    await flushHookEffects();
    commits.mockClear();
    await act(async () => storage.getState().applyMachines([{ ...otherMachine, metadataVersion: 2,
      metadata: { ...otherMachine.metadata!, displayName: 'Renamed other computer' } }], false, publicationScope));
    expect(storage.getState().machineRecordsByServerId[scopeServerId]?.other?.metadata?.displayName).toBe('Renamed other computer');
    expect(commits).not.toHaveBeenCalled();
    await act(async () => storage.getState().applyMachines([{ ...controllerMachine, metadataVersion: 2,
      metadata: { ...controllerMachine.metadata!, displayName: 'Renamed build computer' } }], false, publicationScope));
    expect(commits.mock.calls.length).toBeGreaterThan(0);
    expect(screen.getTextContent()).toContain('Renamed build computer');
    await screen.pressByTestIdAsync('managed-config.controller.chip');
    await act(async () => reportPopoverContentLayout(screen.tree, { width: 400, height: 500 }));
    await waitForHomeGovernance(() => {
      const otherOption = screen.findByTestId('managed-config.controller.picker-option:other');
      expect(otherOption && findTestInstanceByTypeContainingText(otherOption, Text, 'Renamed other computer')).toBeDefined();
    });
    await screen.unmount();
    } finally {
      await act(async () => storage.getState().applyMachines(previousMachines, true, publicationScope));
    }
  }));
  it.each(['agent37', 'freestyle', 'upstash-box', 'daytona', 'superserve', 'hetzner', 'railway', 'maritime'] as const)(
    'discloses stopped compute billing from real %s declarations without treating retained storage as compute', async (vendor) => {
      const providers = {
        agent37: () => import('../../../../../../../packages/plugins/machine-agent37/src/manifest'),
        freestyle: () => import('../../../../../../../packages/plugins/machine-freestyle/src/manifest'),
        'upstash-box': () => import('../../../../../../../packages/plugins/machine-upstash-box/src/manifest'),
        daytona: () => import('../../../../../../../packages/plugins/machine-daytona/src/manifest'),
        superserve: () => import('../../../../../../../packages/plugins/machine-superserve/src/manifest'),
        hetzner: () => import('../../../../../../../packages/plugins/machine-hetzner/src/manifest'),
        railway: () => import('../../../../../../../packages/plugins/machine-railway/src/manifest'),
        maritime: () => import('../../../../../../../packages/plugins/machine-maritime/src/manifest'),
      };
      const { PLUGIN } = await providers[vendor]();
      const descriptor = MachineProvisionerContributionV1Schema.parse(PLUGIN.manifest.contributes.machineProvisioners![0]);
      const native = { contribution: { pluginId: PLUGIN.manifest.id, localId: descriptor.id }, occurrenceId: vendor,
        credentialPurposes: [], acquireExecutionTarget: 'daemon' as const, descriptor };
      let options: MachineProvisionerOptionsResultV1 = createMachineProvisionerOptionsFixture({ base: { launch: {} }, dimensions: {
        size: [{ id: 'native', title: 'Native size', assignments: [], nativeFacts: { size: { id: 'native', title: 'Native size' } } }],
        image: [], location: [], network: [], duration: [],
      } });
      if (vendor === 'agent37') options = MachineProvisionerOptionsResultV1Schema.parse(
        (await import('../../../../../../../packages/plugins/machine-agent37/src/machine/options')).options());
      if (vendor === 'maritime') {
        const provider = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN });
        onTestFinished(() => provider.dispose());
        const unavailable = (): never => { throw new Error('Unexpected host boundary in Maritime options'); };
        // Only the credential and vendor HTTP boundaries are substituted; real options and their strict role schema run.
        options = MachineProvisionerOptionsResultV1Schema.parse(await provider.invokeAction('options', {}, { services: {
          connectedAccounts: { getBinding: unavailable, requestSelection: unavailable, listAccounts: unavailable,
            materializeListedAccount: unavailable, watch: unavailable,
            materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer maritime-fixture' } }) },
          http: createPluginHttpFixture({ request: async ({ url }: HttpRequest) => ({ status: 200, finalUrl: url, headers: {},
            body: new TextEncoder().encode(JSON.stringify({ plan: 'growth', machines: 0, awakeMachines: 0 })) }) }),
        } }));
      }
      const serverId = await addPresetHome({ name: 'Compute billing', serverUrl: `https://${vendor}-billing.example.test`,
        serverIdentityId: `srv_billing_${vendor}`, accountId: 'owner', currentAccount: true });
      await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: defaultController.machineId,
        installationId: defaultController.installationId })]);
      for (const [actionId, result] of [
        ['machines.provisioners.list', { controller: defaultController, provisioners: [native] }],
        ['machines.provisioners.check', { available: true }], ['machines.provisioners.options', options],
      ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
        const request = readProvisionerRequest(value);
        return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
      } });
      const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
      const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(native.contribution)} initialController={defaultController} />);
      const { t } = await import('@/text');
      const description = () => screen.tree.findAll(node => node.props.title === t('managedMachines.config.size')
        && typeof node.props.description === 'string').map(node => node.props.description).join(' ');
      try {
        await waitForHomeGovernance(() => expect(description().length).toBeGreaterThan(0));
        if (vendor === 'maritime') {
          const control = (testID: string) => screen.tree.findAll(node => node.props.testID === testID && typeof node.props.onChange === 'function')[0];
          await waitForHomeGovernance(() => expect(control('managed-config.images')).toBeDefined());
          await act(async () => control('managed-config.images')!.props.onChange('agent-box'));
          expect(description()).toContain(t('managedMachines.config.billedWhileExists'));
          await act(async () => control('managed-config.images')!.props.onChange('linux-computer'));
          expect(description()).toContain(t('managedMachines.config.billedWhileRunning'));
          expect(description()).not.toContain(t('managedMachines.config.billedWhileExists'));
        } else if (vendor === 'hetzner') {
          expect(description()).toContain(t('managedMachines.config.billedWhileExists'));
        } else if (vendor === 'railway') {
          expect(description()).toContain(t('managedRetention.consequence.stopUnknown', { provider: 'Railway' }));
        } else {
          expect(description()).toContain(t('managedMachines.config.billedWhileRunning'));
          expect(description()).not.toContain(t('managedMachines.config.billedWhileExists'));
          if (vendor !== 'daytona') expect(descriptor.billing.storageCharges?.length).toBeGreaterThan(0);
        }
      } finally { await screen.unmount(); }
    },
  );
  it('retains the selected controller for browser-blocked Account options after the runtime host settles', async () => {
    const host = createDeferred<'browser' | 'native'>();
    runtimeHost.current = host.promise;
    const serverId = await addPresetHome({ name: 'Browser compute', serverUrl: 'https://browser-controller.example.test',
      serverIdentityId: 'srv_browser_controller', accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: defaultController.machineId,
      installationId: defaultController.installationId })]);
    const selected = { ...provisioner, acquireExecutionTarget: 'account' as const,
      descriptor: { ...provisioner.descriptor, browserReachable: false } };
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [selected] }],
      ['machines.provisioners.check', { available: true }],
      ['machines.provisioners.options', createManagedCpuOptionsFixture([{ id: 'cloud', title: 'Cloud compute', cpu: 2 }])],
    ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
    } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const onUse = vi.fn();
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(selected.contribution)} initialController={defaultController} onUse={onUse} />);
    try {
      await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.list').length).toBeGreaterThan(0));
      await flushHookEffects();
      expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(0);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(0);
      await act(async () => host.resolve('browser'));
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.sizes:cloud')).not.toBeNull());
      await screen.pressByTestIdAsync('managed-config.sizes:cloud');
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false));
      await screen.pressByTestIdAsync('managed-config.use');
      expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({ controller: defaultController }) }));
      for (const role of ['check', 'options']) {
        const requests = harness.requestsFor(`/v1/actions/machines.provisioners.${role}`);
        expect(requests.length).toBeGreaterThan(0);
        for (const request of requests) expect(readProvisionerRequest(request.input).input)
          .toMatchObject({ controller: defaultController });
      }
    } finally { await screen.unmount(); }
  });
  it.each([false, true])('reads Account options metadata and presentation without a controller or Machine RPC (preset: %s)', async presetOnly => {
    runtimeHost.current = 'native';
    const { PLUGIN } = await import('../../../../../../../packages/plugins/machine-vercel/src/manifest');
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { installBundledPluginUiDeclarationsForTests } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
    const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN.manifest);
    const restoreBundles = installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
      packageName: '@happier-dev/plugins-machine-vercel', displayName: 'Vercel Machines', hasMachineProvisioners: true, entriesById: {},
      normalizedManifest: manifest }]);
    onTestFinished(restoreBundles);
    const serverId = await addPresetHome({ name: 'Fresh Account', serverUrl: 'https://account-options.example.test',
      serverIdentityId: 'srv_account_options', accountId: 'owner', currentAccount: true });
    const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
      await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { useManagedProvisionerOptionsInput } = await import('./useManagedProvisionerOptionsInput');
    const { useManagedProvisionerPresentation } = await import('./useManagedProvisionerPresentation');
    const { projectAccountManagedProvisioners } = await import('@happier-dev/cli-common/machines/managed/provisioners');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' };
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1,
      intentReads: [{ pluginId: manifest.id, response: createEnabledMachinePluginIntentReadFixture(manifest) }], materializations: [], snapshots: [] } });
    const declarations = await readPluginAccountAvailability(scope).ensureCurrentAccountExecutionDeclarations({ family: 'machineProvisioners' });
    if (declarations.kind !== 'available') throw new Error('Expected the Account declaration producer');
    const selected = projectAccountManagedProvisioners(declarations.declarations).find(row => row.contribution.pluginId === 'happier.machine.vercel');
    if (!selected) throw new Error('Expected bundled Vercel');
    const { ACCOUNT_ID } = await import('../../../../../../../packages/plugins/machine-vercel/src/account');
    harness.answer(serverId, '/v4/connect/qualified/accounts', {
      body: { service: { pluginId: manifest.id, localId: ACCOUNT_ID }, accounts: [] },
    });
    const hook = await renderHook(() => {
      const { binding } = useServerCredentialAccountScopeBinding(serverId);
      return { binding, options: useManagedProvisionerOptionsInput({ binding, provisioner: selected }),
        presentation: useManagedProvisionerPresentation({ serverId, provisioner: selected, accountScope: binding?.scope }) };
    });
    try {
      await waitForHomeGovernance(() => expect(hook.getCurrent().options.kind).toBe('ready'));
      const value = hook.getCurrent();
      expect(value.options).toMatchObject({ kind: 'ready', action: { pluginId: selected.contribution.pluginId,
        id: selected.descriptor.actions.options, occurrenceId: selected.occurrenceId }, schema: { type: 'object' } });
      expect(value.presentation.projectionReady).toBe(true);
      if (!value.binding) throw new Error('Expected the captured Account binding');
      const { resolveConnectedAccountPurposeSetupHandoff, readConnectedAccountPurposeSetupDeclaration } =
        await import('@/sync/domains/connectedServices/connectedAccountPurposeSetup');
      const handoff = { request: { scope: value.binding.scope, purpose: { consumer: selected.contribution, purpose: 'cloud-api' } },
        lifetime: value.binding, occurrenceId: selected.occurrenceId };
      const accountSelection = readPluginAccountAvailability(scope).readCurrentAccountExecution(manifest.id);
      if (accountSelection.kind !== 'available') throw new Error('Expected the admitted Account consumer declaration');
      expect(readConnectedAccountPurposeSetupDeclaration(handoff.request, value.binding.scope,
        { accountSelection, accountLifetime: value.binding })).toMatchObject({ consumerKind: 'machineProvisioner',
        purpose: 'cloud-api', serviceRefs: [{ pluginId: manifest.id, localId: 'vercel-account' }] });
      // A missing credential-options producer is unavailable; it never invents a native controller.
      expect(resolveConnectedAccountPurposeSetupHandoff(handoff, { activeHandoff: handoff, binding: value.binding,
        controller: undefined, provisioner: selected, available: true })).toMatchObject({ ok: false,
        error: { code: 'connected_account_purpose_unavailable' } });
      expect(value.presentation.projection.actionsById[buildQualifiedPluginContributionKey({ pluginId: selected.contribution.pluginId,
        localId: selected.descriptor.actions.options! })]).toBeDefined();
      expect(nativeBoundary.rpc).not.toHaveBeenCalled();
      const { VercelLaunchSchema } = await import('../../../../../../../packages/plugins/machine-vercel/src/machine/schemas');
      const launch = VercelLaunchSchema.parse({ image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 2,
        timeoutMs: 300_000, snapshotExpirationMs: 0 });
      for (const [actionId, result] of [
        ['machines.provisioners.list', { provisioners: [{ ...selected, credentialPurposes: [] }] }],
        ['machines.provisioners.check', { available: true }],
        ['machines.provisioners.options', createMachineProvisionerOptionsFixture({ base: { launch, guestPlatform: 'linux' } })],
      ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
        const request = readProvisionerRequest(value);
        return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
      } });
      await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, []);
      const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
      const onUse = vi.fn();
      const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(selected.contribution)} onUse={onUse} presetOnly={presetOnly} />);
      try {
        const { t } = await import('@/text');
        await waitForHomeGovernance(() => expect(screen.findByTestId(presetOnly ? 'managed-config.create' : 'managed-config.use')?.props.disabled).toBe(true));
        expect(screen.findByTestId('managed-config.controller-target:pool')).toBeNull();
        if (!presetOnly) expect(screen.getTextContent()).toContain(t('managedMachines.credential.choose'));
        expect(onUse).not.toHaveBeenCalled();
        expect(nativeBoundary.rpc).not.toHaveBeenCalled();
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
      } finally { await screen.unmount(); }
    } finally { await hook.unmount(); }
  });
  it('settles Account options after a retained daemon catalog and subscriber remount, even when the daemon never answers (J58)', async () => {
    runtimeHost.current = 'native';
    // The view and React load before the Account runtime reads plugin declarations.
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { PLUGIN } = await import('../../../../../../../packages/plugins/machine-vercel/src/manifest');
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { installBundledPluginUiDeclarationsForTests } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
    const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN.manifest);
    onTestFinished(installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
      packageName: '@happier-dev/plugins-machine-vercel', displayName: 'Vercel Machines', hasMachineProvisioners: true, entriesById: {}, normalizedManifest: manifest }]));
    const serverId = await addPresetHome({ name: 'Account acquire', serverUrl: 'https://account-acquire.example.test',
      serverIdentityId: 'srv_account_acquire', accountId: 'owner', currentAccount: true });
    const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
      await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const { projectAccountManagedProvisioners } = await import('@happier-dev/cli-common/machines/managed/provisioners');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' };
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1,
      intentReads: [{ pluginId: manifest.id, response: createEnabledMachinePluginIntentReadFixture(manifest) }], materializations: [], snapshots: [] } });
    const declarations = await readPluginAccountAvailability(scope).ensureCurrentAccountExecutionDeclarations({ family: 'machineProvisioners' });
    if (declarations.kind !== 'available') throw new Error('Expected the Account declaration producer');
    const selected = projectAccountManagedProvisioners(declarations.declarations).find(row => row.contribution.pluginId === 'happier.machine.vercel');
    if (!selected) throw new Error('Expected bundled Vercel');
    expect(selected.acquireExecutionTarget).toBe('account');
    const { ACCOUNT_ID } = await import('../../../../../../../packages/plugins/machine-vercel/src/account');
    const account = { service: { pluginId: manifest.id, localId: ACCOUNT_ID }, accountId: 'vercel-options-j58' };
    const accountCatalog = createDeferred<void>();
    harness.answer(serverId, '/v4/connect/qualified/accounts', {
      select: async () => { await accountCatalog.promise; return { body: { service: account.service, accounts: [{ ref: account, status: 'connected', authenticationModeId: 'token',
        configurationReady: true, configurationRevision: 'selected-config', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] }] } }; },
    });
    harness.answer(serverId, '/v4/connect/qualified/configuration', { status: 503, body: { error: 'unavailable' } });
    const { VercelLaunchSchema } = await import('../../../../../../../packages/plugins/machine-vercel/src/machine/schemas');
    const launch = VercelLaunchSchema.parse({ image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 2,
      timeoutMs: 300_000, snapshotExpirationMs: 0 });
    for (const [actionId, result] of [
      ['machines.provisioners.list', { provisioners: [{ ...selected, occurrenceId: 'daemon-vercel-j58', credentialPurposes: [] }] }],
      ['machines.provisioners.check', { available: true }],
      ['machines.provisioners.options', createMachineProvisionerOptionsFixture({ base: { launch, guestPlatform: 'linux' } })],
    ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = readProvisionerRequest(value);
      const input = request.input as { controller?: unknown } | undefined;
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true,
        result: actionId === 'machines.provisioners.list' && input?.controller ? { ...result, controller: input.controller } : result } } };
    } });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: defaultController.machineId,
      installationId: defaultController.installationId, activeAt: Date.now(), kind: 'persistent' })]);
    const contributionKey = buildQualifiedPluginContributionKey(selected.contribution);
    const { useManagedProvisioners } = await import('./useManagedProvisioners');
    // The Machine catalog's presentation survives its subscriber. A cold editor can
    // display that occurrence while its Account catalog read is settling.
    const warm = await renderHook(() => useManagedProvisioners(serverId, undefined, defaultController, { contributionKey }));
    await waitForHomeGovernance(() => expect(warm.getCurrent()).toMatchObject({ loading: false,
      provisioners: [expect.objectContaining({ occurrenceId: 'daemon-vercel-j58' })] }));
    await warm.unmount();
    // A genuinely unanswered Machine transport must not own these Account reads.
    nativeBoundary.rpc.mockImplementation(() => new Promise(() => {}));
    const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const onUse = vi.fn();
    for (let mount = 0; mount < 2; mount++) {
      const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
        provisioner={contributionKey} onUse={onUse} />);
      try {
        await waitForHomeGovernance(() => expect(harness.requests.filter(request =>
          new URL(request.path, request.serverUrl).pathname === '/v4/connect/qualified/accounts').length).toBeGreaterThan(0));
        await flushHookEffects();
        await act(async () => accountCatalog.resolve());
        // Its catalog entry declares the Account as creator: the page reads the Account's catalog, which asks for the
        // Account's own Vercel account, and names no computer.
        const { t } = await import('@/text');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('managedMachines.credential.choose')));
        expect(screen.findByTestId('managed-config.controller.chip')).toBeNull();
        expect(screen.findByTestId('managed-config.scope')).toBeNull();
        const credentialField = screen.tree.findAllByType(ActionInputFields).find(node => node.props.fields.some(
          (field: { path: string }) => node.props.resolveFieldTestID?.(field) === 'managed-config.credential:cloud-api'));
        if (!credentialField) throw new Error('Expected the Account credential picker');
        await act(async () => credentialField.props.onPatch({ '0': account }));
        // The real Account admission may refuse its unavailable credential/runtime,
        // but the loader must publish that typed result instead of waiting forever.
        await waitForHomeGovernance(() => {
          expect(screen.tree.findAllByType(SurfaceStateCard).find(
            node => node.props.testID === 'managed-config.error')?.props.diagnosticCode).toEqual(expect.any(String));
          expect(screen.tree.findAllByType(SurfaceStateCard).filter(node => node.props.kind === 'loading')).toHaveLength(0);
        });
        // Choices and checks are the Account's: none names the computer.
        expect(['check', 'options'].flatMap(id => harness.requestsFor(`/v1/actions/machines.provisioners.${id}`))
          .filter(request => JSON.stringify(request).includes('"controller"'))).toEqual([]);
      } finally { await screen.unmount(); }
    }
    expect(onUse).not.toHaveBeenCalled();
  });
  it.each(['published', 'private', 'private-after-catalog', 'catalog-location-first'])('retains the Lume native-image editor through options settling (%s)', imageKind => withPopoverWebGlobals(async () => {
    const { PLUGIN_MANIFEST: manifest } = await import('../../../../../../../packages/plugins/machine-lume/src/manifest');
    const { LumeOptionsInputV1Schema } = await import('../../../../../../../packages/plugins/machine-lume/src/machine/schemas');
    const descriptor = MachineProvisionerContributionV1Schema.parse(manifest.contributes.machineProvisioners?.[0]);
    const declaration = PluginActionContributionV2Schema.parse(manifest.contributes.actions?.find(action => action.id === descriptor.actions.options));
    const contribution = { pluginId: manifest.id, localId: descriptor.id };
    const action = PluginProjectedActionV2Schema.parse({ id: declaration.id, title: declaration.title, pluginId: manifest.id,
      scopes: declaration.scopes, surfaces: declaration.surfaces, execution: declaration.execution, dangerLevel: declaration.dangerLevel,
      occurrenceId: 'lume-image-editor', available: true,
      inputHints: normalizePluginActionInputHintsV2(declaration.inputHints, declaration.inputSchema) });
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
      ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
      installedPackagesById: { [manifest.id]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: manifest.id } },
      actionsById: { [buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: action.id })]: action } } });
    nativeBoundary.rpc.mockImplementation(async (request: { method: string }) =>
      request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE ? projection
        : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ ? { ok: true, inputSchema: declaration.inputSchema }
          : { ok: false, code: 'unsupported' });
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://lume-image-editor.example',
      serverIdentityId: 'srv_lume_image_editor', accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: 'host', installationId: 'installation' })]);
    const catalogReference = 'ghcr.io/trycua/macos:26';
    const { createLumeProvider } = await import('../../../../../../../packages/plugins/machine-lume/src/machine/provider');
    const { createLumeNativeClient } = await import('../../../../../../../packages/plugins/machine-lume/src/machine/nativeClient');
    // Only the native/registry HTTP boundary is substituted; provider options and form settling are real.
    const provider = createLumeProvider({ observedAt: 123, native: createLumeNativeClient({ baseUrl: 'http://localhost:7777',
      fetch: async input => {
        const url = new URL(String(input));
        if (url.pathname === '/token') return Response.json({ token: 'public-fixture' });
        if (url.pathname.endsWith('/tags/list')) return Response.json({
          name: url.pathname.includes('macos-tahoe-cua') ? 'trycua/macos-tahoe-cua' : 'trycua/macos', tags: ['26'] });
        if (url.pathname.includes('/manifests/')) return Response.json({ annotations: { 'org.trycua.lume.disk-size': '161061273600' } });
        if (url.pathname === '/lume/config/locations') return Response.json([{ name: 'home', path: '/fixture' }]);
        if (url.pathname === '/lume/vms') return Response.json([]);
        throw new Error(`Unexpected Lume request: ${url.pathname}`);
      } }) });
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [{ contribution, occurrenceId: 'lume-image-editor', acquireExecutionTarget: 'daemon' as const, descriptor, credentialPurposes: [] }] }],
      ['machines.provisioners.check', { available: true }],
      ['machines.provisioners.options', null],
    ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: async value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result: actionId === 'machines.provisioners.options'
        ? await provider.options(ProvisionerOptionsInputV1Schema.parse(request.input).selectors) : result } } };
    } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { ManagedMachineConfigurator } = await import('./ManagedMachineConfigurator');
    const screenText = await import('@/text');
    const { ManagedImageTiles } = await import('./ManagedChoiceSections');
    const { HappierInputField } = await import('@happier-dev/plugin-ui/presentation');
    const { pressTestInstanceAsync } = await import('@/dev/testkit');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={defaultController} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId(`managed-config.images:${catalogReference}`)).not.toBeNull());
      if (imageKind === 'catalog-location-first') {
        await screen.pressByTestIdAsync('managed-config.locations:home');
        await screen.pressByTestIdAsync(`managed-config.images:${catalogReference}`);
        await waitForHomeGovernance(() => {
          expect(screen.findByTestId('managed-config.field:diskBytes')?.props.value).toBe('150');
          expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false);
        });
        return;
      }
      if (imageKind === 'private-after-catalog') {
        await screen.pressByTestIdAsync(`managed-config.images:${catalogReference}`);
        await screen.pressByTestIdAsync('managed-config.locations:home');
        // Establish the catalog's actual hardware defaults before testing the representation change.
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
      }
      // A catalog tile supplies its id; it cannot choose the declaration's custom-image representation.
      expect(screen.findByTestId('managed-config.field:image.id')).toBeNull();
      const select = async (path: string, value: string) => {
        const field = screen.tree.findAllByType(HappierInputField).find(node => node.props.field.path === path);
        expect(field, `Expected the declared ${path} choice to remain reachable`).toBeDefined();
        const option = field?.props.options.find((entry: { value: unknown }) => entry.value === value);
        expect(option).toBeDefined();
        const choice = () => screen.findAllByType('Pressable').find(node =>
          (node.props.role ?? node.props.accessibilityRole) === 'radio' && node.props.accessibilityLabel === option.label);
        if (!choice()) {
          const trigger = screen.findAllByType('Pressable').find(node =>
            String(node.props.accessibilityLabel ?? '').startsWith(field?.props.field.title + ':'));
          expect(trigger).toBeDefined();
          await pressTestInstanceAsync(trigger);
          await act(async () => reportPopoverContentLayout(screen.tree, { width: 400, height: 500 }));
          await waitForHomeGovernance(() => expect(choice()).toBeDefined());
        }
        await pressTestInstanceAsync(choice());
      };
      await select('image.kind', 'native-image');
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:image.reference')).not.toBeNull());
      const nativeReference = imageKind === 'published' ? catalogReference : 'ghcr.io/example/prepared-linux:latest';
      await act(async () => screen.changeTextByTestId('managed-config.field:image.reference', nativeReference));
      if (imageKind !== 'published') {
        await select('image.privateCarrier.kind', 'lume-default-password');
        await select('image.privateCarrier.guestOs', 'linux');
        await act(async () => screen.changeTextByTestId('managed-config.field:image.privateCarrier.user', 'developer'));
      }
      await screen.pressByTestIdAsync('managed-config.locations:home');
      await waitForHomeGovernance(() => {
        const request = harness.requestsFor('/v1/actions/machines.provisioners.options').at(-1);
        const envelope = readProvisionerRequest(request?.input);
        const input = ProvisionerOptionsInputV1Schema.parse(envelope.input);
        expect(LumeOptionsInputV1Schema.parse(input.selectors)).toMatchObject({ storage: 'home',
          image: { kind: 'native-image', reference: nativeReference } });
        expect(screen.tree.findAllByType(ManagedImageTiles)[0]?.props.value).toBe(nativeReference);
        if (imageKind !== 'private-after-catalog') {
          const disk = screen.tree.findAllByType(HappierInputField).find(node => node.props.field.path === 'diskBytes');
          expect(disk).toBeDefined();
          expect(screen.tree.findAllByType(ManagedMachineConfigurator)[0]?.props.summary.spec).toBe(
            screenText.t('session.actionsDraft.validation.requiredField', { field: disk?.props.field.title }));
          expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
        }
      });
      // Native references have no catalog disk default: supply the displayed disk requirement.
      if (imageKind !== 'private-after-catalog') await act(async () => screen.changeTextByTestId('managed-config.field:diskBytes', '150'));
      await waitForHomeGovernance(() => {
        const request = harness.requestsFor('/v1/actions/machines.provisioners.options').at(-1);
        const input = ProvisionerOptionsInputV1Schema.parse(readProvisionerRequest(request?.input).input);
        expect(LumeOptionsInputV1Schema.parse(input.selectors).image).toMatchObject({ kind: 'native-image', reference: nativeReference });
        expect(screen.findByTestId('managed-config.create')?.props.disabled, screen.getTextContent()).toBe(false);
      });
      expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
    } finally { await screen.unmount(); }
  }));
  it('materialises partial Lima native defaults without flashing an unavailable choice while the image is required', async () => {
    const { LIMA_PLUGIN } = await import('../../../../../../../packages/plugins/machine-lima/src/manifest');
    const { createPluginTestkit } = await import('@happier-dev/plugin-sdk/testing');
    const { MachineProvisionerOptionsResultV1Schema } = await import('@happier-dev/protocol/plugins/contributions/machineProvisioners');
    // Captured nl3 Lima v2.2.1 info: base images are inherited, not embedded by `info`.
    const info = { version: 'v2.2.1', hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'], limaHome: '/home/happier/.lima',
      defaultTemplate: { base: [{ url: 'template:_images/ubuntu' }, { url: 'template:_default/mounts' }],
        minimumLimaVersion: '2.0.0', os: 'Linux', arch: 'x86_64', cpus: 4, memory: '4GiB', disk: '100GiB' } };
    // This OS boundary supports only the captured Lima reads; other host calls must fail visibly.
    const unexpectedHostCall = () => { throw new Error('Unexpected host service call'); };
    const kit = await createPluginTestkit({ manifest: LIMA_PLUGIN.manifest, module: LIMA_PLUGIN, services: {
      exec: {
        agentCli: { checkReadiness: unexpectedHostCall },
        systemTools: { resolve: unexpectedHostCall },
        spawn: unexpectedHostCall,
        clients: { connectJsonRpc: unexpectedHostCall, spawn: unexpectedHostCall },
        prepareNativeSocketDirectory: unexpectedHostCall,
        withSpawnAdmission: unexpectedHostCall,
        run: async request => ({ termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(request.args?.[0] === 'info' ? JSON.stringify(info) : 'limactl version 2.2.1'),
        stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }) },
      managedServices: { supervise: unexpectedHostCall, observeWorkload: unexpectedHostCall, dependencies: {
        ensure: unexpectedHostCall, update: unexpectedHostCall, remove: unexpectedHostCall,
        status: async id => ({ state: 'ready', id, sourceId: 'system', version: '2.2.1',
        executable: { kind: 'managedDependency', id: { pluginId: LIMA_PLUGIN.manifest.id, localId: id } } }) } },
    } });
    const manifest = LIMA_PLUGIN.manifest;
    const descriptor = MachineProvisionerContributionV1Schema.parse(manifest.contributes.machineProvisioners?.[0]);
    const declaration = PluginActionContributionV2Schema.parse(manifest.contributes.actions?.find(action => action.id === descriptor.actions.options));
    const contribution = { pluginId: manifest.id, localId: descriptor.id };
    const action = PluginProjectedActionV2Schema.parse({ id: declaration.id, title: declaration.title, pluginId: manifest.id,
      scopes: declaration.scopes, surfaces: declaration.surfaces, execution: declaration.execution, dangerLevel: declaration.dangerLevel,
      occurrenceId: 'lima-partial', available: true,
      inputHints: normalizePluginActionInputHintsV2(declaration.inputHints, declaration.inputSchema) });
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
      projection: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
        installedPackagesById: { [manifest.id]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: manifest.id } },
        actionsById: { [buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: action.id })]: action } } });
    const { buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeRequestSchema } =
      await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
    const deferred = buildDeferredDaemonProjectionSections({ ...projection, projectionDigest: 'b'.repeat(64) });
    const hydration = createDeferred<void>();
    nativeBoundary.rpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
      if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: true, inputSchema: declaration.inputSchema };
      if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { ok: false, code: 'unsupported' };
      const payload = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(request.payload);
      if (!('sectionRead' in payload) || !payload.sectionRead) return deferred.manifest;
      await hydration.promise;
      return deferred.read(payload.sectionRead.digest, payload.sectionRead.offset, payload.sectionRead.includeDigests);
    });
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://lima-partial.example',
      serverIdentityId: 'srv_lima_partial', accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: 'host', installationId: 'installation' })]);
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [{ contribution, occurrenceId: 'lima-partial', acquireExecutionTarget: 'daemon' as const, descriptor, credentialPurposes: [] }] }],
      ['machines.provisioners.check', { available: true }],
    ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
    } });
    let optionsAnswer: ReturnType<typeof MachineProvisionerOptionsResultV1Schema.parse> | undefined;
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.options', { select: async value => {
      const request = readProvisionerRequest(value);
      const input = ProvisionerOptionsInputV1Schema.parse(request.input);
      const result = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', input.selectors, { surface: 'plugin' }));
      optionsAnswer = result;
      return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId, execution: { ok: true, result } } };
    } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
    const { ManagedMachineConfigurator } = await import('./ManagedMachineConfigurator');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={defaultController} />);
    const createReason = () => screen.tree.findByType(ManagedMachineConfigurator).props.receipt.primary.footnote;
    const noUnavailableChoice = () => {
      expect.soft(screen.findByTestId('managed-config.size-refused')).toBeNull();
      const sizeTable = screen.tree.findAll(node => node.props.testID === 'managed-config.sizes' && Array.isArray(node.props.sizes));
      expect.soft(sizeTable.flatMap(node => node.props.sizes).every(row => row.unavailableReason === undefined)).toBe(true);
      const { t } = screenText;
      expect.soft(createReason()).not.toBe(t('managedMachines.options.unavailable'));
    };
    const screenText = await import('@/text');
    try {
      await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(1));
      await flushHookEffects();
      // Options settle before presentation: a missing image does not withdraw the native size.
      noUnavailableChoice();
      // Until the form is known the page holds the one checking line: no interim size echo is drawn and then swapped out.
      expect(screen.tree.findAll(node => node.props.testID === 'managed-config.sizes' && Array.isArray(node.props.sizes))).toHaveLength(0);
      expect(screen.tree.findAll(node => node.props.kind === 'loading'
        && node.props.title === screenText.t('managedMachines.options.loading', { provider: 'Lima' }))).not.toHaveLength(0);
      await act(async () => hydration.resolve());
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:image')).not.toBeNull());
      // The blank required image stays in view; the controller-filled store and driver fold into Advanced, the size into Size.
      const form = screen.tree.findAllByType(ActionInputFields).find(node => node.props.fields.some((field: Readonly<{ path: string }>) => field.path === 'image'));
      if (!form) throw new Error('Expected Lima options fields');
      const fieldOf = (path: string) => screen.tree.findAllByType(ActionInputFields)
        .flatMap(node => node.props.fields as readonly Readonly<{ path: string; description?: string }>[]).find(field => field.path === path);
      expect(screen.findByTestId('managed-config.advanced')).not.toBeNull();
      expect(fieldOf('store')).toBeUndefined();
      expect(form.props.input).toMatchObject({ store: info.limaHome, arch: 'x86_64', vmType: 'qemu', cpus: 4, memoryGiB: 4, diskGiB: 100, mounts: [] });
      expect(form.props.input.image).toBeUndefined();
      expect(form.props.fields.find((field: Readonly<{ path: string }>) => field.path === 'image')).toMatchObject({ required: true,
        description: expect.any(String) });
      expect(createReason()).toBe(screenText.t('session.actionsDraft.validation.requiredField', { field: 'Image location' }));
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
      noUnavailableChoice();
      // The provider's driver refusal names its field even before image completion.
      await act(async () => form.props.onPatch({ vmType: 'vz' }));
      await waitForHomeGovernance(() => expect(optionsAnswer?.base?.available).toBe(false));
      expect(form.props.input.image).toBeUndefined();
      const refusal = optionsAnswer?.base?.unavailableReason;
      expect(refusal).toMatchObject({ code: 'lima_driver_unavailable', fieldPath: 'vmType', status: expect.anything() });
      const refusalCopy = typeof refusal?.status === 'string' ? refusal.status : refusal?.status.fallback;
      await waitForHomeGovernance(() => expect(createReason()).toBe(refusalCopy));
      // A refused field is never hidden in the closed disclosure: it opens on the refusal.
      await waitForHomeGovernance(() => expect(fieldOf('vmType')?.description, JSON.stringify({ refusal,
        visibleFields: screen.tree.findAllByType(ActionInputFields).flatMap(node =>
          node.props.fields.map((field: Readonly<{ path: string }>) => field.path)) })).toBe(refusalCopy));
      await act(async () => screen.changeTextByTestId('managed-config.field:image', 'https://example.test/ubuntu.img'));
      await waitForHomeGovernance(() => expect(createReason()).toBe(refusalCopy));
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
      const imageRows = screen.tree.findAll(node => node.props.testID === 'managed-config.images' && Array.isArray(node.props.images));
      expect(imageRows.flatMap(node => node.props.images).every(row => row.unavailableReason === undefined)).toBe(true);
      await act(async () => form.props.onPatch({ vmType: 'qemu' }));
      await act(async () => screen.changeTextByTestId('managed-config.field:cpus', '2'));
      expect(form.props.input.cpus).toBe(2);
      noUnavailableChoice();
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
      expect(form.props.input).toMatchObject({ cpus: 2, store: info.limaHome, image: 'https://example.test/ubuntu.img', diskGiB: 100 });
      // Refusing a launch that was already chosen: the field and Create say why, and the page draws no second,
      // generic "no longer available" choice for the launch it replaced.
      await act(async () => form.props.onPatch({ vmType: 'vz' }));
      await waitForHomeGovernance(() => expect(createReason()).toBe(refusalCopy));
      expect(screen.findByTestId('managed-config.retained-choice')).toBeNull();
      expect(screen.tree.findAll(node => node.props.kind === 'warning' && node.props.title === screenText.t('managedMachines.options.unavailable'))).toHaveLength(0);
      expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
    } finally { hydration.resolve(); await screen.unmount(); await kit.dispose(); }
  });

  it('shares the picker availability while showing native launch defaults and preserving edits', async () => {
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://native-defaults.example',
      serverIdentityId: 'srv_native_defaults', accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: 'host', installationId: 'installation', activeAt: Date.now() })]);
    const projectionRead = nativeBoundary.rpc.getMockImplementation()!;
    nativeBoundary.rpc.mockImplementation(async request => {
      if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: true,
        inputSchema: { type: 'object', properties: { cpu: { type: 'integer', minimum: 1 } }, additionalProperties: false } };
      const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await projectionRead(request));
      const key = buildQualifiedPluginContributionKey({ pluginId: provisioner.contribution.pluginId, localId: 'options' });
      return { ...response, projection: { ...response.projection, actionsById: { ...response.projection.actionsById,
        [key]: PluginProjectedActionV2Schema.parse({ ...response.projection.actionsById[key],
          inputHints: { fields: [{ path: 'cpu', title: 'CPU cores', widget: 'integer' }] } }),
      } } };
    });
    let checks = 0;
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
      ['machines.provisioners.check', { available: true }],
    ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = readProvisionerRequest(value);
      const answer = actionId === 'machines.provisioners.check' && ++checks > 1 ? { available: false, code: 'lima_2_required' } : result;
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result: answer } } };
    } });
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
      const request = readProvisionerRequest(value);
      const input = request.input as { selectors?: { cpu?: number } };
      return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId, execution: { ok: true,
        result: createMachineProvisionerOptionsFixture({ base: { launch: { cpu: input.selectors?.cpu ?? 6 } } }) } } };
    } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
    const screen = await renderScreen(<><MachineProvisionerPicker serverId={serverId} />
      <ManagedMachineConfigurationView serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} /></>);
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props?.card?.id === buildQualifiedPluginContributionKey(provisioner.contribution)
      && node.props?.card?.status?.tone === 'ready').length).toBeGreaterThan(0));
    expect(screen.tree.findByType(ActionInputFields).props.input.cpu).toBe(6);
    await act(async () => screen.changeTextByTestId('managed-config.field:cpu', '3'));
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    expect(screen.tree.findByType(ActionInputFields).props.input.cpu).toBe(3);
    expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(1);
    await screen.unmount();
  });

  /** P20.9: an Add-to-Preset continuation reopens the one existing editor; only its explicit Save writes. */
  async function mountContinuation(host: string, item: MachinePresetEditContinuation['item']) {
    const initial = await mountAddRoute(host);
    const serverId = route.params.serverId!;
    await initial.unmount();
    // In this editor the Preset name is its launch name, so a draft it handed out carries the same name in both.
    const creation = { launch: { provider: provisioner.contribution, schemaVersion: 1,
      name: 'Unsaved name stays', choices: { cpu: 2 } }, controller: defaultController };
    const retained = { id: 'retained', homeId: 'srv_add_server', revision: 8, name: 'Stored preset name',
      owner: { kind: 'account', accountId: 'owner' }, ...creation, launch: { ...creation.launch, name: 'Stored preset name' } } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    const draft: MachinePresetEditDraft = { name: 'Unsaved name stays', creation,
      setup: { scripts: [{ body: '\r\necho retained\r\n', affects: 'none' }] } };
    const onReturn = vi.fn();
    const continuation = { item, draft, preset: { id: retained.id, revision: retained.revision }, onReturn };
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(retained) } });
    await publishPresetEditorDeclaration(serverId, createMachineProvisionerEditorManifestFixture({ pluginId: provisioner.contribution.pluginId, descriptor: provisioner.descriptor }));
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} presetId={retained.id} presetOnly
      initialController={defaultController} presetContinuation={continuation} />);
    const setup = () => screen.tree.findAll(node => node.props.testID === 'managed-config.setup'
      && typeof node.props.onChange === 'function')[0]?.props.setup;
    const expectedItem = item.kind === 'app' && item.definition.definition.from !== 'catalogApp' && !item.authoredKey
      ? { ...item, authoredKey: expect.any(String) } : item;
    await waitForHomeGovernance(() => expect(setup()).toEqual({ ...draft.setup, items: [expectedItem] }));
    // Return the real authored key in the HTTP save receipt, not an asymmetric matcher.
    const expectedSetup = MachineSetupV1Schema.parse(setup());
    return { screen, setup, expectedSetup, draft, creation, retained, onReturn, serverId };
  }
  // The hand-off carries only App or Software items; a setup recipe is added in the editor itself.
  const appOrSoftware = (value: MachinePresetItemV1) => {
    if (value.kind === 'setupRecipe') throw new Error('Expected an App or Software item');
    return value;
  };
  const softwareItem = appOrSoftware(MachinePresetItemV1Schema.parse({ kind: 'softwareRecipe', selection: {
    ref: { pluginId: 'tools.example', recipeId: 'editor', revision: 'pinned-revision' },
    inputs: { package: { manager: 'brew', brew: { name: 'editor', kind: 'cask', version: '1,2' } } },
  } }));
  const appItem = appOrSoftware(MachinePresetItemV1Schema.parse({ kind: 'app', definition: {
    name: 'Stored app', project: { kind: 'existing', projectSourceId: 'source-app' },
    definition: { from: 'compose', document: 'services:\n  app:\n    image: example/app:1\n', profiles: [], services: ['app'] },
    bindings: [],
  } }));
  const presetWrites = () => [...harness.requestsFor('/v1/machines/presets/create'),
    ...harness.requestsFor('/v1/machines/presets/update'), ...harness.requestsFor('/v1/actions/machines.managed.acquire')];

  it.each([['Software', softwareItem], ['App', appItem]] as const)(
    'keeps an exact %s Add-to-Preset continuation inert until the existing Save, then returns', async (_kind, item) => {
    const { screen, draft, creation, retained, expectedSetup, onReturn, serverId } = await mountContinuation(`continuation-${_kind}`, item);
    harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved',
      preset: createPlainManagedMachinePresetFixture({ ...retained, ...creation, name: draft.name, setup: expectedSetup, revision: 9 }) } });
    // Entering merges the item into the editor's own draft; the caller's draft is not mutated and nothing is written.
    expect(draft.setup).not.toHaveProperty('items');
    expect(presetWrites()).toEqual([]);
    expect(onReturn).not.toHaveBeenCalled();
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
    expect(harness.requestsFor('/v1/machines/presets/update')[0]?.input).toMatchObject({
      homeId: retained.homeId, id: retained.id, expectedRevision: 8,
      patch: { content: { t: 'plain', v: { name: draft.name, setup: expectedSetup, launch: creation.launch } }, controller: creation.controller },
    });
    expect(harness.requestsFor('/v1/machines/presets/create')).toEqual([]);
    await waitForHomeGovernance(() => expect(onReturn).toHaveBeenCalledTimes(1));
    expect(route.replace).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it.each(['ready', 'unavailable', 'retired'] as const)('saves a name edit on an existing Account creation preset exactly once with credential discovery=%s', async discovery => {
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://account-preset-rename.example.test',
      serverIdentityId: 'srv_add_server', accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: defaultController.machineId,
      installationId: defaultController.installationId })]);
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [discovery === 'unavailable'
        ? { ...provisioner, credentialPurposes: undefined } : provisioner] }],
      ['machines.provisioners.check', { available: true }],
      ['machines.provisioners.options', createManagedCpuOptionsFixture([{ id: 'small', title: 'Small server', cpu: 2 }])],
    ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
    } });
    const { ManagedMachinePresetUpdateInputV1Schema, ManagedMachinePresetV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetV1');
    const credentials = discovery === 'retired' ? [{ purpose: { consumer: provisioner.contribution, purpose: 'native-account' },
      account: { service: { pluginId: provisioner.contribution.pluginId, localId: 'native-account' }, accountId: 'retired' } }] : undefined;
    const preset = createPlainManagedMachinePresetFixture({ id: 'account-rename', homeId: 'srv_add_server', revision: 0,
      name: 'Original preset', owner: { kind: 'account', accountId: 'owner' }, controller: defaultController,
      launch: { provider: provisioner.contribution, schemaVersion: 1, name: 'Original preset', choices: { cpu: 2 }, credentials } });
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset } });
    harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved', preset: {
      ...createPlainManagedMachinePresetFixture({ id: preset.id, homeId: preset.homeId, owner: preset.owner, controller: preset.controller,
        name: 'Renamed preset', revision: 1, launch: { ...preset.opened.launch!, name: 'Renamed preset' } }),
    } } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    await publishPresetEditorDeclaration(serverId, createMachineProvisionerEditorManifestFixture({ pluginId: provisioner.contribution.pluginId, descriptor: provisioner.descriptor }));
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} presetId={preset.id} presetOnly
      initialController={defaultController} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    // Native prompt is the platform input boundary; the mounted view owns every draft/save decision.
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.prompt).mockResolvedValueOnce('Renamed preset');
    const rename = screen.tree.findAll(node => typeof node.props.testID === 'string'
      && node.props.testID.endsWith(':rename') && typeof node.props.onPress === 'function')[0];
    expect(rename).toBeDefined();
    await act(async () => rename!.props.onPress());
    expect(screen.getTextContent()).toContain('Renamed preset');
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
    expect(harness.requestsFor('/v1/machines/presets/update')[0]?.input).toMatchObject({
      id: preset.id, expectedRevision: 0, patch: { content: { t: 'plain', v: { name: 'Renamed preset', launch: { name: 'Renamed preset' } } } },
    });
    const renamedContent = ManagedMachinePresetUpdateInputV1Schema.parse(harness.requestsFor('/v1/machines/presets/update')[0]?.input).patch.content;
    if (renamedContent?.t !== 'plain') throw new Error('Plain renamed content expected');
    expect(ManagedMachinePresetContentV1Schema.parse(renamedContent.v).launch?.credentials).toEqual(credentials);
    expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(0);
    await waitForHomeGovernance(() => expect(route.replace).toHaveBeenCalled());
    await screen.unmount();
  });

  it('edits a setup-only preset in the same editor and saves it without creating Machines', async () => {
    const initial = await mountAddRoute('setup-only-edit');
    const serverId = route.params.serverId!;
    await initial.unmount();
    const setupOnly = { id: 'browser-bot', homeId: 'srv_add_server', revision: 4, name: 'Browser bot',
      owner: { kind: 'account', accountId: 'owner' }, setup: { scripts: [{ body: 'echo one', affects: 'none' }] } } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(setupOnly) } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    // A setup-only preset has no provisioner: the editor opens on its setup, never on a provider catalog.
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner=""
      presetId={setupOnly.id} presetOnly />);
    const section = () => screen.tree.findAll(node => node.props.testID === 'managed-config.setup'
      && typeof node.props.onChange === 'function')[0]?.props as { setup?: unknown; onChange: (next: unknown) => void } | undefined;
    await waitForHomeGovernance(() => expect(section()?.setup).toEqual(setupOnly.setup));
    expect(screen.findByTestId('managed-config.catalog')).toBeFalsy();
    const edited = { scripts: [{ body: 'echo two', affects: 'none' }] } satisfies NonNullable<Parameters<typeof createPlainManagedMachinePresetFixture>[0]['setup']>;
    await act(async () => { section()!.onChange(edited); });
    harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture({ ...setupOnly, setup: edited, revision: 5 }) } });
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
    // The update keeps it setup-only: no launch or controller is written.
    expect(harness.requestsFor('/v1/machines/presets/update')[0]?.input).toMatchObject({
      id: setupOnly.id, expectedRevision: 4, patch: { content: { t: 'plain', v: { name: 'Browser bot', setup: edited } }, controller: null },
    });
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
    await screen.unmount();
  });

  it('starts a setup-only preset from an Add-to-Preset continuation and saves the item only on Save', async () => {
    const initial = await mountAddRoute('setup-only-continuation');
    const serverId = route.params.serverId!;
    await initial.unmount();
    const setupOnly = { id: 'research', homeId: 'srv_add_server', revision: 2, name: 'Research bot',
      owner: { kind: 'account', accountId: 'owner' }, setup: MachineSetupV1Schema.parse({ scripts: [{ body: 'echo one', affects: 'none' }] }) } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(setupOnly) } });
    const onReturn = vi.fn();
    const continuation = { item: softwareItem, draft: { name: setupOnly.name, setup: setupOnly.setup },
      preset: { id: setupOnly.id, revision: setupOnly.revision }, onReturn };
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner=""
      presetId={setupOnly.id} presetOnly presetContinuation={continuation} />);
    const setup = () => screen.tree.findAll(node => node.props.testID === 'managed-config.setup'
      && typeof node.props.onChange === 'function')[0]?.props.setup;
    await waitForHomeGovernance(() => expect(setup()).toEqual({ ...setupOnly.setup, items: [softwareItem] }));
    expect(presetWrites()).toEqual([]);
    const saved = MachineSetupV1Schema.parse(setup());
    harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture({ ...setupOnly, setup: saved, revision: 3 }) } });
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
    expect(harness.requestsFor('/v1/machines/presets/update')[0]?.input).toMatchObject({
      id: setupOnly.id, expectedRevision: 2, patch: { content: { t: 'plain', v: { setup: saved } }, controller: null } });
    await waitForHomeGovernance(() => expect(onReturn).toHaveBeenCalledTimes(1));
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
    await screen.unmount();
  });

  it('returns from a setup-only preset continuation on Cancel without writing anything', async () => {
    const initial = await mountAddRoute('setup-only-continuation-cancel');
    const serverId = route.params.serverId!;
    await initial.unmount();
    const setupOnly = { id: 'research', homeId: 'srv_add_server', revision: 2, name: 'Research bot',
      owner: { kind: 'account', accountId: 'owner' }, setup: MachineSetupV1Schema.parse({ scripts: [{ body: 'echo one', affects: 'none' }] }) } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(setupOnly) } });
    const onReturn = vi.fn();
    const continuation = { item: softwareItem, draft: { name: setupOnly.name, setup: setupOnly.setup },
      preset: { id: setupOnly.id, revision: setupOnly.revision }, onReturn };
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner=""
      presetId={setupOnly.id} presetOnly presetContinuation={continuation} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.continuation-cancel')).toBeTruthy());
    await act(async () => screen.pressByTestId('managed-config.continuation-cancel'));
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(presetWrites()).toEqual([]);
    await screen.unmount();
  });

  it('returns from an Add-to-Preset continuation on Cancel without writing anything', async () => {
    const { screen, onReturn } = await mountContinuation('continuation-cancel', softwareItem);
    await act(async () => screen.pressByTestId('managed-config.continuation-cancel'));
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(presetWrites()).toEqual([]);
    await screen.unmount();
  });

  it('keeps the Add-to-Preset draft and exact revision after the existing Save reports a conflict', async () => {
    const { screen, setup, draft, expectedSetup, onReturn, serverId } = await mountContinuation('continuation-conflict', softwareItem);
    harness.answer(serverId, '/v1/machines/presets/update', { status: 409, body: { kind: 'conflict', currentRevision: 9 } });
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
    expect(harness.requestsFor('/v1/machines/presets/update')[0]?.input).toMatchObject({
      id: 'retained', expectedRevision: 8, patch: { content: { t: 'plain', v: { name: draft.name, setup: expectedSetup } } },
    });
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    expect(setup()).toEqual(expectedSetup);
    expect(onReturn).not.toHaveBeenCalled();
    expect(harness.requestsFor('/v1/machines/presets/create')).toEqual([]);
    await screen.unmount();
  });

  async function answerAcquireController(serverId: string) {
    return await answerExternalActionAccountForHome(harness, serverId, {
      actionId: 'machines.managed.acquire', machineId: 'host', installationId: 'installation', tokenEpoch: 0,
      execute: () => { throw new Error('The scenario must supply its acquire HTTP response'); },
    });
  }

  /** The Add route over one controller that offers one small size, ready to Create once it is chosen. */
  async function mountAddRoute(
    host: string,
    enrollmentRole: 'server' | 'personal' | 'sandbox' = 'server',
    guestPlatform: 'linux' | 'darwin' | 'windows' = 'linux',
    optionEnrollmentRole?: 'server' | 'personal' | 'sandbox',
    choose = true,
    imageChoice = false,
    presets?: readonly Parameters<typeof createPlainManagedMachinePresetFixture>[0][],
  ) {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: `https://${host}.example`,
      serverIdentityId: 'srv_add_server',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
      createMachineFixture({ id: 'host', installationId: 'installation' }),
    ]);
    route.params = {
      serverId,
      provisioner: buildQualifiedPluginContributionKey(
        provisioner.contribution,
      ),
      machineId: 'host',
      installationId: 'installation',
    };
    const nativeOptions = createManagedCpuOptionsFixture([
      { id: 'small', title: 'Small server', cpu: 2 },
    ]);
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        {
          controller: defaultController,
          provisioners: [
            {
              ...provisioner,
              descriptor: { ...provisioner.descriptor, enrollmentRole },
            },
          ],
        },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        {
          ...nativeOptions,
          dimensions: {
            ...nativeOptions.dimensions,
            image: imageChoice
              ? [{ id: 'linux-image', title: 'Linux', assignments: [], guestPlatform: 'linux' as const }]
              : [],
          },
          base: {
            ...nativeOptions.base,
            guestPlatform,
            ...(optionEnrollmentRole
              ? { enrollmentRole: optionEnrollmentRole }
              : {}),
          },
        },
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const acquireController = await answerAcquireController(serverId);
    harness.answer(serverId, 'POST /v1/actions/machines.managed.acquire', {
      status: 403,
      body: { code: 'permission_denied' },
    });
    if (presets) {
      const { ManagedMachinePresetAcquireRoutingInputV1Schema, ManagedMachinePresetAcquireRoutingResultV1Schema } =
        await import('@happier-dev/protocol/machines/managed/managedMachinePresetV1');
      harness.answer(serverId, '/v1/machines/presets/resolve-acquire', { select: input => {
        const selected = ManagedMachinePresetAcquireRoutingInputV1Schema.parse(input);
        expect(presets.some(preset => preset.id === selected.id && preset.revision === selected.revision)).toBe(true);
        return { body: ManagedMachinePresetAcquireRoutingResultV1Schema.parse({ kind: 'resolved', controller: defaultController,
          controllerAccess: { installationPublicKey: encodeBase64(decodeBase64(acquireController.machine.installationPublicKey, 'base64'), 'base64url'),
            custodian: { accountId: 'owner' } } }) };
      } });
      harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: presets.map(preset => createPlainManagedMachinePresetFixture(preset)) } });
      harness.answer(serverId, '/v1/machines/presets/get', { select: (input: unknown) => ({
        body: { kind: 'found', preset: (() => { const selected = presets.find(preset => preset.id === (input as { id?: string }).id); return selected ? createPlainManagedMachinePresetFixture(selected) : undefined; })() } }) });
    }
    const { WorkspaceRouteBody } =
      await import('@/app/(app)/settings/machines/add/[provisioner]');
    const screen = await renderScreen(<WorkspaceRouteBody />);
    await waitForHomeGovernance(() =>
      expect({
        size: screen.findByTestId('managed-config.sizes:small') !== null,
        failures: screen.tree.findAll(node => typeof node.props?.diagnosticCode === 'string').map(node => node.props.diagnosticCode),
        text: screen.findByTestId('managed-config.sizes:small') ? '' : screen.getTextContent(),
      }).toEqual({ size: true, failures: [], text: '' }),
    );
    if (choose)
      await act(async () =>
        screen.pressByTestIdAsync('managed-config.sizes:small'),
      );
    return screen;
  }
  const createDisabled = (screen: Awaited<ReturnType<typeof mountAddRoute>>) =>
    screen.findByTestId('managed-config.create')?.props.disabled;
  const acquiredIdentity = () =>
    readProvisionerRequest(
      ExternalActionExecutionAuthorizationRequestV1Schema.parse(
        harness.requestsFor('/v1/actions/machines.managed.acquire')[0]?.input,
      ).envelope,
    ).input;
  it.each(['owner', 'authored'] as const)('presents an acquire Action failure through its %s cause', async (cause) => {
    const screen = await mountAddRoute('typed-acquire-failure');
    const serverId = route.params.serverId!;
    const { t } = await import('@/text');
    const { PluginError } = await import('@happier-dev/plugin-sdk/errors');
    const { readPluginActionError } = await import('@happier-dev/protocol/plugins/actions/invocation');
    const authored = readPluginActionError(new PluginError({ code: 'credential_unavailable',
      message: 'Sign in to Docker: run sbx login', remediation: { kind: 'retry' },
      details: { privateNativeOutput: 'PRIVATE_PROVIDER_OUTPUT' } }));
    if (!authored) throw new Error('Expected the provider PluginError contract');
    harness.answer(serverId, 'POST /v1/actions/machines.managed.acquire', { select: value => {
      const { envelope: request } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(value);
      return { body: { v: 1, actionId: 'machines.managed.acquire', requestId: request.requestId,
        execution: { ok: false, errorCode: cause === 'authored' ? authored.code : 'action_failed', error: 'Private native diagnostic',
          ...(cause === 'authored' ? { details: authored.data } : {}),
          failureCause: { phase: 'machines.managed.acquire', errorClass: 'ManagedMachineControllerError',
            errorCode: 'credential_scope_denied', httpStatus: null } } } };
    } });
    try {
      await waitForHomeGovernance(() => expect(createDisabled(screen)).toBe(false));
      await screen.pressByTestIdAsync('managed-config.create');
      await waitForHomeGovernance(() => {
        expect(screen.findByTestId('managed-config.error')).not.toBeNull();
        expect(screen.getTextContent()).toContain(cause === 'authored'
          ? `Sign in to Docker: run sbx login ${t('errors.tryAgain')}` : t('errors.permissionDenied'));
        const diagnostic = screen.tree.findAll(node => typeof node.props.diagnosticDetail === 'string')
          .map(node => node.props.diagnosticDetail).join('\n');
        expect(diagnostic).toContain('credential_scope_denied');
        expect(diagnostic).toContain('ManagedMachineControllerError');
        expect(screen.getTextContent()).not.toContain('Private native diagnostic');
        expect(screen.getTextContent()).not.toContain('PRIVATE_PROVIDER_OUTPUT');
      });
    } finally { await screen.unmount(); }
  });
  it('offers the same provider repair from a refused acquire', async () => {
    const screen = await mountAddRoute('native-acquire-repair');
    const serverId = route.params.serverId!;
    const { PluginError } = await import('@happier-dev/plugin-sdk/errors');
    const { ManagedMachineControllerError } = await import('@happier-dev/cli-common/machines/managed');
    const { normalizeActionExecutorThrownError } = await import('@happier-dev/protocol/actions/executor/resultProjection');
    const pluginId = provisioner.contribution.pluginId;
    const requirement = { pluginId, localId: 'docker-sandboxes-cli' };
    const failure = new PluginError({ code: 'credential_unavailable', message: 'Sign in to Docker',
      details: { available: false, code: 'credential_unavailable',
        prerequisites: [{ requirement: { kind: 'managedDependency', id: requirement },
          status: 'unavailable', reason: 'Sign in to Docker', repairAction: { action: { pluginId, localId: 'sign-in' }, input: {} } }] } });
    const actionId = 'machines.managed.acquire';
    const error = ManagedMachineControllerError.fromActionFailure({ ok: false, errorCode: failure.code,
      error: failure.message, details: failure.data }, actionId);
    const execution = { ok: false, ...normalizeActionExecutorThrownError(error, actionId) };
    harness.answer(serverId, 'POST /v1/actions/machines.managed.acquire', { select: value => {
      const { envelope: request } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution } };
    } });
    try {
      await waitForHomeGovernance(() => expect(createDisabled(screen)).toBe(false));
      await screen.pressByTestIdAsync('managed-config.create');
      await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Sign in to Docker'));
      expect(screen.findByTestId(`managed-config.repair:managedDependency:${buildQualifiedPluginContributionKey(requirement)}`)?.props.onPress)
        .toEqual(expect.any(Function));
    } finally { await screen.unmount(); }
  });

  it('returns the admitted managed resource to its retained creation host without navigating away', async () => {
    const initial = await mountAddRoute('retained-create');
    const serverId = route.params.serverId!;
    await initial.unmount();
    harness.answer(serverId, 'POST /v1/actions/machines.managed.acquire', { select: value => {
      const authorization = ExternalActionExecutionAuthorizationRequestV1Schema.parse(value);
      const request = readProvisionerRequest(authorization.envelope);
      return { body: { v: 1, actionId: 'machines.managed.acquire', requestId: request.requestId,
        execution: { ok: true, result: { managedId: 'retained-resource' } } } };
    } });
    // Admission already owns the resource even if its subsequent continuation cannot read it.
    harness.answer(serverId, '/v1/actions/machines.managed.get', { status: 403, body: { code: 'permission_denied' } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const onCreated = vi.fn();
    const onCancel = vi.fn();
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController}
      onCreated={onCreated} onCancel={onCancel} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.sizes:small')).not.toBeNull());
      await screen.pressByTestIdAsync('managed-config.sizes:small');
      await waitForHomeGovernance(() => expect(createDisabled(screen)).toBe(false));
      expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
      await screen.pressByTestIdAsync('managed-config.continuation-cancel');
      expect(onCancel).toHaveBeenCalledOnce();
      expect(screen.findByTestId('managed-config.save-preset')).not.toBeNull();
      await screen.pressByTestIdAsync('managed-config.create');
      await waitForHomeGovernance(() => expect(onCreated).toHaveBeenCalledWith({ serverId: 'srv_add_server', managedId: 'retained-resource' }));
      expect(route.replace).not.toHaveBeenCalled();
      expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(1);
    } finally { await screen.unmount(); }
  });
  it.each(['mounted', 'unmounted'] as const)('answers admitted requester pairing from configurator Create without mounting the detail page (%s)', async visibility => {
    const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const token = createAccountTokenForTests('owner', { currentAccount: true });
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://configurator-pairing.example.test',
      serverIdentityId: 'srv_add_server', accountId: 'owner', currentAccount: true, teamsEnabled: true, credentials: { token } });
    const { teamSummaryFixture, teamCapabilitiesFixture } = await import('@/dev/testkit/fixtures/teamFixtures');
    harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ id: 'team-1', viewerRole: 'member', capabilities: teamCapabilitiesFixture({}) }) });
    const key = encodeBase64(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey, 'base64url');
    const saved = createDelegatedManagedPresetFixture({ descriptor: provisioner.descriptor, installationPublicKey: key,
      custodianAccountId: 'company', preset: { id: 'pairing-preset', homeId: 'srv_add_server', revision: 0,
        name: 'Shared machine', owner: { kind: 'team', teamId: 'team-1' }, controller: defaultController,
        launch: { provider: provisioner.contribution, schemaVersion: 1, name: 'Shared machine', choices: { cpu: 2 } } } });
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
    harness.answer(serverId, '/v1/machines/presets/resolve-acquire', { body: { kind: 'resolved', controller: defaultController,
      controllerAccess: saved.opened.controllerAccess } });
    let answered = false;
    const promptArrival = createDeferred<void>();
    if (visibility === 'mounted') promptArrival.resolve();
    const { ManagedMachinePublicFullV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
    const { ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
    const machine = ManagedMachinePublicFullV1Schema.parse({ id: 'pairing-resource', homeId: 'srv_add_server',
      custodianAccountId: 'company', enrollmentAccountId: 'owner', controller: defaultController,
      controllerAccess: { installationPublicKey: key, custodian: { accountId: 'company' } },
      launch: { provider: provisioner.contribution, schemaVersion: 1, name: 'Pairing', choices: {} },
      allocation: 'bound', creationState: 'active', resource: { contributionRef: provisioner.contribution, schemaVersion: 1, value: {} },
      desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const { installManagedInstallationResponseBoundary } = await import('@/dev/testkit/harness/managedInstallationResponseBoundary');
    const installationBoundary = installManagedInstallationResponseBoundary({ homes: harness, serverId,
      serverUrl: 'https://configurator-pairing.example.test', homeId: 'srv_add_server', token, enrollmentAccountId: 'owner',
      readMachine: () => machine, onAnswer: () => { answered = true; } });
    const answers = installationBoundary.answers;
    const operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'pairing-operation', revision: 1,
      actionId: 'machines.managed.acquire', state: 'running', scope: { accountId: 'owner', machineId: 'host' },
      title: 'Create pairing', createdAt: 1, startedAt: 2, cancellation: 'supported',
      domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller: defaultController,
        bootstrapTask: { id: 'pairing-task', taskKind: 'remote.ssh.bootstrapMachine.v1',
          prompt: { kind: 'auth.approveRemoteProvisioning', message: 'Sign into requester Account' } } } });
    for (const actionId of ['machines.managed.acquire', 'machines.managed.get', 'action.operations.get', 'machines.managed.bootstrap.respond']) {
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: async value => {
        if (actionId === 'action.operations.get' && !answered) await promptArrival.promise;
        const envelope = readProvisionerRequest(value && typeof value === 'object' && 'envelope' in value ? value.envelope : value);
        if (actionId === 'machines.managed.bootstrap.respond') answered = true;
        const result = actionId === 'machines.managed.acquire' ? { managedId: machine.id, operation: { operationId: operation.operationId } }
          : actionId === 'machines.managed.get' ? machine
          : actionId === 'action.operations.get' ? { kind: 'found', operation: answered
            ? { ...operation, revision: 2, state: 'succeeded', settledAt: 3, domainRef: { ...operation.domainRef, bootstrapTask: undefined } } : operation }
          : {};
        return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } } };
      } });
    }
    const { ExternalActionExecutionAuthorizationV1Schema, projectExternalActionManagedAdmissionV1 } = await import('@happier-dev/protocol/actions/externalActionApi');
    const { computeExternalActionRequestEnvelopeDigestV1 } = await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
    for (const actionId of ['machines.managed.acquire', 'action.operations.get', 'machines.managed.bootstrap.respond']) {
      harness.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: value => {
        const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(value);
        const managedAdmission = actionId === 'machines.managed.acquire' ? undefined
          : envelope.v === 1 ? projectExternalActionManagedAdmissionV1(actionId, envelope.input) : envelope.managedAdmission;
        return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'pairing-authorization', binding: {
          serverIdentityId: 'srv_add_server', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
          machineId: 'host', installationId: 'installation', custodianAccountId: 'company', accountEncryptionMode: 'plain',
          actionId, requestId: envelope.requestId, target: envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), ...(managedAdmission ? { managedAdmission } : {}),
          ...(actionId === 'machines.managed.acquire' ? { managedAcquireDelegation: true } : {}) } }) };
      } });
    }
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} presetId={saved.id} />);
    let unmounted = false;
    try {
      await waitForHomeGovernance(() => expect(createDisabled(screen)).toBe(false));
      await screen.pressByTestIdAsync('managed-config.create');
      await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.managed.acquire'), JSON.stringify({ paths: harness.requests.map(request => request.path), errors: screen.tree.findAll(node => node.props.testID === 'managed-config.error').map(node => ({ code: node.props.diagnosticCode, detail: node.props.diagnosticDetail })) })).toHaveLength(1));
      if (visibility === 'unmounted') {
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/action.operations.get')).toHaveLength(1));
        await screen.unmount(); unmounted = true;
        promptArrival.resolve();
      }
      await waitForHomeGovernance(() => expect(answers).toHaveLength(1));
      expect(answers).toContainEqual(expect.objectContaining({ managedId: machine.id, operationId: operation.operationId,
        taskId: 'pairing-task', answer: { approved: true } }));
    } finally { promptArrival.resolve(); if (!unmounted) await screen.unmount(); installationBoundary.dispose(); }
  });
  it('names the unfinished choice instead of saying it is no longer available', async () => {
    const screen = await mountAddRoute('unfinished-choice', 'personal', 'linux', undefined, false);
    const { ManagedMachineConfigurator } = await import('./ManagedMachineConfigurator');
    const { t } = await import('@/text');
    const reason = () => screen.tree.findByType(ManagedMachineConfigurator).props.receipt.primary.footnote;
    await waitForHomeGovernance(() => expect(reason()).toBe(t('session.actionsDraft.validation.requiredField', { field: t('managedMachines.config.size') })));
    expect(createDisabled(screen)).toBe(true);
    await screen.pressByTestIdAsync('managed-config.sizes:small');
    await waitForHomeGovernance(() => expect(createDisabled(screen)).toBe(false));
    await screen.unmount();
  });
  it.each([
    [
      'personal',
      'darwin',
      { kind: 'existingUser', role: 'personal' },
      'runsAsAccount',
      'runsAsAccountDescription',
    ],
    [
      'server',
      'windows',
      { kind: 'existingUser', role: 'personal' },
      'runsAsAccount',
      'notLinux',
    ],
    [
      'sandbox',
      'linux',
      { kind: 'guestProcess', role: 'sandbox' },
      'runsInSandbox',
      'runsInSandboxDescription',
    ],
  ] as const)(
    'creates the declared %s / %s guest without dedicated administrator choices',
    async (role, platform, identity, line, reason) => {
      const screen = await mountAddRoute(`add-${role}`, role, platform);
      await waitForHomeGovernance(() =>
        expect(createDisabled(screen)).toBe(false),
      );
      expect(
        screen.findByTestId('managed-config.admin-access:preauthorized'),
      ).toBeNull();
      // How Happier runs there is still said, read-only; a server image that can't host its own user says why and what to do.
      const { t } = await import('@/text');
      expect(
        screen.findByTestId('managed-config.identity.runs-as'),
      ).not.toBeNull();
      expect(screen.getTextContent()).toContain(
        t(`managedMachines.identity.${line}`),
      );
      expect(screen.getTextContent()).toContain(
        t(`managedMachines.identity.${reason}`),
      );
      await act(async () => screen.pressByTestIdAsync('managed-config.create'));
      await waitForHomeGovernance(() =>
        expect(
          harness.requestsFor('/v1/actions/machines.managed.acquire'),
          `${screen.getTextContent()} Requests: ${harness.requests.map(request => request.path).join(', ')}`,
        ).toHaveLength(1),
      );
      expect(acquiredIdentity()).toMatchObject({
        enrollmentIdentity: identity,
      });
      await screen.unmount();
    },
  );
  it('keeps the identity section out until there is a guest image to choose, instead of asking for one that does not exist', async () => {
    const screen = await mountAddRoute(
      'add-server-no-image',
      'server',
      'linux',
      undefined,
      false,
    );
    const { t } = await import('@/text');
    expect(screen.findByTestId('managed-config.identity')).toBeNull();
    expect(screen.getTextContent()).not.toContain(
      t('managedMachines.identity.guestPlatformPending'),
    );
    await screen.unmount();
  });
  it('reserves a declared server identity section and asks for the guest image, not its selected controller', async () => {
    const screen = await mountAddRoute(
      'add-server-pending',
      'server',
      'linux',
      undefined,
      false,
      true,
    );
    const { t } = await import('@/text');
    expect(
      screen.findByTestId('managed-config.admin-access:preauthorized'),
    ).toBeNull();
    expect(
      screen.findByTestId('managed-config.identity.pending'),
    ).not.toBeNull();
    expect(screen.getTextContent()).toContain(
      t('managedMachines.identity.guestPlatformPending'),
    );
    await act(async () =>
      screen.pressByTestIdAsync('managed-config.sizes:small'),
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('managed-config.admin-access:preauthorized'),
      ).not.toBeNull(),
    );
    expect(screen.findByTestId('managed-config.identity.pending')).toBeNull();
    await screen.unmount();
  });
  it('creates with the selected sandbox role instead of the server descriptor without administrator choices', async () => {
    const screen = await mountAddRoute(
      'add-selected-sandbox',
      'server',
      'linux',
      'sandbox',
    );
    await waitForHomeGovernance(() =>
      expect(createDisabled(screen)).toBe(false),
    );
    expect(
      screen.findByTestId('managed-config.admin-access:preauthorized'),
    ).toBeNull();
    await act(async () => screen.pressByTestIdAsync('managed-config.create'));
    await waitForHomeGovernance(() =>
      expect(
        harness.requestsFor('/v1/actions/machines.managed.acquire'),
      ).toHaveLength(1),
    );
    expect(acquiredIdentity()).toMatchObject({
      enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
    });
    await screen.unmount();
  });
  it('creates from the Add route with the dedicated Preauthorized server draft instead of refusing missing identity review', async () => {
    const screen = await mountAddRoute('add-server');
    await waitForHomeGovernance(() =>
      expect(createDisabled(screen)).toBe(false),
    );
    // The disclosed default is the selected choice, not an unreviewed hidden value.
    expect(
      screen.findByTestId('managed-config.admin-access:preauthorized')?.props
        .accessibilityState,
    ).toMatchObject({ checked: true });
    await act(async () => screen.pressByTestIdAsync('managed-config.create'));
    expect(screen.getTextContent()).not.toContain(
      'enrollment_identity_review_required',
    );
    await waitForHomeGovernance(() =>
      expect(
        harness.requestsFor('/v1/actions/machines.managed.acquire'),
      ).toHaveLength(1),
    );
    expect(acquiredIdentity()).toMatchObject({
      enrollmentIdentity: {
        kind: 'dedicatedDaemonUser',
        username: 'happier',
        serviceMode: 'user',
        role: 'server',
        adminAccessAtCreation: 'preauthorized',
      },
      selection: { kind: 'one-off', homeId: 'srv_add_server' },
    });
    // A refused Create says the machine wasn't created, not that the choices couldn't be read, and offers no re-read.
    const { t } = await import('@/text');
    const errorCard = () =>
      screen.tree.findAll(
        (node) =>
          node.props.testID === 'managed-config.error' &&
          node.props.title !== undefined,
      )[0];
    await waitForHomeGovernance(() =>
      expect(errorCard()?.props.title).toBe(
        t('managedMachines.options.createFailed'),
      ),
    );
    expect(errorCard()?.props.action).toBeUndefined();
    await screen.unmount();
  });
  it('starts from a saved preset inline, reviews what it sets up and creates only after the confirm', async () => {
    const launch = { provider: provisioner.contribution, schemaVersion: 1, name: 'web-2', choices: { cpu: 2 } };
    const owner = { kind: 'account' as const, accountId: 'owner' };
    const setup = { items: [MachinePresetItemV1Schema.parse({ kind: 'softwareRecipe', selection: {
      ref: { pluginId: 'tools.example', recipeId: 'editor', revision: 'pinned' }, inputs: {} } })],
      scripts: [{ body: 'corepack enable\npnpm install', affects: 'none' as const }] };
    const screen = await mountAddRoute('start-from', 'server', 'linux', undefined, true, false, [
      { id: 'hardened', homeId: 'srv_add_server', revision: 3, name: 'Hardened server', owner, controller: defaultController, launch, setup },
      { id: 'other-provider', homeId: 'srv_add_server', revision: 1, name: 'Other provider', owner, controller: defaultController,
        launch: { ...launch, provider: { pluginId: 'custom.compute', localId: 'other' } } },
      { id: 'retired', homeId: 'srv_add_server', revision: 1, name: 'Retired', owner, controller: defaultController, launch, archivedAt: 1 },
      { id: 'setup-only', homeId: 'srv_add_server', revision: 1, name: 'Setup only', owner, setup },
    ]);
    const checked = (id: string) => screen.findByTestId(`managed-config.start-from:${id}`)?.props.accessibilityState?.checked;
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.start-from:hardened')).not.toBeNull());
    expect(checked('hand')).toBe(true);
    for (const hidden of ['other-provider', 'retired', 'setup-only'])
      expect(screen.findByTestId(`managed-config.start-from:${hidden}`)).toBeNull();
    await act(async () => screen.pressByTestIdAsync('managed-config.start-from:hardened'));
    await waitForHomeGovernance(() => expect(checked('hardened')).toBe(true));
    await waitForHomeGovernance(() => expect(createDisabled(screen)).toBe(false));
    const { Modal } = await import('@/modal');
    const show = vi.mocked(Modal.show);
    show.mockClear();
    await act(async () => screen.pressByTestIdAsync('managed-config.create'));
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
    expect(show).toHaveBeenCalledTimes(1);
    const shown = show.mock.calls[0]![0] as unknown as Readonly<{ component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> }>;
    const setChrome = vi.fn();
    const review = await renderScreen(<shown.component {...shown.props} setChrome={setChrome} onClose={() => {}} />);
    await waitForHomeGovernance(() => expect(review.getTextContent()).toContain('editor'));
    // The server line is its spec, not the machine's name.
    expect(String(review.findByTestId('managed-config.review.server')?.props.subtitle ?? '')).not.toContain('Hardened server');
    const chrome = setChrome.mock.calls.at(-1)![0] as { footer: React.ReactElement<{ primary: { onPress(): void } }> };
    await act(async () => chrome.footer.props.primary.onPress());
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(1));
    expect(acquiredIdentity()).toMatchObject({ selection: { kind: 'preset', homeId: 'srv_add_server', id: 'hardened', revision: 3 } });
    // The Machine gets the provider's default name, as a one-off Create does, never the preset's.
    expect(acquiredIdentity()).toMatchObject({ presetContentOverride: { content: { t: 'plain', v: { launch: { name: 'Virtual machine' } } } } });
    expect(acquiredIdentity()).not.toHaveProperty('selection.name');
    expect(review.getTextContent()).not.toContain('web-2');
    // The script the person approves is shown by its lines.
    expect(review.getTextContent()).toContain('corepack enable');
    await review.unmount();
    await screen.unmount();
  });
  it('reviews what a preset sets up on the composer Use path before handing over the draft', async () => {
    const launch = { provider: provisioner.contribution, schemaVersion: 1, name: 'web-2', choices: { cpu: 2 } };
    const setup = { items: [MachinePresetItemV1Schema.parse({ kind: 'softwareRecipe', selection: {
      ref: { pluginId: 'tools.example', recipeId: 'editor', revision: 'pinned' }, inputs: {} } })] };
    const mounted = await mountAddRoute('use-review', 'server', 'linux', undefined, true, false, [
      { id: 'hardened', homeId: 'srv_add_server', revision: 3, name: 'Hardened server', owner: { kind: 'account', accountId: 'owner' },
        controller: defaultController, launch, setup },
    ]);
    await mounted.unmount();
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const onUse = vi.fn();
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={route.params.serverId as string}
      provisioner={route.params.provisioner as string} initialController={defaultController} presetId="hardened" onUse={onUse} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false));
    const { Modal } = await import('@/modal');
    const show = vi.mocked(Modal.show);
    show.mockClear();
    await act(async () => screen.pressByTestIdAsync('managed-config.use'));
    expect(onUse).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledTimes(1);
    const shown = show.mock.calls[0]![0] as unknown as Readonly<{ component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> }>;
    expect(shown.props).toMatchObject({ preset: { name: 'Hardened server', revision: 3 }, setup });
    const setChrome = vi.fn();
    const review = await renderScreen(<shown.component {...shown.props} setChrome={setChrome} onClose={() => {}} />);
    expect(review.findByTestId('managed-config.review')).not.toBeNull();
    expect(review.getTextContent()).toContain('editor');
    expect(onUse).not.toHaveBeenCalled();
    const chrome = setChrome.mock.calls.at(-1)![0] as { footer: React.ReactElement<{ primary: { onPress(): void } }> };
    await act(async () => chrome.footer.props.primary.onPress());
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({
      selection: expect.objectContaining({ kind: 'preset', homeId: 'srv_add_server', id: 'hardened', revision: 3 }),
    }));
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
    await review.unmount();
    await screen.unmount();
  });
  it('makes a free-form host\u2019s own size fields its one Size choice instead of echoing them as a one-row table', async () => {
    const viewport = vi
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://free-form.example',
      serverIdentityId: 'srv_free_form',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const optionsSchema = {
      type: 'object',
      properties: {
        size: {
          type: 'object',
          properties: {
            cpu: { type: 'integer', minimum: 1 },
            diskBytes: { type: 'integer', minimum: 1 },
          },
          required: ['cpu'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
    const native = {
      ...provisioner,
      descriptor: {
        ...provisioner.descriptor,
        billing: { location: 'local', stoppedBilling: 'not-billed' },
        launchSchema: {
          type: 'object',
          properties: {
            on: { type: 'string', enum: ['local'] },
            ...optionsSchema.properties,
          },
          required: ['on', 'size'],
          additionalProperties: false,
        },
      },
    };
    const action = PluginProjectedActionV2Schema.parse({
      id: 'options',
      pluginId: provisioner.contribution.pluginId,
      occurrenceId: provisioner.occurrenceId,
      title: 'Native options',
      scopes: ['machine'],
      surfaces: ['cli', 'plugin'],
      execution: { target: 'daemon' },
      available: true,
      dangerLevel: 'safe',
      // Like Cua's space: the disk is part of the size, optional, and only assigned once given.
      inputHints: {
        fields: [
          {
            path: 'size.cpu',
            title: 'CPU cores',
            widget: 'integer',
            required: true,
            defaultValue: 2,
          },
          { path: 'size.diskBytes', title: 'Disk', widget: 'integer' },
        ],
      },
    });
    const projection =
      DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1,
        projection: {
          ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
          agentsById: {},
          diagnostics: [],
          installedPackagesById: {
            [action.pluginId]: {
              ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE
                .installedPackagesById['acme.review'],
              id: action.pluginId,
            },
          },
          actionsById: {
            [buildQualifiedPluginContributionKey({
              pluginId: action.pluginId,
              localId: action.id,
            })]: action,
          },
        },
      });
    nativeBoundary.rpc.mockImplementation(
      async (request: { method: string }) =>
        request.method ===
        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
          ? projection
          : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
            ? { ok: true, inputSchema: optionsSchema }
            : { ok: false, code: 'unsupported' },
    );
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [native] },
      ],
      ['machines.provisioners.check', { available: true }],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    // Like Cua: the answer echoes the asked size as the one size row, assigning exactly what the form sent.
    let answerGate: Promise<void> | null = null;
    const answeredCpus: number[] = [];
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.options', {
      select: async (value) => {
        if (answerGate) await answerGate;
        const request = readProvisionerRequest(value);
        const cpu =
          (request.input as { selectors?: { size?: { cpu?: number } } })
            .selectors?.size?.cpu ?? 1;
        answeredCpus.push(cpu);
        return {
          body: {
            v: 1,
            actionId: 'machines.provisioners.options',
            requestId: request.requestId,
            execution: {
              ok: true,
              result: createMachineProvisionerOptionsFixture({
                base: { launch: { on: 'local' } },
                dimensions: {
                  image: [],
                  location: [],
                  network: [],
                  duration: [],
                  size: [
                    {
                      id: `${cpu}cpu`,
                      title: `${cpu} CPU`,
                      assignments: [{ path: 'size.cpu', value: cpu }],
                      nativeFacts: {
                        size: {
                          id: `${cpu}cpu`,
                          title: `${cpu} CPU`,
                          cpuCores: cpu,
                        },
                      },
                    },
                  ],
                },
              }),
            },
          },
        };
      },
    });
    const onUse = vi.fn<(draft: ManagedMachineSelectionDraft) => void>();
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={defaultController}
        onUse={onUse}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(
        false,
      ),
    );
    // One Size choice: the form's field, inside the Size section; no table repeating it as a single row.
    const sizeSection = screen.findByTestId('managed-config.size');
    expect(sizeSection).not.toBeNull();
    expect(
      sizeSection!.findAll(
        (node) => node.props.testID === 'managed-config.field:size.cpu',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      sizeSection!.findAll(
        (node) => node.props.testID === 'managed-config.field:size.diskBytes',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.tree.findAll(
        (node) =>
          node.props.testID === 'managed-config.sizes' &&
          typeof node.props.onChange === 'function',
      ),
    ).toHaveLength(0);
    await act(async () => screen.pressByTestId('managed-config.use'));
    expect(onUse.mock.calls.at(-1)?.[0]).toMatchObject({
      selection: {
        kind: 'one-off',
        launch: { choices: { on: 'local', size: { cpu: 2 } } },
      },
    });
    // A re-read keeps the last answer in place instead of swapping the page for a loading line.
    let releaseAnswer = () => {};
    answerGate = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    const reads = harness.requestsFor(
      '/v1/actions/machines.provisioners.options',
    ).length;
    await act(async () =>
      screen.changeTextByTestId('managed-config.field:size.cpu', '3'),
    );
    await waitForHomeGovernance(() =>
      expect(
        harness.requestsFor('/v1/actions/machines.provisioners.options')
          .length,
      ).toBeGreaterThan(reads),
    );
    const { t } = await import('@/text');
    expect(screen.getTextContent()).not.toContain(
      t('managedMachines.options.loading', { provider: 'Virtual machine' }),
    );
    expect(screen.findByTestId('managed-config.size')).not.toBeNull();
    // A newer explicit draft wins even if the old native request answers last.
    answerGate = null;
    await act(async () =>
      screen.changeTextByTestId('managed-config.field:size.cpu', '4'),
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false),
    );
    await act(async () => screen.pressByTestId('managed-config.use'));
    expect(onUse.mock.calls.at(-1)?.[0]).toMatchObject({
      selection: { kind: 'one-off', launch: { choices: { on: 'local', size: { cpu: 4 } } } },
    });
    onUse.mockClear();
    releaseAnswer();
    await waitForHomeGovernance(() => expect(answeredCpus).toContain(3));
    await flushHookEffects();
    expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false);
    await act(async () => screen.pressByTestId('managed-config.use'));
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse).toHaveBeenLastCalledWith(expect.objectContaining({
      selection: expect.objectContaining({ launch: expect.objectContaining({ choices: { on: 'local', size: { cpu: 4 } } }) }),
    }));
    await screen.unmount();
  });
  it('folds the provider-filled launch details into one Advanced disclosure once the size has its own section (lab m-config L)', async () => {
    const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://advanced.example', serverIdentityId: 'srv_advanced',
      accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: 'host', installationId: 'installation' })]);
    // Like Lima: a store and a driver the controller fills itself, and the size fields its one size row assigns.
    const optionsSchema = { type: 'object', properties: { store: { type: 'string' }, vmType: { type: 'string', enum: ['qemu', 'vz'] },
      cpus: { type: 'integer', minimum: 1 } }, additionalProperties: false };
    const native = { ...provisioner, descriptor: { ...provisioner.descriptor, billing: { location: 'local', stoppedBilling: 'not-billed' },
      launchSchema: { ...optionsSchema, required: ['store', 'vmType', 'cpus'] } } };
    const action = PluginProjectedActionV2Schema.parse({ id: 'options', pluginId: provisioner.contribution.pluginId,
      occurrenceId: provisioner.occurrenceId, title: 'Native options', scopes: ['machine'], surfaces: ['cli', 'plugin'],
      execution: { target: 'daemon' }, available: true, dangerLevel: 'safe',
      inputHints: { fields: [
        { path: 'store', title: 'Store', widget: 'text', required: true },
        { path: 'vmType', title: 'VM driver', widget: 'select', required: true, requireExplicitSelection: true,
          options: [{ value: 'qemu', label: 'QEMU' }, { value: 'vz', label: 'VZ' }] },
        { path: 'cpus', title: 'CPU cores', widget: 'integer', required: true },
      ] } });
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
      ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
      installedPackagesById: { [action.pluginId]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: action.pluginId } },
      actionsById: { [buildQualifiedPluginContributionKey({ pluginId: action.pluginId, localId: action.id })]: action } } });
    nativeBoundary.rpc.mockImplementation(async (request: { method: string }) =>
      request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE ? projection
        : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ ? { ok: true, inputSchema: optionsSchema }
          : { ok: false, code: 'unsupported' });
    const answer = (actionId: string, result: (input: unknown) => unknown) => answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
      select: (value) => { const request = readProvisionerRequest(value);
        return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result: result(request.input) } } }; } });
    await answer('machines.provisioners.list', () => ({ controller: defaultController, provisioners: [native] }));
    await answer('machines.provisioners.check', () => ({ available: true }));
    await answer('machines.provisioners.options', (input) => {
      const cpus = (input as { selectors?: { cpus?: number } }).selectors?.cpus ?? 4;
      return createMachineProvisionerOptionsFixture({ base: { launch: { store: '/home/me/.lima', vmType: 'qemu', cpus } },
        dimensions: { image: [], location: [], network: [], duration: [], size: [{ id: `${cpus}`, title: `${cpus} CPU`,
          assignments: [{ path: 'cpus', value: cpus }], nativeFacts: { size: { id: `${cpus}`, title: `${cpus} CPU`, cpuCores: cpus } } }] } });
    });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} onUse={vi.fn()} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false));
    // The size keeps its own section; the details fold into one closed row that says what it holds.
    expect(screen.findByTestId('managed-config.size')).not.toBeNull();
    expect(screen.findByTestId('managed-config.advanced')).not.toBeNull();
    expect(screen.findByTestId('managed-config.field:store')).toBeNull();
    expect(screen.getTextContent()).toContain('QEMU');
    await act(async () => screen.pressByTestId('managed-config.advanced.header'));
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:store')).not.toBeNull());
    // Open, the driver offers its other choice too.
    expect(screen.getTextContent()).toContain('VZ');
    await screen.unmount();
  });
  // Like the Docker editor: one blank required field leads the form, the provider's defaults are details.
  const arrangeImageForm = async (name: string) => {
    const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: `https://${name}.example`, serverIdentityId: `srv_${name}`,
      accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: 'host', installationId: 'installation' })]);
    const optionsSchema = defineProtocolObject({ image: defineProtocolString({ minLength: 1 }),
      runtime: defineProtocolUnion([defineProtocolLiteral('docker'), defineProtocolLiteral('podman')]).optional(),
      folder: defineProtocolString().optional() }, { policy: 'closed' }).jsonSchema;
    const native = { ...provisioner, descriptor: { ...provisioner.descriptor, billing: { location: 'local', stoppedBilling: 'not-billed' },
      launchSchema: optionsSchema } };
    const action = PluginProjectedActionV2Schema.parse({ id: 'options', pluginId: provisioner.contribution.pluginId,
      occurrenceId: provisioner.occurrenceId, title: 'Native options', scopes: ['machine'], surfaces: ['cli', 'plugin'],
      execution: { target: 'daemon' }, available: true, dangerLevel: 'safe',
      inputHints: { fields: [
        { path: 'image', title: 'Container image', widget: 'text', required: true },
        { path: 'runtime', title: 'Container runtime', widget: 'select', defaultValue: 'docker',
          options: [{ value: 'docker', label: 'Docker' }, { value: 'podman', label: 'Podman' }] },
        { path: 'folder', title: 'Project folder', widget: 'text' },
      ] } });
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
      ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
      installedPackagesById: { [action.pluginId]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: action.pluginId } },
      actionsById: { [buildQualifiedPluginContributionKey({ pluginId: action.pluginId, localId: action.id })]: action } } });
    nativeBoundary.rpc.mockImplementation(async (request: { method: string }) =>
      request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE ? projection
        : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ ? { ok: true, inputSchema: optionsSchema }
          : { ok: false, code: 'unsupported' });
    const answer = (actionId: string, result: (input: unknown) => unknown) => answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
      select: (value) => { const request = readProvisionerRequest(value);
        return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result: result(request.input) } } }; } });
    await answer('machines.provisioners.list', () => ({ controller: defaultController, provisioners: [native] }));
    await answer('machines.provisioners.check', () => ({ available: true }));
    await answer('machines.provisioners.options', () => createMachineProvisionerOptionsFixture({ base: { launch: {} } }));
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { t } = await import('@/text');
    const props = { serverId, provisioner: buildQualifiedPluginContributionKey(provisioner.contribution), initialController: defaultController };
    return { serverId, ManagedMachineConfigurationView, t, props, native, optionsInputHints: action.inputHints };
  };
  it('leads with the blank required field and neither warns about nor shows the rest of an untouched form', async () => {
    const { ManagedMachineConfigurationView, t, props } = await arrangeImageForm('image-first');
    const screen = await renderScreen(<ManagedMachineConfigurationView {...props} onUse={vi.fn()} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:image')).not.toBeNull());
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.advanced')).not.toBeNull());
    expect(screen.findByTestId('managed-config.field:runtime')).toBeNull();
    expect(screen.tree.findAll(node => node.props.kind === 'warning' && node.props.title === t('managedMachines.options.unavailable'))).toEqual([]);
    expect(screen.getTextContent()).toContain(t('session.actionsDraft.validation.requiredField', { field: 'Container image' }));
    await screen.unmount();
  });
  it('says why a preset can\u2019t be saved, and names the empty audience as Yours', async () => {
    const { serverId, ManagedMachineConfigurationView, t, props, native, optionsInputHints } = await arrangeImageForm('preset-reason');
    await publishPresetEditorDeclaration(serverId, createMachineProvisionerEditorManifestFixture({ pluginId: native.contribution.pluginId, descriptor: native.descriptor, optionsInputHints }));
    const screen = await renderScreen(<ManagedMachineConfigurationView {...props} presetOnly />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:image')).not.toBeNull());
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true));
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('session.actionsDraft.validation.requiredField', { field: 'Container image' })));
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.audience')).not.toBeNull());
    expect(screen.getTextContent()).toContain(t('machinePresets.ownerPersonal'));
    await screen.unmount();
  });
  it('holds the form in place until it knows whether Start from will sit above it', async () => {
    const { serverId, ManagedMachineConfigurationView, t, props } = await arrangeImageForm('start-from-hold');
    const list = createDeferred<{ body: unknown }>();
    harness.answer(serverId, '/v1/machines/presets/list', { select: () => list.promise });
    const screen = await renderScreen(<ManagedMachineConfigurationView {...props} />);
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/list').length).toBeGreaterThan(0));
    await flushHookEffects();
    expect(screen.findByTestId('managed-config.field:image')).toBeNull();
    expect(screen.getTextContent()).toContain(t('managedMachines.options.loading', { provider: 'Virtual machine' }));
    await act(async () => list.resolve({ body: { kind: 'listed', presets: [] } }));
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:image')).not.toBeNull());
    await screen.unmount();
  });
  it('says when the provider form can\'t be read and reads it again on Retry, never leaving an uneditable size (R93)', async () => {
    const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: 'https://form-hints.example', serverIdentityId: 'srv_form_hints',
      accountId: 'owner', currentAccount: true });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: 'host', installationId: 'installation' })]);
    const optionsSchema = { type: 'object', properties: { cpus: { type: 'integer', minimum: 1 } }, additionalProperties: false };
    const native = { ...provisioner, descriptor: { ...provisioner.descriptor, billing: { location: 'local', stoppedBilling: 'not-billed' },
      launchSchema: { ...optionsSchema, required: ['cpus'] } } };
    // The controller's presentation still describes an earlier occurrence of the plugin (before its reload).
    let occurrenceId = 'earlier-occurrence';
    const projectionFor = () => {
      const action = PluginProjectedActionV2Schema.parse({ id: 'options', pluginId: provisioner.contribution.pluginId,
        occurrenceId, title: 'Native options', scopes: ['machine'], surfaces: ['cli', 'plugin'],
        execution: { target: 'daemon' }, available: true, dangerLevel: 'safe',
        inputHints: { fields: [{ path: 'cpus', title: 'CPU cores', widget: 'integer', required: true }] } });
      return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
        installedPackagesById: { [action.pluginId]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: action.pluginId } },
        actionsById: { [buildQualifiedPluginContributionKey({ pluginId: action.pluginId, localId: action.id })]: action } } });
    };
    nativeBoundary.rpc.mockImplementation(async (request: { method: string }) =>
      request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE ? projectionFor()
        : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ ? { ok: true, inputSchema: optionsSchema }
          : { ok: false, code: 'unsupported' });
    const answer = (actionId: string, result: (input: unknown) => unknown) => answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
      select: (value) => { const request = readProvisionerRequest(value);
        return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result: result(request.input) } } }; } });
    await answer('machines.provisioners.list', () => ({ controller: defaultController, provisioners: [native] }));
    await answer('machines.provisioners.check', () => ({ available: true }));
    await answer('machines.provisioners.options', () => createMachineProvisionerOptionsFixture({ base: { launch: { cpus: 4 } },
      dimensions: { image: [], location: [], network: [], duration: [], size: [{ id: '4', title: 'Custom size',
        assignments: [{ path: 'cpus', value: 4 }], nativeFacts: { size: { id: '4', title: 'Custom size', cpuCores: 4 } } }] } }));
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const { t } = await import('@/text');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} onUse={vi.fn()} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.form-unavailable')).not.toBeNull());
    expect(screen.getTextContent()).toContain(t('managedMachines.options.error'));
    expect(screen.findByTestId('managed-config.field:cpus')).toBeNull();
    occurrenceId = provisioner.occurrenceId;
    await act(async () => screen.pressByTestId('managed-config.form-unavailable:action'));
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:cpus')).not.toBeNull());
    expect(screen.findByTestId('managed-config.form-unavailable')).toBeNull();
    await screen.unmount();
  });
  it('keeps an explicit Ask choice until its administrator is named, never falling back to Preauthorized', async () => {
    const screen = await mountAddRoute('add-ask');
    await waitForHomeGovernance(() =>
      expect(createDisabled(screen)).toBe(false),
    );
    await act(async () =>
      screen.pressByTestIdAsync('managed-config.admin-access:ask'),
    );
    expect(createDisabled(screen)).toBe(true);
    await act(async () =>
      screen.changeTextByTestId('managed-config.administrator', 'root'),
    );
    expect(createDisabled(screen)).toBe(true);
    await act(async () =>
      screen.changeTextByTestId('managed-config.administrator', 'leeroy'),
    );
    await waitForHomeGovernance(() =>
      expect(createDisabled(screen)).toBe(false),
    );
    await act(async () => screen.pressByTestIdAsync('managed-config.create'));
    await waitForHomeGovernance(() =>
      expect(
        harness.requestsFor('/v1/actions/machines.managed.acquire'),
      ).toHaveLength(1),
    );
    expect(acquiredIdentity()).toMatchObject({
      enrollmentIdentity: {
        kind: 'dedicatedDaemonUser',
        role: 'server',
        adminAccessAtCreation: 'ask',
        administrator: { username: 'leeroy' },
      },
    });
    await screen.unmount();
  });
  it('creates with None after Ask was considered, without carrying the abandoned administrator', async () => {
    const screen = await mountAddRoute('add-none');
    await waitForHomeGovernance(() =>
      expect(createDisabled(screen)).toBe(false),
    );
    await act(async () =>
      screen.pressByTestIdAsync('managed-config.admin-access:ask'),
    );
    await act(async () =>
      screen.changeTextByTestId('managed-config.administrator', 'leeroy'),
    );
    await act(async () =>
      screen.pressByTestIdAsync('managed-config.admin-access:none'),
    );
    await waitForHomeGovernance(() =>
      expect(createDisabled(screen)).toBe(false),
    );
    await act(async () => screen.pressByTestIdAsync('managed-config.create'));
    await waitForHomeGovernance(() =>
      expect(
        harness.requestsFor('/v1/actions/machines.managed.acquire'),
      ).toHaveLength(1),
    );
    const identity = (
      acquiredIdentity() as { enrollmentIdentity: Record<string, unknown> }
    ).enrollmentIdentity;
    expect(identity).toMatchObject({
      kind: 'dedicatedDaemonUser',
      adminAccessAtCreation: 'none',
    });
    expect(identity).not.toHaveProperty('administrator');
    await screen.unmount();
  });
  it.each(['legacy', 'dimensions'] as const)(
    'renders a %s controller catalog through the real Action boundary and preserves exact reviewed choices',
    async (format) => {
      const serverId = await addPresetHome({
        name: 'Compute',
        serverUrl: `https://catalog-${format}.example`,
        serverIdentityId: `srv_catalog_${format}`,
        accountId: 'owner',
        currentAccount: true,
      });
      await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
            createMachineFixture({
              id: 'host',
              installationId: 'installation',
            }),
          ]);
      const price = {
        amount: '0.005',
        currency: 'EUR',
        unit: 'hour',
        source: 'native',
        observedAt: 10,
        label: 'Compute',
      };
      const choices = [
        {
          id: 'small-native',
          title: 'Small native guest',
          launch: { cpu: 2 },
          prices: [price],
          nativeFacts: {
            size: { id: 'native-size', title: 'Native size', cpuCores: 2 },
            image: { id: 'linux', title: 'Linux' },
          },
        },
        {
          id: 'large-native',
          title: 'Large native guest',
          launch: { cpu: 4 },
          nativeFacts: {
            size: { id: 'native-size', title: 'Native size', cpuCores: 4 },
            image: { id: 'windows', title: 'Windows' },
          },
        },
      ];
      const options =
        format === 'legacy'
          ? { choices }
          : createMachineProvisionerOptionsFixture({
              base: { launch: {} },
              dimensions: {
                size: choices.map((choice) => ({
                  id: choice.id,
                  title: choice.title,
                  assignments: [{ path: 'cpu', value: choice.launch.cpu }],
                  prices: choice.prices,
                  nativeFacts: {
                    size: {
                      id: choice.id,
                      title: choice.title,
                      cpuCores: choice.launch.cpu,
                    },
                    ...(choice.nativeFacts?.image
                      ? { image: choice.nativeFacts.image }
                      : {}),
                  },
                })),
                image: [],
                location: [],
                network: [],
                duration: [],
              },
            });
      for (const [actionId, result] of [
        [
          'machines.provisioners.list',
          { controller: defaultController, provisioners: [provisioner] },
        ],
        ['machines.provisioners.check', { available: true }],
        ['machines.provisioners.options', options],
      ] as const)
        await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
          select: (value) => {
            const request = readProvisionerRequest(value);
            return {
              body: {
                v: 1,
                actionId,
                requestId: request.requestId,
                execution: { ok: true, result },
              },
            };
          },
        });
      const onUse = vi.fn<(draft: ManagedMachineSelectionDraft) => void>();
      const { ManagedMachineConfigurationView } =
        await import('./ManagedMachineConfigurationView');
      const screen = await renderScreen(
        <ManagedMachineConfigurationView
          serverId={serverId}
          provisioner={buildQualifiedPluginContributionKey(
            provisioner.contribution,
          )}
          initialController={defaultController}
          onUse={onUse}
        />,
      );
      const sizes = () =>
        screen.tree.findAll(
          (node) =>
            node.props.testID === 'managed-config.sizes' &&
            typeof node.props.onChange === 'function',
        )[0];
      await waitForHomeGovernance(() =>
        expect(
          sizes()?.props.sizes.map((size: { id: string; name: string }) => [
            size.id,
            size.name,
          ]),
        ).toEqual([
          ['small-native', 'Small native guest'],
          ['large-native', 'Large native guest'],
        ]),
      );
      expect(sizes()?.props.sizes[0]).toMatchObject({ cpu: '2' });
      expect(sizes()?.props.sizes[0].hourly).toContain('0.005');
      await act(async () => sizes()?.props.onChange('small-native'));
      await waitForHomeGovernance(() =>
        expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(
          false,
        ),
      );
      await act(async () => screen.pressByTestId('managed-config.use'));
      expect(onUse.mock.calls.at(-1)?.[0]).toMatchObject({
        selection: { kind: 'one-off', launch: { choices: { cpu: 2 } } },
        receipt: {
          prices: [price],
          nativeFacts: { image: { id: 'linux', title: 'Linux' } },
        },
      });
      expect(sizes()?.props.sizes).toHaveLength(2);
      await act(async () => sizes()?.props.onChange('large-native'));
      await act(async () => screen.pressByTestId('managed-config.use'));
      expect(onUse.mock.calls.at(-1)?.[0]).toMatchObject({
        selection: { kind: 'one-off', launch: { choices: { cpu: 4 } } },
        receipt: {
          nativeFacts: { image: { id: 'windows', title: 'Windows' } },
        },
      });
      expect(
        harness.requestsFor('/v1/actions/machines.managed.acquire'),
      ).toHaveLength(0);
      await screen.unmount();
    },
  );
  it('composes real DigitalOcean dimensions, regional restrictions, native prices and exact acquire selectors', async () => {
    const { PLUGIN, MACHINE_PROVISIONER, ROLE_SCHEMAS } =
      await import('../../../../../../../packages/plugins/machine-digitalocean/src/index');
    const provider = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN });
    onTestFinished(() => provider.dispose());
    const requests: HttpRequest[] = [];
    const catalog = {
      sizes: [
        {
          slug: 'small',
          memory: 1024,
          vcpus: 1,
          disk: 25,
          transfer: 1,
          price_hourly: 0.02,
          price_monthly: 12,
          regions: ['nyc3', 'ams3'],
          available: true,
        },
        {
          slug: 'large',
          memory: 2048,
          vcpus: 2,
          disk: 50,
          transfer: 2,
          price_hourly: 0.04,
          price_monthly: 24,
          regions: ['ams3'],
          available: true,
        },
      ],
      images: [
        {
          id: 1,
          name: 'Ubuntu',
          distribution: 'Ubuntu',
          regions: ['nyc3', 'ams3'],
          status: 'available',
          type: 'base',
        },
      ],
      regions: [
        { slug: 'nyc3', name: 'New York', available: true, sizes: ['small'] },
        {
          slug: 'ams3',
          name: 'Amsterdam',
          available: true,
          sizes: ['small', 'large'],
        },
      ],
      links: {},
    };
    const context = {
      invokedAtMs: 1234,
      signal: new AbortController().signal,
      services: {
        connectedAccounts: {
          materialize: async () => ({
            kind: 'httpHeaders',
            headers: { Authorization: 'Bearer native-fixture' },
          }),
        },
        http: {
          request: async (request: HttpRequest) => {
            requests.push(request);
            return {
              status: request.method === 'POST' ? 202 : 200,
              finalUrl: request.url,
              headers: {},
              body: new TextEncoder().encode(
                JSON.stringify(
                  request.method === 'POST'
                    ? { droplet: { id: 42 }, links: { actions: [] } }
                    : catalog,
                ),
              ),
            };
          },
        },
      },
    } as unknown as PluginInvocationContext;
    const descriptor = MachineProvisionerContributionV1Schema.parse({
      id: 'digitalocean',
      ...MACHINE_PROVISIONER,
    });
    const native = {
      contribution: {
        pluginId: 'happier.machine.digitalocean',
        localId: descriptor.id,
      },
      occurrenceId: 'digitalocean',
      credentialPurposes: [],
      acquireExecutionTarget: 'daemon' as const,
      descriptor,
    };
    const action = PluginProjectedActionV2Schema.parse({
      id: descriptor.actions.options,
      pluginId: native.contribution.pluginId,
      occurrenceId: 'digitalocean',
      title: 'Options',
      scopes: ['machine'],
      surfaces: ['cli', 'plugin'],
      execution: { target: 'daemon' },
      available: true,
      dangerLevel: 'safe',
    });
    const projection =
      DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1,
        projection: {
          ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
          agentsById: {},
          diagnostics: [],
          installedPackagesById: {
            [action.pluginId]: {
              ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE
                .installedPackagesById['acme.review'],
              id: action.pluginId,
            },
          },
          actionsById: {
            [buildQualifiedPluginContributionKey({
              pluginId: action.pluginId,
              localId: action.id,
            })]: action,
          },
        },
      });
    nativeBoundary.rpc.mockImplementation(
      async (request: { method: string }) =>
        request.method ===
        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
          ? projection
          : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
            ? {
                ok: true,
                inputSchema: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
              }
            : { ok: false, code: 'unsupported' },
    );
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://native-digitalocean.example',
      serverIdentityId: 'srv_native_digitalocean',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [native] },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        await provider.invokeAction('options', {}, { services: context.services, signal: context.signal }),
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const onUse = vi.fn<(draft: ManagedMachineSelectionDraft) => void>();
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(native.contribution)}
        initialController={defaultController}
        onUse={onUse}
      />,
    );
    const control = (testID: string) =>
      screen.tree.findAll(
        (node) =>
          node.props.testID === testID &&
          typeof node.props.onChange === 'function',
      )[0];
    await waitForHomeGovernance(() =>
      expect(control('managed-config.sizes')).toBeDefined(),
    );
    expect(control('managed-config.sizes')?.props.sizes).toHaveLength(2);
    expect(control('managed-config.sizes')?.props.sizes[0].hourly).toContain(
      '0.02',
    );
    // CLOUD45b: both native 1 GiB and 2 GiB sizes warn, and Use below still succeeds.
    const memoryWarning = (await import('@/text')).t('managedMachines.config.lowMemoryWarning', { memory: '4 GiB' });
    expect(control('managed-config.sizes')?.props.sizes[0].warning).toBe(memoryWarning);
    expect(control('managed-config.sizes')?.props.sizes[1].warning).toBe(memoryWarning);
    await act(async () =>
      control('managed-config.sizes')?.props.onChange('small'),
    );
    await act(async () =>
      control('managed-config.images')?.props.onChange('1'),
    );
    await act(async () =>
      control('managed-config.locations')?.props.onChange('nyc3'),
    );
    expect(
      control('managed-config.sizes')?.props.sizes[1].unavailableReason,
    ).toBeTruthy();
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(
        false,
      ),
    );
    await act(async () => screen.pressByTestId('managed-config.use'));
    const reviewed = onUse.mock.calls.at(-1)?.[0];
    expect(reviewed?.selection).toMatchObject({
      kind: 'one-off',
      launch: {
        choices: {
          sizeSlug: 'small',
          imageId: 1,
          regionSlug: 'nyc3',
          publicNetworking: { ipv6: false },
        },
      },
    });
    expect(
      (reviewed && 'receipt' in reviewed ? reviewed.receipt : undefined)?.prices?.map((price) => [price.amount, price.unit]),
    ).toEqual([
      ['0.02', 'hour'],
      ['12', 'month'],
    ]);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    expect(
      harness.requestsFor('/v1/actions/machines.managed.acquire'),
    ).toHaveLength(0);
    if (reviewed?.selection.kind !== 'one-off')
      throw new Error('Expected reviewed one-off selection');
    const input = ROLE_SCHEMAS.acquireInput.parse({
      managedId: 'cmvnxb7gn009mmcagisyszwlh',
      launch: reviewed.selection.launch.choices,
      bootstrapPublicKey: 'ssh-ed25519 public',
    });
    expect(
      ROLE_SCHEMAS.acquireResult.parse(
        await provider.invokeAction('acquire', input, { services: context.services, signal: context.signal }),
      ).kind,
    ).not.toBe('rejected');
    expect(
      requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
    await screen.unmount();
  });
  it.each([390, 1280])(
    'selects exact Boat snapshot, fork and blank sources through the shared configurator at %s px',
    async (width) => {
      const viewport = vi
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width, height: 844, scale: 1, fontScale: 1 });
      restoreViewport = () => viewport.mockRestore();
      const { PLUGIN, ROLE_SCHEMAS } =
        await import('../../../../../../../packages/plugins/machine-boat/src/manifest');
      const provider = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN });
      onTestFinished(() => provider.dispose());
      const requests: HttpRequest[] = [];
      // Only the credential and vendor HTTP boundaries are substituted; options,
      // strict role admission, the mounted configurator and native acquire run.
      const context = {
        invokedAtMs: 1234,
        signal: new AbortController().signal,
        services: {
          connectedAccounts: {
            materialize: async () => ({
              kind: 'httpHeaders',
              headers: { Authorization: 'Bearer boat-fixture' },
            }),
          },
          http: {
            request: async (request: HttpRequest) => {
              requests.push(request);
              const path = new URL(request.url).pathname;
              const value = path.endsWith('/limits')
                ? { ok: true, type: 'limits.info', sandboxPlanKey: 'pro', sandboxPlanDollars: 100 }
                : path.endsWith('/saved-snapshots')
                  ? {
                      ok: true,
                      type: 'snapshot.named.list',
                      snapshots: [
                        {
                          name: 'workbench',
                          status: 'ready',
                          sourceSandboxId: 'bx_23456789',
                          createdAt: '2026-10-12T00:00:00Z',
                        },
                      ],
                    }
                  : request.method === 'GET' && path.endsWith('/sandboxes')
                    ? {
                        ok: true,
                        type: 'sandbox.list',
                        sandboxes: [
                          {
                            id: 'bx_23456789',
                            name: 'Workbench',
                            state: 'ready',
                          },
                        ],
                      }
                    : {
                        ok: true,
                        type: 'sandbox.created',
                        sandbox: { id: 'bx_abcdefgh', state: 'provisioning' },
                      };
              return {
                status: request.method === 'POST' ? 202 : 200,
                finalUrl: request.url,
                headers: {},
                body: new TextEncoder().encode(JSON.stringify(value)),
              };
            },
          },
        },
      } as unknown as PluginInvocationContext;
      const descriptor = MachineProvisionerContributionV1Schema.parse(
        PLUGIN.manifest.contributes.machineProvisioners?.[0],
      );
      const boat = {
        contribution: { pluginId: PLUGIN.manifest.id, localId: descriptor.id },
        occurrenceId: 'boat-occurrence',
        credentialPurposes: [],
        acquireExecutionTarget: 'daemon' as const,
        descriptor,
      };
      const optionsAction = PLUGIN.manifest.contributes.actions?.find(
        (action) => action.id === descriptor.actions.options,
      );
      if (!optionsAction) throw new Error('Expected the Boat options Action');
      const projectedAction = PluginProjectedActionV2Schema.parse({
        id: optionsAction.id,
        pluginId: PLUGIN.manifest.id,
        occurrenceId: boat.occurrenceId,
        title: optionsAction.title,
        scopes: optionsAction.scopes,
        surfaces: optionsAction.surfaces,
        execution: optionsAction.execution,
        dangerLevel: optionsAction.dangerLevel,
        available: true,
      });
      const projection =
        DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
          protocolVersion: 1,
          projection: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
            agentsById: {},
            diagnostics: [],
            installedPackagesById: {
              [PLUGIN.manifest.id]: {
                ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE
                  .installedPackagesById['acme.review'],
                id: PLUGIN.manifest.id,
              },
            },
            actionsById: {
              [buildQualifiedPluginContributionKey({
                pluginId: PLUGIN.manifest.id,
                localId: optionsAction.id,
              })]: projectedAction,
            },
          },
        });
      nativeBoundary.rpc.mockImplementation(
        async (request: { method: string }) =>
          request.method ===
          RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? projection
            : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
              ? { ok: true, inputSchema: optionsAction.inputSchema }
              : { ok: false, code: 'unsupported' },
      );
      const serverId = await addPresetHome({
        name: 'Compute',
        serverUrl: `https://boat-sources-${width}.example`,
        serverIdentityId: `srv_boat_sources_${width}`,
        accountId: 'owner',
        currentAccount: true,
      });
      await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
            createMachineFixture({
              id: 'host',
              installationId: 'installation',
            }),
          ]);
      for (const [actionId, result] of [
        [
          'machines.provisioners.list',
          { controller: defaultController, provisioners: [boat] },
        ],
        [
          'machines.provisioners.check',
          await provider.invokeAction('check', {}, { services: context.services, signal: context.signal }),
        ],
        [
          'machines.provisioners.options',
          await provider.invokeAction('options', {}, { services: context.services, signal: context.signal }),
        ],
      ] as const)
        await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
          select: (value) => {
            const request = readProvisionerRequest(value);
            return {
              body: {
                v: 1,
                actionId,
                requestId: request.requestId,
                execution: { ok: true, result },
              },
            };
          },
        });
      const onUse = vi.fn<(draft: ManagedMachineSelectionDraft) => void>();
      const { ManagedMachineConfigurationView } =
        await import('./ManagedMachineConfigurationView');
      const screen = await renderScreen(
        <ManagedMachineConfigurationView
          serverId={serverId}
          provisioner={buildQualifiedPluginContributionKey(boat.contribution)}
          initialController={defaultController}
          onUse={onUse}
        />,
      );
      await waitForHomeGovernance(() =>
        expect(
          screen.findByTestId('managed-config.images:snapshot/workbench'),
        ).not.toBeNull(),
      );
      const sizes = screen.tree.findAll(
        (node) =>
          node.props.testID === 'managed-config.sizes' &&
          typeof node.props.onChange === 'function',
      )[0];
      expect(sizes).toBeDefined();
      await act(async () => sizes!.props.onChange('small'));
      await screen.pressByTestIdAsync('managed-config.locations:eu');
      for (const [id, source, path, from] of [
        [
          'snapshot/workbench',
          { kind: 'named-snapshot', name: 'workbench' },
          '/api/v1/sandboxes',
          'workbench',
        ],
        [
          'fork/bx_23456789',
          { kind: 'fork', sandboxId: 'bx_23456789' },
          '/api/v1/sandboxes/bx_23456789/fork',
          undefined,
        ],
        ['blank', { kind: 'blank' }, '/api/v1/sandboxes', undefined],
      ] as const) {
        requests.length = 0;
        await screen.pressByTestIdAsync(`managed-config.images:${id}`);
        await waitForHomeGovernance(() =>
          expect(
            screen.findByTestId('managed-config.use')?.props.disabled,
          ).toBe(false),
        );
        await screen.pressByTestIdAsync('managed-config.use');
        const intent = onUse.mock.calls.at(-1)?.[0];
        expect(intent?.selection).toMatchObject({
          kind: 'one-off',
          launch: { choices: { size: 'small', source } },
        });
        expect(requests).toEqual([]);
        if (intent?.selection.kind !== 'one-off')
          throw new Error('Expected reviewed one-off selection');
        const acquireInput = ROLE_SCHEMAS.acquireInput.parse({
          managedId: `selected-${id}`,
          launch: intent.selection.launch.choices,
        });
        expect(
          ROLE_SCHEMAS.acquireResult.parse(
            await provider.invokeAction('acquire', acquireInput, { services: context.services, signal: context.signal }),
          ),
        ).toMatchObject({
          kind: 'bound',
          resource: { value: { sandboxId: 'bx_abcdefgh' } },
        });
        const posts = requests.filter((request) => request.method === 'POST');
        expect(posts).toHaveLength(1);
        expect(new URL(posts[0]!.url).pathname).toBe(path);
        expect(JSON.parse(new TextDecoder().decode(posts[0]!.body))).toEqual({
          type: 'small',
          snapshots: true,
          noEnv: true,
          ttlSeconds: null,
          labels: { 'happier-managed-id': `selected-${id}` },
          ...(from ? { from } : {}),
        });
      }
      await screen.unmount();
    },
  );

  it.each(['check', 'options', 'options-action'] as const)(
    'preserves the native %s diagnostic without claiming an empty catalog or retrying itself',
    async (role) => {
      const serverId = await addPresetHome({
        name: 'Compute',
        serverUrl: `https://native-${role}.example`,
        serverIdentityId: `srv_native_${role}`,
        accountId: 'owner',
        currentAccount: true,
      });
      await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
            createMachineFixture({
              id: 'host',
              installationId: 'installation',
            }),
          ]);
      const nativeCause = {
        httpStatusClass: '4xx',
        code: 'forbidden',
      } as const;
      for (const [actionId, result] of [
        [
          'machines.provisioners.list',
          { controller: defaultController, provisioners: [provisioner] },
        ],
        [
          'machines.provisioners.check',
          role === 'check'
            ? { available: false, code: 'provider_unavailable', nativeCause }
            : { available: true },
        ],
        [
          'machines.provisioners.options',
          role === 'options'
            ? {
                dimensions: {
                  size: [],
                  image: [],
                  location: [],
                  network: [],
                  duration: [],
                },
                code: 'provider_unavailable',
                nativeCause,
              }
            : {
                dimensions: {
                  size: [],
                  image: [],
                  location: [],
                  network: [],
                  duration: [],
                },
              },
        ],
      ] as const)
        await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
          select: (value) => {
            const request = readProvisionerRequest(value);
            return {
              body: {
                v: 1,
                actionId,
                requestId: request.requestId,
                execution: role === 'options-action' && actionId === 'machines.provisioners.options'
                  ? { ok: false, errorCode: 'action_failed', error: 'action_failed',
                      details: { kind: 'managedNative', nativeCause } }
                  : { ok: true, result },
              },
            };
          },
        });
      const { ManagedMachineConfigurationView } =
        await import('./ManagedMachineConfigurationView');
      const { t } = await import('@/text');
      const screen = await renderScreen(
        <ManagedMachineConfigurationView
          serverId={serverId}
          provisioner={buildQualifiedPluginContributionKey(
            provisioner.contribution,
          )}
          initialController={defaultController}
        />,
      );
      const testID =
        role === 'check'
          ? 'managed-config.unavailable'
          : 'managed-config.error';
      await waitForHomeGovernance(() =>
        expect(
          screen.tree.findAll(
            (node) =>
              node.props.testID === testID &&
              node.props.diagnosticCode ===
                `${role === 'options-action' ? 'action_failed' : 'provider_unavailable'} · HTTP 4xx · forbidden`,
          ).length,
        ).toBeGreaterThan(0),
      );
      expect(screen.getTextContent()).not.toContain(
        t('managedMachines.options.empty', { provider: 'Virtual machine' }),
      );
      const count = harness.requestsFor(
        `/v1/actions/machines.provisioners.${role === 'options-action' ? 'options' : role}`,
      ).length;
      await flushHookEffects();
      expect(
        harness.requestsFor(`/v1/actions/machines.provisioners.${role === 'options-action' ? 'options' : role}`),
      ).toHaveLength(count);
      await screen.unmount();
    },
  );
  it.each([
    ['Hetzner', () => import('../../../../../../../packages/plugins/machine-hetzner/src/manifest')],
    ['Lima', () => import('../../../../../../../packages/plugins/machine-lima/src/manifest')],
    ['Lume', () => import('../../../../../../../packages/plugins/machine-lume/src/manifest')],
    ['DigitalOcean', () => import('../../../../../../../packages/plugins/machine-digitalocean/src/manifest')],
  ] as const)('reads %s schema and options exactly once while presentation sections are still pending', async (provider, loadManifest) => {
    const { PLUGIN_MANIFEST: manifest } = await loadManifest();
    const descriptor = MachineProvisionerContributionV1Schema.parse(manifest.contributes.machineProvisioners?.[0]);
    const declaration = PluginActionContributionV2Schema.parse(manifest.contributes.actions?.find(action => action.id === descriptor.actions.options));
    const contribution = { pluginId: manifest.id, localId: descriptor.id };
    const action = PluginProjectedActionV2Schema.parse({ id: declaration.id, title: declaration.title, pluginId: manifest.id,
      scopes: declaration.scopes, surfaces: declaration.surfaces, execution: declaration.execution, dangerLevel: declaration.dangerLevel,
      occurrenceId: provider, available: true,
      inputHints: normalizePluginActionInputHintsV2(declaration.inputHints, declaration.inputSchema) });
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
      projection: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
        installedPackagesById: { [manifest.id]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: manifest.id } },
        actionsById: { [buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: action.id })]: action } } });
    const schema = createDeferred<Readonly<{ ok: true; inputSchema: typeof declaration.inputSchema }>>();
    const { buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeRequestSchema } =
      await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
    const deferred = buildDeferredDaemonProjectionSections({ ...projection, projectionDigest: 'a'.repeat(64) });
    const hydration = createDeferred<void>();
    let sectionReads = 0;
    let sectionCompletions = 0;
    nativeBoundary.rpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
      if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return schema.promise;
      if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { ok: false, code: 'unsupported' };
      const payload = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(request.payload);
      if (!('sectionRead' in payload) || !payload.sectionRead) return deferred.manifest;
      sectionReads++;
      await hydration.promise;
      sectionCompletions++;
      return deferred.read(payload.sectionRead.digest, payload.sectionRead.offset, payload.sectionRead.includeDigests);
    });
    const schemaRequests = () => nativeBoundary.rpc.mock.calls.filter(([request]) =>
      request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ);
    const serverId = await addPresetHome({ name: 'Compute', serverUrl: `https://${provider.toLowerCase()}-ready.example`,
      serverIdentityId: `srv_${provider.toLowerCase()}_ready`, accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: 'host', installationId: 'installation' })]);
    const service = 'connectedAccountDescriptors' in manifest.contributes
      ? manifest.contributes.connectedAccountDescriptors?.[0] : undefined;
    const account = service ? { service: { pluginId: manifest.id, localId: service.id }, accountId: 'connected-account' } : undefined;
    if (account) {
      const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
      const activeAccount = await activateStorageAccountScope({
        serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner',
      }, storage);
      onTestFinished(() => activeAccount.dispose());
    }
    const credentialPurposes = account ? [{ purpose: { consumer: contribution, purpose: 'cloud-api' },
      options: [{ value: account, label: provider }] }] : [];
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [{ contribution, occurrenceId: provider, acquireExecutionTarget: 'daemon' as const, descriptor, credentialPurposes }] }],
      ['machines.provisioners.check', { available: true }],
      ['machines.provisioners.options', createMachineProvisionerOptionsFixture({ base: { launch: {} } })],
    ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = readProvisionerRequest(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
    } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={defaultController} />);
    try {
      if (account) {
        const { Modal } = await import('@/modal');
        const show = vi.mocked(Modal.show);
        const sheetCount = show.mock.calls.length;
        const alertCount = vi.mocked(Modal.alert).mock.calls.length;
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.connect:cloud-api')).not.toBeNull());
        expect(screen.findByTestId('managed-config.connect:cloud-api')?.props.disabled).not.toBe(true);
        expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(0);
        await screen.pressByTestIdAsync('managed-config.connect:cloud-api');
        expect(vi.mocked(Modal.alert).mock.calls).toHaveLength(alertCount);
        await waitForHomeGovernance(() => expect(show.mock.calls.slice(sheetCount).some(([config]) => config.chrome?.testID === 'connect-sheet')).toBe(true));
        const sheet = show.mock.calls.slice(sheetCount).find(([config]) => config.chrome?.testID === 'connect-sheet')?.[0];
        if (!sheet?.props) throw new Error('Expected the in-place Connect sheet');
        onTestFinished(() => sheet.onRequestClose?.());
        expect(sheet.props.request).toMatchObject({ purpose: { consumer: contribution, purpose: 'cloud-api' },
          purposeRequest: { machineId: defaultController.machineId, purpose: { consumer: contribution, purpose: 'cloud-api' } } });
        await act(async () => sheet.props?.onResult({ kind: 'selected', account }));
        expect(vi.mocked(Modal.alert).mock.calls).toHaveLength(alertCount);
        await waitForHomeGovernance(() => expect(vi.mocked(Modal.hide)).toHaveBeenCalled());
        const { t } = await import('@/text');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('connectedServices.detail.actions.reconnect')));
        await screen.pressByTestIdAsync('managed-config.connect:cloud-api');
        const selectedSheet = show.mock.calls.at(-1)?.[0];
        expect(selectedSheet?.chrome?.testID).toBe('connect-sheet');
        expect(selectedSheet?.props?.request).toMatchObject({ service: account.service, account });
        await act(async () => selectedSheet?.props?.onResult({ kind: 'dismissed' }));
      }
      await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.check').length).toBeGreaterThan(0));
      await waitForHomeGovernance(() => expect(sectionReads).toBeGreaterThan(0));
      // This exact question is already authorized by the selected catalog occurrence.
      // No presentation section must finish before schema acquisition or the options read.
      expect(sectionCompletions).toBe(0);
      expect(schemaRequests()).toHaveLength(1);
      expect(schemaRequests()[0]?.[0]).toMatchObject({ machineId: defaultController.machineId, payload: {
        machineId: defaultController.machineId, expectedOccurrenceId: provider,
        qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: declaration.id }),
      } });
      expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(0);
      await act(async () => schema.resolve({ ok: true, inputSchema: declaration.inputSchema }));
      await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(1));
      expect(readProvisionerRequest(harness.requestsFor('/v1/actions/machines.provisioners.options')[0]?.input)).toMatchObject({ input: {
        contribution, controller: defaultController,
        ...(account ? { credentials: [{ purpose: { consumer: contribution, purpose: 'cloud-api' }, account }] } : {}),
      } });
      await flushHookEffects();
      expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(1);
      expect(sectionCompletions).toBe(0);
      await act(async () => hydration.resolve());
      await waitForHomeGovernance(() => {
        const entry = readCachedDaemonMergedProjectionCacheEntry({ serverId, machineId: defaultController.machineId, sections: ['actionsById'] });
        expect(entry?.kind === 'ready' ? entry.inputs.pluginUiProjection?.actionsById[
          buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: declaration.id })]?.occurrenceId : null).toBe(provider);
      });
      await flushHookEffects();
      expect(schemaRequests()).toHaveLength(1);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(1);
    } finally { hydration.resolve(); await screen.unmount(); }
  });
  it.each([
    'ready',
    'schema-unavailable',
  ] as const)(
    'keeps options question settlement free of timers for %s',
    async (outcome) => {
      const binding = {
        serverId: 'server-a',
        accountId: 'owner',
        revision: 1,
        scope: { serverId: 'server-a', accountId: 'owner' },
        isCurrent: () => true,
        onRetire: () => ({ dispose() {} }),
      } satisfies ServerCredentialAccountScopeBinding;
      nativeBoundary.rpc.mockResolvedValue(
        outcome === 'schema-unavailable'
          ? { ok: false, code: 'action_not_found' }
          : {
              ok: true,
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
      );
      const { useManagedProvisionerOptionsInput } =
        await import('./useManagedProvisionerOptionsInput');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const hook = await renderHook(() =>
          useManagedProvisionerOptionsInput({
            binding,
            controller: defaultController,
            provisioner,
          }),
        );
        await flushHookEffects();
        expect(hook.getCurrent().kind).toBe(
          outcome === 'ready' ? 'ready' : 'unavailable',
        );
        // Schema settlement starts no competing deadline or idle recovery timer.
        expect(vi.getTimerCount()).toBe(0);
        await hook.unmount();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it.each(['ready', 'unavailable'] as const)('publishes no loading or equal options-schema result on refresh (%s)', async outcome => {
    const binding = {
      serverId: 'server-a', accountId: 'owner', revision: 1,
      scope: { serverId: 'server-a', accountId: 'owner' }, isCurrent: () => true,
      onRetire: () => ({ dispose() {} }),
    } satisfies ServerCredentialAccountScopeBinding;
    let changed = false;
    nativeBoundary.rpc.mockImplementation(async () => outcome === 'unavailable'
      ? { ok: false, code: 'action_not_found' }
      : { ok: true, inputSchema: { type: 'object', properties: changed ? { region: { type: 'string' } } : {}, additionalProperties: false } });
    const { useManagedProvisionerOptionsInput } = await import('./useManagedProvisionerOptionsInput');
    const publications: unknown[] = [];
    const hook = await renderHook(({ refreshKey }) => {
      const value = useManagedProvisionerOptionsInput({ binding, controller: defaultController, provisioner, refreshKey });
      React.useEffect(() => { publications.push(value); }, [value]);
      return value;
    }, { initialProps: { refreshKey: 0 } });
    try {
      await flushHookEffects();
      expect(hook.getCurrent().kind).toBe(outcome);
      const settled = hook.getCurrent();
      publications.length = 0;
      await hook.rerender({ refreshKey: 1 });
      await flushHookEffects();
      expect(publications).toHaveLength(0);
      expect(hook.getCurrent()).toBe(settled);
      if (outcome === 'ready') {
        changed = true;
        await hook.rerender({ refreshKey: 2 });
        await flushHookEffects();
        expect(publications).toHaveLength(1);
        expect(hook.getCurrent()).toMatchObject({ kind: 'ready', schema: { properties: { region: { type: 'string' } } } });
      }
    } finally { await hook.unmount(); }
  });
  it('accepts a slow schema answer without starting a competing deadline', async () => {
    const binding = {
      serverId: 'server-a',
      accountId: 'owner',
      revision: 1,
      scope: { serverId: 'server-a', accountId: 'owner' },
      isCurrent: () => true,
      onRetire: () => ({ dispose() {} }),
    } satisfies ServerCredentialAccountScopeBinding;
    let answer!: (value: unknown) => void;
    nativeBoundary.rpc.mockImplementation(
      async () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { useManagedProvisionerOptionsInput } =
      await import('./useManagedProvisionerOptionsInput');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const hook = await renderHook(() => useManagedProvisionerOptionsInput({
        binding, controller: defaultController, provisioner,
      }));
      expect(hook.getCurrent().kind).toBe('loading');
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1,
        );
      });
      expect(hook.getCurrent().kind).toBe('loading');
      await act(async () => {
        answer({
          ok: true,
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        });
      });
      expect(hook.getCurrent().kind).toBe('ready');
      expect(vi.getTimerCount()).toBe(0);
      await hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps the schema read through an unchanged catalog refresh and replaces it for a new plugin occurrence', async () => {
    const binding = {
      serverId: 'server-a',
      accountId: 'owner',
      revision: 1,
      scope: { serverId: 'server-a', accountId: 'owner' },
      isCurrent: () => true,
      onRetire: () => ({ dispose() {} }),
    } satisfies ServerCredentialAccountScopeBinding;
    const reads: Readonly<{ signal?: AbortSignal; payload: Readonly<{ expectedOccurrenceId: string }> }>[] = [];
    const answers = new Map<string, ReturnType<typeof createDeferred<unknown>>>();
    nativeBoundary.rpc.mockImplementation(
      async (request: { method: string; signal?: AbortSignal; payload: Readonly<{ expectedOccurrenceId: string }> }) => {
        if (request.method !== RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ)
          return { ok: false, code: 'unsupported' };
        reads.push(request);
        const answer = createDeferred<unknown>();
        answers.set(request.payload.expectedOccurrenceId, answer);
        return answer.promise;
      },
    );
    const { useManagedProvisionerOptionsInput } =
      await import('./useManagedProvisionerOptionsInput');
    const hook = await renderHook(
      (selected: typeof provisioner) =>
        useManagedProvisionerOptionsInput({
          binding,
          controller: defaultController,
          provisioner: selected,
        }),
      { initialProps: provisioner },
    );
    try {
      expect(reads).toHaveLength(1);
      await hook.rerender({ ...provisioner });
      expect(reads).toHaveLength(1);
      expect(reads[0]?.signal?.aborted).toBe(false);
      await hook.rerender({ ...provisioner, occurrenceId: 'replacement' });
      expect(reads).toHaveLength(2);
      expect(reads[0]?.signal?.aborted).toBe(true);
      await act(async () => answers.get(provisioner.occurrenceId)?.resolve({ ok: false, code: 'plugin_occurrence_stale' }));
      expect(hook.getCurrent().kind).toBe('loading');
      const schema = { type: 'object', properties: {}, additionalProperties: false };
      await act(async () => answers.get('replacement')?.resolve({ ok: true, inputSchema: schema }));
      expect(hook.getCurrent()).toMatchObject({ kind: 'ready', schema, action: { occurrenceId: 'replacement' } });
    } finally { await hook.unmount(); }
    expect(reads[1]?.signal?.aborted).toBe(true);
  });
  it('retires a pending schema read and ignores its delayed answer after the Account changes', async () => {
    let current = true;
    let retire!: () => void;
    const binding = {
      serverId: 'server-a',
      accountId: 'owner',
      revision: 1,
      scope: { serverId: 'server-a', accountId: 'owner' },
      isCurrent: () => current,
      onRetire: (callback: () => void) => {
        retire = callback;
        return { dispose() {} };
      },
    } satisfies ServerCredentialAccountScopeBinding;
    let signal: AbortSignal | undefined;
    let answer!: (value: unknown) => void;
    nativeBoundary.rpc.mockImplementation(
      async (request: { signal?: AbortSignal }) => {
        signal = request.signal;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    );
    const { useManagedProvisionerOptionsInput } =
      await import('./useManagedProvisionerOptionsInput');
    const hook = await renderHook(() =>
      useManagedProvisionerOptionsInput({
        binding,
        controller: defaultController,
        provisioner,
      }),
    );
    await act(async () => {
      current = false;
      retire();
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      answer({
        ok: true,
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      });
    });
    expect(hook.getCurrent()).toEqual({
      kind: 'unavailable',
      error: 'controller_unavailable',
    });
    await hook.unmount();
  });
  it('says why an unavailable provisioner cannot create here in the check\u2019s own words, with its next step', async () => {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://unavailable-check.example',
      serverIdentityId: 'srv_unavailable_check',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const local = {
      ...provisioner,
      descriptor: {
        ...provisioner.descriptor,
        billing: { location: 'local', stoppedBilling: 'not-billed' },
      },
    };
    const status = {
      key: 'custom.compute.status.notInstalled',
      fallback: 'Not installed \u00b7 install the tool',
    };
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [local] },
      ],
      [
        'machines.provisioners.check',
        { available: false, code: 'tool_unavailable', status },
      ],
      [
        'machines.provisioners.options',
        {
          dimensions: {
            size: [],
            image: [],
            location: [],
            network: [],
            duration: [],
          },
        },
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(local.contribution)}
        initialController={defaultController}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.unavailable')).not.toBeNull(),
    );
    expect(screen.getTextContent()).toContain(status.fallback);
    await screen.unmount();
  });
  it.each(['available', 'absent', 'failed'] as const)(
    'keeps the saved-preset Create review pending until its reads settle (%s, J58 READY68)', async outcome => {
      const serverId = await addPresetHome({ name: 'Compute', serverUrl: `https://pending-review-${outcome}.example`,
        serverIdentityId: 'srv_pending_review', accountId: 'owner', currentAccount: true });
      await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: defaultController.machineId,
        installationId: defaultController.installationId })]);
      const presetRead = createDeferred<void>();
      const catalogRead = createDeferred<void>();
      const saved = { id: 'pending-review', homeId: 'srv_pending_review', revision: 1, name: 'Saved machine',
        owner: { kind: 'account', accountId: 'owner' }, controller: defaultController,
        launch: { provider: provisioner.contribution, schemaVersion: 1, name: 'Saved machine', choices: { cpu: 2 } } } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
      harness.answer(serverId, '/v1/machines/presets/get', { select: async () => {
        await presetRead.promise;
        return outcome === 'failed' ? { status: 503, body: { code: 'unavailable' } }
          : { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(saved) } };
      } });
      for (const [actionId, result] of [
        ['machines.provisioners.list', { controller: defaultController, provisioners: outcome === 'absent' ? [] : [provisioner] }],
        ['machines.provisioners.check', { available: true }],
        ['machines.provisioners.options', createManagedCpuOptionsFixture([{ id: 'small', title: 'Small', cpu: 2 }])],
      ] as const) await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, { select: async value => {
        if (actionId === 'machines.provisioners.list') await catalogRead.promise;
        const request = readProvisionerRequest(value);
        return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
      } });
      const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
      const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
      const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} presetId={saved.id}
        initialController={defaultController} />);
      const catalogState = () => screen.tree.findAllByType(SurfaceStateCard)
        .find(node => node.props.testID === 'managed-config.catalog')?.props;
      try {
        await waitForHomeGovernance(() => expect(harness.requests.some(request =>
          new URL(request.path, request.serverUrl).pathname === '/v1/machines/presets/get')).toBe(true));
        expect(catalogState()?.kind).toBe('loading');
        expect(screen.findByTestId('managed-config.create')).toBeNull();
        await act(async () => presetRead.resolve());
        if (outcome === 'failed') {
          await waitForHomeGovernance(() => expect(catalogState()).toMatchObject({ kind: 'error', diagnosticCode: expect.any(String) }));
          return;
        }
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.list').length).toBeGreaterThan(0));
        expect(catalogState()?.kind).toBe('loading');
        await act(async () => catalogRead.resolve());
        if (outcome === 'absent') {
          await waitForHomeGovernance(() => expect(catalogState()?.kind).toBe('empty'));
        } else {
          await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
          expect(catalogState()).toBeUndefined();
        }
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
      } finally { await screen.unmount(); }
    },
  );
  it('reads as loading, not as a verdict, while a named controller waits for the machine list to sync', async () => {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://unsynced-list.example',
      serverIdentityId: 'srv_unsynced_list',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
    // This is an intentionally incomplete list-read fixture. Clear retained global rows and
    // publish a null scoped list so the resolver cannot treat an older Home's row as a verdict.
    storage.setState({ machines: {}, machineListByServerId: { [scopeId]: null }, machineRecordsByServerId: { [scopeId]: {} },
      machineListStatusByServerId: { [scopeId]: 'loading' } });
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={defaultController}
      />,
    );
    await flushHookEffects();
    const catalogState = () =>
      screen.tree
        .findAll((node) => node.props.testID === 'managed-config.catalog')
        .map((node) => node.props.kind);
    expect(catalogState(), JSON.stringify(screen.tree
      .findAllByType(SurfaceStateCard)
      .map(node => ({ kind: node.props.kind, title: node.props.title, diagnosticCode: node.props.diagnosticCode })))
      + JSON.stringify(harness.requests.map(request => request.path))).toContain('loading');
    expect(catalogState()).not.toContain('empty');
    // Once the Home's list has really synced without the named controller, the empty verdict is true.
    await act(async () => {
      await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, []);
    });
    await flushHookEffects();
    expect(catalogState()).toContain('empty');
    expect(harness.requests.filter(request => request.path.includes('machines.provisioners.'))).toEqual([]);
    await screen.unmount();
  });
  it('names the controller it could not read and offers Retry when the catalog read fails, instead of a bare refusal', async () => {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://unreadable-controller.example',
      serverIdentityId: 'srv_unreadable_controller',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: defaultController.machineId, installationId: defaultController.installationId }),
        ]);
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.list', {
      status: 503,
      body: { code: 'service_unavailable' },
    }, true);
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={defaultController}
      />,
    );
    const errorCards = () =>
      screen.tree.findAll(
        (node) =>
          node.props.testID === 'managed-config.catalog' &&
          node.props.kind === 'error',
      );
    await waitForHomeGovernance(() =>
      expect(errorCards().length).toBeGreaterThan(0),
    );
    expect(errorCards()[0]!.props.action?.label).toBeTruthy();
    const text = await import('@/text');
    expect(String(errorCards()[0]!.props.title), JSON.stringify({ language: text.getPreferredLanguage(),
      translationType: typeof text.getTranslationValue('managedMachines.add.controllerUnreadable') })).toContain('tester.local');
    await screen.unmount();
  });
  it('refuses a schema-less options Action without probing native options or losing the configurator', async () => {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://missing-options-schema.example',
      serverIdentityId: 'srv_missing_options_schema',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const read = nativeBoundary.rpc.getMockImplementation();
    nativeBoundary.rpc.mockImplementation(
      async (request: { method: string }) =>
        request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
          ? { ok: true }
          : read?.(request),
    );
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [provisioner] },
      ],
      ['machines.provisioners.check', { available: true }],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={defaultController}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.error')).not.toBeNull(),
    );
    expect(nativeBoundary.rpc).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: defaultController.machineId,
        method: RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ,
        payload: {
          machineId: defaultController.machineId,
          expectedOccurrenceId: provisioner.occurrenceId,
          qualifiedActionId: buildQualifiedPluginContributionKey({
            pluginId: provisioner.contribution.pluginId,
            localId: 'options',
          }),
        },
      }),
    );
    expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(
      true,
    );
    expect(
      harness.requestsFor('/v1/actions/machines.provisioners.options'),
    ).toEqual([]);
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
    await screen.unmount();
  });
  it.each([390, 1440])('shows a real delayed schema refusal and retries to a valid delayed answer (%dpx)', async width => {
    const viewport = vi.spyOn(Dimensions, 'get')
      .mockReturnValue({ width, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://silent-options-schema.example',
      serverIdentityId: 'srv_silent_options_schema',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const read = nativeBoundary.rpc.getMockImplementation();
    let schemaReads = 0;
    const schemaReadSignals: AbortSignal[] = [];
    const replies: Array<(value: unknown) => void> = [];
    nativeBoundary.rpc.mockImplementation(
      async (request: { method: string; signal?: AbortSignal }) => {
        if (request.method !== RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ)
          return read?.(request);
        schemaReads++;
        if (request.signal) schemaReadSignals.push(request.signal);
        return new Promise((resolve) => {
          replies.push(resolve);
        });
      },
    );
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [provisioner] },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        {
          dimensions: {
            size: [],
            image: [],
            location: [],
            network: [],
            duration: [],
          },
        },
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: async (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const { t } = await import('@/text');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const screen = await renderScreen(
        <ManagedMachineConfigurationView
          serverId={serverId}
          provisioner={buildQualifiedPluginContributionKey(
            provisioner.contribution,
          )}
          initialController={defaultController}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1,
        );
      });
      expect(schemaReads).toBe(1);
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
      if (width === 390) {
        expect(screen.findByTestId('managed-config.summary')?.props.accessibilityLabel).toContain(
          t('managedMachines.options.loading', { provider: 'Virtual machine' }),
        );
      } else {
        const receipt = screen.tree.findAll(node => node.props.model?.primary?.testID === 'managed-config.create')[0];
        expect(receipt?.props.model.primary.footnote).toBe(
          t('managedMachines.options.loading', { provider: 'Virtual machine' }),
        );
      }
      expect(screen.getTextContent()).toContain(
        t('managedMachines.options.loading', { provider: 'Virtual machine' }),
      );
      expect(screen.findByTestId('managed-config.error')).toBeNull();
      await act(async () => {
        replies[0]({ ok: false, code: 'action_not_found' });
      });
      expect(screen.findByTestId('managed-config.error')).not.toBeNull();
      expect(screen.getTextContent()).not.toContain(
        t('managedMachines.options.loading', { provider: 'Virtual machine' }),
      );
      // Retry reads again while retaining this exact schema refusal until a new answer settles.
      await act(async () => {
        screen.pressByTestId('managed-config.error-action');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(schemaReads).toBe(2);
      expect(screen.findByTestId('managed-config.error')).not.toBeNull();
      expect(screen.getTextContent()).not.toContain(
        t('managedMachines.options.loading', { provider: 'Virtual machine' }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1,
        );
      });
      expect(screen.findByTestId('managed-config.error')).not.toBeNull();
      // Retry also reloads the merged projection. Its temporary loading phase retains this
      // exact Action occurrence and must not cancel the replacement schema read.
      expect(schemaReadSignals).toHaveLength(2);
      expect(schemaReadSignals[1]?.aborted).toBe(false);
      await act(async () => {
        replies[1]({
          ok: true,
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        });
      });
      // The schema answer starts the real check/options HTTP continuation.
      await flushHookEffects({ advanceTimersMs: 0 });
      expect(screen.findByTestId('managed-config.error')).toBeNull();
      expect(screen.getTextContent()).not.toContain(
        t('managedMachines.options.loading', { provider: 'Virtual machine' }),
      );
      await screen.unmount();
      expect(schemaReadSignals[1]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps pending check and schema reads alive until the form unmounts', async () => {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://silent-everything.example',
      serverIdentityId: 'srv_silent_everything',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const read = nativeBoundary.rpc.getMockImplementation();
    nativeBoundary.rpc.mockImplementation(
      async (request: { method: string }) =>
        request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
          ? new Promise(() => {})
          : read?.(request),
    );
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.list', {
      select: (value) => {
        const request = readProvisionerRequest(value);
        return {
          body: {
            v: 1,
            actionId: 'machines.provisioners.list',
            requestId: request.requestId,
            execution: {
              ok: true,
              result: {
                controller: defaultController,
                provisioners: [provisioner],
              },
            },
          },
        };
      },
    });
    // A loaded host answers neither the check nor the schema read.
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.check', {
      respondAfter: new Promise<void>(() => {}),
    }, true);
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const { t } = await import('@/text');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const screen = await renderScreen(
        <ManagedMachineConfigurationView
          serverId={serverId}
          provisioner={buildQualifiedPluginContributionKey(
            provisioner.contribution,
          )}
          initialController={defaultController}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1_000,
        );
      });
      expect(screen.findByTestId('managed-config.error')).toBeNull();
      expect(screen.getTextContent()).toContain(
        t('managedMachines.options.loading', { provider: 'Virtual machine' }),
      );
      expect(
        harness.requestsFor('/v1/actions/machines.provisioners.check'),
      ).toHaveLength(1);
      await screen.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  it('settles native options independently when the controller\u2019s presentation projection has failed', async () => {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://failed-projection.example',
      serverIdentityId: 'srv_failed_projection',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const read = nativeBoundary.rpc.getMockImplementation();
    nativeBoundary.rpc.mockImplementation(
      async (request: { method: string }) => {
        if (
          request.method ===
          RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
        )
          throw new Error('rpc_failed');
        return read?.(request);
      },
    );
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [provisioner] },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        {
          dimensions: {
            size: [],
            image: [],
            location: [],
            network: [],
            duration: [],
          },
        },
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={defaultController}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(1),
    );
    await flushHookEffects();
    expect(screen.findByTestId('managed-config.error')).toBeNull();
    expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(1);
    await screen.unmount();
  });
  it('puts a failed read where the choices would be instead of a column of empty fields', async () => {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://failed-read-blank-fields.example',
      serverIdentityId: 'srv_failed_read_blank_fields',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const action = PluginProjectedActionV2Schema.parse({
      id: 'options',
      pluginId: provisioner.contribution.pluginId,
      occurrenceId: provisioner.occurrenceId,
      title: 'Native options',
      scopes: ['machine'],
      surfaces: ['cli', 'plugin'],
      execution: { target: 'daemon' },
      available: true,
      dangerLevel: 'safe',
      inputHints: {
        fields: [
          {
            path: 'instance',
            title: 'Instance name',
            widget: 'text',
            required: true,
          },
        ],
      },
    });
    const projection =
      DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1,
        projection: {
          ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
          agentsById: {},
          diagnostics: [],
          installedPackagesById: {
            [action.pluginId]: {
              ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE
                .installedPackagesById['acme.review'],
              id: action.pluginId,
            },
          },
          actionsById: {
            [buildQualifiedPluginContributionKey({
              pluginId: action.pluginId,
              localId: action.id,
            })]: action,
          },
        },
      });
    nativeBoundary.rpc.mockImplementation(
      async (request: { method: string }) =>
        request.method ===
        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
          ? projection
          : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
            ? {
                ok: true,
                inputSchema: {
                  type: 'object',
                  properties: { instance: { type: 'string' } },
                  additionalProperties: false,
                },
              }
            : { ok: false, code: 'unsupported' },
    );
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.list', {
      select: (value) => {
        const request = readProvisionerRequest(value);
        return {
          body: {
            v: 1,
            actionId: 'machines.provisioners.list',
            requestId: request.requestId,
            execution: {
              ok: true,
              result: {
                controller: defaultController,
                provisioners: [provisioner],
              },
            },
          },
        };
      },
    });
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.check', {
      status: 500,
      body: { code: 'unavailable' },
    }, true);
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={defaultController}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.error')).not.toBeNull(),
    );
    // The required field has nothing in it and the read that would fill its choices failed: no empty box to fill.
    expect(screen.findByTestId('managed-config.field:instance')).toBeNull();
    expect(screen.findByTestId('managed-config.error-action')).not.toBeNull();
    await screen.unmount();
  });
  it('leaves the phone summary without a dash while no price is known', async () => {
    const viewport = vi
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://unpriced-summary.example',
      serverIdentityId: 'srv_unpriced_summary',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [provisioner] },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        {
          base: { launch: { cpu: 2 }, guestPlatform: 'linux' },
          dimensions: {
            size: [],
            image: [],
            location: [],
            network: [],
            duration: [],
          },
        },
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={defaultController}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.summary')).not.toBeNull(),
    );
    await waitForHomeGovernance(() => {
      const summary = screen.findByTestId('managed-config.summary')?.props.accessibilityLabel;
      expect(summary).toContain('Virtual machine');
      expect(summary).not.toContain('\u2014');
    });
    await screen.unmount();
  });
  it.each([false, true])('offers retained wake for a resume-only provisioner and preserves the choice in composer intent (drafted prompt: %s)', async (startsSession) => {
    const viewport = vi
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://resume-wake.example',
      serverIdentityId: 'srv_resume_wake',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const resumable = {
      ...provisioner,
      descriptor: {
        ...provisioner.descriptor,
        retention: { supportedIntents: ['resume', 'stop', 'delete'] },
      },
    };
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [resumable] },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        createManagedCpuOptionsFixture([
          { id: 'resumable', title: 'Resumable compute', cpu: 2 },
        ]),
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const onUse = vi.fn();
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={defaultController}
        onUse={onUse}
        startsSession={startsSession}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('managed-config.sizes:resumable'),
      ).not.toBeNull(),
    );
    await screen.pressByTestIdAsync('managed-config.sizes:resumable');
    const wakeSwitch = 'managed-config.receipt:keep:wake:switch';
    // Always on never stops, so the wake row sits beside a Stop rule (58d §D4).
    expect(screen.findByTestId(wakeSwitch)).toBeNull();
    await screen.pressByTestIdAsync('managed-config.receipt:keep:choice:unused:stop:3600000');
    expect(screen.findByTestId(wakeSwitch)).not.toBeNull();
    await act(async () =>
      screen.findByTestId(wakeSwitch)?.props.onValueChange(true),
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(
        false,
      ),
    );
    // From a composer holding a drafted prompt the one press creates and starts the session (58d receipt, Q2);
    // otherwise it is plain Use, and only Send admits an acquisition.
    const { t } = await import('@/text');
    expect(screen.getTextContent().includes(t('managedMachines.receipt.createAndStart'))).toBe(startsSession);
    await screen.pressByTestIdAsync('managed-config.use');
    expect(onUse).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: expect.objectContaining({ wakeOnAcceptedMessage: true }),
        receipt: expect.objectContaining({ wakeOnAcceptedMessage: true }),
      }),
      ...(startsSession ? [{ send: true }] : []),
    );
    expect(onUse.mock.calls[0]).toHaveLength(startsSession ? 2 : 1);
    await screen.unmount();
  });
  it('keeps a local VM receipt free of a bill before any choice exists (UIR5c)', async () => {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://local-empty-receipt.example',
      serverIdentityId: 'srv_local_empty_receipt',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const local = {
      ...provisioner,
      descriptor: {
        ...provisioner.descriptor,
        billing: { location: 'local', stoppedBilling: 'not-billed' },
      },
    };
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [local] },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        {
          dimensions: {
            size: [],
            image: [],
            location: [],
            network: [],
            duration: [],
          },
        },
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const { t } = await import('@/text');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(local.contribution)}
        initialController={defaultController}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.getTextContent()).toContain(
        t('managedMachines.price.noBill'),
      ),
    );
    expect(screen.getTextContent()).not.toContain(
      t('managedMachines.price.unavailable', { provider: 'Virtual machine' }),
    );
    await screen.unmount();
  });
  it('does not call an untouched launch "no choices": the required fields are what it awaits, and once filled a truly empty answer says so', async () => {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://untouched-launch.example',
      serverIdentityId: 'srv_untouched_launch',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const local = {
      ...provisioner,
      descriptor: {
        ...provisioner.descriptor,
        billing: { location: 'local', stoppedBilling: 'not-billed' },
      },
    };
    const action = PluginProjectedActionV2Schema.parse({
      id: 'options',
      pluginId: provisioner.contribution.pluginId,
      occurrenceId: provisioner.occurrenceId,
      title: 'Native options',
      scopes: ['machine'],
      surfaces: ['cli', 'plugin'],
      execution: { target: 'daemon' },
      available: true,
      dangerLevel: 'safe',
      inputHints: {
        fields: [
          {
            path: 'instance',
            title: 'Instance name',
            widget: 'text',
            required: true,
          },
        ],
      },
    });
    const projection =
      DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1,
        projection: {
          ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
          agentsById: {},
          diagnostics: [],
          installedPackagesById: {
            [action.pluginId]: {
              ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE
                .installedPackagesById['acme.review'],
              id: action.pluginId,
            },
          },
          actionsById: {
            [buildQualifiedPluginContributionKey({
              pluginId: action.pluginId,
              localId: action.id,
            })]: action,
          },
        },
      });
    nativeBoundary.rpc.mockImplementation(
      async (request: { method: string }) =>
        request.method ===
        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
          ? projection
          : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
            ? {
                ok: true,
                inputSchema: {
                  type: 'object',
                  properties: { instance: { type: 'string' } },
                  additionalProperties: false,
                },
              }
            : { ok: false, code: 'unsupported' },
    );
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [local] },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        {
          dimensions: {
            size: [],
            image: [],
            location: [],
            network: [],
            duration: [],
          },
        },
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const { t } = await import('@/text');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(local.contribution)}
        initialController={defaultController}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('managed-config.field:instance'),
      ).not.toBeNull(),
    );
    await waitForHomeGovernance(() =>
      expect(
        harness.requests.some(
          (request) =>
            request.path === '/v1/actions/machines.provisioners.options',
        ),
      ).toBe(true),
    );
    await flushHookEffects({ cycles: 10 });
    const emptyNotice = t('managedMachines.options.empty', {
      provider: 'Virtual machine',
    });
    expect(screen.getTextContent()).not.toContain(emptyNotice);
    expect(screen.getTextContent()).toContain(t('session.actionsDraft.validation.requiredField', { field: 'Instance name' }));
    await act(async () =>
      screen.changeTextByTestId('managed-config.field:instance', 'studio'),
    );
    await waitForHomeGovernance(() =>
      expect(screen.getTextContent()).toContain(emptyNotice),
    );
    await screen.unmount();
  });
  it('discloses conditional cloud quotes and lets coupled native dimensions be staged without acquiring', async () => {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://conditional-quotes.example',
      serverIdentityId: 'srv_conditional_quotes',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const nativeFacts = {
      size: { id: 'small', title: 'Small' },
      image: { id: 'linux', title: 'Linux' },
      location: { id: 'west', title: 'West' },
    };
    const price = (amount: string, location: string) => ({
      amount,
      currency: 'EUR',
      unit: 'hour',
      source: 'native',
      observedAt: 10,
      when: [{ dimension: 'location' as const, optionIds: [location] }],
    });
    const options = createMachineProvisionerOptionsFixture({
      base: { launch: {} },
      dimensions: {
        size: [
          {
            id: 'small',
            title: 'Small',
            assignments: [{ path: 'cpu', value: 2 }],
            nativeFacts: { size: nativeFacts.size },
            prices: [price('1', 'west'), price('3', 'east')],
          },
        ],
        image: [
          { id: 'linux', title: 'Linux', assignments: [] },
          { id: 'other', title: 'Other image', assignments: [] },
          {
            id: 'windows',
            title: 'Windows',
            assignments: [],
            available: false,
          },
        ],
        location: [
          { id: 'west', title: 'West', assignments: [] },
          { id: 'east', title: 'East', assignments: [] },
        ],
        network: [],
        duration: [],
      },
      constraints: [
        {
          when: { dimension: 'image', optionIds: ['linux'] },
          requires: { dimension: 'location', optionIds: ['west'] },
        },
        {
          when: { dimension: 'image', optionIds: ['other'] },
          requires: { dimension: 'location', optionIds: ['east'] },
        },
      ],
    });
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [provisioner] },
      ],
      ['machines.provisioners.check', { available: true }],
      ['machines.provisioners.options', options],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const { t } = await import('@/text');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={defaultController}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.images:linux')).not.toBeNull(),
    );
    await act(async () => screen.pressByTestId('managed-config.images:linux'));
    const sizes = screen.tree.findAll(
      (node) =>
        node.props.testID === 'managed-config.sizes' &&
        typeof node.props.onChange === 'function',
    )[0];
    await act(async () => sizes?.props.onChange('small'));
    await act(async () =>
      screen.pressByTestId('managed-config.locations:west'),
    );
    expect(
      screen.tree.findAll(
        (node) =>
          node.props.testID === 'managed-config.sizes' &&
          typeof node.props.onChange === 'function',
      )[0]?.props.sizes[0].hourly,
    ).toContain('1');
    // A choice says why it can't be picked: one never offered here, one only not with the other picks.
    expect(screen.getTextContent()).toContain(
      t('managedMachines.options.notOffered', { provider: 'Virtual machine' }),
    );
    expect(screen.getTextContent()).toContain(
      t('managedMachines.options.unavailableWithChoices'),
    );
    expect(findAllHostTestInstances(screen.tree, node => node.type === 'Text'
      && node.props.children === t('managedMachines.options.unavailable'))).toEqual([]);
    await act(async () => screen.pressByTestId('managed-config.images:other'));
    expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(
      true,
    );
    await act(async () =>
      screen.pressByTestId('managed-config.locations:east'),
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(
        false,
      ),
    );
    expect(
      harness.requestsFor('/v1/actions/machines.managed.acquire'),
    ).toHaveLength(0);
    await screen.unmount();
  });
  it('offers the provider’s networking variants as one more choice, so the person can pick the one without the extra address charge', async () => {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://network-variants.example',
      serverIdentityId: 'srv_network_variants',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const facts = {
      size: { id: 'small', title: 'Small' },
      image: { id: 'linux', title: 'Linux' },
      location: { id: 'west', title: 'West' },
    };
    const price = (amount: string, label: string) => ({
      amount,
      currency: 'EUR',
      unit: 'month',
      source: 'native',
      observedAt: 10,
      label,
    });
    const options = createMachineProvisionerOptionsFixture({
      base: { launch: {} },
      dimensions: {
        size: [
          {
            id: 'small',
            title: 'Small',
            assignments: [{ path: 'cpu', value: 2 }],
            nativeFacts: { size: facts.size },
            prices: [price('3.49', 'Compute')],
          },
        ],
        image: [{ id: 'linux', title: 'Linux', assignments: [] }],
        location: [{ id: 'west', title: 'West', assignments: [] }],
        network: [
          {
            id: '10',
            title: 'IPv4 only',
            assignments: [],
            prices: [price('0.60', 'Primary IPv4')],
          },
          { id: '01', title: 'IPv6 only', assignments: [] },
        ],
        duration: [],
      },
    });
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [provisioner] },
      ],
      ['machines.provisioners.check', { available: true }],
      ['machines.provisioners.options', options],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={defaultController}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.networks:01')).not.toBeNull(),
    );
    await act(async () => screen.pressByTestId('managed-config.images:linux'));
    await act(async () =>
      screen.tree
        .findAll(
          (node) =>
            node.props.testID === 'managed-config.sizes' &&
            typeof node.props.onChange === 'function',
        )[0]
        ?.props.onChange('small'),
    );
    await act(async () =>
      screen.pressByTestId('managed-config.locations:west'),
    );
    // The provider's first variant stands until another is chosen, and it shows its address charge.
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(
        false,
      ),
    );
    expect(screen.getTextContent()).toContain('Primary IPv4');
    await act(async () => screen.pressByTestId('managed-config.networks:01'));
    expect(screen.getTextContent()).not.toContain('Primary IPv4');
    expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(
      false,
    );
    expect(
      harness.requestsFor('/v1/actions/machines.managed.acquire'),
    ).toHaveLength(0);
    await screen.unmount();
  });
  it('keeps the actual Modal timeout as one editable field inside Ends without rereading the preset options', async () => {
    const viewport = vi
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await addPresetHome({
      name: 'Modal compute',
      serverUrl: 'https://modal-duration.example',
      serverIdentityId: 'srv_modal_duration',
      accountId: 'owner',
      currentAccount: true,
    });
    const controller = { machineId: 'host', installationId: 'installation' };
    await publishPresetEditorDeclaration(serverId, PluginPortableReleaseManifestV1Schema.parse(modalManifest));
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({
            id: controller.machineId,
            installationId: controller.installationId,
          }),
        ]);
    const descriptor = modalManifest.contributes.machineProvisioners?.[0];
    if (!descriptor)
      throw new Error('The actual Modal manifest must declare its provisioner');
    const optionsDeclaration = modalManifest.contributes.actions?.find(
      (action) => action.id === descriptor.actions.options,
    );
    if (!optionsDeclaration?.inputSchema || !optionsDeclaration.inputHints)
      throw new Error(
        'The actual Modal options declaration must publish its schema and fields',
      );
    const contribution = { pluginId: modalManifest.id, localId: descriptor.id };
    const modal = {
      contribution,
      occurrenceId: 'modal-provisioner',
      acquireExecutionTarget: 'daemon' as const,
      descriptor,
      credentialPurposes: [],
    };
    const action = PluginProjectedActionV2Schema.parse({
      id: optionsDeclaration.id,
      pluginId: modalManifest.id,
      occurrenceId: modal.occurrenceId,
      title: optionsDeclaration.title,
      scopes: optionsDeclaration.scopes,
      surfaces: optionsDeclaration.surfaces,
      execution: optionsDeclaration.execution,
      dangerLevel: optionsDeclaration.dangerLevel,
      inputHints: optionsDeclaration.inputHints,
      available: true,
    });
    const projection =
      DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1,
        projection: {
          ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
          agentsById: {},
          diagnostics: [],
          installedPackagesById: {
            [modalManifest.id]: {
              ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE
                .installedPackagesById['acme.review'],
              id: modalManifest.id,
            },
          },
          actionsById: {
            [buildQualifiedPluginContributionKey({
              pluginId: modalManifest.id,
              localId: optionsDeclaration.id,
            })]: action,
          },
        },
      });
    nativeBoundary.rpc.mockImplementation(
      async (request: { method: string }) =>
        request.method ===
        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
          ? projection
          : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
            ? { ok: true, inputSchema: optionsDeclaration.inputSchema }
            : { ok: false, code: 'unsupported' },
    );
    const launch = ModalLaunchV1Schema.parse({
      appReference: 'reviewed-app',
      imageReference: 'reviewed-image',
      resources: { cpu: 0.5, memoryMb: 1024 },
      timeoutMs: 7_200_000,
    });
    const saved = {
      id: 'modal-preset',
      homeId: 'srv_modal_duration',
      revision: 1,
      name: 'Saved Modal',
      owner: { kind: 'account', accountId: 'owner' },
      controller,
      launch: {
        provider: contribution,
        schemaVersion: descriptor.schemaVersion,
        name: 'Saved Modal',
        choices: launch,
      },
    } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(saved) },
    });
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller, provisioners: [modal] }],
      ['machines.provisioners.check', { available: true }],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const capturedSelectors: unknown[] = [];
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.options', {
      select: (value) => {
        const request = readProvisionerRequest(value);
        if (
          !request.input ||
          typeof request.input !== 'object' ||
          Array.isArray(request.input)
        )
          throw new Error('The native options input must be an object');
        const selectors = Reflect.get(request.input, 'selectors');
        capturedSelectors.push(selectors);
        const complete = ModalLaunchV1Schema.safeParse(selectors);
        const selected = complete.success ? complete.data : null;
        return {
          body: {
            v: 1,
            actionId: 'machines.provisioners.options',
            requestId: request.requestId,
            execution: {
              ok: true,
              result: createMachineProvisionerOptionsFixture(
                selected
                  ? {
                      base: {
                        launch: selected,
                        nativeFacts: {
                          image: {
                            id: selected.imageReference,
                            title: selected.imageReference,
                          },
                          size: {
                            id: `${selected.resources.cpu}:${selected.resources.memoryMb}`,
                            title: `${selected.resources.cpu} CPU · ${selected.resources.memoryMb} MiB`,
                            cpuCores: selected.resources.cpu,
                            memoryBytes:
                              selected.resources.memoryMb * 1024 * 1024,
                          },
                          duration: {
                            id: String(selected.timeoutMs),
                            title: `${selected.timeoutMs / 1000} s`,
                            afterMs: selected.timeoutMs,
                          },
                        },
                      },
                      dimensions: {
                        size: [],
                        image: [],
                        location: [],
                        network: [],
                        duration: [
                          {
                            id: String(selected.timeoutMs),
                            title: `${selected.timeoutMs / 1000} s`,
                            assignments: [],
                            nativeFacts: {
                              duration: {
                                id: String(selected.timeoutMs),
                                title: `${selected.timeoutMs / 1000} s`,
                                afterMs: selected.timeoutMs,
                              },
                            },
                          },
                        ],
                      },
                    }
                  : {},
              ),
            },
          },
        };
      },
    });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(contribution)}
        presetId={saved.id}
        presetOnly
        initialController={controller}
      />,
    );
    const timeoutField = 'managed-config.field:timeoutMs';
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId(timeoutField)).not.toBeNull(),
    );
    const keep = screen.tree.findAll(
      (node) =>
        node.props.finiteOnly && node.props.nativeDuration,
    )[0];
    expect(keep?.props.nativeDuration).toMatchObject({
      value: null,
      choices: [],
    });
    expect(
      screen.findByTestId('managed-config.receipt:keep:retention'),
    ).not.toBeNull();
    expect(
      screen.findByTestId('managed-config.field:appReference'),
    ).not.toBeNull();
    expect(
      screen.findByTestId('managed-config.field:resources.cpu'),
    ).not.toBeNull();
    expect(
      findAllHostTestInstances(
        screen.tree,
        (node) => node.props.testID === timeoutField,
      ).length,
    ).toBe(1);
    expect(
      keep
        ? findAllHostTestInstances(
            keep,
            (node) => node.props.testID === timeoutField,
          ).length
        : 0,
    ).toBe(1);
    expect(
      screen.tree.findAll(
        (node) =>
          node.props.items?.some(
            (item: { id: string }) => item.id === String(launch.timeoutMs),
          ) && typeof node.props.onSelect === 'function',
      ),
    ).toHaveLength(0);
    const updated = { ...launch, timeoutMs: 1_800_000 };
    await act(async () =>
      screen.changeTextByTestId(timeoutField, String(updated.timeoutMs)),
    );
    // A preset-only editor owns the saved launch declaration. Its local edit does not
    // re-run the creation-time options Action or replace the exact native facts.
    expect(capturedSelectors).toHaveLength(0);
    expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(0);
    expect(
      screen.tree.findAll(
        (node) =>
          node.props.finiteOnly &&
          node.props.nativeDuration?.choices?.length > 0,
      ),
    ).toHaveLength(0);
    expect(screen.findByTestId(timeoutField)?.props.value).toBe(
      String(updated.timeoutMs),
    );
    // The declared form already reviewed this exact complete launch; its
    // singleton native facts do not require redundant size/image picks.
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(
        false,
      ),
    );
    harness.answer(serverId, '/v1/machines/presets/update', {
      body: {
        kind: 'saved',
        preset: createPlainManagedMachinePresetFixture({
          ...saved,
          revision: 2,
          launch: { ...saved.launch, choices: updated },
        }),
      },
    });
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() =>
      expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(
        1,
      ),
    );
    const update = harness.requestsFor('/v1/machines/presets/update')[0]?.input;
    expect(update).toMatchObject({ patch: { content: { t: 'plain', v: { launch: { choices: updated } } } } });
    expect(
      harness.requests.some((request) =>
        request.path.endsWith('machines.managed.acquire'),
      ),
    ).toBe(false);
    await screen.unmount();
  });
  it.each([false, true])('creates from a saved Cua preset showing its own choices chosen, without raw fields or a byte count (archived=%s)', async (archived) => {
    const viewport = vi
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await addPresetHome({
      name: 'Cua compute',
      serverUrl: 'https://cua-preset.example',
      serverIdentityId: 'srv_cua_preset',
      accountId: 'owner',
      currentAccount: true,
    });
    const controller = { machineId: 'host', installationId: 'installation' };
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({
            id: controller.machineId,
            installationId: controller.installationId,
          }),
        ]);
    const descriptor = MachineProvisionerContributionV1Schema.parse(
      CUA_PLUGIN.manifest.contributes.machineProvisioners?.find(
        (entry) => entry.id === 'local-sandbox',
      ),
    );
    const optionsDeclaration = PluginActionContributionV2Schema.parse(
      CUA_PLUGIN.manifest.contributes.actions?.find(
        (entry) => entry.id === descriptor.actions.options,
      ),
    );
    const contribution = {
      pluginId: CUA_PLUGIN.manifest.id,
      localId: descriptor.id,
    };
    // The hints exactly as the daemon projection publishes them: authored fields completed from the input schema.
    const action = PluginProjectedActionV2Schema.parse({
      id: optionsDeclaration.id,
      pluginId: contribution.pluginId,
      occurrenceId: 'cua',
      title: 'Cua options',
      scopes: optionsDeclaration.scopes,
      surfaces: optionsDeclaration.surfaces,
      execution: optionsDeclaration.execution,
      dangerLevel: optionsDeclaration.dangerLevel,
      available: true,
      inputHints: normalizePluginActionInputHintsV2(
        optionsDeclaration.inputHints,
        optionsDeclaration.inputSchema,
      ),
    });
    const projection =
      DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1,
        projection: {
          ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
          agentsById: {},
          diagnostics: [],
          installedPackagesById: {
            [contribution.pluginId]: {
              ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE
                .installedPackagesById['acme.review'],
              id: contribution.pluginId,
            },
          },
          actionsById: {
            [buildQualifiedPluginContributionKey({
              pluginId: contribution.pluginId,
              localId: action.id,
            })]: action,
          },
        },
      });
    nativeBoundary.rpc.mockImplementation(
      async (request: { method: string }) =>
        request.method ===
        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
          ? projection
          : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
            ? { ok: true, inputSchema: optionsDeclaration.inputSchema }
            : { ok: false, code: 'unsupported' },
    );
    const imageId = 'ghcr.io/trycua/linux:24.04';
    const size = { cpu: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 3188907520 };
    const saved = {
      id: 'cua-preset',
      homeId: 'srv_cua_preset',
      revision: 0,
      name: 'Saved Cua',
      owner: { kind: 'account', accountId: 'owner' },
      controller,
      launch: {
        provider: contribution,
        schemaVersion: descriptor.schemaVersion,
        name: 'Saved Cua',
        choices: { on: 'local', imageId, runtimeId: 'runc', size },
      },
      ...(archived ? { archivedAt: 1 } : {}),
    } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(saved) },
    });
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        {
          controller,
          provisioners: [
            {
              contribution,
              occurrenceId: 'cua',
              acquireExecutionTarget: 'daemon' as const,
              descriptor,
              credentialPurposes: [],
            },
          ],
        },
      ],
      ['machines.provisioners.check', { available: true }],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    // Only native process IO is substituted; Cua's own option reader assigns the rows.
    const digest = `sha256:${'a'.repeat(64)}`;
    const native = createCuaNativeClient({
      executable: { kind: 'systemTool', id: 'cua' },
      exec: {
        run: async (request) => {
          const args = request.args?.join(' ');
          const value =
            args === '--json --embedded runtime doctor'
              ? {
                  host: {
                    os: 'linux',
                    arch: 'x86_64',
                    kvm: false,
                    accel: { x86_64: 'tcg', aarch64: 'tcg' },
                  },
                  backends: [
                    { backend: 'container', ready: true, provisionable: false },
                  ],
                  qemu: { version: null },
                  container: {
                    reachable: true,
                    gvisor: false,
                    runtimes: ['runc'],
                  },
                }
              : args === '--json images ls'
                ? [
                    {
                      ref: imageId,
                      published: true,
                      os: 'linux',
                      arch: ['amd64'],
                      local: 'container',
                      spacesd: true,
                      digest,
                      sizes: {
                        digest,
                        platforms: [{ arch: 'amd64', disk: size.diskBytes }],
                      },
                    },
                  ]
                : undefined;
          if (!value) throw new Error(`Unexpected native operation: ${args}`);
          return {
            termination: {
              observed: { kind: 'exit', exitCode: 0 },
              requestedBy: { kind: 'none' },
            },
            stdout: new TextEncoder().encode(JSON.stringify(value)),
            stderr: new Uint8Array(),
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
      },
    });
    await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.options', {
      select: async (value) => {
        const request = readProvisionerRequest(value);
        const selectors = CuaLocalOptionsQueryV1Schema.parse(
          (request.input as { selectors?: unknown }).selectors ?? {},
        );
        return {
          body: {
            v: 1,
            actionId: 'machines.provisioners.options',
            requestId: request.requestId,
            execution: {
              ok: true,
              result: await createCuaNativeFacts(native).options(
                undefined,
                selectors,
              ),
            },
          },
        };
      },
    });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(contribution)}
        presetId={saved.id}
        initialController={controller}
      />,
    );
    const imageTiles = () =>
      screen.tree.findAll(
        (node) =>
          node.props.testIdPrefix === 'managed-config.images' &&
          Array.isArray(node.props.options),
      )[0];
    await waitForHomeGovernance(() =>
      expect(imageTiles()?.props.value).toBe(imageId),
    );
    const { t } = await import('@/text');
    // The page says the launch is the preset's instead of asking to pick it.
    expect(screen.getTextContent()).toContain(
      t('managedMachines.config.presetDescription', { preset: saved.name }),
    );
    expect(screen.getTextContent()).not.toContain(
      t('managedMachines.config.description'),
    );
    // The preset's own image and place are the chosen ones, not "no longer available".
    expect(imageTiles()?.props.options).toEqual([
      expect.objectContaining({ id: imageId, disabled: true }),
    ]);
    expect(screen.getTextContent()).not.toContain(
      t('managedMachines.options.unavailable'),
    );
    const locations = screen.tree.findAll(
      (node) =>
        node.props.testIdPrefix === 'managed-config.locations' &&
        Array.isArray(node.props.options),
    )[0];
    expect(locations?.props.value).toBe('runc');
    // Choices the sections already make are not repeated as raw provider fields.
    for (const path of [
      'imageId',
      'runtimeId',
      'size.cpu',
      'size.memoryBytes',
      'size.diskBytes',
    ])
      expect(screen.findByTestId(`managed-config.field:${path}`)).toBeNull();
    // The preset's size is its one chosen row; the disk reads in its unit, never as a byte count.
    const sizeTable = screen.tree.findAll(
      (node) =>
        node.props.testID === 'managed-config.sizes' &&
        Array.isArray(node.props.sizes),
    )[0];
    expect(sizeTable?.props.value).toBe(sizeTable?.props.sizes[0]?.id);
    expect(sizeTable?.props.sizes).toEqual([
      expect.objectContaining({
        disk: formatManagedSizeBytes(size.diskBytes),
        selectable: false,
      }),
    ]);
    expect(screen.getTextContent()).not.toContain(String(size.diskBytes));
    expect(
      harness.requestsFor('/v1/actions/machines.managed.acquire'),
    ).toHaveLength(0);
    // An archived preset says why it cannot create, as its own page does; the live one says nothing.
    expect(screen.findByTestId('managed-config.preset-archived') !== null).toBe(archived);
    if (archived) {
      expect(screen.getTextContent()).toContain(t('machinePresets.archived'));
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
    }
    await screen.unmount();
  });
  it('discloses the first labelled native rate in the compact summary without computing a total', async () => {
    const viewport = vi
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://compact-prices.example',
      serverIdentityId: 'srv_compact_prices',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const action = PluginProjectedActionV2Schema.parse({
      id: 'options',
      pluginId: provisioner.contribution.pluginId,
      occurrenceId: provisioner.occurrenceId,
      title: 'Native options',
      scopes: ['machine'],
      surfaces: ['cli', 'plugin'],
      execution: { target: 'daemon' },
      available: true,
      dangerLevel: 'safe',
    });
    const projection =
      DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1,
        projection: {
          ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
          agentsById: {},
          diagnostics: [],
          installedPackagesById: {
            [action.pluginId]: {
              ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE
                .installedPackagesById['acme.review'],
              id: action.pluginId,
            },
          },
          actionsById: {
            [buildQualifiedPluginContributionKey({
              pluginId: action.pluginId,
              localId: action.id,
            })]: action,
          },
        },
      });
    nativeBoundary.rpc.mockImplementation(
      async (request: { method: string }) =>
        request.method ===
        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
          ? projection
          : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
            ? {
                ok: true,
                inputSchema: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
              }
            : { ok: false, code: 'unsupported' },
    );
    const prices = [
      {
        amount: '0.005',
        currency: 'EUR',
        unit: 'hour',
        source: 'native-compute',
        observedAt: 10,
        label: 'Compute',
      },
      {
        amount: '0.0008',
        currency: 'EUR',
        unit: 'hour',
        source: 'native-network',
        observedAt: 10,
        label: 'IPv4',
      },
    ];
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [provisioner] },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        createManagedCpuOptionsFixture([
          { id: 'native', title: 'Native compute', cpu: 2, prices },
        ]),
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={{
          machineId: 'host',
          installationId: 'installation',
        }}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.sizes:native')).not.toBeNull(),
    );
    await act(async () => screen.pressByTestId('managed-config.sizes:native'));
    const summary = screen.findByTestId('managed-config.summary')?.props
      .accessibilityLabel;
    expect(summary).toContain('Compute');
    expect(summary).toContain('0.005');
    expect(summary).toContain('€');
    expect(summary).toContain(
      (await import('@/text')).t('managedMachines.price.perHour'),
    );
    expect(summary).not.toContain('0.0058');
    await screen.unmount();
  });
  it.each(['entered', 'project-supplied'] as const)(
    'uses %s selectors in the shared native field/configuration continuation without acquiring',
    async (mode) => {
      const capturedSelectors: unknown[] = [];
      // The wide receipt exposes both real actions; compact anatomy is covered separately.
      const viewport = vi
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
      restoreViewport = () => viewport.mockRestore();
      const serverId = await addPresetHome({
        name: 'Compute',
        serverUrl: 'https://native-input.example',
        serverIdentityId: 'srv_native_input',
        accountId: 'owner',
        currentAccount: true,
      });
      await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
            createMachineFixture({
              id: 'host',
              installationId: 'installation',
            }),
          ]);
      const optionsSchema = {
        type: 'object',
        properties: {
          runtimeId: { type: 'string', enum: ['qemu'] },
          imageId: { type: 'string', minLength: 1 },
          size: {
            type: 'object',
            properties: {
              cpu: { type: 'integer', minimum: 1 },
              memoryBytes: { type: 'integer', minimum: 1 },
              diskBytes: { type: 'integer', minimum: 1 },
            },
            required: ['cpu', 'memoryBytes', 'diskBytes'],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      };
      const native = {
        ...provisioner,
        descriptor: {
          ...provisioner.descriptor,
          launchSchema: {
            ...optionsSchema,
            properties: {
              ...optionsSchema.properties,
              on: { type: 'string', enum: ['local'] },
            },
            required: ['on', 'runtimeId', 'imageId', 'size'],
          },
        },
      };
      const action = PluginProjectedActionV2Schema.parse({
        id: 'options',
        pluginId: provisioner.contribution.pluginId,
        occurrenceId: provisioner.occurrenceId,
        title: 'Native options',
        scopes: ['machine'],
        surfaces: ['cli', 'plugin'],
        execution: { target: 'daemon' },
        available: true,
        dangerLevel: 'safe',
        inputHints: {
          fields: [
            { path: 'runtimeId', title: 'Runtime', widget: 'text' },
            { path: 'imageId', title: 'Image', widget: 'text' },
            { path: 'size.cpu', title: 'CPU', widget: 'integer' },
            {
              path: 'size.memoryBytes',
              title: 'Memory bytes',
              widget: 'integer',
            },
            { path: 'size.diskBytes', title: 'Disk bytes', widget: 'integer' },
          ],
        },
      });
      const projection =
        DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
          protocolVersion: 1,
          projection: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
            agentsById: {},
            diagnostics: [],
            installedPackagesById: {
              [action.pluginId]: {
                ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE
                  .installedPackagesById['acme.review'],
                id: action.pluginId,
              },
            },
            actionsById: {
              [buildQualifiedPluginContributionKey({
                pluginId: action.pluginId,
                localId: action.id,
              })]: action,
            },
          },
        });
      nativeBoundary.rpc.mockImplementation(
        async (request: { method: string }) =>
          request.method ===
          RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? projection
            : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
              ? { ok: true, inputSchema: optionsSchema }
              : { ok: false, code: 'unsupported' },
      );
      for (const [actionId, result] of [
        [
          'machines.provisioners.list',
          { controller: defaultController, provisioners: [native] },
        ],
        ['machines.provisioners.check', { available: true }],
      ] as const)
        await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
          select: (value) => {
            const request = readProvisionerRequest(value);
            return {
              body: {
                v: 1,
                actionId,
                requestId: request.requestId,
                execution: { ok: true, result },
              },
            };
          },
        });
      const launch = {
        on: 'local',
        runtimeId: 'qemu',
        imageId: 'linux',
        size: { cpu: 4, memoryBytes: 4294967296, diskBytes: 85899345920 },
      };
      const prices = [
        {
          amount: '0.005',
          currency: 'EUR',
          unit: 'hour',
          source: 'native-compute',
          observedAt: 10,
          label: 'Compute',
        },
        {
          amount: '0.0008',
          currency: 'EUR',
          unit: 'hour',
          source: 'native-network',
          observedAt: 10,
          label: 'IPv4',
        },
      ];
      await answerProvisionerAction(serverId, '/v1/actions/machines.provisioners.options', {
        select: (value) => {
          const request = readProvisionerRequest(value);
          const input = request.input as { selectors?: unknown };
          capturedSelectors.push(input.selectors);
          const complete = pluginJsonValuesEqual(input.selectors, {
            runtimeId: launch.runtimeId,
            imageId: launch.imageId,
            size: launch.size,
          });
          return {
            body: {
              v: 1,
              actionId: 'machines.provisioners.options',
              requestId: request.requestId,
              execution: {
                ok: true,
                result: createMachineProvisionerOptionsFixture(
                  complete ? { base: { launch, prices } } : {},
                ),
              },
            },
          };
        },
      });
      const onUse = vi.fn();
      const { ManagedMachineConfigurationView } =
        await import('./ManagedMachineConfigurationView');
      const screen = await renderScreen(
        <ManagedMachineConfigurationView
          serverId={serverId}
          provisioner={buildQualifiedPluginContributionKey(
            provisioner.contribution,
          )}
          initialController={{
            machineId: 'host',
            installationId: 'installation',
          }}
          onUse={onUse}
          initialOptionsSelectors={
            mode === 'project-supplied'
              ? {
                  runtimeId: launch.runtimeId,
                  imageId: launch.imageId,
                  size: launch.size,
                }
              : undefined
          }
        />,
      );
      await waitForHomeGovernance(() =>
        expect(
          harness.requestsFor('/v1/actions/machines.provisioners.options')
            .length,
        ).toBeGreaterThan(0),
      );
      if (mode === 'project-supplied')
        expect(capturedSelectors).toContainEqual({
          runtimeId: launch.runtimeId,
          imageId: launch.imageId,
          size: launch.size,
        });
      expect(
        screen.findByTestId('managed-config.field:size.cpu'),
      ).not.toBeNull();
      for (const [path, value] of mode === 'entered'
        ? ([
            ['runtimeId', 'qemu'],
            ['imageId', 'linux'],
            ['size.cpu', '4'],
            ['size.memoryBytes', '4294967296'],
            ['size.diskBytes', '85899345920'],
          ] as const)
        : []) {
        await act(async () =>
          screen.changeTextByTestId(`managed-config.field:${path}`, value),
        );
      }
      await flushHookEffects();
      // Field edits are read after the shared typing pause, not the render turn.
      await waitForHomeGovernance(() =>
        expect(capturedSelectors.at(-1)).toEqual({
          runtimeId: launch.runtimeId,
          imageId: launch.imageId,
          size: launch.size,
        }),
      );
      await waitForHomeGovernance(() =>
        expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(
          false,
        ),
      );
      expect(screen.findByTestId('managed-config.save-preset')).not.toBeNull();
      await waitForHomeGovernance(() =>
        expect(
          screen.findByTestId('managed-config.save-preset')?.props.disabled,
        ).toBe(false),
      );
      await act(async () => screen.pressByTestId('managed-config.use'));
      expect(capturedSelectors).toContainEqual({
        runtimeId: 'qemu',
        imageId: 'linux',
        size: launch.size,
      });
      expect(onUse).toHaveBeenCalledWith(
        expect.objectContaining({
          selection: expect.objectContaining({
            launch: expect.objectContaining({ choices: launch }),
          }),
        }),
      );
      expect(
        harness.requests.some((request) =>
          request.path.endsWith('machines.managed.acquire'),
        ),
      ).toBe(false);
      await act(async () =>
        screen.changeTextByTestId('managed-config.field:size.cpu', '0'),
      );
      expect(screen.findByTestId('managed-config.use')).not.toBeNull();
      expect(screen.findByTestId('managed-config.save-preset')).not.toBeNull();
      expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(
        true,
      );
      expect(
        screen.findByTestId('managed-config.save-preset')?.props.disabled,
      ).toBe(true);
      await act(async () => {
        screen.pressByTestId('managed-config.use');
        screen.pressByTestId('managed-config.save-preset');
      });
      expect(onUse).toHaveBeenCalledTimes(1);
      expect(
        harness.requestsFor('/v1/machines/presets/create'),
      ).toHaveLength(0);
      await screen.unmount();
    },
  );
  it('uses the one finite Ends control to choose the exact declared native duration before committing composer intent', async () => {
    const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://duration.example',
      serverIdentityId: 'srv_duration',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const finite = {
      ...provisioner,
      descriptor: {
        ...provisioner.descriptor,
        retention: { supportedIntents: ['delete'], finiteOnly: true },
      },
    };
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [finite] },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        createMachineProvisionerOptionsFixture({
          base: { launch: {} },
          dimensions: {
            size: [],
            image: [],
            location: [],
            network: [],
            duration: [
              {
                id: 'short',
                title: 'Short',
                assignments: [{ path: 'cpu', value: 2 }],
                nativeFacts: {
                  duration: {
                    id: 'short',
                    title: '1 hour',
                    afterMs: 3_600_000,
                  },
                },
              },
              {
                id: 'long',
                title: 'Long',
                assignments: [{ path: 'cpu', value: 4 }],
                nativeFacts: {
                  duration: {
                    id: 'long',
                    title: '2 hours',
                    afterMs: 7_200_000,
                  },
                },
              },
            ],
          },
        }),
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const onUse = vi.fn();
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={{
          machineId: 'host',
          installationId: 'installation',
        }}
        onUse={onUse}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.tree.findAll(
          (node) =>
            node.props.finiteOnly &&
            node.props.nativeDuration?.choices?.length === 2,
        ).length,
      ).toBeGreaterThan(0),
    );
    const control = screen.tree.findAll(
      (node) =>
        node.props.finiteOnly &&
        node.props.nativeDuration?.choices?.length === 2,
    )[0];
    await act(async () => control?.props.nativeDuration.onChange('long'));
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(
        false,
      ),
    );
    await act(async () => screen.pressByTestId('managed-config.use'));
    expect(onUse).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: expect.objectContaining({
          launch: expect.objectContaining({ choices: { cpu: 4 } }),
        }),
        receipt: expect.objectContaining({
          nativeFacts: {
            duration: { id: 'long', title: '2 hours', afterMs: 7_200_000 },
          },
          retention: { kind: 'unused', afterMs: 3_600_000, effect: 'delete' },
          wakeOnAcceptedMessage: false,
        }),
      }),
    );
    expect(
      harness.requests.some((request) =>
        request.path.endsWith('machines.managed.acquire'),
      ),
    ).toBe(false);
    const current = createMachineFixture({
      id: 'host',
      installationId: 'replacement-installation',
    });
    if (!current.metadata)
      throw new Error('Canonical machine fixture metadata is required');
    const replacement = createMachineFixture({
      id: 'host',
      installationId: 'replacement-installation',
      metadata: { ...current.metadata, host: 'Replacement controller' },
    });
    await act(async () =>
      publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [replacement]),
    );
    const { MachineConfigurationReceipt } = await import('./MachineConfigurationReceipt');
    const receipts = screen.findAllByType(MachineConfigurationReceipt);
    expect(receipts.length).toBeGreaterThan(0);
    for (const receipt of receipts) expect(receipt.props.model.facts).not.toContainEqual(expect.objectContaining({ id: 'controller' }));
    for (const receipt of receipts)
      expect(findTestInstanceByTypeContainingText(receipt, Text, 'Replacement controller')).toBeUndefined();
    await screen.unmount();
  });
  it('mounts the contributed size, image and location controls over complete native choices and keeps reviewed facts together', async () => {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://dimensions.example',
      serverIdentityId: 'srv_dimensions',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const nativeFacts = {
      size: {
        id: 'small',
        title: 'Small',
        cpuCores: 2,
        memoryBytes: 4294967296,
        diskBytes: 85899345920,
      },
      image: { id: 'linux', title: 'Linux' },
      location: { id: 'west', title: 'West' },
    };
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [provisioner] },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        createMachineProvisionerOptionsFixture({
          base: { launch: {} },
          dimensions: {
            size: [
              {
                id: 'small',
                title: 'Small',
                assignments: [{ path: 'cpu', value: 2 }],
                nativeFacts: { size: nativeFacts.size },
              },
            ],
            image: [
              {
                id: 'linux',
                title: 'Linux',
                assignments: [],
                nativeFacts: { image: nativeFacts.image },
              },
            ],
            location: [
              {
                id: 'west',
                title: 'West',
                assignments: [],
                nativeFacts: { location: nativeFacts.location },
              },
            ],
            network: [],
            duration: [],
          },
        }),
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={{
          machineId: 'host',
          installationId: 'installation',
        }}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.tree.findAll(
          (node) => node.props.testID === 'managed-config.sizes',
        ).length,
      ).toBeGreaterThan(0),
    );
    const sizes = screen.tree.findAll(
      (node) =>
        node.props.testID === 'managed-config.sizes' &&
        typeof node.props.onChange === 'function',
    )[0];
    expect(sizes?.props.sizes[0]).toMatchObject({
      id: 'small',
      name: 'Small',
      cpu: '2',
    });
    await act(async () => sizes?.props.onChange('small'));
    // Picking among the returned choices is local: the answer on screen is not asked for again, and the controller's
    // projection is described once for this visit, not per click.
    const reads = () => ({
      options: harness.requests.filter(
        (request) =>
          request.path === '/v1/actions/machines.provisioners.options',
      ).length,
      describes: nativeBoundary.rpc.mock.calls.filter(
        ([request]) =>
          request.method ===
          RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      ).length,
    });
    const beforeClicks = reads();
    expect(beforeClicks.describes).toBe(1);
    expect(
      screen.tree.findAll(
        (node) => node.props.testID === 'managed-config.images',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.tree.findAll(
        (node) => node.props.testID === 'managed-config.locations',
      ).length,
    ).toBeGreaterThan(0);
    const images = screen.tree.findAll(
      (node) =>
        node.props.testID === 'managed-config.images' &&
        typeof node.props.onChange === 'function',
    )[0];
    const locations = screen.tree.findAll(
      (node) =>
        node.props.testID === 'managed-config.locations' &&
        typeof node.props.onChange === 'function',
    )[0];
    await act(async () => images?.props.onChange('linux'));
    await act(async () => locations?.props.onChange('west'));
    await flushHookEffects({ cycles: 5 });
    expect(reads()).toEqual(beforeClicks);
    expect(
      screen.tree.findAll((node) =>
        node.props.model?.facts?.some(
          (fact: { id: string; value: string }) =>
            fact.id === 'image' && fact.value === 'Linux',
        ),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      harness.requestsFor('/v1/actions/machines.managed.acquire'),
    ).toHaveLength(0);
    await screen.unmount();
  });
  it('describes a local machine\u2019s location as where it runs, not as a distance to the person', async () => {
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://local-location.example',
      serverIdentityId: 'srv_local_location',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    const local = {
      ...provisioner,
      descriptor: {
        ...provisioner.descriptor,
        billing: { location: 'local', stoppedBilling: 'not-billed' },
      },
    };
    const nativeFacts = {
      image: { id: 'linux', title: 'Linux' },
      location: { id: 'runc', title: 'runc' },
    };
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [local] },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        createMachineProvisionerOptionsFixture({
          base: { launch: { cpu: 2 } },
          dimensions: {
            size: [],
            image: [
              {
                id: 'linux',
                title: 'Linux',
                assignments: [],
                nativeFacts: { image: nativeFacts.image },
              },
            ],
            location: [
              {
                id: 'runc',
                title: 'runc',
                assignments: [],
                nativeFacts: { location: nativeFacts.location },
              },
            ],
            network: [],
            duration: [],
          },
        }),
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const { t } = await import('@/text');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(local.contribution)}
        initialController={defaultController}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.locations')).not.toBeNull(),
    );
    expect(screen.getTextContent()).not.toContain(
      t('managedMachines.config.locationDescription'),
    );
    await screen.unmount();
  });
  it.each(['use', 'create', 'route-create'] as const)('uses a reviewed one-off as composer intent without admitting a resource in the configurator (%s)', async (intent) => {
    const createOnUse = intent !== 'use';
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://compute.example',
      serverIdentityId: 'srv_compute',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ]);
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [provisioner] },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        createManagedCpuOptionsFixture([
          { id: 'small', title: 'Small', cpu: 2 },
        ]),
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const onUse = vi.fn();
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const { ManagedMachineConfigurationScreen } = await import('./ManagedMachineConfigurationScreen');
    route.params = { serverId, provisioner: buildQualifiedPluginContributionKey(provisioner.contribution),
      machineId: 'host', installationId: 'installation', draftId: 'original-composer' };
    route.getState.mockReturnValue({ index: 2, routes: [
      { key: 'composer', name: 'new', params: { draftId: 'original-composer' } },
      { key: 'add', name: 'settings/machines/add', params: route.params },
      { key: 'configure', name: 'settings/machines/add/managed', params: route.params },
    ] });
    const screen = await renderScreen(
      intent === 'route-create' ? <ManagedMachineConfigurationScreen /> : <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
        initialController={{
          machineId: 'host',
          installationId: 'installation',
        }}
        onUse={onUse}
        createOnUse={createOnUse}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.tree.findAll(
          (node) => node.props.testID === 'managed-config.sizes:small',
        ).length,
      ).toBeGreaterThan(0),
    );
    await act(async () => screen.pressByTestId('managed-config.sizes:small'));
    await act(async () => screen.pressByTestId(createOnUse ? 'managed-config.create' : 'managed-config.use'));
    const returned = intent === 'route-create' ? route.dispatch.mock.calls.find(([action]) => action.type === 'SET_PARAMS')?.[0] : null;
    const { peekTempData } = await import('@/utils/sessions/tempDataStore');
    const data = returned ? peekTempData<import('@/utils/sessions/tempDataStore').NewSessionData>(returned.payload.params.dataId) : null;
    expect(intent === 'route-create' ? data?.managedMachineSelection : onUse.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        selection: {
          kind: 'one-off',
          homeId: 'srv_compute',
          launch: {
            provider: provisioner.contribution,
            schemaVersion: 1,
            name: 'Virtual machine',
            choices: { cpu: 2 },
          },
          controller: { machineId: 'host', installationId: 'installation' },
          retention: expect.any(Object),
          wakeOnAcceptedMessage: expect.any(Boolean),
        },
        archiveEffect: 'keep',
        receipt: expect.objectContaining({ optionStatus: 'current' }),
      }),
    );
    expect(intent === 'route-create' ? data?.managedMachineUseOptions : onUse.mock.calls[0]?.[1]).toEqual(createOnUse ? { create: true } : undefined);
    if (intent === 'route-create') {
      expect(returned?.source).toBe('composer');
      expect(route.dispatch).toHaveBeenCalledWith({ type: 'POP', payload: { count: 2 } });
      expect(route.replace).not.toHaveBeenCalled();
    }
    expect(
      harness.requests.some((request) =>
        request.path.endsWith('machines.managed.acquire'),
      ),
    ).toBe(false);
    await screen.unmount();
  });
  it('shows the captured Account creation-disabled lifecycle banner even when provisioners are unavailable', async () => {
    const target = await addPresetHome({
      name: 'No creation',
      serverUrl: 'https://no-creation.example',
      serverIdentityId: 'srv_no_creation',
      accountId: 'owner',
    });
    await addPresetHome({
      name: 'Other',
      serverUrl: 'https://other.example',
      serverIdentityId: 'srv_other',
      accountId: 'other',
    });
    harness.answer(target, '/v2/account/settings', {
      body: {
        content: { t: 'plain', v: { managedMachineCreationEnabled: false } },
        version: 1,
      },
    });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={target}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.tree.findAll(
          (node) =>
            node.props.testID === 'managed-config.catalog' &&
            node.props.kind !== 'loading',
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(
      screen.tree.findAll(
        (node) => node.props.testID === 'managed-config.creation-disabled',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      harness.requestsFor('/v1/actions/machines.managed.acquire'),
    ).toHaveLength(0);
    await screen.unmount();
  });
  it('reviews a one-off deadline, omits it from a saved preset, and preserves it after failed Create', async () => {
    const viewport = vi
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await addPresetHome({
      name: 'Compute',
      serverUrl: 'https://compute.example',
      serverIdentityId: 'srv_compute',
      accountId: 'owner',
      currentAccount: true,
    });
    const metadata = createMachineFixture().metadata;
    if (!metadata)
      throw new Error('The canonical controller fixture has no metadata');
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
          createMachineFixture({
            id: 'host',
            installationId: 'installation',
            activeAt: Date.now(),
            metadata: { ...metadata, host: 'Build host', platform: 'linux' },
          }),
        ]);
    for (const [actionId, result] of [
      [
        'machines.provisioners.list',
        { controller: defaultController, provisioners: [provisioner] },
      ],
      ['machines.provisioners.check', { available: true }],
      [
        'machines.provisioners.options',
        createManagedCpuOptionsFixture([
          { id: 'small', title: 'Small', cpu: 2 },
        ]),
      ],
    ] as const)
      await answerProvisionerAction(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = readProvisionerRequest(value);
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.requestId,
              execution: { ok: true, result },
            },
          };
        },
      });
    const { ManagedMachineConfigurationView } =
      await import('./ManagedMachineConfigurationView');
    const screen = await renderScreen(
      <ManagedMachineConfigurationView
        serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(
          provisioner.contribution,
        )}
      />,
    );
    // The Home's one controller ("Build host") is preselected, so its choices load without a controller pick.
    await waitForHomeGovernance(() =>
      expect(
        screen.tree.findAll(
          (node) => node.props.testID === 'managed-config.sizes:small',
        ).length,
      ).toBeGreaterThan(0),
    );
    await act(async () => screen.pressByTestId('managed-config.sizes:small'));
    expect(
      harness.requestsFor('/v1/actions/machines.managed.acquire'),
    ).toHaveLength(0);
    // A one-off machine has no audience or running limit: those belong to the preset editor.
    expect(screen.findByTestId('managed-config.audience')).toBeNull();
    expect(screen.findByTestId('managed-config.limit')).toBeNull();
    const keep = 'managed-config.receipt:keep';
    const deadline = {
      kind: 'deadline',
      at: new Date(2099, 0, 2, 18, 30).getTime(),
      effect: 'stop',
    };
    expect(screen.findByTestId(`${keep}:choice:deadline`)).not.toBeNull();
    expect(screen.findByTestId(`${keep}:deadline:confirm`)).toBeNull();
    await screen.pressByTestIdAsync(`${keep}:choice:deadline`);
    await act(async () =>
      screen.changeTextByTestId(`${keep}:deadline-date-input`, '2099-01-02'),
    );
    await act(async () =>
      screen.changeTextByTestId(`${keep}:deadline-time-input`, '18:30'),
    );
    expect(screen.findByTestId(`${keep}:deadline:interrupts`)).not.toBeNull();
    expect(
      harness.requestsFor('/v1/actions/machines.managed.acquire'),
    ).toHaveLength(0);
    expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(0);
    await screen.pressByTestIdAsync(`${keep}:deadline:confirm`);
    expect(
      screen.findByTestId('managed-config.receipt:secondary-note'),
    ).not.toBeNull();
    const saved = {
      id: 'saved',
      homeId: 'srv_compute',
      revision: 1,
      name: 'Virtual machine',
      owner: { kind: 'account', accountId: 'owner' },
      launch: {
        provider: provisioner.contribution,
        schemaVersion: 1,
        name: 'Virtual machine',
        choices: { cpu: 2 },
      },
      controller: { machineId: 'host', installationId: 'installation' },
    } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/create', {
      body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(saved) },
    });
    await act(async () => screen.pressByTestId('managed-config.save-preset'));
    await waitForHomeGovernance(() =>
      expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(
        1,
      ),
    );
    expect(
      harness.requestsFor('/v1/machines/presets/create')[0]?.input,
    ).toMatchObject({
      content: { t: 'plain', v: { launch: saved.launch } },
      controller: saved.controller,
      wakeOnAcceptedMessage: true,
    });
    expect(
      harness.requestsFor('/v1/machines/presets/create')[0]?.input,
    ).not.toHaveProperty('retention');
    expect(
      harness.requestsFor('/v1/actions/machines.managed.acquire'),
    ).toHaveLength(0);
    harness.answer(serverId, 'POST /v1/actions/machines.managed.acquire', {
      status: 403,
      body: { code: 'permission_denied' },
    });
    await answerAcquireController(serverId);
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false),
    );
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() =>
      expect(
        screen.tree.findAll(
          (node) => node.props.testID === 'managed-config.error',
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(
      acquiredIdentity(),
    ).toMatchObject({
      selection: { retention: deadline, wakeOnAcceptedMessage: true },
      reviewedFacts: { retention: deadline },
    });
    expect(
      screen.tree.findAll(
        (node) =>
          node.props.testID === 'managed-config.sizes:small' &&
          node.props.selected === true,
      ).length,
    ).toBeGreaterThan(0);
    harness.answer(serverId, 'POST /v1/actions/machines.managed.acquire', {
      select: (value) => {
        const { envelope: request } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(value);
        return {
          status: 409,
          body: {
            error: 'invalid_request',
            code: 'target_unavailable',
            requestId: request.requestId,
            managedAdmission: { managedId: 'waiting-managed' },
          },
        };
      },
    });
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false),
    );
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() =>
      expect(route.replace).toHaveBeenCalledWith(
        `/settings/machines/managed/waiting-managed?serverId=${encodeURIComponent(resolveServerProfileScopeIdForIdentifier(serverId))}`,
      ),
    );
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(2);
    await screen.unmount();
  });
});
