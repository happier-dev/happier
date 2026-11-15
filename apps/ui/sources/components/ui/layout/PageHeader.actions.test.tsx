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

// The menu draws a checked row's check; a header menu that passed its own glyph as well showed two.
it('leaves a checked header menu row\'s check to the menu', async () => {
  const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
  screen = await renderScreen(
    <PageHeaderMenu actions={[{ id: 'pause', title: 'Don\'t pause', checked: true, onSelect: () => {} }]} />,
  );
  const menu = screen.root.findAll((node) => Array.isArray(node.props.items) && typeof node.props.onSelect === 'function')[0]!;
  expect(menu.props.items).toEqual([expect.objectContaining({ id: 'pause', checked: true })]);
  expect(menu.props.items[0].rightElement).toBeUndefined();
});

// A phone recomposes the header (controls on a row below the name) without remounting the name's
// field, so its focus, caret and selection survive the breakpoint (owner 11-15 H2).
it('keeps the title editor mounted when the actions move between the title row and a row below', async () => {
  const header = (actionsLayout: 'inline' | 'wrap') => (
    <PageHeader
      testID="header"
      title="Release check"
      alwaysShowTitle
      actionsLayout={actionsLayout}
      titleEditor={{ value: 'Release check', onChangeText: () => {}, accessibilityLabel: 'Name', testID: 'name' }}
      actions={<RoundButton testID="run" title="Run now" />}
    />
  );
  screen = await renderScreen(header('inline'));
  const name = screen.findHostByTestId('name');
  expect(name).not.toBeNull();
  await screen.update(header('wrap'));
  expect(screen.findHostByTestId('name') === name).toBe(true);
  await screen.update(header('inline'));
  expect(screen.findHostByTestId('name') === name).toBe(true);
});
