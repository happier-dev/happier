import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

installUiListsCommonModuleMocks();
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

afterEach(standardCleanup);

const { TechnicalDetailsDisclosure } =
  await import('./TechnicalDetailsDisclosure');
const { ItemGroup } = await import('./ItemGroup');
const { ItemGroupRowPositionBoundary } = await import('./ItemGroupRowPosition');

const lines = [{ key: 'code', label: 'Error', value: 'outcome_unknown' }];

// UI refinements ruling 2026-11-24 08:57Z (DESIGN-ACCEPT-152 fix 16): one disclosure, its density from where it sits.
it('is the small inline toggle inside a card or row, with the values one press away', async () => {
  const screen = await renderScreen(
    <TechnicalDetailsDisclosure
      testID="details"
      title="Technical details"
      lines={lines}
    />,
  );
  expect(screen.findAllByTestId('details.header')).toHaveLength(0);
  expect(screen.getTextContent()).not.toContain('outcome_unknown');
  await screen.pressByTestIdAsync('details');
  expect(screen.getTextContent()).toContain('outcome_unknown');
});

it('is the full row as a page section, and inline again behind a card boundary inside that section', async () => {
  const page = await renderScreen(
    <ItemGroup title="Details">
      <TechnicalDetailsDisclosure
        testID="details"
        title="Technical details"
        lines={lines}
      />
    </ItemGroup>,
  );
  expect(page.findAllByTestId('details.header').length).toBeGreaterThan(0);
  await page.unmount();

  const card = await renderScreen(
    <ItemGroup title="Requests">
      <ItemGroupRowPositionBoundary>
        <TechnicalDetailsDisclosure
          testID="details"
          title="Technical details"
          lines={lines}
        />
      </ItemGroupRowPositionBoundary>
    </ItemGroup>,
  );
  expect(card.findAllByTestId('details.header')).toHaveLength(0);
});
