import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { PluginMachineMaterializationV1Schema, PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';

import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createManagedControllerMachineFixture as createControllerMachineFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useManagedControllerScope } = await import('./useManagedControllerScope');
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');

beforeEach(async () => {
  await harness.reset();
  resetScopedHomeActionExecutorsForTests();
});
afterEach(async () => {
  standardCleanup();
  await harness.reset();
});

describe('Managed controller scope', () => {
  it('keeps an online controller eligible when a package publishes only its presentation manifest', async () => {
    const serverIdentityId = 'srv_build';
    const accountId = 'owner';
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId, accountId, currentAccount: true });
    const computer = createControllerMachineFixture({ id: 'controller-computer', installationId: 'computer-installation',
      activeAt: Date.now(), metadata: createMachineMetadataFixture({ platform: 'linux' }) });
    await publishMachineInventoryForTest({ serverId, accountId }, [computer]);

    const presentationManifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2,
      id: 'happier.fixture-provisioner', version: '1.0.0', displayName: 'Fixture provisioner', runtime: { apiVersion: 1 } });
    onTestFinished(installBundledPluginUiDeclarationsForTests([{ pluginId: presentationManifest.id,
      pluginVersion: presentationManifest.version, displayName: 'Fixture provisioner', packageName: '@happier-dev/fixture-provisioner',
      presentationManifest, hasMachineProvisioners: true, entriesById: {} }]));
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const materialization = PluginMachineMaterializationV1Schema.parse({ serverIdentityId, machineId: computer.id,
      materializationId: 'install-provisioner', pluginId: presentationManifest.id, version: presentationManifest.version,
      sourceClass: 'bundledFirstParty', portableRelease: false, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: Date.now() });
    replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId },
      snapshot: { availabilityCursor: 1, intentReads: [], materializations: [materialization],
        snapshots: [{ serverIdentityId, machineId: computer.id, materializations: [materialization] }] } });

    const hook = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    try {
      expect(hook.getCurrent().controller?.machineId).toBe(computer.id);
    } finally { await hook.unmount(); }
  });

  it.each(['none', 'default', 'lastUsed', 'thisComputer'] as const)('never defaults Managed from implicitly to a managed guest, preserving its existing selection intent (%s)', async intent => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { setMachineAdministrationTargetPreference, MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
    const { rememberMachineAdministrationTargetObservation } = await import('@/sync/domains/state/machineAdministrationUiState');
    const { getSystemTasksRunner } = await import('@/components/systemTasks/systemTasksRuntime');
    const { publishLocalDaemonStatus, readLocalDaemonSharedState } = await import('@/components/settings/machines/localControl/localDaemonSharedState');
    const runner = getSystemTasksRunner();
    const previousStatus = readLocalDaemonSharedState(runner).status;
    onTestFinished(() => publishLocalDaemonStatus(runner, previousStatus));
    const previousSettings = storage.getState().settings;
    const previousScope = storage.getState().settingsScope;
    onTestFinished(() => storage.setState({ settings: previousSettings, settingsScope: previousScope }));
    const guest = createControllerMachineFixture({ id: 'a-guest', installationId: 'guest-installation',
      active: intent !== 'default', activeAt: intent === 'default' ? 0 : Date.now(),
      managedMachineRef: { homeId: 'srv_build', managedId: 'managed' } });
    const computer = createControllerMachineFixture({ id: 'z-computer', installationId: 'computer-installation', activeAt: Date.now() });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [guest, computer]);
    storage.setState({ machineListStatusByServerId: { srv_build: 'idle' },
      settingsScope: { serverId: 'srv_build', accountId: 'owner' }, settings: { ...previousSettings,
        machineAdministrationTargetsLocalV1: intent === 'default' ? setMachineAdministrationTargetPreference({},
          MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.managedMachines, { serverIdentityId: 'srv_build', machineId: guest.id }) : {} } });
    if (intent === 'lastUsed') rememberMachineAdministrationTargetObservation({ serverId: 'srv_build', accountId: 'owner' },
      MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.managedMachines, { serverIdentityId: 'srv_build', machineId: guest.id });
    if (intent === 'thisComputer') publishLocalDaemonStatus(runner,
      { serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: guest.id });
    const hook = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    try {
      expect(hook.getCurrent().controller?.machineId).toBe(intent === 'default' ? guest.id : computer.id);
      if (intent === 'none') {
        await act(async () => {
          await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [guest]);
        });
        expect(hook.getCurrent().controller?.machineId).toBe(computer.id);
        expect(hook.getCurrent().selection?.state.kind).toBe('missing');
      }
      const target = hook.getCurrent().selection?.pickerRows.find(row => row.candidate.target.machineId === guest.id)?.candidate.target;
      expect(target).toBeDefined();
      await act(async () => hook.getCurrent().selection?.selectTarget(target!));
      expect(hook.getCurrent().controller?.machineId).toBe(guest.id);
    } finally { await hook.unmount(); }
  });
});
