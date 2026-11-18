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
import { PluginUiScrollActivityProvider, type PluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { projectThemeLibraryEntry } from '@/theme/profiles/themeProfilePresentation';
import { projectInstalledStoreThemeRows } from '../catalog/storeThemes';
import { reportCollectionLayout } from '@/dev/testkit/harness/collectionLayoutHarness';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

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
    families: { app: { ...empty, navigation: appNavigation }, theme: { ...empty, appliesToScope: !machineDoor }, browserExtension: empty, mcpServer: empty, skill: empty, agent: empty,
      provider: empty, plugin: empty, software: { rows: [row], coverage: 'available' } },
    operationalFamilies: { watchedService: empty, setup: empty, configuredCheck: empty, configuredBackup: { ...empty, navigation: appNavigation } },
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

it.each([1, 2] as const)('windows all installed theme listings in the physical page (%s columns)', async (columns) => {
  const scope = { serverId: 'theme-inventory', accountId: 'viewer' };
  const entries = Array.from({ length: 200 }, (_, index) => {
    const parsed = parseThemeProfileDocument({ schemaVersion: 1, id: `store-window-${index}`, name: `Theme ${index}`,
      createdAt: '2026-11-17', updatedAt: '2026-11-17', base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} },
      source: { kind: 'store', contributionId: 'dark', provenance: { sourceId: 'catalog', format: 'happier-catalog',
        sourceUrl: 'https://catalog.example.test', itemId: `theme-${index}`, ref: { kind: 'version', version: '1' }, importedAt: 0 } } });
    if (!parsed.ok) throw new Error('Invalid theme fixture');
    return projectThemeLibraryEntry(parsed.document);
  });
  const rows = projectInstalledStoreThemeRows(entries, scope);
  const empty = { rows: [], coverage: 'available' } as const;
  const navigation: InstalledAppsResult['navigation'] = { hasNextPage: false, hasPreviousPage: false,
    nextPage() {}, previousPage() {}, refresh: async () => {} };
  const inventory: ManagedInventoryView = {
    families: { app: { ...empty, navigation }, theme: { rows, coverage: 'available', appliesToScope: true }, browserExtension: empty,
      mcpServer: empty, skill: empty, agent: empty, provider: empty, plugin: empty, software: empty },
    operationalFamilies: { watchedService: empty, setup: empty, configuredCheck: empty, configuredBackup: { ...empty, navigation } },
    rows, coverage: 'complete', loading: false, attention: [], noticeSource: null,
  };
  const input = { scope, machine: null, projectKey: null };
  // Coordinates are the platform boundary: the actual directory and page windowing stay real.
  let window = { top: 0, bottom: 240 };
  const listeners = new Set<() => void>();
  const tracker: PluginUiScrollActivityTracker = { onScroll() {}, onLayout() {}, onContentSizeChange() {},
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getWindow: () => window, measureSpan: async () => ({ top: 0 }), invalidateLayout() {}, getLayoutRevision: () => 0 };
  const screen = await renderScreen(
    <ManagedInventorySections inventory={inventory} input={input} groupBy="kind" openKey={null} onOpenChange={() => {}}>
      {state => <ItemList><PluginUiScrollActivityProvider tracker={tracker}>
        <ManagedInventoryDirectory state={state} input={input} groupBy="kind" columns={columns} preview={4} testIDPrefix="themes" />
      </PluginUiScrollActivityProvider></ItemList>}
    </ManagedInventorySections>,
  );
  const id = (key: string) => `themes.section.theme.row.${key}`;
  const mounted = () => rows.filter(row => screen.findAllHostsByTestId(id(row.key)).length > 0);
  expect(mounted()).toHaveLength(4);
  await screen.pressByTestIdAsync('themes.section.theme.all');
  await reportCollectionLayout(screen.root, 'themes.section.theme.rows', { width: 900, height: 240 });
  expect(mounted()).toHaveLength(columns === 1 ? 5 : 8);
  const lastLine = Math.floor((rows.length - 1) / columns);
  const offset = lastLine * (HAPPIER_COLLECTION_LIST_METRICS.catalogRow.minHeight + (columns === 2 ? 16 : 0));
  await act(async () => { window = { top: offset, bottom: offset + 240 }; listeners.forEach(listener => listener()); });
  expect(mounted().length).toBeLessThan(rows.length);
  expect(screen.findAllHostsByTestId(id(rows.at(-1)!.key)).length).toBeGreaterThan(0);
  await act(async () => { window = { top: 0, bottom: 240 }; listeners.forEach(listener => listener()); });
  await screen.pressByTestIdAsync('themes.section.theme.fewer');
  expect(mounted()).toHaveLength(4);
});
