import {
  createManagedCpuOptionsFixture,
  createMachineProvisionerOptionsFixture,
  createManagedControllerMachineFixture as createMachineFixture,
} from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import {
  createMachineReadBatchResponseFixture,
  createPlainMachineRowFixture,
} from '@/dev/testkit/fixtures/machineFixtures';
import {
  renderHook,
  renderScreen,
  createDeferred,
  standardCleanup,
  flushHookEffects,
  reportPopoverContentLayout,
  withPopoverWebGlobals,
} from '@/dev/testkit';
import { findAllHostTestInstances } from '@/dev/testkit/render/renderScreen';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ProvisionerOptionsInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { Dimensions } from 'react-native';
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

const route = vi.hoisted(() => ({
  replace: vi.fn(),
  params: {} as Record<string, string>,
}));
const nativeBoundary = vi.hoisted(() => ({ rpc: vi.fn() }));
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
  router: async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      router: route,
      params: () => route.params,
    }).module,
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
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
  route.params = {};
  nativeBoundary.rpc.mockReset();
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
    launchSchema: {
      type: 'object',
      properties: { cpu: { type: 'integer', minimum: 1 } },
      required: ['cpu'],
      additionalProperties: false,
    },
    resourceSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
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

describe('mounted managed configurator', () => {
  it('does not render a named controller page for another Machine publication and updates its controller name', () => withPopoverWebGlobals(async () => {
    const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://controller-selection.example.test',
      serverIdentityId: 'srv_controller_selection', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const controllerMachine = createMachineFixture({ id: defaultController.machineId, installationId: defaultController.installationId,
      metadata: { ...createMachineFixture().metadata!, displayName: 'Build computer' } });
    const otherMachine = createMachineFixture({ id: 'other', installationId: 'other-installation',
      metadata: { ...createMachineFixture().metadata!, displayName: 'Other computer' } });
    const publicationScope = { sourceServerId: serverId, sourceAccountId: 'owner' };
    const scopeServerId = resolveServerProfileScopeIdForIdentifier(serverId);
    const previousMachines = storage.getState().machineListByServerId[scopeServerId] ?? [];
    storage.setState({ profileScope: { serverId, accountId: 'owner' } });
    storage.getState().applyMachines([controllerMachine, otherMachine], true, publicationScope);
    expect(storage.getState().machineRecordsByServerId[scopeServerId]?.host?.installationId).toBe(defaultController.installationId);
    storage.getState().markMachineListSettled(serverId);
    try {
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
      ['machines.provisioners.check', { available: true }],
      ['machines.provisioners.options', createManagedCpuOptionsFixture([{ id: 'small', title: 'Small', cpu: 2 }])],
    ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
      const otherOption = screen.findHostByTestId('managed-config.controller.picker-option:other');
      expect(otherOption?.props.accessibilityLabel ?? otherOption?.props['aria-label']).toContain('Renamed other computer');
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
          http: createPluginHttpFixture({ request: async ({ url }: HttpRequest) => ({ status: 200, finalUrl: url, headers: {}, body: new TextEncoder().encode('{}') }) }),
        } }));
      }
      const serverId = await harness.addHome({ name: 'Compute billing', serverUrl: `https://${vendor}-billing.example.test`,
        serverIdentityId: `srv_billing_${vendor}`, accountId: 'owner', currentAccount: true });
      const { storage } = await import('@/sync/domains/state/storage');
      storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: defaultController.machineId,
        installationId: defaultController.installationId })] } });
      for (const [actionId, result] of [
        ['machines.provisioners.list', { controller: defaultController, provisioners: [native] }],
        ['machines.provisioners.check', { available: true }], ['machines.provisioners.options', options],
      ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    const serverId = await harness.addHome({ name: 'Browser compute', serverUrl: 'https://browser-controller.example.test',
      serverIdentityId: 'srv_browser_controller', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: defaultController.machineId,
      installationId: defaultController.installationId })] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const selected = { ...provisioner, acquireExecutionTarget: 'account' as const,
      descriptor: { ...provisioner.descriptor, browserReachable: false } };
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [selected] }],
      ['machines.provisioners.check', { available: true }],
      ['machines.provisioners.options', createManagedCpuOptionsFixture([{ id: 'cloud', title: 'Cloud compute', cpu: 2 }])],
    ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
        for (const request of requests) expect(ExternalActionRequestEnvelopeV1Schema.parse(request.input).input)
          .toMatchObject({ controller: defaultController });
      }
    } finally { await screen.unmount(); }
  });
  it('reads Account options metadata and presentation without a controller or Machine RPC', async () => {
    runtimeHost.current = 'native';
    const { PLUGIN } = await import('../../../../../../../packages/plugins/machine-vercel/src/manifest');
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { installBundledPluginUiDeclarationsForTests } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
    const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN.manifest);
    const restoreBundles = installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
      packageName: '@happier-dev/plugins-machine-vercel', displayName: 'Vercel Machines', hasMachineProvisioners: true, entriesById: {},
      normalizedManifest: manifest }]);
    onTestFinished(restoreBundles);
    const serverId = await harness.addHome({ name: 'Fresh Account', serverUrl: 'https://account-options.example.test',
      serverIdentityId: 'srv_account_options', accountId: 'owner', currentAccount: true });
    const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
      await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { useManagedProvisionerOptionsInput } = await import('./useManagedProvisionerOptionsInput');
    const { useManagedProvisionerPresentation } = await import('./useManagedProvisionerPresentation');
    const { projectAccountManagedProvisioners } = await import('@happier-dev/cli-common/machines/managed/provisioners');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' };
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
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
      ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
      } });
      const { storage } = await import('@/sync/domains/state/storage');
      storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } });
      const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
      const onUse = vi.fn();
      const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
        provisioner={buildQualifiedPluginContributionKey(selected.contribution)} onUse={onUse} />);
      try {
        const { t } = await import('@/text');
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(true));
        expect(screen.getTextContent()).toContain(t('managedMachines.credential.choose'));
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
    const serverId = await harness.addHome({ name: 'Account acquire', serverUrl: 'https://account-acquire.example.test',
      serverIdentityId: 'srv_account_acquire', accountId: 'owner', currentAccount: true });
    const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
      await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const { projectAccountManagedProvisioners } = await import('@happier-dev/cli-common/machines/managed/provisioners');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' };
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
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
    ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
      const input = request.input as { controller?: unknown } | undefined;
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true,
        result: actionId === 'machines.provisioners.list' && input?.controller ? { ...result, controller: input.controller } : result } } };
    } });
    // A computer that could manage is online: before the acquire role decided, the page chose it by default.
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: defaultController.machineId,
      installationId: defaultController.installationId, activeAt: Date.now(), kind: 'persistent' })] },
      machineListStatusByServerId: { [serverId]: 'idle' } });
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
        run: async request => ({ termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(request.args?.[0] === 'info' ? JSON.stringify(info) : 'limactl version 2.2.1'),
        stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }) },
      managedServices: { supervise: unexpectedHostCall, dependencies: {
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
    const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://lima-partial.example',
      serverIdentityId: 'srv_lima_partial', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller: defaultController, provisioners: [{ contribution, occurrenceId: 'lima-partial', acquireExecutionTarget: 'daemon' as const, descriptor, credentialPurposes: [] }] }],
      ['machines.provisioners.check', { available: true }],
    ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
    } });
    let optionsAnswer: ReturnType<typeof MachineProvisionerOptionsResultV1Schema.parse> | undefined;
    harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select: async value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
      expect(fieldOf('vmType')?.description).toBe(refusalCopy);
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
    const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://native-defaults.example',
      serverIdentityId: 'srv_native_defaults', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation', activeAt: Date.now() })] },
      machineListStatusByServerId: { [serverId]: 'idle' } });
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
    ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
      const answer = actionId === 'machines.provisioners.check' && ++checks > 1 ? { available: false, code: 'lima_2_required' } : result;
      return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result: answer } } };
    } });
    harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
      owner: { kind: 'account', accountId: 'owner' }, ...creation, launch: { ...creation.launch, name: 'Stored preset name' } };
    const draft: MachinePresetEditDraft = { name: 'Unsaved name stays', creation,
      setup: { scripts: [{ body: '\r\necho retained\r\n', affects: 'none' }] } };
    const onReturn = vi.fn();
    const continuation = { item, draft, preset: { id: retained.id, revision: retained.revision }, onReturn };
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: retained } });
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
      preset: { ...retained, ...creation, name: draft.name, setup: expectedSetup, revision: 9 } } });
    // Entering merges the item into the editor's own draft; the caller's draft is not mutated and nothing is written.
    expect(draft.setup).not.toHaveProperty('items');
    expect(presetWrites()).toEqual([]);
    expect(onReturn).not.toHaveBeenCalled();
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
    expect(harness.requestsFor('/v1/machines/presets/update')[0]?.input).toMatchObject({
      homeId: retained.homeId, id: retained.id, expectedRevision: 8,
      patch: { name: draft.name, setup: expectedSetup, launch: creation.launch, controller: creation.controller },
    });
    expect(harness.requestsFor('/v1/machines/presets/create')).toEqual([]);
    await waitForHomeGovernance(() => expect(onReturn).toHaveBeenCalledTimes(1));
    expect(route.replace).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it('edits a setup-only preset in the same editor and saves it without creating Machines', async () => {
    const initial = await mountAddRoute('setup-only-edit');
    const serverId = route.params.serverId!;
    await initial.unmount();
    const setupOnly = { id: 'browser-bot', homeId: 'srv_add_server', revision: 4, name: 'Browser bot',
      owner: { kind: 'account', accountId: 'owner' }, setup: { scripts: [{ body: 'echo one', affects: 'none' }] } };
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: setupOnly } });
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    // A setup-only preset has no provisioner: the editor opens on its setup, never on a provider catalog.
    const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner=""
      presetId={setupOnly.id} presetOnly />);
    const section = () => screen.tree.findAll(node => node.props.testID === 'managed-config.setup'
      && typeof node.props.onChange === 'function')[0]?.props as { setup?: unknown; onChange: (next: unknown) => void } | undefined;
    await waitForHomeGovernance(() => expect(section()?.setup).toEqual(setupOnly.setup));
    expect(screen.findByTestId('managed-config.catalog')).toBeFalsy();
    const edited = { scripts: [{ body: 'echo two', affects: 'none' }] };
    await act(async () => { section()!.onChange(edited); });
    harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved', preset: { ...setupOnly, setup: edited, revision: 5 } } });
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
    // The update keeps it setup-only: no launch or controller is written.
    expect(harness.requestsFor('/v1/machines/presets/update')[0]?.input).toMatchObject({
      id: setupOnly.id, expectedRevision: 4, patch: { name: 'Browser bot', setup: edited, launch: null, controller: null },
    });
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
    await screen.unmount();
  });

  it('starts a setup-only preset from an Add-to-Preset continuation and saves the item only on Save', async () => {
    const initial = await mountAddRoute('setup-only-continuation');
    const serverId = route.params.serverId!;
    await initial.unmount();
    const setupOnly = { id: 'research', homeId: 'srv_add_server', revision: 2, name: 'Research bot',
      owner: { kind: 'account', accountId: 'owner' }, setup: { scripts: [{ body: 'echo one', affects: 'none' }] } };
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: setupOnly } });
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
    harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved', preset: { ...setupOnly, setup: saved, revision: 3 } } });
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
    expect(harness.requestsFor('/v1/machines/presets/update')[0]?.input).toMatchObject({
      id: setupOnly.id, expectedRevision: 2, patch: { setup: saved, launch: null, controller: null } });
    await waitForHomeGovernance(() => expect(onReturn).toHaveBeenCalledTimes(1));
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
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
      id: 'retained', expectedRevision: 8, patch: { name: draft.name, setup: expectedSetup },
    });
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    expect(setup()).toEqual(expectedSetup);
    expect(onReturn).not.toHaveBeenCalled();
    expect(harness.requestsFor('/v1/machines/presets/create')).toEqual([]);
    await screen.unmount();
  });

  async function answerAcquireController(serverId: string) {
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const { encodeBase64 } = await import('@happier-dev/protocol/crypto/base64');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { readOriginalAccountActionAuthentication } = await import('@/sync/api/externalActionAccountTransport');
    const { ExternalActionExecutionAuthorizationV1Schema,
      bindExternalActionExecutionAuthorizationHttpPathV1 } = await import('@happier-dev/protocol/actions/externalActionApi');
    const { computeExternalActionRequestEnvelopeDigestV1 } = await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
    const account = await captureLazyActionAccountContext(serverId);
    const authentication = readOriginalAccountActionAuthentication(account.credentials.token);
    const homeId = account.serverIdentityId;
    account.dispose();
    if (!authentication || !homeId) throw new Error('Expected the fixture Account identity');
    const publishedController = {
      ...createPlainMachineRowFixture({ id: 'host', accountId: 'owner',
        machine: createMachineFixture({ id: 'host', installationId: 'installation', activeAt: Date.now() }),
      }),
      installationId: 'installation',
      installationPublicKey: encodeBase64(sodium.crypto_sign_keypair().publicKey, 'base64'),
    };
    harness.answer(serverId, '/v1/machines', { body: [publishedController] });
    harness.answer(serverId, '/v1/machines/read-batch', {
      select: async input => ({ body: await createMachineReadBatchResponseFixture(input,
        id => id === publishedController.id ? publishedController : null).json() }),
    });
    // Home authorization is an HTTP boundary. Preserve the real request digest,
    // installation custody and confirmed invocation instead of bypassing admission.
    harness.answer(serverId, bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'), {
      select: input => {
        const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(input);
        return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-acquire-authorization', binding: {
          accountId: 'owner', authentication, serverIdentityId: homeId, machineId: 'host',
          custodianAccountId: 'owner', installationId: publishedController.installationId, accountEncryptionMode: 'plain',
          actionId: 'machines.managed.acquire', requestId: envelope.requestId, target: envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } }) };
      },
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
  ) {
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: `https://${host}.example`,
      serverIdentityId: 'srv_add_server',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    await answerAcquireController(serverId);
    harness.answer(serverId, '/v1/actions/machines.managed.acquire', {
      status: 403,
      body: { code: 'permission_denied' },
    });
    const { WorkspaceRouteBody } =
      await import('@/app/(app)/settings/machines/add/[provisioner]');
    const screen = await renderScreen(<WorkspaceRouteBody />);
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.sizes:small')).not.toBeNull(),
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
    ExternalActionRequestEnvelopeV1Schema.parse(
      ExternalActionExecutionAuthorizationRequestV1Schema.parse(
        harness.requestsFor('/v1/actions/machines.managed.acquire')[0]?.input,
      ).envelope,
    ).input;
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
  it('makes a free-form host\u2019s own size fields its one Size choice instead of echoing them as a one-row table', async () => {
    const viewport = vi
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://free-form.example',
      serverIdentityId: 'srv_free_form',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    harness.answer(serverId, '/v1/actions/machines.provisioners.options', {
      select: async (value) => {
        if (answerGate) await answerGate;
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://advanced.example', serverIdentityId: 'srv_advanced',
      accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
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
    const answer = (actionId: string, result: (input: unknown) => unknown) => harness.answer(serverId, `/v1/actions/${actionId}`, {
      select: (value) => { const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result: result(request.input) } } }; } });
    answer('machines.provisioners.list', () => ({ controller: defaultController, provisioners: [native] }));
    answer('machines.provisioners.check', () => ({ available: true }));
    answer('machines.provisioners.options', (input) => {
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
      const serverId = await harness.addHome({
        name: 'Compute',
        serverUrl: `https://catalog-${format}.example`,
        serverIdentityId: `srv_catalog_${format}`,
        accountId: 'owner',
        currentAccount: true,
      });
      const { storage } = await import('@/sync/domains/state/storage');
      storage.setState({
        machineListByServerId: {
          [serverId]: [
            createMachineFixture({
              id: 'host',
              installationId: 'installation',
            }),
          ],
        },
      });
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
        harness.answer(serverId, `/v1/actions/${actionId}`, {
          select: (value) => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://native-digitalocean.example',
      serverIdentityId: 'srv_native_digitalocean',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
      reviewed?.receipt.prices?.map((price) => [price.amount, price.unit]),
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
      const serverId = await harness.addHome({
        name: 'Compute',
        serverUrl: `https://boat-sources-${width}.example`,
        serverIdentityId: `srv_boat_sources_${width}`,
        accountId: 'owner',
        currentAccount: true,
      });
      const { storage } = await import('@/sync/domains/state/storage');
      storage.setState({
        machineListByServerId: {
          [serverId]: [
            createMachineFixture({
              id: 'host',
              installationId: 'installation',
            }),
          ],
        },
      });
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
        harness.answer(serverId, `/v1/actions/${actionId}`, {
          select: (value) => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
      const serverId = await harness.addHome({
        name: 'Compute',
        serverUrl: `https://native-${role}.example`,
        serverIdentityId: `srv_native_${role}`,
        accountId: 'owner',
        currentAccount: true,
      });
      const { storage } = await import('@/sync/domains/state/storage');
      storage.setState({
        machineListByServerId: {
          [serverId]: [
            createMachineFixture({
              id: 'host',
              installationId: 'installation',
            }),
          ],
        },
      });
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
        harness.answer(serverId, `/v1/actions/${actionId}`, {
          select: (value) => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    const serverId = await harness.addHome({ name: 'Compute', serverUrl: `https://${provider.toLowerCase()}-ready.example`,
      serverIdentityId: `srv_${provider.toLowerCase()}_ready`, accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
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
    ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
      expect(harness.requestsFor('/v1/actions/machines.provisioners.options')[0]?.input).toMatchObject({ input: {
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://unavailable-check.example',
      serverIdentityId: 'srv_unavailable_check',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
      const serverId = await harness.addHome({ name: 'Compute', serverUrl: `https://pending-review-${outcome}.example`,
        serverIdentityId: 'srv_pending_review', accountId: 'owner', currentAccount: true });
      const { storage } = await import('@/sync/domains/state/storage');
      storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: defaultController.machineId,
        installationId: defaultController.installationId })] },
        machineListStatusByServerId: { [serverId]: 'idle' } });
      const presetRead = createDeferred<void>();
      const catalogRead = createDeferred<void>();
      const saved = { id: 'pending-review', homeId: 'srv_pending_review', revision: 1, name: 'Saved machine',
        owner: { kind: 'account', accountId: 'owner' }, controller: defaultController,
        launch: { provider: provisioner.contribution, schemaVersion: 1, name: 'Saved machine', choices: { cpu: 2 } } };
      harness.answer(serverId, '/v1/machines/presets/get', { select: async () => {
        await presetRead.promise;
        return outcome === 'failed' ? { status: 503, body: { code: 'unavailable' } }
          : { body: { kind: 'found', preset: saved } };
      } });
      for (const [actionId, result] of [
        ['machines.provisioners.list', { controller: defaultController, provisioners: outcome === 'absent' ? [] : [provisioner] }],
        ['machines.provisioners.check', { available: true }],
        ['machines.provisioners.options', createManagedCpuOptionsFixture([{ id: 'small', title: 'Small', cpu: 2 }])],
      ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: async value => {
        if (actionId === 'machines.provisioners.list') await catalogRead.promise;
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://unsynced-list.example',
      serverIdentityId: 'srv_unsynced_list',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
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
    expect(catalogState()).toContain('loading');
    expect(catalogState()).not.toContain('empty');
    // Once the Home's list has really synced without the named controller, the empty verdict is true.
    await act(async () => {
      storage.setState({
        machineListByServerId: { [serverId]: [] },
        machineListStatusByServerId: { [serverId]: 'idle' },
      });
    });
    await flushHookEffects();
    expect(catalogState()).toContain('empty');
    expect(harness.requests.filter(request => request.path.includes('machines.provisioners.'))).toEqual([]);
    await screen.unmount();
  });
  it('names the controller it could not read and offers Retry when the catalog read fails, instead of a bare refusal', async () => {
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://unreadable-controller.example',
      serverIdentityId: 'srv_unreadable_controller',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', {
      status: 503,
      body: { code: 'service_unavailable' },
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
    expect(String(errorCards()[0]!.props.title)).toContain('tester.local');
    await screen.unmount();
  });
  it('refuses a schema-less options Action without probing native options or losing the configurator', async () => {
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://missing-options-schema.example',
      serverIdentityId: 'srv_missing_options_schema',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://silent-options-schema.example',
      serverIdentityId: 'srv_silent_options_schema',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: async (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
      // Retry reads again: while it runs the page says it is checking, with the last failure withdrawn.
      await act(async () => {
        screen.pressByTestId('managed-config.error-action');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(schemaReads).toBe(2);
      expect(screen.findByTestId('managed-config.error')).toBeNull();
      expect(screen.getTextContent()).toContain(
        t('managedMachines.options.loading', { provider: 'Virtual machine' }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1,
        );
      });
      expect(screen.findByTestId('managed-config.error')).toBeNull();
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://silent-everything.example',
      serverIdentityId: 'srv_silent_everything',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
    const read = nativeBoundary.rpc.getMockImplementation();
    nativeBoundary.rpc.mockImplementation(
      async (request: { method: string }) =>
        request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
          ? new Promise(() => {})
          : read?.(request),
    );
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', {
      select: (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    harness.answer(serverId, '/v1/actions/machines.provisioners.check', {
      respondAfter: new Promise<void>(() => {}),
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://failed-projection.example',
      serverIdentityId: 'srv_failed_projection',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://failed-read-blank-fields.example',
      serverIdentityId: 'srv_failed_read_blank_fields',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', {
      select: (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    harness.answer(serverId, '/v1/actions/machines.provisioners.check', {
      status: 500,
      body: { code: 'unavailable' },
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://unpriced-summary.example',
      serverIdentityId: 'srv_unpriced_summary',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://resume-wake.example',
      serverIdentityId: 'srv_resume_wake',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://local-empty-receipt.example',
      serverIdentityId: 'srv_local_empty_receipt',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://untouched-launch.example',
      serverIdentityId: 'srv_untouched_launch',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://conditional-quotes.example',
      serverIdentityId: 'srv_conditional_quotes',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    expect(screen.getTextContent()).not.toContain(
      t('managedMachines.options.unavailable'),
    );
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://network-variants.example',
      serverIdentityId: 'srv_network_variants',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
  it('keeps the actual Modal timeout as one editable field inside Ends and revalidates its exact native launch', async () => {
    const viewport = vi
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await harness.addHome({
      name: 'Modal compute',
      serverUrl: 'https://modal-duration.example',
      serverIdentityId: 'srv_modal_duration',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    const controller = { machineId: 'host', installationId: 'installation' };
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({
            id: controller.machineId,
            installationId: controller.installationId,
          }),
        ],
      },
    });
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
    };
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: saved },
    });
    for (const [actionId, result] of [
      ['machines.provisioners.list', { controller, provisioners: [modal] }],
      ['machines.provisioners.check', { available: true }],
    ] as const)
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    harness.answer(serverId, '/v1/actions/machines.provisioners.options', {
      select: (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    await waitForHomeGovernance(() =>
      expect(
        screen.tree.findAll(
          (node) => node.props.nativeDuration?.choices?.length > 0,
        ).length,
      ).toBeGreaterThan(0),
    );
    const keep = screen.tree.findAll(
      (node) =>
        node.props.finiteOnly && node.props.nativeDuration?.choices?.length > 0,
    )[0];
    expect(keep?.props.nativeDuration).toMatchObject({
      value: String(launch.timeoutMs),
      choices: [{ id: String(launch.timeoutMs) }],
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
    const timeoutField = 'managed-config.field:timeoutMs';
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
    await waitForHomeGovernance(() =>
      expect(capturedSelectors).toContainEqual(updated),
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.tree.findAll(
          (node) =>
            node.props.finiteOnly &&
            node.props.nativeDuration?.choices?.some(
              (choice: { id: string }) =>
                choice.id === String(updated.timeoutMs),
            ),
        ).length,
      ).toBeGreaterThan(0),
    );
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
        preset: {
          ...saved,
          revision: 2,
          launch: { ...saved.launch, choices: updated },
        },
      },
    });
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() =>
      expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(
        1,
      ),
    );
    const update = harness.requestsFor('/v1/machines/presets/update')[0]?.input;
    expect(update).toMatchObject({ patch: { launch: { choices: updated } } });
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
    const serverId = await harness.addHome({
      name: 'Cua compute',
      serverUrl: 'https://cua-preset.example',
      serverIdentityId: 'srv_cua_preset',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    const controller = { machineId: 'host', installationId: 'installation' };
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({
            id: controller.machineId,
            installationId: controller.installationId,
          }),
        ],
      },
    });
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
    };
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: saved },
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    harness.answer(serverId, '/v1/actions/machines.provisioners.options', {
      select: async (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://compact-prices.example',
      serverIdentityId: 'srv_compact_prices',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
      const serverId = await harness.addHome({
        name: 'Compute',
        serverUrl: 'https://native-input.example',
        serverIdentityId: 'srv_native_input',
        accountId: 'owner',
        currentAccount: true,
      });
      const { storage } = await import('@/sync/domains/state/storage');
      storage.setState({
        machineListByServerId: {
          [serverId]: [
            createMachineFixture({
              id: 'host',
              installationId: 'installation',
            }),
          ],
        },
      });
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
        harness.answer(serverId, `/v1/actions/${actionId}`, {
          select: (value) => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
      harness.answer(serverId, '/v1/actions/machines.provisioners.options', {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
        harness.requestsFor('/v1/actions/machines.presets.create'),
      ).toHaveLength(0);
      await screen.unmount();
    },
  );
  it('uses the one finite Ends control to choose the exact declared native duration before committing composer intent', async () => {
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://duration.example',
      serverIdentityId: 'srv_duration',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
      storage.setState({
        machineListByServerId: { [serverId]: [replacement] },
      }),
    );
    const { t } = await import('@/text');
    const receipts = screen.tree.findAll((node) =>
      node.props.model?.facts?.some(
        (fact: { id: string }) => fact.id === 'controller',
      ),
    );
    expect(receipts.length).toBeGreaterThan(0);
    for (const receipt of receipts)
      expect(
        receipt.props.model.facts.find(
          (fact: { id: string }) => fact.id === 'controller',
        )?.value,
      ).toBe(t('common.unknown'));
    await screen.unmount();
  });
  it('mounts the contributed size, image and location controls over complete native choices and keeps reviewed facts together', async () => {
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://dimensions.example',
      serverIdentityId: 'srv_dimensions',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
      harness.requests.some((request) => request.path.endsWith('/acquire')),
    ).toBe(false);
    await screen.unmount();
  });
  it('describes a local machine\u2019s location as where it runs, not as a distance to the person', async () => {
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://local-location.example',
      serverIdentityId: 'srv_local_location',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
  it('uses a reviewed one-off as composer intent without admitting a resource', async () => {
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://compute.example',
      serverIdentityId: 'srv_compute',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({ id: 'host', installationId: 'installation' }),
        ],
      },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
          (node) => node.props.testID === 'managed-config.sizes:small',
        ).length,
      ).toBeGreaterThan(0),
    );
    await act(async () => screen.pressByTestId('managed-config.sizes:small'));
    await act(async () => screen.pressByTestId('managed-config.use'));
    expect(onUse).toHaveBeenCalledWith(
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
    expect(
      harness.requests.some((request) =>
        request.path.endsWith('machines.managed.acquire'),
      ),
    ).toBe(false);
    await screen.unmount();
  });
  it('shows the captured Account creation-disabled lifecycle banner even when provisioners are unavailable', async () => {
    const target = await harness.addHome({
      name: 'No creation',
      serverUrl: 'https://no-creation.example',
      serverIdentityId: 'srv_no_creation',
      accountId: 'owner',
    });
    await harness.addHome({
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
      harness.requests.some((request) => request.path.endsWith('/acquire')),
    ).toBe(false);
    await screen.unmount();
  });
  it('reviews a one-off deadline, omits it from a saved preset, and preserves it after failed Create', async () => {
    const viewport = vi
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const serverId = await harness.addHome({
      name: 'Compute',
      serverUrl: 'https://compute.example',
      serverIdentityId: 'srv_compute',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    const metadata = createMachineFixture().metadata;
    if (!metadata)
      throw new Error('The canonical controller fixture has no metadata');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({
            id: 'host',
            installationId: 'installation',
            activeAt: Date.now(),
            metadata: { ...metadata, host: 'Build host', platform: 'linux' },
          }),
        ],
      },
      machineListStatusByServerId: { [serverId]: 'idle' },
    });
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
      harness.answer(serverId, `/v1/actions/${actionId}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
      harness.requests.some((request) => request.path.endsWith('/acquire')),
    ).toBe(false);
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
    };
    harness.answer(serverId, '/v1/machines/presets/create', {
      body: { kind: 'saved', preset: saved },
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
      launch: saved.launch,
      controller: saved.controller,
      wakeOnAcceptedMessage: true,
    });
    expect(
      harness.requestsFor('/v1/machines/presets/create')[0]?.input,
    ).not.toHaveProperty('retention');
    expect(
      harness.requests.some((request) => request.path.endsWith('/acquire')),
    ).toBe(false);
    harness.answer(serverId, '/v1/actions/machines.managed.acquire', {
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
    harness.answer(serverId, '/v1/actions/machines.managed.acquire', {
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
