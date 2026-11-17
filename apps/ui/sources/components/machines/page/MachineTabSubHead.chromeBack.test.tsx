// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const { MachineTabSubHead } = await import('./MachineTabSubHead');
const { NavigationTitleChromeProvider } =
  await import('@/components/ui/layout/navigationTitleChrome');

afterEach(() => standardCleanup());

async function crumbShown(
  chrome: Readonly<{ showsTitle: boolean; showsBack: boolean }>,
) {
  const screen = await renderScreen(
    <NavigationTitleChromeProvider
      showsTitle={chrome.showsTitle}
      showsBack={chrome.showsBack}
    >
      <MachineTabSubHead
        placement="page"
        underNativeChrome={chrome.showsTitle}
        title="Sharing"
        back={{
          label: 'devbox',
          onPress: () => {},
          testID: 'machine-sub-page-back-sharing',
        }}
      />
    </NavigationTitleChromeProvider>,
  );
  const found =
    screen.root.findAll(
      (node) => node.props?.testID === 'machine-sub-page-back-sharing',
    ).length > 0;
  await screen.unmount();
  return found;
}

it('leaves the way back to a phone bar that already draws one: one Back per page', async () => {
  expect(await crumbShown({ showsTitle: true, showsBack: true })).toBe(false);
});

it('keeps its crumb where nothing else leads back (wide layouts, a phone deep link without history)', async () => {
  expect(await crumbShown({ showsTitle: false, showsBack: false })).toBe(true);
  expect(await crumbShown({ showsTitle: true, showsBack: false })).toBe(true);
});

it('names a page it heads with a level-one heading, and stays a level-two heading under the machine header (C77)', async () => {
  // Computer control at 1440 (11-17): the page's only title read as level 2, so the page had no level-one heading.
  const screen = await renderScreen(
    <NavigationTitleChromeProvider showsTitle={false} showsBack={false}>
      <MachineTabSubHead placement="page" title="Computer control" back={null} />
      <MachineTabSubHead placement="tab" title="Worktrees" back={null} />
    </NavigationTitleChromeProvider>,
  );
  const levels = screen.root
    .findAll((node) => typeof node.type === 'string' && node.props?.accessibilityRole === 'header')
    .map((node) => [node.props.children, node.props['aria-level']]);
  expect(levels).toEqual([['Computer control', 1], ['Worktrees', 2]]);
  await screen.unmount();
});
