import * as React from 'react';
import { afterEach, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { ManagedInventorySectionsState } from './ManagedInventorySections';
import type { ManagedInventoryView } from './useManagedInventory';
import type { InstalledBrowserExtensionRow } from '../catalog/storeBrowserExtensions';

const { ManagedInventorySections } = await import('./ManagedInventorySections');

afterEach(() => {
  standardCleanup();
});

const scope = {
  serverId: 'srv_installed_extensions',
  accountId: 'alice',
} as const;
const extensionId = 'a'.repeat(32);
const row: InstalledBrowserExtensionRow = {
  kind: 'browserExtension', subject: 'extension',
  key: 'ext-row',
  scope,
  machineId: 'machine-a',
  native: {
    profileId: 'work',
    restartRequired: false,
    extension: {
      id: extensionId,
      name: 'Reader',
      version: '1.0',
      enabled: true,
      source: { kind: 'webStore', extensionId },
      directory: '/browser/extensions/reader',
      permissions: [],
      hostPermissions: [],
    },
  },
};
const empty = { rows: [], coverage: 'available' } as const;

it('gives Installed browser extensions their own section, with refusing Machines as partial coverage beside the rows', async () => {
  // One Machine answered; another refused as unavailable. The answered row shows; the refusal is coverage, not a hidden list.
  const browserExtension = {
    rows: [row],
    coverage: {
      partial: [
        {
          machineId: 'machine-b',
          reason: { kind: 'action' as const, code: 'target_unavailable' },
        },
      ],
    },
    continuation: () => {},
  };
  const inventory = {
    families: {
      app: empty,
      browserExtension,
      mcpServer: empty,
      skill: empty,
      agent: empty,
      provider: empty,
      plugin: empty,
      software: empty,
    },
    operationalFamilies: { watchedService: empty, setup: empty, configuredCheck: empty },
    rows: [row],
    coverage: 'partial',
    loading: false,
    attention: [],
    noticeSource: null,
  } as unknown as ManagedInventoryView; // Typed native families are produced by their adapters; this fixture holds only the shape the sections read.
  let state!: ManagedInventorySectionsState;
  await renderScreen(
    <ManagedInventorySections
      inventory={inventory}
      input={{ scope, machine: null, projectKey: null }}
      groupBy="kind"
      openKey={null}
      onOpenChange={() => {}}
    >
      {(value) => {
        state = value;
        return null;
      }}
    </ManagedInventorySections>,
  );
  const family = state.families.find(
    (entry) => entry.kind === 'browserExtension',
  );
  expect(family?.result.rows.map((entry) => entry.key)).toEqual(['ext-row']);
  expect(family?.result.coverage).toMatchObject({
    partial: [{ machineId: 'machine-b' }],
  });
  expect(state.rows.map((entry) => entry.key)).toEqual(['ext-row']);
});

it('says an empty browser-extensions section holds nothing yet and leads to the kind page, never an All over no rows', async () => {
  const { ManagedInventoryDirectory } = await import('./ManagedInventoryDirectory');
  const { ItemList } = await import('@/components/ui/lists/ItemList');
  // No answering Machine holds an extension yet; one Machine has not answered, so the family stays shown.
  const browserExtension = {
    rows: [],
    coverage: { partial: [{ machineId: 'machine-b', reason: { kind: 'action' as const, code: 'target_unavailable' } }] },
    continuation: () => {},
  };
  const inventory = {
    families: { app: empty, browserExtension, mcpServer: empty, skill: empty, agent: empty, provider: empty, plugin: empty, software: empty },
    operationalFamilies: { watchedService: empty, setup: empty, configuredCheck: empty },
    rows: [], coverage: 'partial', loading: false, attention: [], noticeSource: null,
  } as unknown as ManagedInventoryView; // Shape-only fixture, as above.
  const input = { scope, machine: null, projectKey: null };
  const screen = await renderScreen(
    <ManagedInventorySections inventory={inventory} input={input} groupBy="kind" openKey={null} onOpenChange={() => {}}>
      {(state) => (
        // The page list gives sections their page header, where a section's action sits.
        <ItemList>
          <ManagedInventoryDirectory state={state} input={input} groupBy="kind" columns={2} preview={4} testIDPrefix="installed" />
        </ItemList>
      )}
    </ManagedInventorySections>,
  );
  expect(screen.getTextContent()).toContain('Nothing yet.');
  expect(screen.findAllByTestId('installed.section.browserExtension.browse').length).toBeGreaterThan(0);
  expect(screen.findAllByTestId('installed.section.browserExtension.all')).toHaveLength(0);
});
