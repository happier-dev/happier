import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { DOCKER_ENGINE_RECIPE_REF_V1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ManagedInventorySections } from './ManagedInventorySections';
import { ManagedInventoryDirectory } from './ManagedInventoryDirectory';
import type { ManagedInventoryView } from './useManagedInventory';
import type { InstalledSoftwareRow } from '../catalog/storeSoftwareInstalled';
import type { InstalledAppsResult } from '../catalog/storeApps';

afterEach(() => standardCleanup());

it.each([false, true])('offers Docker removal only for manageable installations (Machine door: %s)', async (machineDoor) => {
  const scope = { serverId: 'inventory-home', accountId: 'viewer' };
  const previous = storage.getState();
  const publish = (role: 'use' | 'manage' | null) => {
    const machines = role ? [createMachineFixture({ id: 'shared-machine', isShared: true,
      access: { role, resourceMode: 'plain', accessState: 'ready', custodian: { accountId: 'owner', displayName: 'Owner' } } })] : [];
    storage.setState({ machineListByServerId: { [scope.serverId]: machines } });
  };
  const row: InstalledSoftwareRow = { kind: 'software', subject: 'recipe', key: 'docker', scope,
    presentation: { title: 'Docker Engine' }, native: { ref: DOCKER_ENGINE_RECIPE_REF_V1, inputs: {} },
    installations: [{ machineId: 'shared-machine', observation: null }] };
  const empty = { rows: [], coverage: 'available' } as const;
  const appNavigation: InstalledAppsResult['navigation'] = { hasNextPage: false, hasPreviousPage: false,
    nextPage: () => undefined, previousPage: () => undefined, refresh: async () => {} };
  const inventory: ManagedInventoryView = {
    families: { app: { ...empty, navigation: appNavigation }, browserExtension: empty, mcpServer: empty, skill: empty, agent: empty,
      provider: empty, plugin: empty, software: { rows: [row], coverage: 'available' } },
    operationalFamilies: { watchedService: empty, setup: empty, configuredCheck: empty, configuredBackup: empty },
    rows: [row], coverage: 'complete', loading: false, attention: [], noticeSource: null,
  };
  const input = { scope, projectKey: null,
    machine: machineDoor ? { serverIdentityId: scope.serverId, machineId: 'shared-machine' } : null };
  publish('use');
  const screen = await renderScreen(
    <ManagedInventorySections inventory={inventory} input={input} groupBy="kind" openKey={null} onOpenChange={() => {}}>
      {state => <ItemList><ManagedInventoryDirectory state={state} input={input} groupBy="kind"
        columns={machineDoor ? 1 : 2} preview={4} testIDPrefix="inventory" /></ItemList>}
    </ManagedInventorySections>,
  );
  try {
    // Removal sits behind the row's "…" menu, offered only to a manager of an installed Machine.
    const remove = () => screen.findAllByTestId('inventory.section.software.row.docker.more')
      .filter(node => typeof node.type === 'string');
    expect(screen.getTextContent()).toContain('Docker Engine');
    expect(remove()).toHaveLength(0);
    await act(async () => publish('manage'));
    expect(remove().length).toBeGreaterThan(0);
    await act(async () => publish('use'));
    expect(remove()).toHaveLength(0);
    await act(async () => publish(null));
    expect(remove()).toHaveLength(0);
  } finally {
    await screen.unmount();
    storage.setState({ machineListByServerId: previous.machineListByServerId });
  }
});
