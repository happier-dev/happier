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
