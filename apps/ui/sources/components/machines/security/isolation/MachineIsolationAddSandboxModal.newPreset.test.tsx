import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import {
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import {
  MachineSetupPlanInputV1Schema,
  MachineSetupPlanResultV1Schema,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineProvisionersListResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createManagedControllerMachineFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import {
  clearPluginAccountAvailabilityProjection,
  replacePluginAccountAvailabilityProjection,
} from '@/sync/domains/plugins/availability/projection';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

// test-policy-boundary: Metro's lazy module loader is substituted; the actual Action executor stays real.
vi.mock(
  '@/sync/ops/actions/frontDoorRuntimeActionExecutor',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')
      >();
    const { createFrontDoorActionExecuteForVitest } =
      await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return {
      ...original,
      createFrontDoorActionExecute:
        createFrontDoorActionExecuteForVitest(original),
    };
  },
);
installApprovalCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } =
  await import('@/sync/ops/actions/scopedHomeActionExecutor');
beforeEach(async () => {
  await harness.reset();
  resetScopedHomeActionExecutorsForTests();
});
afterEach(async () => {
  standardCleanup();
  await harness.reset();
});


it('creates a new preset inside the sheet with one footer, then returns to the Preset step with it chosen', async () => {
  onTestFinished(installBundledPluginUiDeclarationsForTests([]));
  onTestFinished(clearPluginAccountAvailabilityProjection);
  const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://sandbox-new-preset.example.test',
    serverIdentityId: 'srv_sandbox_new_preset', accountId: 'owner', currentAccount: true });
  replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' },
    snapshot: { availabilityCursor: 1, inventoryComplete: true, materializations: [], snapshots: [], intentReads: [] } });
  const controller = { machineId: 'devbox', installationId: 'installation' };
  const machine = createManagedControllerMachineFixture({ id: controller.machineId, installationId: controller.installationId,
    activeAt: Date.now(), kind: 'persistent', isShared: false });
  await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [{ ...machine, metadata: { ...machine.metadata!, platform: 'linux' } }]);
  const descriptor = { id: 'ready', title: 'Ready kind', icon: 'server', resourceKind: 'Container', schemaVersion: 1,
    launchSchema: { type: 'object', properties: {}, additionalProperties: false },
    resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
    sessionPlacement: { kind: 'controller-local' },
    actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } };
  const list = MachineProvisionersListResultV1Schema.parse({ controller, provisioners: [{
    contribution: { pluginId: 'sandbox.kinds', localId: 'ready' }, occurrenceId: 'occurrence-ready', credentialPurposes: [],
    acquireExecutionTarget: 'daemon', descriptor,
  }] });
  await answerExternalActionAccountForHome(harness, serverId, { ...controller, actionId: 'machines.provisioners.list', tokenEpoch: 0,
    requesterInvocation: 'optional', execute: async () => list, failure: () => null });
  await answerExternalActionAccountForHome(harness, serverId, { ...controller, actionId: 'machines.provisioners.check', tokenEpoch: 0,
    requesterInvocation: 'optional', execute: async () => ({ available: true }), failure: () => null });
  const { MachineIsolationAddSandboxModal } = await import('./MachineIsolationAddSandboxModal');
  const { ManagedMachineConfigurationView } = await import('@/components/settings/machines/managed/ManagedMachineConfigurationView');
  const setChrome = vi.fn();
  const onClose = vi.fn();
  const onAdded = vi.fn();
  const screen = await renderScreen(<ListPresentationProvider value="page">
    <MachineIsolationAddSandboxModal onClose={onClose} setChrome={setChrome} serverId={serverId} controller={controller} machineName="devbox" onAdded={onAdded} />
  </ListPresentationProvider>);
  try {
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-isolation-add.kind:sandbox.kinds/ready')).not.toBeNull());
    await screen.pressByTestIdAsync('machine-isolation-add.kind:sandbox.kinds/ready');
    const footer = await renderScreen(setChrome.mock.calls.at(-1)![0].footer);
    try {
      await waitForHomeGovernance(async () => {
        await footer.update(setChrome.mock.calls.at(-1)![0].footer);
        expect(footer.findByTestId('machine-isolation-add.continue')?.props.disabled).not.toBe(true);
      });
      await footer.pressByTestIdAsync('machine-isolation-add.continue');
    } finally { await footer.unmount(); }
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-isolation-add.new-preset')).not.toBeNull());
    await screen.pressByTestIdAsync('machine-isolation-add.new-preset');
    await waitForHomeGovernance(() => expect(screen.findAllByType(ManagedMachineConfigurationView).length).toBe(1));
    // The configurator's own Save and Cancel are the one set of buttons: the sheet drops its footer.
    expect(setChrome.mock.calls.at(-1)![0].footer).toBeNull();
    // Saving the new preset brings the sheet back to its Preset step with that preset chosen; nothing is added yet.
    const configurator = screen.findAllByType(ManagedMachineConfigurationView)[0]!;
    await act(async () => { configurator.props.onPresetSaved({ id: 'new-preset' }); });
    expect(onClose).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-isolation-add.new-preset')).not.toBeNull());
    const confirm = await renderScreen(setChrome.mock.calls.at(-1)![0].footer);
    try { expect(confirm.findByTestId('machine-isolation-add.confirm')?.props.disabled).not.toBe(true); }
    finally { await confirm.unmount(); }
  } finally { await screen.unmount(); }
});
