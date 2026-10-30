import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeSettingEntryFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks();

afterEach(() => standardCleanup());

/** DR-15: the one registry renderer says a value in its unit and never offers a choice that is not one. */
describe('HomeSettingFieldRow', { timeout: 180_000 }, () => {
  it('leaves out an enum with a single allowed value: nothing can be chosen, so nothing is offered', async () => {
    const { HomeSettingFieldRow } = await import('./HomeSettingFieldRow');
    const entry = homeSettingEntryFixture(
      'HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY',
      {
        value: 'disabled',
        declaration: {
          type: 'enum',
          section: 'features',
          default: 'disabled',
          bounds: { values: ['disabled'] },
        },
      },
    );
    const screen = await renderScreen(
      <HomeSettingFieldRow
        testID="row"
        entry={entry}
        title="Encrypted custom pets"
        staged={undefined}
        readOnly={false}
        disabled={false}
        error={null}
        onStage={vi.fn()}
      />,
    );
    expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('row');
    await screen.update(
      <HomeSettingFieldRow
        testID="row"
        entry={homeSettingEntryFixture('HAPPIER_FILES_BACKEND', {
          value: 'local',
          declaration: {
            type: 'enum',
            section: 'server',
            group: 'storage',
            bounds: { values: ['local', 's3'] },
          },
        })}
        title="Storage backend"
        staged={undefined}
        readOnly={false}
        disabled={false}
        error={null}
        onStage={vi.fn()}
      />,
    );
    expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('row');
  });

  it('states a byte limit with its unit, editable and read-only alike', async () => {
    const { HomeSettingFieldRow } = await import('./HomeSettingFieldRow');
    const entry = homeSettingEntryFixture(
      'HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT',
      {
        value: 104857600,
        source: 'home',
        declaration: { type: 'int', section: 'features', bounds: { min: 0 } },
      },
    );
    const editable = await renderScreen(
      <HomeSettingFieldRow
        testID="row"
        entry={entry}
        title="Imported pet storage per person"
        staged={undefined}
        readOnly={false}
        disabled={false}
        error={null}
        onStage={vi.fn()}
      />,
    );
    expect(editable.getTextContent()).toContain('homeSettings.units.bytes');
    standardCleanup();
    const readOnly = await renderScreen(
      <HomeSettingFieldRow
        testID="row"
        entry={entry}
        title="Imported pet storage per person"
        staged={undefined}
        readOnly
        disabled={false}
        error={null}
        onStage={vi.fn()}
      />,
    );
    // Storage uses decimal units through the shared formatter (memory alone is binary).
    expect(readOnly.getTextContent()).toContain('105 MB');
    expect(readOnly.getTextContent()).not.toContain('104857600');
  });
  it('says a refused list entry under that entry only, not again on the first entry', async () => {
    const { HomeSettingFieldRow } = await import('./HomeSettingFieldRow');
    const { act } = await import('react-test-renderer');
    const entry = homeSettingEntryFixture('HAPPIER_IROH_RELAY_URLS', {
      value: ['https://relay-a.northwind.example'],
      source: 'home',
      declaration: { type: 'list', section: 'reach', bounds: { scheme: 'https' } },
    });
    const screen = await renderScreen(
      <HomeSettingFieldRow
        testID="row"
        entry={entry}
        title="Relay servers"
        staged={undefined}
        readOnly={false}
        disabled={false}
        error="The Home refused this list"
        onStage={vi.fn()}
        onCommit={vi.fn()}
      />,
    );
    await screen.pressByTestIdAsync('row.list.add');
    await act(async () => { screen.changeTextByTestId('row.list.item.1', 'relay-b.northwind.example'); });
    await act(async () => { screen.findByTestId('row.list.item.1')?.props.onBlur?.(); });
    expect(screen.findByTestId('row.list.item.1.error')).not.toBeNull();
    expect(screen.findByTestId('row.list.item.0.error')).toBeNull();
  });
});
