import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';

import { CockpitTabBarActionView } from './CockpitTabBar';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } =
    await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});

const visibleText = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
  screen
    .findAll(
      (node) =>
        typeof node.type === 'string' &&
        node.children.some((child) => typeof child === 'string'),
    )
    .flatMap((node) =>
      node.children.filter(
        (child): child is string => typeof child === 'string',
      ),
    );

describe('CockpitTabBarAction label', () => {
  // Owner 11-15 (MOBILE-FIX-1115 H1): folded into a page's own bar, More stands for the open item and reads the one
  // tab-labels setting like every tab: its name shows with labels on, its glyph alone with labels off.
  it('names the open item it stands for with labels on', async () => {
    const screen = await renderScreen(
      <CockpitTabBarActionView testID="more" label="Overview, 2 failing" visibleLabel="Overview" icon="info" selected
        metrics={resolveTabBarMetrics('regular', true)} onPress={() => {}} />,
    );
    expect(visibleText(screen)).toContain('Overview');
    expect(visibleText(screen)).not.toContain('Overview, 2 failing');
  });

  it('stays a glyph with labels off, even while it stands for the open item', async () => {
    const screen = await renderScreen(
      <CockpitTabBarActionView testID="more" label="Overview" icon="info" selected
        metrics={resolveTabBarMetrics('regular', false)} onPress={() => {}} />,
    );
    expect(visibleText(screen)).not.toContain('Overview');
  });
});

describe('CockpitTabBarAction semantics', () => {
  // C77 (DESIGN-ACCEPT-B F3): More opens a menu, so it is a menu button beside the bar's tablist, never a tab or a
  // toggle. Standing for the open item, it is announced as the current page rather than as a selected tab.
  it('is a menu button, not a toggle', async () => {
    const screen = await renderScreen(
      <CockpitTabBarActionView testID="more" label="More" icon="dots-three" expanded={false}
        metrics={resolveTabBarMetrics('regular', true)} onPress={() => {}} />,
    );
    const host = screen.findHostByTestId('more');
    expect(host?.props.role ?? host?.props.accessibilityRole).toBe('button');
    expect(host?.props['aria-haspopup']).toBe('menu');
    expect(host?.props['aria-pressed']).toBeUndefined();
    expect(host?.props['aria-current']).toBeUndefined();
  });

  it('stands for the open item as the current page', async () => {
    const screen = await renderScreen(
      <CockpitTabBarActionView testID="more" label="Overview" icon="info" selected expanded={false}
        metrics={resolveTabBarMetrics('regular', true)} onPress={() => {}} />,
    );
    const host = screen.findHostByTestId('more');
    expect(host?.props.role ?? host?.props.accessibilityRole).toBe('button');
    expect(host?.props['aria-current']).toBe('page');
  });
});
