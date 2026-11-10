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
  // QA-F-LISTS READY172 (390): folded into a detail's pinned footer, More stands for the open tab but showed only its
  // glyph with labels off, while the bar's own selected detail tab names itself.
  const metrics = resolveTabBarMetrics('regular', false);

  it('names the open item it stands for when the bar names its selected tab, with labels off', async () => {
    const screen = await renderScreen(
      <CockpitTabBarActionView
        testID="more"
        label="Overview"
        icon="info"
        selected
        namesItselfWhenSelected
        metrics={metrics}
        onPress={() => {}}
      />,
    );
    expect(visibleText(screen)).toContain('Overview');
  });

  it('stays a glyph while it is only More', async () => {
    const screen = await renderScreen(
      <CockpitTabBarActionView
        testID="more"
        label="More"
        icon="dots-three"
        namesItselfWhenSelected
        metrics={metrics}
        onPress={() => {}}
      />,
    );
    expect(visibleText(screen)).not.toContain('More');
  });
});
