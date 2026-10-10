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
    // Read as a size a person recognises, through the app's one byte formatter.
    expect(readOnly.getTextContent()).toContain('100 MB');
    expect(readOnly.getTextContent()).not.toContain('104857600');
  });
});
