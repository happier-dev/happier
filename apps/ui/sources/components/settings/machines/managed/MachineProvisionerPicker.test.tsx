import { createRequire } from 'node:module';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred, flushHookEffects, renderHook, renderScreen, standardCleanup, reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit';
import { createManagedControllerMachineFixture as createControllerMachineFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

// The JS host the app runs in is a platform boundary. The shared runtime-fetch owner is loaded by the global
// test setup against the node stub, so a test that is a browser says so here; every other test keeps the real answer.
const runtimeHost = vi.hoisted(() => ({ current: null as 'browser' | 'native' | null, reads: vi.fn() }));
vi.mock('@/utils/system/runtimeFetch', async (importActual) => {
  const actual = await importActual<typeof import('@/utils/system/runtimeFetch')>();
  return { ...actual, readRuntimeFetchHost: (input: RequestInfo | URL) => {
    runtimeHost.reads(input);
    return runtimeHost.current ? Promise.resolve(runtimeHost.current) : actual.readRuntimeFetchHost(input);
  } };
});
// Navigation is the app shell's boundary: the picker's ways out are observed as the routes they open.
const routerPush = vi.hoisted(() => vi.fn());
installApprovalCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
  },
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Prepare the real owner graph after installing boundaries, outside per-operation test budgets.
await import('./useManagedControllerScope');
const { resetScopedHomeActionExecutorsForTests } =
  await import('@/sync/ops/actions/scopedHomeActionExecutor');
beforeEach(async () => {
  await harness.reset();
  resetScopedHomeActionExecutorsForTests();
});
afterEach(async () => {
  standardCleanup();
  // Retire the real Home/credential lifetimes before global setup clears their storage backing.
  await harness.reset();
});

// The Add route owns page presentation; without it the grouped-menu header intentionally omits page actions.
function renderPicker(element: React.ReactElement) {
  return renderScreen(
    <ListPresentationProvider value="page">{element}</ListPresentationProvider>,
  );
}

// The bundled machine plugins the Account catalog reads. The Account reader loads the bundled set once per
// test file, so every test installs the same set.
async function installBundledMachinePlugins() {
  const { PLUGIN } = await import('../../../../../../../packages/plugins/machine-vercel/src/manifest');
  const { LIMA_PLUGIN } = await import('../../../../../../../packages/plugins/machine-lima/src/manifest');
  const { PLUGIN: E2B_PLUGIN } = await import('../../../../../../../packages/plugins/machine-e2b/src/manifest');
  const { PLUGIN: MARITIME_PLUGIN } = await import('../../../../../../../packages/plugins/machine-maritime/src/manifest');
  const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
  const { installBundledPluginUiDeclarationsForTests } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
  const vercel = PluginPortableReleaseManifestV1Schema.parse(PLUGIN.manifest);
  const lima = PluginPortableReleaseManifestV1Schema.parse(LIMA_PLUGIN.manifest);
  const e2b = PluginPortableReleaseManifestV1Schema.parse(E2B_PLUGIN.manifest);
  const maritime = PluginPortableReleaseManifestV1Schema.parse(MARITIME_PLUGIN.manifest);
  onTestFinished(installBundledPluginUiDeclarationsForTests([
    { pluginId: vercel.id, pluginVersion: vercel.version, packageName: '@happier-dev/plugins-machine-vercel', displayName: 'Vercel Machines', entriesById: {}, normalizedManifest: vercel },
    { pluginId: lima.id, pluginVersion: lima.version, packageName: '@happier-dev/plugins-machine-lima', displayName: 'Lima Machines', entriesById: {}, normalizedManifest: lima },
    { pluginId: e2b.id, pluginVersion: e2b.version, packageName: '@happier-dev/plugins-machine-e2b', displayName: 'E2B Machines', entriesById: {}, normalizedManifest: e2b },
    { pluginId: maritime.id, pluginVersion: maritime.version, packageName: '@happier-dev/plugins-machine-maritime', displayName: 'Maritime Machines', entriesById: {}, normalizedManifest: maritime },
  ]));
  return { vercel, lima, e2b, maritime };
}

// Controller-only empty/loading states require a settled Account catalog with
// no offers; a missing Account answer is an availability failure instead.
async function publishNoAccountProvisioners(serverId: string) {
  const { vercel, lima, e2b, maritime } = await installBundledMachinePlugins();
  const { PluginAccountAvailabilityIntentReadResponseV1Schema } = await import('@happier-dev/protocol/plugins/availability');
  const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
  const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
  onTestFinished(clearPluginAccountAvailabilityProjection);
  replacePluginAccountAvailabilityProjection({
    scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' },
    snapshot: {
      // This fixture settles Account offers, not the selected daemon's plugin census.
      availabilityCursor: 1, inventoryComplete: false, materializations: [], snapshots: [],
      intentReads: [vercel, lima, e2b, maritime].map(({ id: pluginId }) => ({
        pluginId,
        response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
          availabilityCursor: 1, hostingCapability: { enabled: false },
          intent: { pluginId, desiredVersion: null, enabled: false, offlineUiHosting: 'disabled', writableCollections: [], revision: 'disabled' },
          release: null, packageAssets: [], uiArtifacts: [],
        }),
      })),
    },
  });
}

describe('provisioner picker demand', () => {
  it('lets a preset choose local descriptors without a controller or acquisition prerequisites', async () => {
    // The native SDK is the platform boundary. Keep the real runner/bridge construction path beneath this observer.
    const nativeSsh = await import('@happier-dev/ssh-native');
    const sshAvailability = vi.spyOn(nativeSsh, 'getNativeSshAvailability');
    onTestFinished(() => sshAvailability.mockRestore());
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'native');
    onTestFinished(() => vi.unstubAllEnvs());
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    // Before an authenticated catalog can create the shared Action executor, the real
    // authoring scope must leave this computer's native runner cold. Add still observes it.
    const coldPreset = await renderPicker(<MachineProvisionerPicker serverId="signed-out-native-home" presetOnly />);
    try { expect(sshAvailability).not.toHaveBeenCalled(); }
    finally { await coldPreset.unmount(); }
    const coldAcquisition = await renderPicker(<MachineProvisionerPicker serverId="signed-out-native-home" />);
    try { expect(sshAvailability).toHaveBeenCalledTimes(1); }
    finally { await coldAcquisition.unmount(); }
    const { lima, e2b } = await installBundledMachinePlugins();
    const serverId = await harness.addHome({ name: 'Preset authoring', serverUrl: 'https://preset-authoring.example.test',
      serverIdentityId: 'srv_preset_authoring', accountId: 'owner', currentAccount: true });
    const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' },
      snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    runtimeHost.current = 'browser';
    onTestFinished(() => { runtimeHost.current = null; });
    const selected = vi.fn();
    runtimeHost.reads.mockClear();
    routerPush.mockClear();
    const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} presetOnly onSelectProvisioner={selected} />);
    try {
      for (const manifest of [lima, e2b]) {
        const descriptor = manifest.contributes.machineProvisioners[0]!;
        const key = buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: descriptor.id });
        await waitForHomeGovernance(() => {
          const cards = screen.tree.findAll(node => node.props.testID === 'managed-picker.provisioners')[0]?.props.cards;
          expect(cards?.find((card: { id: string }) => card.id === key), screen.getTextContent()).toMatchObject({
            action: { kind: 'choose' }, status: { tone: 'none', label: '' },
          });
        });
        const group = descriptor.billing.location === 'local' ? 'local' : 'cloud-sandboxes';
        const row = `managed-picker.provisioners.${group}.${key}`;
        await act(async () => screen.pressByTestId(screen.findByTestId(`${row}.action`) ? `${row}.action` : row));
        expect(selected).toHaveBeenLastCalledWith({ serverId, provisioner: key });
      }
      expect(runtimeHost.reads).not.toHaveBeenCalled();
      expect(routerPush).not.toHaveBeenCalled();
      expect(harness.requests.filter(request => /machines\.provisioners\.(check|options)|machines\.managed\.acquire/.test(request.path))).toHaveLength(0);
      expect(harness.requestsFor('/v4/connect/qualified/accounts')).toHaveLength(0);
    } finally { await screen.unmount(); }
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const editor = await renderPicker(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey({ pluginId: lima.id, localId: lima.contributes.machineProvisioners[0]!.id })} presetOnly />);
    try { expect(sshAvailability).toHaveBeenCalledTimes(1); }
    finally { await editor.unmount(); }
  });

  it.each([
    { name: 'agent37', group: 'cloud-sandboxes', load: () => import('../../../../../../../packages/plugins/machine-agent37/src/manifest') },
    { name: 'maritime', group: 'cloud', load: () => import('../../../../../../../packages/plugins/machine-maritime/src/manifest') },
    { name: 'hetzner', group: 'cloud', load: () => import('../../../../../../../packages/plugins/machine-hetzner/src/manifest') },
    { name: 'boat', group: 'cloud', load: () => import('../../../../../../../packages/plugins/machine-boat/src/manifest') },
  ])('offers the browser-blocked $name Account action on the selected controller', async ({ name, group, load }) => {
    const { PLUGIN } = await load();
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN.manifest);
    await installBundledMachinePlugins();
    const serverId = await harness.addHome({ name: 'Build', serverUrl: `https://${name}-daemon.example`,
      serverIdentityId: `srv_${name}_daemon`, accountId: 'owner', currentAccount: true });
    await publishNoAccountProvisioners(serverId);
    const { storage } = await import('@/sync/domains/state/storage');
    const controller = { machineId: 'controller', installationId: 'installation' };
    storage.setState({ machineListByServerId: { [serverId]: [
      createControllerMachineFixture({ id: controller.machineId, installationId: controller.installationId, activeAt: Date.now(), kind: 'persistent' }),
    ] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const { MachineProvisionersListResultV1Schema } = await import('@happier-dev/protocol/plugins/contributions/machineProvisioners');
    const result = MachineProvisionersListResultV1Schema.parse({ controller,
      provisioners: manifest.contributes.machineProvisioners?.map(descriptor => ({
        contribution: { pluginId: manifest.id, localId: descriptor.id }, occurrenceId: `occurrence-${descriptor.id}`,
        acquireExecutionTarget: manifest.contributes.actions?.find(action => action.id === descriptor.actions.acquire)?.execution.target,
        credentialPurposes: [], descriptor,
      })),
    });
    const reply = (actionId: string, requestId: string | undefined, value: unknown) =>
      ({ body: { v: 1, actionId, requestId, execution: { ok: true, result: value } } });
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', {
      select: value => { const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        return reply('machines.provisioners.list', request.requestId, result); },
    });
    harness.answer(serverId, '/v1/actions/machines.provisioners.check', {
      select: value => { const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        return reply('machines.provisioners.check', request.requestId, { available: true }); },
    });
    runtimeHost.current = 'browser';
    onTestFinished(() => { runtimeHost.current = null; });
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const onSelectProvisioner = vi.fn();
    function SelectedControllerPicker() {
      return <MachineProvisionerPicker serverId={serverId} onSelectProvisioner={onSelectProvisioner} />;
    }
    const screen = await renderPicker(<SelectedControllerPicker />);
    try {
      const key = buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: name });
      await waitForHomeGovernance(() => {
        const cards = screen.tree.findAll(node => Array.isArray(node.props.cards)).flatMap(node => node.props.cards);
        expect(cards.find(card => card.id === key), screen.getTextContent()).toMatchObject({ action: { kind: 'choose' } });
      });
      const row = `managed-picker.provisioners.${group}.${key}`;
      await act(async () => screen.pressByTestId(screen.findByTestId(`${row}.action`) ? `${row}.action` : row));
      expect(onSelectProvisioner).toHaveBeenCalledWith({ serverId, provisioner: key, controller });
      expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
    } finally { await screen.unmount(); }
  });

  it('retains Account provisioner descriptors when this Home has no controller', async () => {
    await installBundledMachinePlugins();
    const serverId = await harness.addHome({ name: 'Cloud', serverUrl: 'https://cloud-empty.example.test',
      serverIdentityId: 'srv_cloud_empty', accountId: 'owner', currentAccount: true });
    const { CONTRIBUTION: contribution } = await import('../../../../../../../packages/plugins/machine-vercel/src/machine/schemas');
    const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' },
      snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    runtimeHost.current = 'browser';
    onTestFinished(() => { runtimeHost.current = null; });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={() => {}} />);
    try {
      // The Account catalog's first read is still loading: no Machine is needed, so the page never says one is (D21).
      expect(screen.findByTestId('managed-picker.no-controller')).toBeNull();
      await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Vercel'));
      expect(screen.findByTestId('managed-picker.no-controller')).toBeNull();
      await waitForHomeGovernance(() => {
        const cards = screen.tree.findAll(node => node.props.testID === 'managed-picker.provisioners')[0]?.props.cards;
        expect(cards?.find((card: { id: string }) => card.id === buildQualifiedPluginContributionKey(contribution))).toBeDefined();
      });
      expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
    } finally { await screen.unmount(); }
  });
  it('projects the same browser handoff on a directly opened configurator instead of asking for a hidden account (R8-9)', async () => {
    await installBundledMachinePlugins();
    const serverId = await harness.addHome({ name: 'Cloud', serverUrl: 'https://cloud-config.example.test',
      serverIdentityId: 'srv_cloud_config', accountId: 'owner', currentAccount: true });
    const { CONTRIBUTION: contribution } = await import('../../../../../../../packages/plugins/machine-maritime/src/machine/schemas');
    const { ACCOUNT_ID } = await import('../../../../../../../packages/plugins/machine-maritime/src/account');
    harness.answer(serverId, '/v4/connect/qualified/accounts', {
      body: { service: { pluginId: contribution.pluginId, localId: ACCOUNT_ID }, accounts: [] },
    });
    const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' },
      snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    runtimeHost.current = 'browser';
    onTestFinished(() => { runtimeHost.current = null; });
    const { Modal } = await import('@/modal');
    const show = vi.spyOn(Modal, 'show');
    onTestFinished(() => show.mockRestore());
    const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
    const screen = await renderPicker(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)} />);
    try {
      await waitForHomeGovernance(() => {
        const model = screen.tree.findAll(node => node.props.testID === 'managed-config' && node.props.receipt)[0]?.props;
        expect(model?.blocker).toMatchObject({ kind: 'needsApp', title: 'Needs the app', action: { label: 'Get the app' } });
        expect(model?.receipt.primary.disabled).toBe(true);
        expect(model?.summary.spec).toBe(model?.blocker.title);
      });
      const model = screen.tree.findAll(node => node.props.testID === 'managed-config' && node.props.blocker)[0]!.props;
      await act(async () => { model.blocker.action.onPress(); });
      expect(show).toHaveBeenCalledTimes(1);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(0);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(0);
    } finally { await screen.unmount(); }
  });
  it('says a browser-blocked provider needs the app and hands off without opening its configurator (58d AF8)', async () => {
    await installBundledMachinePlugins();
    const serverId = await harness.addHome({ name: 'Cloud', serverUrl: 'https://cloud-web.example.test',
      serverIdentityId: 'srv_cloud_web', accountId: 'owner', currentAccount: true });
    const { CONTRIBUTION: contribution } = await import('../../../../../../../packages/plugins/machine-maritime/src/machine/schemas');
    const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    // Maritime declares browserReachable: false; Vercel and E2B support browser recipes.
    replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' },
      snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    // This device is a browser: provider calls without a controller would run in the page itself.
    runtimeHost.current = 'browser';
    onTestFinished(() => { runtimeHost.current = null; });
    const { Modal } = await import('@/modal');
    const show = vi.spyOn(Modal, 'show');
    onTestFinished(() => show.mockRestore());
    const selected = vi.fn();
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={selected} />);
    try {
      const id = buildQualifiedPluginContributionKey(contribution);
      type Card = { id: string; status: { label: string }; action: { label: string; disabled?: boolean; onPress(): void } };
      let card: Card | undefined;
      await waitForHomeGovernance(() => {
        const cards = screen.tree.findAll(node => node.props.testID === 'managed-picker.provisioners')[0]?.props.cards as Card[] | undefined;
        card = cards?.find(candidate => candidate.id === id);
        // The app-only provider stays visible with a handoff instead of prompting for credentials.
        expect(card?.status.label).toBe('Needs the app');
      });
      expect(card?.action.label).toBe('Get the app');
      expect(card?.action.disabled).not.toBe(true);
      await act(async () => { card!.action.onPress(); });
      expect(selected).not.toHaveBeenCalled();
      expect(show).toHaveBeenCalledTimes(1);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(0);
      expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
    } finally { await screen.unmount(); }
  });
  it('keeps a closed named controller scope idle for another Machine publication and follows its own record', async () => {
    const serverId = await harness.addHome({ name: 'Controller locality', serverUrl: 'https://controller-locality.example.test',
      serverIdentityId: 'srv_controller_locality', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scopeServerId = resolveServerProfileScopeIdForIdentifier(serverId);
    const controller = { machineId: 'controller', installationId: 'controller-installation' };
    const selected = createControllerMachineFixture({ id: controller.machineId, installationId: controller.installationId,
      metadata: { ...createControllerMachineFixture().metadata!, displayName: 'Build computer' } });
    const other = createControllerMachineFixture({ id: 'other', installationId: 'other-installation',
      metadata: { ...createControllerMachineFixture().metadata!, displayName: 'Other computer' } });
    const publicationScope = { sourceServerId: serverId, sourceAccountId: 'owner' };
    const previousMachines = storage.getState().machineListByServerId[scopeServerId] ?? [];
    storage.setState({ profileScope: { serverId, accountId: 'owner' } });
    storage.getState().applyMachines([selected, other], true, publicationScope);
    expect(storage.getState().machineRecordsByServerId[scopeServerId]?.controller?.installationId).toBe(controller.installationId);
    storage.getState().markMachineListSettled(serverId);
    try {
    const renders = vi.fn();
    const hook = await renderHook(() => {
      const scope = useManagedControllerScope({ serverId, preferred: controller, testIDPrefix: 'locality.scope' });
      renders();
      return scope;
    });
    expect(hook.getCurrent().controller).toEqual(controller);
    renders.mockClear();
    await act(async () => storage.getState().applyMachines([{ ...other, metadataVersion: 2,
      metadata: { ...other.metadata!, displayName: 'Renamed other computer' } }], false, publicationScope));
    expect(storage.getState().machineRecordsByServerId[scopeServerId]?.other?.metadata?.displayName).toBe('Renamed other computer');
    expect(renders).not.toHaveBeenCalled();
    await act(async () => storage.getState().applyMachines([{ ...selected, metadataVersion: 2,
      metadata: { ...selected.metadata!, displayName: 'Renamed build computer' } }], false, publicationScope));
    expect(renders.mock.calls.length).toBeGreaterThan(0);
    expect(hook.getCurrent().machine?.metadata?.displayName).toBe('Renamed build computer');
    await hook.unmount();
    } finally {
      await act(async () => storage.getState().applyMachines(previousMachines, true, publicationScope));
    }
  });

  it('defaults to a controller whose pushed protocol can execute provisioner Actions instead of a remembered incompatible daemon', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } =
      await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const previousRuntime = getAppliedActiveServerSnapshot();
    const previousAvailable = isAppliedActiveServerRuntimeAvailable();
    onTestFinished(() => publishAppliedActiveServerSnapshot(previousRuntime, previousAvailable));
    publishAppliedActiveServerSnapshot({ ...previousRuntime, serverId, serverUrl: 'https://build.example' });
    storage.setState({ profileScope: { serverId, accountId: 'owner' }, machineListByServerId: { srv_build: [
      createControllerMachineFixture({ id: 'old', installationId: 'old-installation', activeAt: Date.now(), operationProtocolCapabilitiesRevision: 3,
        operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1] } } }),
      createControllerMachineFixture({ id: 'ready', installationId: 'ready-installation', activeAt: Date.now() }),
    ] }, machineListStatusByServerId: { srv_build: 'idle' } });
    const { rememberMachineAdministrationTargetObservation } = await import('@/sync/domains/state/machineAdministrationUiState');
    rememberMachineAdministrationTargetObservation({ serverId: 'srv_build', accountId: 'owner' }, 'machines.managed', { serverIdentityId: 'srv_build', machineId: 'old' });
    const baselineRequests = harness.requests.length;
    const automatic = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'protocol.scope' }));
    expect(automatic.getCurrent().controller?.machineId).toBe('ready');
    expect(harness.requests.length - baselineRequests).toBe(0);
    await automatic.unmount();
    const explicit = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'protocol.scope',
      preferred: { machineId: 'old', installationId: 'old-installation' } }));
    expect(explicit.getCurrent().controller).toEqual({ machineId: 'old', installationId: 'old-installation' });
    expect(explicit.getCurrent().selection?.resolveExecutionTarget()).toBeNull();
    await explicit.unmount();
    const ready = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'protocol.scope',
      preferred: { machineId: 'ready', installationId: 'ready-installation' } }));
    const captured = ready.getCurrent().selection!.resolveExecutionTarget;
    expect(captured()?.machine.id).toBe('ready');
    await act(async () => {
      storage.setState(state => ({ machineListByServerId: { srv_build: state.machineListByServerId.srv_build!.map(machine =>
        machine.id === 'ready' ? { ...machine, operationProtocolCapabilitiesRevision: 2, operationProtocolCapabilities: {} } : machine) } }));
      expect(captured()).toBeNull();
    });
    await ready.unmount();
  });

  // QA-MANAGED2.md's 01:23–01:29 live default and the FIX-REVB2 continuation
  // instruction require an admitted provisioner controller, beyond protocol support.
  it('defaults to the admitted provisioner controller 58f6 instead of remembered online 10a7 without reads or renewal renders', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
    const { PluginMachineMaterializationV1Schema, PluginPortableReleaseManifestV1Schema,
      projectPluginMachineMaterializationReportFactsV1 } = await import('@happier-dev/protocol/plugins/availability');
    const { CRABBOX_PLUGIN } = await import('../../../../../../../packages/plugins/machine-crabbox/src/manifest');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const manifest = PluginPortableReleaseManifestV1Schema.parse(CRABBOX_PLUGIN.manifest);
    const materializations = ['controller-126', '58f6'].map(machineId => PluginMachineMaterializationV1Schema.parse({
      serverIdentityId: 'srv_build', machineId, materializationId: `installed-${machineId}`, pluginId: manifest.id,
      version: manifest.version, sourceClass: 'localPath', portableRelease: false, declaredManifest: manifest,
      enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [],
    }));
    const machines = Array.from({ length: 128 }, (_, index) => createControllerMachineFixture({ id: index === 0 ? '10a7' : index === 127 ? '58f6' : `controller-${String(index).padStart(3, '0')}`,
      installationId: `installation-${index}`, activeAt: Date.now() }));
    storage.setState({ machineListByServerId: { srv_build: machines }, machineListStatusByServerId: { srv_build: 'idle' } });
    replacePluginAccountAvailabilityProjection({ scope, snapshot: {
      availabilityCursor: 1, intentReads: [], materializations, snapshots: [],
    } });
    const installed = readPluginAccountAvailability(scope).readInstalledPlugins();
    expect(installed.kind).toBe('available');
    expect(installed.kind === 'available' && installed.plugins.some(plugin => plugin.installations.some(installation =>
      installation.declarationState === 'known' && (installation.declaration?.contributes.machineProvisioners?.length ?? 0) > 0))).toBe(true);
    const { rememberMachineAdministrationTargetObservation } = await import('@/sync/domains/state/machineAdministrationUiState');
    rememberMachineAdministrationTargetObservation(scope, 'machines.managed', { serverIdentityId: 'srv_build', machineId: '10a7' });
    let renders = 0;
    const hook = await renderHook(() => {
      renders += 1;
      return useManagedControllerScope({ serverId, testIDPrefix: 'capable.scope' });
    });
    expect(hook.getCurrent().controller?.machineId).toBe('58f6');
    const baselineRequests = harness.requests.length;
    const baselineRenders = renders;
    await act(async () => replacePluginAccountAvailabilityProjection({ scope, snapshot: {
      availabilityCursor: 2, intentReads: [], materializations, snapshots: [],
    } }));
    expect(renders - baselineRenders).toBe(0);
    await act(async () => rememberMachineAdministrationTargetObservation(scope, 'machines.managed', { serverIdentityId: 'srv_build', machineId: 'controller-126' }));
    // Re-entering Create one restores a last-used controller that supports provisioners.
    await hook.unmount();
    const restored = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'capable.scope' }));
    expect(restored.getCurrent().controller?.machineId).toBe('controller-126');
    expect(harness.requests.length - baselineRequests).toBe(0);
    await act(async () => replacePluginAccountAvailabilityProjection({ scope, snapshot: {
      availabilityCursor: 3, intentReads: [], materializations: materializations.map(row => row.machineId === 'controller-126' ? { ...row, enabled: false } : row), snapshots: [],
    } }));
    // R2: once resolved, changing declarations does not choose another controller.
    expect(restored.getCurrent().controller?.machineId).toBe('controller-126');
    // A settled source-bound declaration failure is unknown support, never a
    // negative capability fact. The real report strips the inline manifest.
    await act(async () => replacePluginAccountAvailabilityProjection({ scope, snapshot: {
      availabilityCursor: 4, intentReads: [], materializations: materializations.map(row =>
        projectPluginMachineMaterializationReportFactsV1(row.machineId === 'controller-126' ? { ...row, enabled: false } : row)), snapshots: [],
    } }));
    expect(restored.getCurrent().controller?.machineId).toBe('controller-126');
    await act(async () => replacePluginAccountAvailabilityProjection({ scope, snapshot: {
      availabilityCursor: 5, intentReads: [], materializations: [], snapshots: [],
    } }));
    expect(restored.getCurrent().controller?.machineId).toBe('controller-126');
    expect(harness.requests.length - baselineRequests).toBe(0);
    await restored.unmount();
    const explicit = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'capable.scope',
      preferred: { machineId: '10a7', installationId: 'installation-0' } }));
    expect(explicit.getCurrent().controller).toEqual({ machineId: '10a7', installationId: 'installation-0' });
    await explicit.unmount();
  });

  it('orders controllers by availability and removes confirmed-absent resources without redirecting the retained draft', () => withPopoverWebGlobals(async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const absent = ManagedMachineV1Schema.parse({ id: 'ended-resource', homeId: 'srv_build', custodianAccountId: 'owner', enrolledMachineId: 'ghost',
      launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Old guest', choices: {} },
      controller: { machineId: 'live', installationId: 'live-installation' }, allocation: 'confirmed-absent', creationState: 'active',
      desired: 'delete', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const listPath = '/v1/machines/managed/actions/list';
    const firstRead = createDeferred<void>();
    onTestFinished(() => firstRead.resolve());
    let managedMachines = [absent];
    harness.answer(serverId, `POST ${listPath}`, { select: () => ({ body: { machines: managedMachines }, respondAfter: firstRead.promise }) });
    storage.setState({ machineListByServerId: { srv_build: [
      createControllerMachineFixture({ id: 'ghost', installationId: 'ghost-installation', active: false, activeAt: 0 }),
      createControllerMachineFixture({ id: 'live', installationId: 'live-installation', activeAt: Date.now() }),
    ] }, machineListStatusByServerId: { srv_build: 'idle' } });
    const onSelect = vi.fn();
    let current: ReturnType<typeof useManagedControllerScope> | undefined;
    function ControllerPicker() {
      current = useManagedControllerScope({ serverId, testIDPrefix: 'absent.scope', onSelect,
        preferred: { machineId: 'ghost', installationId: 'ghost-installation' } });
      return current.chip;
    }
    const screen = await renderScreen(<ControllerPicker />);
    expect(harness.requestsFor(listPath)).toHaveLength(0);
    await screen.pressByTestIdAsync('absent.scope.chip');
    await act(async () => reportPopoverContentLayout(screen.tree, { width: 400, height: 500 }));
    await waitForHomeGovernance(() => expect(harness.requestsFor(listPath)).toHaveLength(1));
    const orderedOptions = () => screen.root.findAll(node => typeof node.type === 'string'
      && /^absent\.scope\.picker-option:/.test(String(node.props.testID ?? ''))).map(node => node.props.testID);
    const initialOrder = orderedOptions();
    expect(initialOrder).toEqual(['absent.scope.picker-option:live', 'absent.scope.picker-option:ghost']);
    await act(async () => firstRead.resolve());
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('absent.scope.picker-option:ghost')).toBeNull());
    expect(orderedOptions()).toEqual(['absent.scope.picker-option:live']);
    expect(screen.findHostByTestId('absent.scope.picker-option:live')).not.toBeNull();
    expect(current?.controller).toEqual({ machineId: 'ghost', installationId: 'ghost-installation' });
    expect(current?.selection?.resolveExecutionTarget()).toBeNull();
    await act(async () => current?.selection?.selectTarget({ serverIdentityId: 'srv_build', machineId: 'ghost' }));
    expect(onSelect).not.toHaveBeenCalled();
    managedMachines = [absent, { ...absent, id: 'ended-live-resource', enrolledMachineId: 'live' }];
    await act(async () => publishHomeAccountChange(serverId));
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('absent.scope.picker-option:live')).toBeNull());
    expect(screen.findHostByTestId('absent.scope.chip')).not.toBeNull();
    expect(harness.requestsFor(listPath)).toHaveLength(2);
    expect(orderedOptions()).toEqual([]);
    expect(current?.controller).toEqual({ machineId: 'ghost', installationId: 'ghost-installation' });
    await screen.unmount();
  }));

  it('keeps the real provisioner picker open when its last controller is confirmed absent', () => withPopoverWebGlobals(async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
    const controller = { machineId: 'ghost', installationId: 'ghost-installation' };
    const absent = ManagedMachineV1Schema.parse({ id: 'ended-resource', homeId: 'srv_build', custodianAccountId: 'owner', enrolledMachineId: 'ghost',
      launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Old guest', choices: {} },
      controller, allocation: 'confirmed-absent', creationState: 'active', desired: 'delete', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const listPath = '/v1/machines/managed/actions/list';
    harness.answer(serverId, `POST ${listPath}`, { body: { machines: [absent] } });
    storage.setState({ machineListByServerId: { srv_build: [createControllerMachineFixture({ id: 'ghost',
      installationId: controller.installationId, active: false, activeAt: 0 })] }, machineListStatusByServerId: { srv_build: 'idle' } });
    await publishNoAccountProvisioners(serverId);
    const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} />);
    // The chip sits on the folded computer-run offers once the catalog answers.
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('managed-picker.controller.chip')).not.toBeNull());
    await screen.pressByTestIdAsync('managed-picker.controller.chip');
    await act(async () => reportPopoverContentLayout(screen.tree, { width: 400, height: 500 }));
    await waitForHomeGovernance(() => {
      expect(screen.findHostByTestId('managed-picker.controller.picker-option:ghost')).toBeNull();
      expect(harness.requestsFor(listPath)).toHaveLength(1);
    });
    expect(screen.findHostByTestId('managed-picker.controller.chip')).not.toBeNull();
    expect(screen.findHostByTestId('managed-picker.no-controller')).toBeNull();
    expect(harness.requestsFor(listPath)).toHaveLength(1);
    await screen.unmount();
  }));

  it('follows activity-only controller withdrawal across 128 machines without rerendering or reading on heartbeat renewal', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const { useMachineAdministrationTargetSelection } = await import('@/sync/domains/machines/administration/useTargetSelection');
    const { publishMachineActivity } = await import('@/sync/domains/machines/machineActivity');
    const machines = Array.from({ length: 128 }, (_, index) => createControllerMachineFixture({ id: `controller-${String(index).padStart(3, '0')}`,
      installationId: `installation-${index}`, activeAt: Date.now() }));
    storage.setState({ machineListByServerId: { srv_build: machines }, machineListStatusByServerId: { srv_build: 'idle' } });
    let renders = 0;
    const hook = await renderHook(() => {
      renders += 1;
      return { managed: useManagedControllerScope({ serverId, testIDPrefix: 'activity.scope' }),
        administration: useMachineAdministrationTargetSelection('agents', { allowSoleCandidate: false }) };
    });
    expect(hook.getCurrent().managed.controller?.machineId).toBe('controller-000');
    const originalRows = hook.getCurrent().managed.selection!.pickerRows;
    const originalAdministrationRows = hook.getCurrent().administration.pickerRows;
    const baselineRenders = renders;
    const baselineRequests = harness.requests.length;
    await act(async () => {
      for (let beat = 1; beat <= 4; beat++) for (const machine of machines) {
        publishMachineActivity(machine, { active: true, activeAt: Date.now() + beat }, []);
      }
    });
    expect(renders - baselineRenders).toBe(0);
    expect(hook.getCurrent().managed.selection!.pickerRows).toBe(originalRows);
    await act(async () => publishMachineActivity(machines[0]!, { active: false, activeAt: 0 }, []));
    // R2: keep the resolved target and publish its offline state instead of redirecting.
    expect(hook.getCurrent().managed.controller?.machineId).toBe('controller-000');
    expect(hook.getCurrent().managed.selection?.state.kind).toBe('offline');
    expect(hook.getCurrent().managed.selection!.pickerRows.at(-1)!.candidate.availability).toBe('offline');
    expect(hook.getCurrent().administration.pickerRows.find(row => row.candidate.target.machineId === machines[0]!.id)
      ?.candidate.availability).toBe('offline');
    expect(hook.getCurrent().administration.pickerRows[0]).toBe(originalAdministrationRows[1]);
    expect(hook.getCurrent().managed.selection!.pickerRows[0]).toBe(originalRows[1]);
    expect(harness.requests.length - baselineRequests).toBe(0);
    await hook.unmount();
  });

  it('keeps the open controller list ordered and shows canonical offline presence after an activity-only update', () => withPopoverWebGlobals(async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const { publishMachineActivity } = await import('@/sync/domains/machines/machineActivity');
    const { t } = await import('@/text');
    const { formatLastSeen } = await import('@/utils/sessions/sessionUtils');
    const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
    const asleep = ManagedMachineV1Schema.parse({ id: 'sleeping-resource', homeId: 'srv_build', custodianAccountId: 'owner', enrolledMachineId: 'sleeping',
      launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Studio', choices: {} },
      controller: { machineId: 'z', installationId: 'z-installation' }, allocation: 'bound', creationState: 'active',
      resource: { contributionRef: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, value: { nativeId: 'studio' } },
      desired: 'stop', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
      observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained' } });
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    let managedMachines = [asleep];
    harness.answer(serverId, 'POST /v1/machines/managed/actions/list', { select: () => ({ body: { machines: managedMachines } }) });
    const machines = [
      ...['a', 'z'].map(id => createControllerMachineFixture({ id, installationId: `${id}-installation`, activeAt: Date.now() })),
      createControllerMachineFixture({ id: 'b', installationId: 'b-installation', active: false, activeAt: 100 }),
      createControllerMachineFixture({ id: 'd', installationId: 'd-installation', active: false, activeAt: 200 }),
      createControllerMachineFixture({ id: 'sleeping', installationId: 'sleeping-installation', active: false, activeAt: 50 }),
    ];
    storage.setState({ machineListByServerId: { srv_build: machines }, machineListStatusByServerId: { srv_build: 'idle' } });
    function ControllerPicker() { return useManagedControllerScope({ serverId, testIDPrefix: 'presence.scope' }).chip; }
    const screen = await renderScreen(<ControllerPicker />);
    await screen.pressByTestIdAsync('presence.scope.chip');
    await act(async () => reportPopoverContentLayout(screen.tree, { width: 400, height: 500 }));
    const orderedOptions = () => screen.root.findAll(node => typeof node.type === 'string'
      && /^presence\.scope\.picker-option:/.test(String(node.props.testID ?? ''))).map(node => node.props.testID);
    await waitForHomeGovernance(() => {
      const sleeping = screen.findHostByTestId('presence.scope.picker-option:sleeping');
      expect(sleeping?.props.accessibilityLabel ?? sleeping?.props['aria-label']).toContain(t('managedPower.asleep'));
    });
    expect(orderedOptions()).toEqual(['a', 'z', 'sleeping', 'd', 'b'].map(id => `presence.scope.picker-option:${id}`));
    await act(async () => publishMachineActivity(machines[0]!, { active: false, activeAt: 0 }, []));
    expect(orderedOptions()).toEqual(['z', 'sleeping', 'd', 'b', 'a'].map(id => `presence.scope.picker-option:${id}`));
    const row = screen.findHostByTestId('presence.scope.picker-option:a');
    expect(row?.props.accessibilityLabel ?? row?.props['aria-label']).toContain(t('settingsOverview.machineOffline', { lastSeen: formatLastSeen(0) }));
    managedMachines = [{ ...asleep, wakeOnAcceptedMessage: false }];
    await act(async () => publishHomeAccountChange(serverId));
    await waitForHomeGovernance(() => {
      expect(orderedOptions()).toEqual(['z', 'sleeping', 'd', 'b', 'a'].map(id => `presence.scope.picker-option:${id}`));
      const sleeping = screen.findHostByTestId('presence.scope.picker-option:sleeping');
      expect(sleeping?.props.accessibilityLabel ?? sleeping?.props['aria-label']).toContain(t('managedPower.asleep'));
    });
    managedMachines = [{ ...asleep, wakeOnAcceptedMessage: false,
      observation: { observedAt: 11, availability: 'present', power: 'running', storage: 'retained' } }];
    await act(async () => publishHomeAccountChange(serverId));
    await waitForHomeGovernance(() => expect(orderedOptions()).toEqual(
      ['z', 'd', 'b', 'sleeping', 'a'].map(id => `presence.scope.picker-option:${id}`),
    ));
    await screen.unmount();
  }));

  it('prefers this computer only while it is an installed online controller, without demanding local status', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const { getSystemTasksRunner } = await import('@/components/systemTasks/systemTasksRuntime');
    const { publishLocalDaemonStatus, readLocalDaemonSharedState } = await import('@/components/settings/machines/localControl/localDaemonSharedState');
    const runner = getSystemTasksRunner();
    const previous = readLocalDaemonSharedState(runner).status;
    onTestFinished(() => publishLocalDaemonStatus(runner, previous));
    publishLocalDaemonStatus(runner, { serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'z' });
    const online = (id: string) => createControllerMachineFixture({ id, installationId: `${id}-installation`, activeAt: Date.now() });
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('a'), online('z')] }, machineListStatusByServerId: { srv_build: 'idle' } }));
    const local = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    expect(local.getCurrent().controller?.machineId).toBe('z');
    await local.unmount();
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('a'), createControllerMachineFixture({ id: 'z', installationId: 'z-installation', active: false, activeAt: 0 })] } }));
    const remote = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    expect(remote.getCurrent().controller?.machineId).toBe('a');
    await remote.unmount();
  });
  it('keeps a deterministic online controller across inventory order and presence changes, and retains explicit draft choice', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const online = (id: string) => createControllerMachineFixture({ id, installationId: `${id}-installation`, activeAt: Date.now(), metadata: null });
    const asleep = createControllerMachineFixture({ id: 'ghost', installationId: 'ghost-installation', active: false, activeAt: 0 });
    const retired = createControllerMachineFixture({ id: 'retired', installationId: 'retired-installation', activeAt: Date.now(), replacedByMachineId: 'a' });
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [asleep, retired, online('z'), online('a')] }, machineListStatusByServerId: { srv_build: 'idle' } }));
    const onSelect = vi.fn();
    const scope = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe', onSelect }));
    expect(scope.getCurrent().controller?.machineId).toBe('a');
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('z'), asleep, online('a'), retired] } }));
    expect(scope.getCurrent().controller?.machineId).toBe('a');
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('z'), asleep,
      createControllerMachineFixture({ id: 'a', installationId: 'a-installation', active: false, activeAt: 0 })] } }));
    // R2: an unavailable resolved default stays selected until the person chooses.
    expect(scope.getCurrent().controller?.machineId).toBe('a');
    expect(scope.getCurrent().selection?.state.kind).toBe('offline');
    const target = scope.getCurrent().selection?.pickerRows.find(row => row.candidate.target.machineId === 'z')?.candidate.target;
    expect(target).toBeDefined();
    await act(async () => scope.getCurrent().selection?.selectTarget(target!));
    expect(onSelect).toHaveBeenCalledWith({ machineId: 'z', installationId: 'z-installation' });
    await scope.rerender();
    expect(scope.getCurrent().controller?.machineId).toBe('z');
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('a'),
      createControllerMachineFixture({ id: 'z', installationId: 'z-installation', activeAt: Date.now(), replacedByMachineId: 'a' })] } }));
    expect(scope.getCurrent().controller?.machineId).toBe('z');
    expect(scope.getCurrent().selection?.state.kind).toBe('replaced');
    expect(scope.getCurrent().selection?.resolveExecutionTarget()).toBeNull();
    await scope.unmount();
  });
  it('PAR-R1 starts the next Add visit from its local observation without changing settings or a deliberate default', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const online = (id: string) => createControllerMachineFixture({ id, installationId: `${id}-installation`, activeAt: Date.now(), metadata: null });
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('a'), online('z')] }, machineListStatusByServerId: { srv_build: 'idle' } }));
    // A navigation observation never becomes a deliberate default, even when Settings writes are refused.
    const syncRuntime = await import('@/sync/syncEngine');
    (createRequire(import.meta.url)('../../../../sync/sync.ts') as typeof import('@/sync/sync')).registerSyncRuntime(syncRuntime);
    const previousSettings = storage.getState().settings;
    onTestFinished(() => storage.setState({ settings: previousSettings, settingsScope: null }));
    await act(async () => storage.setState({ settingsScope: { serverId, accountId: 'owner' } }));
    await harness.setActionPolicy(serverId, 'settings.set', 'ui', 'off');
    const { readMachineAdministrationTargetObservation } = await import('@/sync/domains/state/machineAdministrationUiState');
    const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
    const device = getPersistenceStorage();
    const settingsBytes = () => device.getAllKeys().filter(key => key.includes('settings'))
      .map(key => [key, device.getString(key)] as const).sort(([a], [b]) => a.localeCompare(b));
    const first = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    expect(first.getCurrent().controller?.machineId).toBe('a');
    const settingsBeforePick = storage.getState().settings;
    const beforePick = settingsBytes();
    const target = first.getCurrent().selection?.pickerRows.find(row => row.candidate.target.machineId === 'z')?.candidate.target;
    await act(async () => first.getCurrent().selection?.selectTarget(target!));
    expect(readMachineAdministrationTargetObservation({ serverId: 'srv_build', accountId: 'owner' }, 'machines.managed')).toEqual(target);
    expect(storage.getState().settings).toBe(settingsBeforePick);
    expect(settingsBytes()).toEqual(beforePick);
    await first.unmount();
    const second = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    expect(second.getCurrent().controller?.machineId).toBe('z');
    await second.unmount();
  });
  it('starts a later Add visit on an online controller when the last picked one has gone offline', async () => {
    await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const machine = (id: string, online: boolean) => createControllerMachineFixture({ id, installationId: `${id}-installation`,
      active: online, activeAt: online ? Date.now() : 0, metadata: null });
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [machine('a', true), machine('z', true)] }, machineListStatusByServerId: { srv_build: 'idle' } }));
    const first = await renderHook(() => useManagedControllerScope({ serverId: 'srv_build', testIDPrefix: 'scope-probe' }));
    const target = first.getCurrent().selection?.pickerRows.find(row => row.candidate.target.machineId === 'z')?.candidate.target;
    await act(async () => first.getCurrent().selection?.selectTarget(target!));
    await first.unmount();
    // The remembered pick is a preference among online machines, not a reason to land on one that is away.
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [machine('a', true), machine('z', false)] } }));
    const second = await renderHook(() => useManagedControllerScope({ serverId: 'srv_build', testIDPrefix: 'scope-probe' }));
    expect(second.getCurrent().controller?.machineId).toBe('a');
    await second.unmount();
  });
  it('reopens the chooser with each controller\u2019s current presence after one went offline while it was closed', async () => {
    await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const machine = (id: string, online: boolean) => createControllerMachineFixture({ id, installationId: `${id}-installation`,
      active: online, activeAt: online ? Date.now() : 0, metadata: null });
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [machine('a', true), machine('b', true)] }, machineListStatusByServerId: { srv_build: 'idle' } }));
    const scope = await renderHook(() => useManagedControllerScope({ serverId: 'srv_build', testIDPrefix: 'scope-probe' }));
    expect(scope.getCurrent().controller?.machineId).toBe('a');
    // 'b' goes away while the chooser is closed; opening it must show that, not the presence it had when it closed.
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [machine('a', true), machine('b', false)] } }));
    const availability = () => scope.getCurrent().selection?.pickerRows
      .find(row => row.candidate.target.machineId === 'b')?.candidate.availability;
    const chip = scope.getCurrent().chip as React.ReactElement<{ onChipOpenChange(open: boolean): void }>;
    await act(async () => chip.props.onChipOpenChange(true));
    expect(availability()).not.toBe('online');
    await scope.unmount();
  });
  it('retains a resolved controller after a failed request proves it unreachable', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
    onTestFinished(clearMachineRequestReachabilityForTest);
    const online = (id: string) => createControllerMachineFixture({ id, installationId: `${id}-installation`, activeAt: Date.now(), metadata: null });
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('a'), online('z')] }, machineListStatusByServerId: { srv_build: 'idle' } }));
    const scope = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    expect(scope.getCurrent().controller?.machineId).toBe('a');

    // Request observations use the Home's canonical scope, not its device-local route profile id.
    await act(async () => recordMachineRequestFailed({ serverId: 'srv_build', accountId: 'owner', machineId: 'a' }));

    expect(scope.getCurrent().controller?.machineId).toBe('a');
    expect(scope.getCurrent().selection?.state.kind).toBe('offline');
    await scope.unmount();
  });
  it('lets the person switch controller while the Home\u2019s machine list is being re-read after a failure', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const online = (id: string) => createControllerMachineFixture({ id, installationId: `${id}-installation`, activeAt: Date.now(), metadata: null });
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('a'), online('z')] }, machineListStatusByServerId: { srv_build: 'error' } }));
    const onSelect = vi.fn();
    const scope = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe', onSelect,
      preferred: { machineId: 'a', installationId: 'a-installation' } }));
    const rows = scope.getCurrent().selection?.pickerRows ?? [];
    const target = rows.find(row => row.candidate.target.machineId === 'z')?.candidate.target;
    expect(target).toBeDefined();
    await act(async () => scope.getCurrent().selection?.selectTarget(target!));
    expect(onSelect).toHaveBeenCalledWith({ machineId: 'z', installationId: 'z-installation' });
    await scope.unmount();
  });
  it('leaves automatic scope unselected when only offline or retired controllers exist', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [
      createControllerMachineFixture({ id: 'ghost', installationId: 'ghost-installation', active: false, activeAt: 0 }),
      createControllerMachineFixture({ id: 'retired', installationId: 'retired-installation', activeAt: Date.now(), replacedByMachineId: 'next' }),
    ] }, machineListStatusByServerId: { srv_build: 'idle' } }));
    const scope = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    expect(scope.getCurrent().controller).toBeUndefined();
    await scope.unmount();
  });
  it('identifies New preset before a Home is selected, without demanding a provisioner catalog', async () => {
    const homeId = await harness.addHome({ name: 'Build', serverUrl: 'https://preset-build.example', serverIdentityId: 'srv_preset_build', accountId: 'owner', currentAccount: true });
    const { NewMachinePresetRoute } = await import('@/app/(app)/settings/machines/presets/new');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { t } = await import('@/text');
    const screen = await renderScreen(<DestinationInstanceHost tabId="preset-new" ref={{ kind: 'settings', params: { pageId: 'machines/presets/new' } }}
      pathname="/settings/machines/presets/new" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
      <NewMachinePresetRoute />
    </DestinationInstanceHost>);
    expect(screen.root.findAll(node => node.props.accessibilityRole === 'header')
      .some(node => node.props.children === t('machinePresets.newPreset'))).toBe(true);
    expect(screen.findByTestId(`managed-picker.home:${homeId}`)).not.toBeNull();
  });
  it('names each Home through the Home label owner, never by its address', async () => {
    const homeId = await harness.addHome({ name: 'preset-home.example:3011', serverUrl: 'https://preset-home.example:3011', serverIdentityId: 'srv_preset_home', accountId: 'owner', currentAccount: true });
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const { resolveHomeDisplayLabel } = await import('@/components/settings/server/homeDisplayName');
    const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const screen = await renderPicker(<MachineProvisionerPicker serverId="" presetOnly />);
    const row = screen.root.findAll(node => node.props.testID === `managed-picker.home:${homeId}` && node.props.title !== undefined)[0];
    expect(row?.props.title).toBe(resolveHomeDisplayLabel(getServerProfileById(homeId), homeId));
    expect(String(row?.props.title)).not.toContain('preset-home.example');
  });
  it.each([
    { location: 'cloud', credentialFailure: false },
    { location: 'unknown', credentialFailure: false },
    { location: 'cloud', credentialFailure: true },
    { location: 'cloud', credentialFailure: true, optionalCredential: true },
    { location: 'cloud', credentialFailure: false, checkFailure: true },
    { location: 'local', credentialFailure: false, caveat: true },
    { location: 'local', credentialFailure: false, nativeStatus: true },
  ] as const)(
    'retains completed provider status without acquiring ($location, credential failure=$credentialFailure)',
    async ({ location, credentialFailure, ...rest }) => {
      const checkFailure = 'checkFailure' in rest;
      const caveat = 'caveat' in rest;
      const nativeStatus = 'nativeStatus' in rest;
      const optionalCredential = 'optionalCredential' in rest;
      const serverId = await harness.addHome({
        name: 'Build',
        serverUrl: 'https://build.example',
        serverIdentityId: 'srv_build',
        accountId: 'owner',
        currentAccount: true,
      });
      const { storage } = await import('@/sync/domains/state/storage');
      storage.setState({
        machineListByServerId: {
          [serverId]: [
            createControllerMachineFixture({
              id: 'controller',
              installationId: 'installation',
              activeAt: Date.now(),
              kind: 'persistent',
            }),
          ],
        },
        machineListStatusByServerId: { [serverId]: 'idle' },
      });
      const contribution = { pluginId: 'custom.compute', localId: 'native' };
      await publishNoAccountProvisioners(serverId);
      const provisioner = {
        contribution,
        occurrenceId: 'occurrence',
        ...(credentialFailure ? { credentialPurposes: [{ purpose: { consumer: contribution, purpose: 'compute' }, options: [] }] } : {}),
        acquireExecutionTarget: 'daemon' as const,
        descriptor: {
          id: 'native',
          title: 'Custom compute',
          icon: 'server',
          resourceKind: 'native-compute-vm',
          schemaVersion: 1,
          kindTitle: { key: 'native.kind', fallback: 'VM' },
          description: {
            key: 'native.description',
            fallback: 'A custom native guest.',
          },
          launchSchema: {
            type: 'object',
            properties: optionalCredential ? { cpu: { type: 'integer' } } : {},
            additionalProperties: false,
          },
          ...(optionalCredential ? { credentialPurposeRequirements: [{ purpose: 'cloud-account',
            optionalWhen: { op: 'eq', path: 'cpu', value: 2 } }] } : {}),
          resourceSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          platforms: ['linux'],
          prerequisites: [],
          billing: { location, stoppedBilling: 'billed' },
          retention: { supportedIntents: ['delete'] },
          actions: {
            check: 'check',
            options: 'options',
            acquire: 'acquire',
            bootstrap: 'bootstrap',
            inspect: 'inspect',
            destroy: 'destroy',
          },
        },
        credentialPurposes: [{ purpose: { consumer: contribution, purpose: 'cloud-account' }, options: [] }],
      };
      const { MachineProvisionersListResultV1Schema } =
        await import('@happier-dev/protocol/plugins/contributions/machineProvisioners');
      MachineProvisionersListResultV1Schema.parse({
        controller: { machineId: 'controller', installationId: 'installation' },
        provisioners: [provisioner],
      });
      for (const [actionId, result] of [
        ['machines.provisioners.list', { controller: { machineId: 'controller', installationId: 'installation' }, provisioners: [provisioner] }],
        [
          'machines.provisioners.check',
          caveat
            ? { available: true, code: 'home_not_guest_reachable', status: { key: 'native.home', fallback: 'This Home only offers a connection on the controller.' } }
            : nativeStatus ? { available: true, code: 'native_cache_enabled', status: { key: 'native.cache', fallback: 'Image cache enabled' } }
            : {
              available: false,
              code: 'license_required',
              status: { key: 'native.license', fallback: 'License required' },
            },
        ],
      ] as const) {
        harness.answer(serverId, `/v1/actions/${actionId}`, {
          select: (value) => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return {
              body: {
                v: 1,
                actionId,
                requestId: request.requestId,
                execution: credentialFailure && actionId === 'machines.provisioners.check'
                  ? { ok: false, errorCode: 'credential_unavailable', error: 'credential_unavailable' }
                  : checkFailure && actionId === 'machines.provisioners.check'
                    ? { ok: false, errorCode: 'controller_unavailable', error: 'controller_unavailable' }
                    : { ok: true, result },
              },
            };
          },
        });
      }
      const onSelectProvisioner = vi.fn();
      const { MachineProvisionerPicker } =
        await import('./MachineProvisionerPicker');
      const { t } = await import('@/text');
      const { buildQualifiedPluginContributionKey } =
        await import('@happier-dev/protocol/plugins/contribution-identity');
      const screen = await renderPicker(
        <MachineProvisionerPicker
          serverId={serverId}
          onSelectProvisioner={onSelectProvisioner}
        />,
      );
      const row = `managed-picker.provisioners.${location === 'local' ? 'local' : 'cloud'}.${buildQualifiedPluginContributionKey(contribution)}`;
      await waitForHomeGovernance(() =>
        expect(
          screen.findByTestId(`${row}.action`) ??
            screen.findByTestId(row) ??
            screen.findByTestId('managed-picker.unavailable'),
        ).not.toBeNull(),
      );
      if (checkFailure) {
        // A failed check retains the offer and gives the person a working recovery step.
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.unavailable')).not.toBeNull());
        const unreadable = screen.tree.findAll(node => Array.isArray(node.props.cards)).flatMap(node => node.props.cards);
        expect(unreadable[0].status.label).not.toBe('');
        expect(unreadable[0].action.label).toBe(t('common.retry'));
        expect(unreadable[0].action.disabled).not.toBe(true);
        const failure = screen.tree.findAll(node => node.props.testID === 'managed-picker.unavailable' && 'diagnosticCode' in node.props)[0];
        expect(failure?.props.diagnosticCode).toBe('controller_unavailable');
        expect(failure?.props.diagnosticDetail).toBeTruthy();
        expect(failure?.props.diagnosticDetail).not.toBe(failure?.props.diagnosticCode);
        expect(onSelectProvisioner).not.toHaveBeenCalled();
        await act(async () => screen.pressByTestId(`${row}.action`));
        expect(onSelectProvisioner).not.toHaveBeenCalled();
        await screen.unmount();
        return;
      }
      if (caveat) {
        // The Home's caveat is the page's one line; the card only asks for setup and is no longer ready.
        // It says the outcome in the app's words (never the daemon's "controller"/"endpoint" sentence) and names the fix.
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.caveat')).not.toBeNull());
        expect(screen.getTextContent().split(t('managedMachines.add.homeUnreachable')).length - 1).toBe(1);
        expect(screen.getTextContent()).not.toContain('This Home only offers a connection on the controller.');
        const cards = screen.tree.findAll(node => Array.isArray(node.props.cards)).flatMap(node => node.props.cards);
        expect(cards[0].status).toEqual({ tone: 'attention', label: t('managedMachines.add.status.needsSetup') });
        routerPush.mockClear();
        await act(async () => screen.pressByTestId('managed-picker.caveat-action'));
        expect(routerPush).toHaveBeenCalledWith(`/settings/home/${serverId}/reach`);
        await screen.unmount();
        return;
      }
      if (nativeStatus) {
        await waitForHomeGovernance(() => {
          const cards = screen.tree.findAll(node => Array.isArray(node.props.cards)).flatMap(node => node.props.cards);
          expect(cards[0].status.tone).not.toBe('none');
        });
        const cards = screen.tree.findAll(node => Array.isArray(node.props.cards)).flatMap(node => node.props.cards);
        expect(cards[0].status).toEqual({ tone: 'ready', label: 'Image cache enabled' });
        expect(screen.findByTestId('managed-picker.caveat')).toBeNull();
        await screen.pressByTestIdAsync(screen.findByTestId(`${row}.action`) ? `${row}.action` : row);
        expect(onSelectProvisioner).toHaveBeenCalledWith(expect.objectContaining({ provisioner: buildQualifiedPluginContributionKey(contribution) }));
        expect(harness.requests.some(request => request.path.includes('machines.managed.acquire'))).toBe(false);
        await screen.unmount();
        return;
      }
      await waitForHomeGovernance(() => {
        const cards = screen.tree
          .findAll((node) => Array.isArray(node.props.cards))
          .flatMap((node) => node.props.cards);
        if (credentialFailure && screen.findByTestId('managed-picker.unavailable')) return;
        expect(cards).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              description: 'A custom native guest.',
              status: expect.objectContaining({
                label:
                  credentialFailure ? t('managedMachines.add.status.noAccount') : location === 'unknown'
                    ? `License required · ${t('managedMachines.add.status.billingUnknown')}`
                    : 'License required',
              }),
            }),
          ]),
        );
      });
      if (credentialFailure) {
        const cards = screen.tree.findAll(node => Array.isArray(node.props.cards)).flatMap(node => node.props.cards);
        expect(cards[0].status.label).toBe(t('managedMachines.add.status.noAccount'));
        // An optional service nobody connected yet does not need the person: no amber dot (lab m-add).
        expect(cards[0].status.tone).toBe('none');
        expect(cards[0].action.label).toBe(t(optionalCredential ? 'managedMachines.add.action.choose' : 'managedMachines.add.action.connect'));
      }
      expect(screen.findByTestId('managed-picker.unavailable')?.props.diagnosticCode).toBeUndefined();
      await act(async () =>
        screen.pressByTestId(
          screen.findByTestId(`${row}.action`) ? `${row}.action` : row,
        ),
      );
      expect(onSelectProvisioner).toHaveBeenCalledWith({
        serverId,
        provisioner: buildQualifiedPluginContributionKey(contribution),
        controller: { machineId: 'controller', installationId: 'installation' },
        ...(credentialFailure && !optionalCredential ? { connectPurpose: 'cloud-account' } : {}),
      });
      expect(
        harness.requests.some((request) =>
          request.path.includes('machines.managed.acquire'),
        ),
      ).toBe(false);
      await screen.unmount();
    },
  );
  /** One Home whose catalog answers with two provisioners; `hold` decides which later reads stay pending. */
  async function arrangeCatalog(hold: Readonly<{
    list?: (read: number, machineId: string) => boolean;
    check?: (read: number, localId: string) => boolean;
    /** Declared `[localId, title, kindTitle, location?, acquire target?]` per provisioner; defaults to Alpha and Beta local VMs. */
    declared?: readonly (readonly [string, string, string, ('local' | 'cloud')?, ('account' | 'daemon')?])[];
    /** A Home of its own, so no earlier controller choice carries over. */
    home?: string;
  }>) {
    const serverId = await harness.addHome({
      name: 'Build', serverUrl: `https://${hold.home ?? 'build'}.example`, serverIdentityId: `srv_${hold.home ?? 'build'}`, accountId: 'owner', currentAccount: true,
    });
    const descriptor = (localId: string, title: string, kind = 'VM', location: 'local' | 'cloud' = 'local', acquire: 'account' | 'daemon' = 'daemon') => ({
      contribution: { pluginId: 'custom.compute', localId }, occurrenceId: `occurrence-${localId}`, credentialPurposes: [],
      acquireExecutionTarget: acquire,
      descriptor: {
        id: localId, title, icon: 'server', resourceKind: 'native-compute-vm', schemaVersion: 1,
        kindTitle: { key: `${localId}.kind`, fallback: kind }, description: { key: `${localId}.description`, fallback: `${title} guest.` },
        launchSchema: { type: 'object', properties: {}, additionalProperties: false },
        resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
        // These Account-created fixture guests support calls from the browser itself.
        ...(acquire === 'account' ? { browserReachable: true } : {}),
        platforms: ['linux'], prerequisites: [], billing: { location, stoppedBilling: 'not-billed' },
        retention: { supportedIntents: ['delete'] },
        actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
      },
    });
    const provisioners = (hold.declared ?? [['alpha', 'Alpha', 'VM'], ['beta', 'Beta', 'VM']] as const)
      .map(([localId, title, kind, location, acquire]) => descriptor(localId, title, kind, location, acquire));
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: { [serverId]: ['controller', 'other'].map(id =>
        createControllerMachineFixture({ id, installationId: `${id}-installation`, activeAt: Date.now(), kind: 'persistent' })) },
      machineListStatusByServerId: { [serverId]: 'idle' },
    });
    const reads = { list: 0, check: new Map<string, number>() };
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reply = (actionId: string, requestId: string | undefined, execution: unknown) => ({ body: { v: 1, actionId, requestId, execution } });
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', {
      select: async (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        const controller = (request.input as { controller: { machineId: string; installationId: string } }).controller;
        reads.list += 1;
        if (hold.list?.(reads.list, controller.machineId)) await gate;
        return reply('machines.provisioners.list', request.requestId, { ok: true, result: { controller, provisioners } });
      },
    });
    harness.answer(serverId, '/v1/actions/machines.provisioners.check', {
      select: async (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        const localId = (request.input as { contribution: { localId: string } }).contribution.localId;
        const read = (reads.check.get(localId) ?? 0) + 1;
        reads.check.set(localId, read);
        if (hold.check?.(read, localId)) await gate;
        return reply('machines.provisioners.check', request.requestId, localId === 'alpha'
          ? { ok: true, result: { available: false, code: 'license_required', status: { key: 'alpha.license', fallback: 'License required' } } }
          : localId === 'beta' ? { ok: false, errorCode: 'controller_unavailable', error: 'controller_unavailable' }
          : { ok: true, result: { available: true } });
      },
    });
    await publishNoAccountProvisioners(serverId);
    return { serverId, reads, release, provisioners };
  }

  it('recovers a cold controller catalog when Account availability arrives without Retry', async () => {
    const { serverId, reads } = await arrangeCatalog({});
    const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } =
      await import('@/sync/domains/plugins/availability/projection');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    clearPluginAccountAvailabilityProjection();
    const { useManagedProvisioners } = await import('./useManagedProvisioners');
    const controller = { machineId: 'controller', installationId: 'controller-installation' };
    const hook = await renderHook(({ contributionKey }: { contributionKey?: string }) =>
      useManagedProvisioners(serverId, undefined, controller, { contributionKey }), { initialProps: {} });
    try {
      // Account availability that has not loaded yet is readiness, not a failure: the catalog keeps loading.
      await waitForHomeGovernance(() => expect(reads.list).toBeGreaterThan(0));
      await flushHookEffects();
      expect(hook.getCurrent().error).toBeNull();
      const publish = () => replacePluginAccountAvailabilityProjection({
        scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' },
        snapshot: { availabilityCursor: 1, inventoryComplete: false, intentReads: [], materializations: [], snapshots: [] },
      });
      await act(async () => publish());
      await waitForHomeGovernance(() => {
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().current).toBe(true);
        expect(hook.getCurrent().provisioners.some(row => row.contribution.pluginId === 'happier.machine.vercel')).toBe(true);
      });
      const settledReads = reads.list;
      await act(async () => { for (let index = 0; index < 3; index++) publish(); });
      await flushHookEffects();
      expect(reads.list).toBe(settledReads);
      await hook.rerender({ contributionKey: 'custom.compute/alpha' });
      await waitForHomeGovernance(() => {
        expect(hook.getCurrent().reading).toBe(false);
        expect(hook.getCurrent().current).toBe(true);
      });
      const selectedReads = reads.list;
      const { PluginAccountAvailabilityIntentReadResponseV1Schema } = await import('@happier-dev/protocol/plugins/availability');
      const pluginId = 'happier.machine.vercel';
      await act(async () => replacePluginAccountAvailabilityProjection({
        scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' },
        snapshot: { availabilityCursor: 2, inventoryComplete: false, materializations: [], snapshots: [], intentReads: [{ pluginId,
          response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 2, hostingCapability: { enabled: false },
            intent: { pluginId, desiredVersion: null, enabled: false, offlineUiHosting: 'disabled', writableCollections: [], revision: 'disabled' },
            release: null, packageAssets: [], uiArtifacts: [] }) }] },
      }));
      await flushHookEffects();
      expect(reads.list).toBe(selectedReads);
    } finally { await hook.unmount(); }
  });

  it('keeps a Machine-less Account catalog loading until Account availability arrives, never reporting it as a failure', async () => {
    const { serverId } = await arrangeCatalog({ home: 'not-loaded' });
    const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } =
      await import('@/sync/domains/plugins/availability/projection');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    clearPluginAccountAvailabilityProjection();
    const { useManagedProvisioners } = await import('./useManagedProvisioners');
    const hook = await renderHook(() => useManagedProvisioners(serverId));
    try {
      await flushHookEffects();
      await flushHookEffects();
      expect(hook.getCurrent().error).toBeNull();
      expect(hook.getCurrent().loading).toBe(true);
      await act(async () => replacePluginAccountAvailabilityProjection({
        scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' },
        snapshot: { availabilityCursor: 1, inventoryComplete: false, intentReads: [], materializations: [], snapshots: [] },
      }));
      await waitForHomeGovernance(() => {
        expect(hook.getCurrent().loading).toBe(false);
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().provisioners.some(row => row.contribution.pluginId === 'happier.machine.vercel')).toBe(true);
      });
    } finally { await hook.unmount(); }
  });

  it('puts "Managed from" on the section of offers a Machine runs, and shows none for Account-placed offers', async () => {
    const { serverId } = await arrangeCatalog({ declared: [['alpha', 'Alpha', 'VM', 'local', 'daemon'], ['gamma', 'Gamma', 'Server', 'cloud', 'account']] });
    const { t } = await import('@/text');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    // The section that carries the "Managed from" chip, read from the composed page (its header action).
    const sectionAction = (screen: Awaited<ReturnType<typeof renderPicker>>, title: string) =>
      screen.tree.findAll(node => node.props.title === title && 'action' in node.props)[0]?.props.action;
    const onSelect = vi.fn();
    const online = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={onSelect} />);
    try {
      await waitForHomeGovernance(() => expect(online.findByTestId('managed-picker.provisioners.local.custom.compute/alpha.action'), online.getTextContent()).not.toBeNull());
      // The computer that runs Alpha is chosen on Alpha's section; the Account creates Gamma, whose section names none.
      expect(sectionAction(online, t('managedMachines.add.onThisComputer'))).toBeTruthy();
      expect(sectionAction(online, t('managedMachines.add.cloudTitle'))).toBeUndefined();
      expect(online.tree.findAll(node => node.props.title === t('managedMachines.config.managedFrom'))).toHaveLength(0);
      expect(online.findByTestId('managed-picker.provisioners.local.collapsed')).toBeNull();
      // Alpha is checked on the computer; the Account creates Gamma, so the computer is never asked about it.
      const checks = (localId: string) => harness.requestsFor('/v1/actions/machines.provisioners.check')
        .filter(request => JSON.stringify(request).includes(`"localId":"${localId}"`));
      await waitForHomeGovernance(() => expect(checks('alpha')).not.toHaveLength(0));
      expect(checks('gamma')).toEqual([]);
      await act(async () => online.pressByTestId('managed-picker.provisioners.local.custom.compute/alpha.action'));
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ provisioner: 'custom.compute/alpha', controller: expect.anything() }));
    } finally { await online.unmount(); }

    // Only Account-created offers: no Machine runs anything here, so the page asks for none.
    const accountOnly = await arrangeCatalog({ home: 'cloud-only', declared: [['gamma', 'Gamma', 'Server', 'cloud', 'account']] });
    const cloud = await renderPicker(<MachineProvisionerPicker serverId={accountOnly.serverId} onSelectProvisioner={vi.fn()} />);
    try {
      await waitForHomeGovernance(() => expect(cloud.tree.findAll(node => node.props.title === t('managedMachines.add.cloudTitle')).length).toBeGreaterThan(0));
      expect(sectionAction(cloud, t('managedMachines.add.cloudTitle'))).toBeUndefined();
      expect(cloud.findByTestId('managed-picker.controller.chip')).toBeNull();
      expect(cloud.getTextContent()).not.toContain(t('managedMachines.config.managedFrom'));
    } finally { await cloud.unmount(); }
  });
  it('folds computer-run VMs into one row that leads to adding a computer while no computer can run them, and does not check them', async () => {
    const { lima } = await installBundledMachinePlugins();
    // An Account of its own: the Account's provisioner catalog is not one an earlier test already read.
    const serverId = await harness.addHome({ name: 'Cloud', serverUrl: 'https://cloud-fold.example.test',
      serverIdentityId: 'srv_cloud_fold', accountId: 'fold-owner', currentAccount: true });
    const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'fold-owner' },
      snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    runtimeHost.current = 'native';
    onTestFinished(() => { runtimeHost.current = null; });
    const addComputer = vi.fn();
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={vi.fn()} onSetUpThisComputer={addComputer} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.provisioners.local.collapsed'), screen.getTextContent()).not.toBeNull());
      const cards = screen.tree.findAll(node => node.props.testID === 'managed-picker.provisioners')[0]?.props.cards as { title: string; location: string }[];
      // The Account creates the cloud machine without a computer; the computer-run VM is not a card of its own.
      expect(cards.some(card => card.location === 'cloud')).toBe(true);
      expect(cards.some(card => card.location === 'local')).toBe(false);
      expect(screen.getTextContent()).toContain('Lima');
      expect(screen.findByTestId('managed-picker.controller.chip')).toBeNull();
      await act(async () => screen.pressByTestId('managed-picker.provisioners.local.collapsed.action'));
      expect(addComputer).toHaveBeenCalledTimes(1);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.check')
        .filter(request => JSON.stringify(request).includes(lima.id))).toHaveLength(0);
    } finally { await screen.unmount(); }
  });

  it('tells two provisioners of one product apart by their declared kind and says a pending check in a word', async () => {
    const { serverId, release } = await arrangeCatalog({
      declared: [['alpha', 'Cua', 'sandbox'], ['beta', 'Cua', 'space']],
      check: () => true,
    });
    const { t } = await import('@/text');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={vi.fn()} />);
    const cards = () => [...new Map(screen.tree.findAll(node => Array.isArray(node.props.cards))
      .flatMap(node => node.props.cards as { id: string; title: string; status: { label: string } }[])
      .map(card => [card.id, card])).values()];
    try {
      await waitForHomeGovernance(() => {
        // Two provisioners of one product read as one phrase each; the group says what they share.
        expect(cards().map(card => card.title)).toEqual(['Cua sandbox', 'Cua space']);
      });
      // The catalog's own line owns "Checking available provisioners"; a card still waiting says only that it is checking.
      expect(cards().map(card => card.status.label)).toEqual([t('managedMachines.add.status.checking'), t('managedMachines.add.status.checking')]);
    } finally {
      release();
    }
    await screen.unmount();
  });

  it('keeps admitted provisioner cards and their answers from the first remount frame', async () => {
    const { serverId, release } = await arrangeCatalog({ home: 'retained-create', list: read => read > 1, check: read => read > 1 });
    const { storage } = await import('@/sync/domains/state/storage');
    const { setActiveServerId, getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');
    const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const previous = storage.getState();
    await setActiveServerId(serverId);
    storage.getState().activateProfileScope({ serverId, accountId: 'owner' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const { useManagedProvisioners } = await import('./useManagedProvisioners');
    const first = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={vi.fn()} />);
    await waitForHomeGovernance(() => expect(first.getTextContent()).toContain('License required'));
    await first.unmount();
    const frames: string[][] = [];
    const resumed = await renderHook(() => {
      const catalog = useManagedProvisioners(serverId, undefined, { machineId: 'controller', installationId: 'controller-installation' });
      frames.push(catalog.provisioners.map(item => item.descriptor.title as string));
      return catalog;
    });
    try {
      expect(frames[0]).toEqual(['Alpha', 'Beta']);
      const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={vi.fn()} />);
      try { expect(screen.getTextContent()).toContain('License required'); }
      finally { await screen.unmount(); }
      retireActiveServerAccountScopeLifetime();
      await resumed.rerender();
      expect(resumed.getCurrent().provisioners).toEqual([]);
      await resumed.unmount();
      const nextLifetime = await renderHook(() => useManagedProvisioners(serverId, undefined,
        { machineId: 'controller', installationId: 'controller-installation' }));
      try { expect(nextLifetime.getCurrent().provisioners).toEqual([]); }
      finally { await nextLifetime.unmount(); }
    } finally {
      release(); await resumed.unmount();
      publishAppliedActiveServerRuntimeAvailability(false);
      storage.setState(previous);
    }
  });

  it('explains transient catalog and check failures and recovers through Retry without remounting the named controller', async () => {
    const { serverId, provisioners } = await arrangeCatalog({});
    const code = 'project_requester_home_unavailable';
    let listUnavailable = true;
    let checkUnavailable = true;
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
      const controller = (request.input as { controller: { machineId: string; installationId: string } }).controller;
      return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
        execution: listUnavailable ? { ok: false, errorCode: code, error: code }
          : { ok: true, result: { controller, provisioners } } }) };
    } });
    harness.answer(serverId, '/v1/actions/machines.provisioners.check', { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
      return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.provisioners.check', requestId: request.requestId,
        execution: checkUnavailable ? { ok: false, errorCode: code, error: code }
          : { ok: true, result: { available: true } } }) };
    } });
    const { readTransientAvailabilityFailure } = await import('@/utils/errors/transientAvailability');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const onSelect = vi.fn();
    const preferred = { machineId: 'controller', installationId: 'controller-installation' };
    function FixedPicker() {
      return <MachineProvisionerPicker serverId={serverId} onSelectProvisioner={onSelect} />;
    }
    const screen = await renderPicker(<FixedPicker />);
    const failureCard = () => screen.tree.findAll(node => node.props.testID === 'managed-picker.unavailable' && 'diagnosticCode' in node.props)[0];
    try {
      await waitForHomeGovernance(() => expect(failureCard()?.props.diagnosticCode).toBe(code));
      expect(failureCard()?.props.diagnosticDetail).toBe(readTransientAvailabilityFailure(code)?.message);
      listUnavailable = false;
      await act(async () => screen.pressByTestId('managed-picker.unavailable-action'));
      await waitForHomeGovernance(() => {
        expect(screen.findByTestId('managed-picker.provisioners')).not.toBeNull();
        expect(failureCard()?.props.diagnosticCode).toBe(code);
      });
      expect(failureCard()?.props.diagnosticDetail).toBe(readTransientAvailabilityFailure(code)?.message);
      checkUnavailable = false;
      await act(async () => screen.pressByTestId('managed-picker.unavailable-action'));
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.unavailable')).toBeNull());
      await act(async () => screen.pressByTestId('managed-picker.provisioners.local.custom.compute/alpha.action'));
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ provisioner: 'custom.compute/alpha', controller: preferred }));
      // One initial catalog read and one per explicit Retry; recovery does not start a background retry loop.
      expect(harness.requestsFor('/v1/actions/machines.provisioners.list')).toHaveLength(3);
      expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(4);
    } finally { await screen.unmount(); }
  });

  it('keeps the answered checks on screen while the catalog is re-read', async () => {
    const { serverId, reads, release } = await arrangeCatalog({ check: (read) => read > 1 });
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={vi.fn()} />);
    // Nested layout nodes repeat the same card objects; one entry per card.
    const cards = () => [...new Map(screen.tree.findAll(node => Array.isArray(node.props.cards))
      .flatMap(node => node.props.cards as { title: string; status: { label: string } }[]).map(card => [card.title, card])).values()];
    try {
      await waitForHomeGovernance(() => {
        expect(screen.findByTestId('managed-picker.unavailable')).not.toBeNull();
        expect(cards().find(card => card.title === 'Alpha')?.status.label).toBe('License required');
      });
      await act(async () => screen.pressByTestId('managed-picker.unavailable-action'));
      await waitForHomeGovernance(() => expect(reads.check.get('alpha')).toBe(2));
      // The re-check is still pending: both cards keep what the last answer said.
      expect(cards().map(card => card.title)).toEqual(['Alpha', 'Beta']);
      expect(cards().find(card => card.title === 'Alpha')?.status.label).toBe('License required');
    } finally {
      release();
    }
    await screen.unmount();
  });
  it('shows each check as it answers, so one slow provisioner leaves the others readable', async () => {
    const { serverId, release } = await arrangeCatalog({ check: (_read, localId) => localId === 'beta' });
    const { t } = await import('@/text');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={vi.fn()} />);
    const cards = () => [...new Map(screen.tree.findAll(node => Array.isArray(node.props.cards))
      .flatMap(node => node.props.cards as { title: string; status: { label: string } }[]).map(card => [card.title, card])).values()];
    try {
      await waitForHomeGovernance(() => expect(cards().find(card => card.title === 'Alpha')?.status.label).toBe('License required'));
      // Beta's read is still pending: it says so itself and nothing else is blamed.
      expect(cards().find(card => card.title === 'Beta')?.status.label).toBe(t('managedMachines.add.status.checking'));
      expect(screen.findByTestId('managed-picker.unavailable')).toBeNull();
    } finally {
      release();
    }
    await screen.unmount();
  });
  it('keeps retained checks display-only when the replacement catalog fails, and enables Choose after recovery', async () => {
    const { serverId, provisioners } = await arrangeCatalog({});
    const onSelect = vi.fn();
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    function FixedPicker() {
      return <MachineProvisionerPicker serverId={serverId} onSelectProvisioner={onSelect} />;
    }
    harness.answer(serverId, '/v1/actions/machines.provisioners.check', { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
      return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.provisioners.check', requestId: request.requestId, execution: { ok: true,
        result: { available: false, code: 'license_required', status: { key: 'alpha.license', fallback: 'License required' } } } }) };
    } });
    const screen = await renderPicker(<FixedPicker />);
    const cards = () => screen.tree.findAll(node => Array.isArray(node.props.cards))
      .flatMap(node => node.props.cards as { title: string; status: { label: string }; action: { disabled?: boolean; onPress(): void } }[]);
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(cards().find(card => card.title === 'Alpha')?.status.label, 'initial check').toBe('License required'); });
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
      return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
        execution: { ok: false, errorCode: 'unavailable', error: 'unavailable' } }) };
    } });
    // A refreshed credential for the same Account retires the binding; an unrelated Home publication does not.
    await act(async () => { await harness.switchAccount(serverId, 'owner', { currentAccount: true }); });
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(screen.findByTestId('managed-picker.unavailable'), 'failed catalog').not.toBeNull(); });
    expect(screen.findByTestId('managed-picker.unavailable')).not.toBeNull();
    const retained = cards().find(card => card.title === 'Alpha');
    expect(retained?.status.label).toBe('License required');
    expect(retained?.action.disabled).not.toBe(true);
    await act(async () => retained?.action.onPress());
    expect(onSelect).not.toHaveBeenCalled();
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
      const controller = request.input && typeof request.input === 'object' && 'controller' in request.input ? request.input.controller : undefined;
      if (!controller) throw new Error('Expected the requested controller');
      return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
        execution: { ok: true, result: { controller, provisioners } } }) };
    } });
    await act(async () => screen.pressByTestId('managed-picker.unavailable-action'));
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(cards().find(card => card.title === 'Alpha')?.action.disabled, 'recovered catalog').not.toBe(true); });
    await act(async () => cards().find(card => card.title === 'Alpha')?.action.onPress());
    expect(onSelect).toHaveBeenCalledOnce();
    await screen.unmount();
  });
  it('says the chosen controller is offline, with its next step, while its last cards stay on screen (J8)', async () => {
    const { serverId } = await arrangeCatalog({ home: 'offline-cards' });
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const { storage } = await import('@/sync/domains/state/storage');
    const { publishMachineActivity } = await import('@/sync/domains/machines/machineActivity');
    function FixedPicker() {
      return <MachineProvisionerPicker serverId={serverId} />;
    }
    const screen = await renderPicker(<FixedPicker />);
    const cards = () => screen.tree.findAll(node => Array.isArray(node.props.cards))
      .flatMap(node => node.props.cards as { title: string }[]);
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(cards().some(card => card.title === 'Alpha')).toBe(true); });
    expect(screen.findByTestId('managed-picker.offline')).toBeNull();
    const machine = storage.getState().machineListByServerId[serverId]!.find(entry => entry.id === 'controller')!;
    await act(async () => publishMachineActivity(machine, { active: false, activeAt: 0 }, []));
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.offline')).not.toBeNull());
    expect(screen.findByTestId('managed-picker.offline-action')).not.toBeNull();
    expect(cards().some(card => card.title === 'Alpha')).toBe(true);
    await screen.unmount();
  });
  it('publishes no loading or replacement cards for an equal catalog refresh, and publishes changed cards once', async () => {
    const { serverId, reads, provisioners } = await arrangeCatalog({});
    const { useManagedProvisioners } = await import('./useManagedProvisioners');
    const controller = { machineId: 'controller', installationId: 'controller-installation' };
    const publications: { loading: boolean; provisioners: ReturnType<typeof useManagedProvisioners>['provisioners'] }[] = [];
    const hook = await renderHook(() => {
      const catalog = useManagedProvisioners(serverId, undefined, controller);
      React.useEffect(() => { publications.push({ loading: catalog.loading, provisioners: catalog.provisioners }); },
        [catalog.loading, catalog.provisioners]);
      return catalog;
    });
    try {
      await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
      await waitForHomeGovernance(() => expect(hook.getCurrent().provisioners).toHaveLength(2));
      const settled = hook.getCurrent().provisioners;
      publications.length = 0;
      const before = reads.list;
      await act(async () => hook.getCurrent().refresh());
      await waitForHomeGovernance(() => expect(reads.list).toBeGreaterThan(before));
      await flushHookEffects();
      await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
      expect(publications).toHaveLength(0);
      expect(hook.getCurrent().provisioners).toBe(settled);
      provisioners[0] = { ...provisioners[0]!, descriptor: { ...provisioners[0]!.descriptor, title: 'Changed native compute' } };
      await act(async () => hook.getCurrent().refresh());
      await waitForHomeGovernance(() => expect(hook.getCurrent().provisioners[0]?.descriptor.title).toBe('Changed native compute'));
      expect(publications).toHaveLength(1);
      expect(publications[0]?.loading).toBe(false);
      expect(hook.getCurrent().provisioners[1]).toBe(settled[1]);
    } finally { await hook.unmount(); }
  });
  it('keeps the last catalog across a refreshed credential binding while the replacement reads', async () => {
    const { serverId, release } = await arrangeCatalog({ list: (read) => read > 1 });
    const { useManagedProvisioners } = await import('./useManagedProvisioners');
    const controller = { machineId: 'controller', installationId: 'controller-installation' };
    const hook = await renderHook(() => useManagedProvisioners(serverId, undefined, controller));
    try {
      await waitForHomeGovernance(() => expect(hook.getCurrent().provisioners).toHaveLength(2));
      const firstBinding = hook.getCurrent().binding;
      // A refreshed credential retires the binding and binds the same Account again.
      await harness.switchAccount(serverId, 'owner', { currentAccount: true });
      await waitForHomeGovernance(() => expect(hook.getCurrent().binding).not.toBe(firstBinding));
      expect(hook.getCurrent().reading).toBe(true);
      expect(hook.getCurrent().loading).toBe(false);
      expect(hook.getCurrent().current).toBe(false);
      expect(hook.getCurrent().provisioners).toHaveLength(2);
    } finally {
      release();
    }
  });
  it('reserves the catalog layout while the first catalog reads, without a lone loading line or a controller prompt', async () => {
    const { serverId, release } = await arrangeCatalog({ list: read => read === 1 });
    const { t } = await import('@/text');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} />);
    try {
      expect(screen.findByTestId('managed-picker.loading')).not.toBeNull();
      expect(screen.getTextContent()).not.toContain(t('managedMachines.providers.loading'));
      expect(screen.getTextContent()).not.toContain(t('managedMachines.add.chooseController'));
      expect(screen.getTextContent()).not.toContain(t('managedMachines.config.managedFrom'));
      release();
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.provisioners')).not.toBeNull());
      expect(screen.findByTestId('managed-picker.loading')).toBeNull();
      expect(screen.findByTestId('managed-picker.controller.chip')).not.toBeNull();
    } finally { release(); await screen.unmount(); }
  });

  it('keeps the last catalog while another controller is being read', async () => {
    const { serverId, release } = await arrangeCatalog({ list: (_read, machineId) => machineId === 'other' });
    const { useManagedProvisioners } = await import('./useManagedProvisioners');
    const first = { machineId: 'controller', installationId: 'controller-installation' };
    const hook = await renderHook(({ controller }) => useManagedProvisioners(serverId, undefined, controller), { initialProps: { controller: first } });
    try {
      await waitForHomeGovernance(() => expect(hook.getCurrent().provisioners).toHaveLength(2));
      await hook.rerender({ controller: { machineId: 'other', installationId: 'other-installation' } });
      expect(hook.getCurrent().reading).toBe(true);
      expect(hook.getCurrent().loading).toBe(false);
      expect(hook.getCurrent().current).toBe(false);
      expect(hook.getCurrent().provisioners).toHaveLength(2);
    } finally {
      release();
    }
  });
  it('does not read one controller\u2019s checks as another\u2019s while the new controller answers', async () => {
    const { serverId, release } = await arrangeCatalog({ list: (_read, machineId) => machineId === 'other' });
    const { useManagedProvisioners } = await import('./useManagedProvisioners');
    const first = { machineId: 'controller', installationId: 'controller-installation' };
    const hook = await renderHook(({ controller }) => useManagedProvisioners(serverId, undefined, controller), { initialProps: { controller: first } });
    try {
      await waitForHomeGovernance(() => expect(hook.getCurrent().provisioners).toHaveLength(2));
      await act(async () => hook.getCurrent().setChecks({ alpha: { kind: 'succeeded', value: { available: true } } }));
      expect(Object.keys(hook.getCurrent().checks)).toEqual(['alpha']);
      await hook.rerender({ controller: { machineId: 'other', installationId: 'other-installation' } });
      // The cards stay; their answers belonged to the previous computer.
      expect(hook.getCurrent().provisioners).toHaveLength(2);
      expect(hook.getCurrent().checks).toEqual({});
    } finally {
      release();
    }
  });
  it('keeps Account offers beside controller-installed cards and when the controller catalog is empty', async () => {
    const { vercel, lima, e2b } = await installBundledMachinePlugins();
    const { serverId, provisioners } = await arrangeCatalog({});
    const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } =
      await import('@/sync/domains/plugins/availability/projection');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
    const publishAccount = () => {
      // An omitted intent retains its prior read. Start this fixture's enabled
      // bundled Account source after arrangeCatalog's deliberately disabled one.
      clearPluginAccountAvailabilityProjection();
      replacePluginAccountAvailabilityProjection({ scope,
        snapshot: { availabilityCursor: 1, inventoryComplete: false, intentReads: [], materializations: [], snapshots: [] } });
    };
    onTestFinished(clearPluginAccountAvailabilityProjection);
    publishAccount();
    const { useManagedProvisioners } = await import('./useManagedProvisioners');
    const controller = { machineId: 'controller', installationId: 'controller-installation' };
    const { MachineProvisionersListResultV1Schema } = await import('@happier-dev/protocol/plugins/contributions/machineProvisioners');
    const nativeAccountEntry = { contribution: { pluginId: e2b.id, localId: e2b.contributes.machineProvisioners![0]!.id },
      occurrenceId: 'controller-e2b', acquireExecutionTarget: 'account', descriptor: e2b.contributes.machineProvisioners![0]! };
    const nativeCatalog = MachineProvisionersListResultV1Schema.parse({ controller, provisioners: [...provisioners, nativeAccountEntry] });
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
      return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
        execution: { ok: true, result: nativeCatalog } } };
    } });
    const hook = await renderHook(() => useManagedProvisioners(serverId, undefined, controller));
    const accountKey = buildQualifiedPluginContributionKey({ pluginId: vercel.id, localId: vercel.contributes.machineProvisioners![0]!.id });
    const keys = () => hook.getCurrent().provisioners.map(row => buildQualifiedPluginContributionKey(row.contribution));
    try {
      await waitForHomeGovernance(() => {
        expect(hook.getCurrent().loading).toBe(false);
        expect(keys()).toContain(accountKey);
      });
      expect(hook.getCurrent().provisioners).toEqual(expect.arrayContaining(provisioners));
      expect(hook.getCurrent().provisioners.filter(row => row.contribution.pluginId === e2b.id)).toEqual([
        expect.objectContaining({ occurrenceId: 'controller-e2b' }),
      ]);
      // Daemon-target bundled declarations remain filtered by the selected daemon's catalog/OS.
      expect(hook.getCurrent().provisioners.some(row => row.contribution.pluginId === lima.id)).toBe(false);
      const replyEmpty = (value: unknown) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
          execution: { ok: true, result: { controller, provisioners: [] } } } };
      };
      harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: replyEmpty });
      await act(async () => hook.getCurrent().refresh());
      await waitForHomeGovernance(() => {
        expect(hook.getCurrent().loading).toBe(false);
        expect(keys()).toContain(accountKey);
        expect(keys()).not.toContain(buildQualifiedPluginContributionKey(provisioners[0]!.contribution));
      });
      // An Account projection that is loading again is readiness, not a failure: the last declared cards stay.
      clearPluginAccountAvailabilityProjection();
      await act(async () => hook.getCurrent().refresh());
      await flushHookEffects();
      expect(hook.getCurrent().error).toBeNull();
      expect(keys()).toContain(accountKey);
      publishAccount();
      await act(async () => hook.getCurrent().refresh());
      await waitForHomeGovernance(() => {
        expect(hook.getCurrent().loading).toBe(false);
        expect(hook.getCurrent().error).toBeNull();
        expect(keys()).toContain(accountKey);
      });
      expect(harness.requests.some(request => request.path.includes('/connect/qualified/accounts'))).toBe(false);
    } finally { await hook.unmount(); }
  });
  it('asks for an explicit Home, then reads preset descriptors without consulting its controller', async () => {
    const first = await harness.addHome({
      name: 'Build',
      serverUrl: 'https://build.example',
      serverIdentityId: 'srv_build',
      accountId: 'owner',
      currentAccount: true,
    });
    await publishNoAccountProvisioners(first);
    await harness.addHome({
      name: 'Other',
      serverUrl: 'https://other.example',
      serverIdentityId: 'srv_other',
      accountId: 'other',
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [first]: [
          createControllerMachineFixture({
            id: 'build-controller',
            installationId: 'build-installation',
            activeAt: Date.now(),
            kind: 'persistent',
          }),
        ],
      },
      machineListStatusByServerId: { [first]: 'idle' },
    });
    harness.answer(first, '/v1/actions/machines.provisioners.list', {
      select: (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        return {
          body: {
            v: 1,
            actionId: 'machines.provisioners.list',
            requestId: request.requestId,
            execution: { ok: true, result: { provisioners: [] } },
          },
        };
      },
    });
    const { MachineProvisionerPicker } =
      await import('./MachineProvisionerPicker');
    const screen = await renderPicker(
      <MachineProvisionerPicker serverId="" presetOnly />,
    );
    expect(
      harness.requestsFor('/v1/actions/machines.provisioners.list'),
    ).toHaveLength(0);
    expect(screen.findByTestId('managed-picker.controller.chip')).toBeNull();
    await act(async () => screen.pressByTestId(`managed-picker.home:${first}`));
    // A known controller is future execution placement, not a prerequisite or catalog authority for authoring.
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-picker.empty')).not.toBeNull(),
    );
    expect(screen.findByTestId('managed-picker.controller.chip')).toBeNull();
    expect(screen.findByTestId('managed-picker.no-controller')).toBeNull();
    expect(
      harness.requestsFor('/v1/actions/machines.provisioners.list'),
    ).toHaveLength(0);
    expect(
      harness.requests.some((request) => request.path.endsWith('/acquire')),
    ).toBe(false);
    await screen.unmount();
  });
  it.each(['profile', 'portable'] as const)('keeps a named offline controller while the machine list loads for a %s Home identifier, and offers setup when nothing can manage', async (identifierKind) => {
    const serverId = await harness.addHome({
      name: 'Build',
      serverUrl: 'https://build.example',
      serverIdentityId: 'srv_build',
      accountId: 'owner',
      currentAccount: true,
    });
    const scopeId = identifierKind === 'portable' ? 'srv_build' : serverId;
    await publishNoAccountProvisioners(scopeId);
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        srv_build: [
          createControllerMachineFixture({
            id: 'asleep',
            installationId: 'installation',
            active: false,
            activeAt: 0,
            kind: 'persistent',
          }),
        ],
      },
      machineListStatusByServerId: { srv_build: 'loading' },
    });
    const { MachineProvisionerPicker } =
      await import('./MachineProvisionerPicker');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const { useMachineListStatusForServer } = await import('@/sync/domains/state/storage');
    const controllerScope = await renderHook(() => ({
      scope: useManagedControllerScope({ serverId: scopeId, preferred: { machineId: 'asleep', installationId: 'installation' }, testIDPrefix: 'scope-probe' }),
      status: useMachineListStatusForServer(scopeId),
    }));
    expect(controllerScope.getCurrent().status).toBe('loading');
    expect(controllerScope.getCurrent().scope.controller).toEqual({ machineId: 'asleep', installationId: 'installation' });
    await act(async () => { storage.setState({ machineListStatusByServerId: { srv_build: 'idle' } }); });
    expect(controllerScope.getCurrent().status).toBe('idle');
    await controllerScope.unmount();
    storage.setState({
      machineListByServerId: {
        srv_build: [
          createControllerMachineFixture({ id: 'plain', installationId: null }),
        ],
      },
    });
    const onSetUpThisComputer = vi.fn();
    const empty = await renderPicker(
      <MachineProvisionerPicker
        serverId={scopeId}
        onSetUpThisComputer={onSetUpThisComputer}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(empty.findByTestId('managed-picker.no-controller')).not.toBeNull(),
    );
    await act(async () =>
      empty.pressByTestId('managed-picker.no-controller-action'),
    );
    expect(onSetUpThisComputer).toHaveBeenCalledTimes(1);
    await empty.unmount();
  });
  it('says why nothing is listed when every controller is offline, instead of an empty page under the chip', async () => {
    const homeId = await harness.addHome({ name: 'Build', serverUrl: 'https://offline-picker.example', serverIdentityId: 'srv_offline_picker', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    await act(async () => storage.setState({ machineListByServerId: { [homeId]: [
      createControllerMachineFixture({ id: 'studio', installationId: 'studio-installation', active: false, activeAt: 0 }),
    ] }, machineListStatusByServerId: { [homeId]: 'idle' } }));
    await publishNoAccountProvisioners(homeId);
    const screen = await renderPicker(<MachineProvisionerPicker serverId={homeId} />);
    expect(screen.findByTestId('managed-picker.no-controller')).toBeNull();
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.no-online-controller')).not.toBeNull());
    await screen.unmount();
  });
  it('offers the Account providers with every machine offline, never saying nothing is online (D21)', async () => {
    await installBundledMachinePlugins();
    const homeId = await harness.addHome({ name: 'Cloud', serverUrl: 'https://offline-cloud.example', serverIdentityId: 'srv_offline_cloud', accountId: 'owner', currentAccount: true });
    const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(homeId) || homeId, accountId: 'owner' },
      snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    runtimeHost.current = 'browser';
    onTestFinished(() => { runtimeHost.current = null; });
    const { storage } = await import('@/sync/domains/state/storage');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    await act(async () => storage.setState({ machineListByServerId: { [homeId]: [
      createControllerMachineFixture({ id: 'studio', installationId: 'studio-installation', active: false, activeAt: 0 }),
    ] }, machineListStatusByServerId: { [homeId]: 'idle' } }));
    const screen = await renderPicker(<MachineProvisionerPicker serverId={homeId} onSelectProvisioner={() => {}} />);
    try {
      // Loading, and then settled: an Account provider needs no Machine, so the page never says one must be online.
      expect(screen.findByTestId('managed-picker.no-online-controller')).toBeNull();
      await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Vercel'));
      expect(screen.findByTestId('managed-picker.no-online-controller')).toBeNull();
    } finally { await screen.unmount(); }
  });
  it('asks for a choice instead of saying nothing is online when a machine is online but none was preselected', async () => {
    const homeId = await harness.addHome({ name: 'Build', serverUrl: 'https://unpicked-picker.example', serverIdentityId: 'srv_unpicked_picker', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const { t } = await import('@/text');
    // Online, but a shared machine is never the page's automatic default.
    await act(async () => storage.setState({ machineListByServerId: { [homeId]: [
      createControllerMachineFixture({ id: 'teammate', installationId: 'teammate-installation', activeAt: Date.now(), isShared: true }),
    ] }, machineListStatusByServerId: { [homeId]: 'idle' } }));
    await publishNoAccountProvisioners(homeId);
    const screen = await renderPicker(<MachineProvisionerPicker serverId={homeId} />);
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('managedMachines.add.chooseController')));
    expect(screen.getTextContent()).not.toContain(t('managedMachines.add.noOnlineController'));
    await screen.unmount();
  });
  it('waits for the Home\u2019s machine list instead of saying no machine can create machines', async () => {
    const homeId = await harness.addHome({ name: 'Build', serverUrl: 'https://unsynced-picker.example', serverIdentityId: 'srv_unsynced_picker', accountId: 'owner', currentAccount: true });
    await publishNoAccountProvisioners(homeId);
    const { storage } = await import('@/sync/domains/state/storage');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const screen = await renderPicker(<MachineProvisionerPicker serverId={homeId} />);
    expect(screen.findByTestId('managed-picker.no-controller')).toBeNull();
    expect(screen.findByTestId('managed-picker.loading')).not.toBeNull();
    await act(async () => storage.setState({ machineListByServerId: { [homeId]: [] }, machineListStatusByServerId: { [homeId]: 'idle' } }));
    expect(screen.findByTestId('managed-picker.no-controller')).not.toBeNull();
    await act(async () => storage.setState({ machineListStatusByServerId: { [homeId]: 'error' }, machineListByServerId: { [homeId]: null } }));
    expect(screen.findByTestId('managed-picker.no-controller')).toBeNull();
    expect(screen.findByTestId('managed-picker.machines-unavailable')).not.toBeNull();
    await screen.unmount();
  });
  it('settles a signed-out Home without an endless provisioning spinner or reading a different Home', async () => {
    const signedOut = await harness.addHome({
      name: 'Signed out',
      serverUrl: 'https://signed-out.example',
      serverIdentityId: 'srv_signed_out',
      accountId: null,
    });
    await harness.addHome({
      name: 'Other',
      serverUrl: 'https://other.example',
      serverIdentityId: 'srv_other',
      accountId: 'other',
    });
    const { MachineProvisionerPicker } =
      await import('./MachineProvisionerPicker');
    const screen = await renderPicker(
      <MachineProvisionerPicker serverId={signedOut} />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.tree.findAll(
          (node) => node.props.testID === 'managed-picker.unavailable',
        ).length,
      ).toBeGreaterThan(0),
    );
    const failure = screen.tree.findAll(node => node.props.testID === 'managed-picker.unavailable' && 'diagnosticCode' in node.props)[0];
    expect(failure?.props.diagnosticDetail).toBeTruthy();
    expect(failure?.props.diagnosticDetail).not.toBe(failure?.props.diagnosticCode);
    expect(
      harness.requestsFor(
        '/v1/machines/managed/actions/machines.provisioners.list',
      ),
    ).toHaveLength(0);
    await screen.unmount();
  });
});
