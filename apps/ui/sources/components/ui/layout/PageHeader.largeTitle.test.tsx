import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { NavigationTitleChromeProvider, PageHeader } from '@/components/ui/layout/PageHeader';
import { NavigationLargeTitleProvider } from '@/components/ui/layout/navigationTitleChrome';

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

const publisher = () => ({ setTitle: vi.fn(), setPageTitle: vi.fn(), setBack: vi.fn() });

it('under a bar, a large title names the page itself and never goes into the bar', async () => {
  const chrome = publisher();
  screen = await renderScreen(
    <NavigationTitleChromeProvider showsTitle publisher={chrome}>
      <NavigationLargeTitleProvider largeTitle>
        <PageHeader testID="header" title="Appearance" description="Theme and text" />
      </NavigationLargeTitleProvider>
    </NavigationTitleChromeProvider>,
  );

  expect(screen.getTextContent()).toContain('Appearance');
  expect(chrome.setTitle).toHaveBeenCalledWith(undefined);
  expect(chrome.setTitle).not.toHaveBeenCalledWith('Appearance');
  // The tab still knows the page's name.
  expect(chrome.setPageTitle).toHaveBeenCalledWith('Appearance');
});

it('without a large title the bar keeps the name and the page shows only its purpose', async () => {
  const chrome = publisher();
  screen = await renderScreen(
    <NavigationTitleChromeProvider showsTitle publisher={chrome}>
      <PageHeader testID="header" title="Appearance" description="Theme and text" />
    </NavigationTitleChromeProvider>,
  );

  expect(screen.getTextContent()).not.toContain('Appearance');
  expect(chrome.setTitle).toHaveBeenCalledWith('Appearance');
});
