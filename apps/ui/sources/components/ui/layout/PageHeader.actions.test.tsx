import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { renderScreen } from '@/dev/testkit';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';

vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('@react-navigation/native', async () =>
  (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
);

type Screen = Awaited<ReturnType<typeof renderScreen>>;
let screen: Screen | null = null;

afterEach(async () => {
  await screen?.unmount();
  screen = null;
});

function drawnHeights(button: NonNullable<ReturnType<Screen['findByTestId']>>): number[] {
  return button
    .findAll((node) => typeof node.type === 'string')
    .map((node) => StyleSheet.flatten(node.props.style)?.minHeight)
    .filter((height): height is number => typeof height === 'number');
}

// A chip and a field beside it are the page control's height, so a button that takes its size from the
// header stands level with them, whatever its fill: the header decides, no page does.
it('draws every button in a page header at the page control height', async () => {
  screen = await renderScreen(
    <PageHeader
      testID="header"
      title="Artifacts"
      alwaysShowTitle
      actions={(
        <>
          <RoundButton testID="primary" title="New document" />
          <RoundButton testID="secondary" display="secondary" title="Invite people" />
        </>
      )}
    />,
  );

  expect(drawnHeights(screen.findByTestId('primary')!)).toContain(HAPPIER_PAGE_METRICS.controlHeightPx);
  expect(drawnHeights(screen.findByTestId('secondary')!)).toContain(HAPPIER_PAGE_METRICS.controlHeightPx);
});

it('draws the page\'s declared primary action at the same height', async () => {
  screen = await renderScreen(
    <PageHeader
      testID="header"
      title="Artifacts"
      alwaysShowTitle
      primaryAction={{ title: 'New document', onPress: () => {}, testID: 'declared-primary' }}
    />,
  );

  expect(drawnHeights(screen.findByTestId('declared-primary')!)).toContain(HAPPIER_PAGE_METRICS.controlHeightPx);
});
