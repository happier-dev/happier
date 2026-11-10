import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { NavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';

// The device's safe area is a platform boundary: a phone with a 62 pt status-bar inset.
vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
  useChromeSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));

import { CollectionList } from './CollectionList';

const StubBack: NavigationBackControl = (
  props: Readonly<{ style: StyleProp<ViewStyle> }>,
) => <View testID="stub-back" style={props.style} />;

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === 'object'
    ? (style as Record<string, unknown>)
    : {};
}

/** The top edge of the Back: the sum of its ancestors' top padding, up to the list's root. */
function topPaddingAbove(
  node: { parent: unknown; props: { style?: unknown } } | null,
): number {
  let total = 0;
  for (
    let current = node;
    current;
    current = current.parent as typeof current
  ) {
    const padding = flatten(current.props?.style).paddingTop;
    if (typeof padding === 'number') total += padding;
  }
  return total;
}

describe('a collection list that is the whole phone page', () => {
  it('stands its Back under the status bar, not inside it', async () => {
    const screen = await renderScreen(
      <CollectionList title="All discussions" pageBack={StubBack} />,
    );
    try {
      const back = screen.tree.root.findByProps({ testID: 'stub-back' });
      expect(topPaddingAbove(back as never)).toBeGreaterThanOrEqual(62);
    } finally {
      await screen.unmount();
    }
  });

  it('adds no inset where the list is not the page (no Back of its own)', async () => {
    const screen = await renderScreen(
      <CollectionList title="All discussions" pageBack={null} />,
    );
    try {
      expect(
        screen.tree.root.findAll(
          (node) => flatten(node.props?.style).paddingTop === 62,
        ),
      ).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});
