import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { MachineProvisionersListResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createManagedControllerMachineFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import {
  clearPluginAccountAvailabilityProjection,
  replacePluginAccountAvailabilityProjection,
} from '@/sync/domains/plugins/availability/projection';

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

it('says a Machine that offers no sandbox kinds has none, on the sheet body edge, instead of the create-a-machine line', async () => {
  onTestFinished(installBundledPluginUiDeclarationsForTests([]));
  onTestFinished(clearPluginAccountAvailabilityProjection);
  const serverId = await harness.addHome({
    name: 'Build',
    serverUrl: 'https://sandbox-empty.example.test',
    serverIdentityId: 'srv_sandbox_empty',
    accountId: 'owner',
    currentAccount: true,
  });
  replacePluginAccountAvailabilityProjection({
    scope: {
      serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId,
      accountId: 'owner',
    },
    snapshot: {
      availabilityCursor: 1,
      inventoryComplete: true,
      materializations: [],
      snapshots: [],
      intentReads: [],
    },
  });
  const controller = { machineId: 'devbox', installationId: 'installation' };
  const machine = createManagedControllerMachineFixture({
    id: controller.machineId,
    installationId: controller.installationId,
    activeAt: Date.now(),
    kind: 'persistent',
  });
  await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
    { ...machine, metadata: { ...machine.metadata!, platform: 'linux' } },
  ]);
  // The controller's catalog answers with no kinds at all (a CLI that reports none).
  await answerExternalActionAccountForHome(harness, serverId, {
    ...controller,
    actionId: 'machines.provisioners.list',
    tokenEpoch: 0,
    requesterInvocation: 'optional',
    execute: async () =>
      MachineProvisionersListResultV1Schema.parse({
        controller,
        provisioners: [],
      }),
  });
  const { MachineIsolationAddSandboxModal } =
    await import('./MachineIsolationAddSandboxModal');
  const { t } = await import('@/text');
  const screen = await renderScreen(
    <ListPresentationProvider value="page">
      <MachineIsolationAddSandboxModal
        onClose={() => {}}
        setChrome={() => {}}
        serverId={serverId}
        controller={controller}
        machineName="devbox"
        onAdded={() => {}}
      />
    </ListPresentationProvider>,
  );
  try {
    type Node = { children?: ReadonlyArray<Node | string> };
    const textOf = (node: Node): string =>
      (node.children ?? []).map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
    const says = (root: Node | null, text: string) =>
      root === null ? screen.getTextContent().includes(text) : textOf(root).includes(text);
    const noKinds = t('machineDetailPage.isolation.add.noKinds', { machine: 'devbox' });
    const createAMachine = t('managedMachines.providers.empty');
    // Whichever empty line the step draws once the catalog has answered.
    await waitForHomeGovernance(() =>
      expect(says(null, noKinds) || says(null, createAMachine)).toBe(true),
    );
    expect(says(null, createAMachine)).toBe(false);
    const line = screen.findByTestId('managed-picker.empty')!;
    expect(says(line, noKinds)).toBe(true);
    // The sheet draws its own content edge (the lead sentence stands on it): the line adds no inset of its own.
    const lineRoot = line.findAll(
      (node) => typeof node.type === 'string' && node.props.style != null,
    )[0]!;
    expect(StyleSheet.flatten(lineRoot.props.style).paddingHorizontal).toBe(0);
  } finally {
    await screen.unmount();
  }
});
