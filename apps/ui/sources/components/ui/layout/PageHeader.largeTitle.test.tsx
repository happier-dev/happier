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

it('the page title it draws is the page\'s level-one heading', async () => {
  const chrome = publisher();
  screen = await renderScreen(
    <NavigationTitleChromeProvider showsTitle publisher={chrome}>
      <NavigationLargeTitleProvider largeTitle>
        <PageHeader testID="header" title="Appearance" description="Theme and text" />
      </NavigationLargeTitleProvider>
    </NavigationTitleChromeProvider>,
  );

  const headings = screen.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'header');
  expect(headings.map(node => [node.props.children, node.props['aria-level']])).toEqual([['Appearance', 1]]);
});

it('a drawn title keeps its "·" separator with the word before it, so a wrapped line never starts with "·"', async () => {
  const chrome = publisher();
  screen = await renderScreen(
    <NavigationTitleChromeProvider showsTitle publisher={chrome}>
      <NavigationLargeTitleProvider largeTitle>
        <PageHeader testID="header" title="Set session title · Review the storefront guide" />
      </NavigationLargeTitleProvider>
    </NavigationTitleChromeProvider>,
  );

  expect(screen.getTextContent()).toContain('Set session title · Review the storefront guide');
  // The page's name for tabs and assistive technology stays the plain title.
  expect(chrome.setPageTitle).toHaveBeenCalledWith('Set session title · Review the storefront guide');
});

it('a held entity header under a large-title bar stands where its arriving header lands (same top, same title line)', async () => {
  const { PageHeaderPlaceholder } = await import('@/components/ui/layout/PageHeader');
  const { HappierPageHeader, happierPageTextMetrics } = await import('@happier-dev/plugin-ui/presentation');
  const { View } = await import('react-native');
  const mark = <View testID="mark" style={{ width: 44, height: 44 }} />;
  const headerProps = async (element: React.ReactElement) => {
    const rendered = await renderScreen(
      <NavigationTitleChromeProvider showsTitle publisher={publisher()}>
        <NavigationLargeTitleProvider largeTitle>{element}</NavigationLargeTitleProvider>
      </NavigationTitleChromeProvider>,
    );
    const props = rendered.findAllByType(HappierPageHeader)[0]!.props;
    await rendered.unmount();
    return props;
  };
  const arriving = await headerProps(<PageHeader testID="header" title="Northwind Field Survey" alwaysShowTitle leading={mark} />);
  const held = await headerProps(<PageHeaderPlaceholder testID="held" alwaysShowTitle leading={mark} />);
  // The top inset follows `largeTitle`: both headers must agree, or the identity rises when the Team answers.
  expect(held.largeTitle).toBe(arriving.largeTitle);
  // A marked title keeps the page title's size, so the held bar sits on a page-title line.
  expect(held.title.props.style.height).toBe(happierPageTextMetrics('pageTitle').lineHeight);
});
