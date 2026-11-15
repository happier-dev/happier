import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({
      width: 1440,
      height: 900,
      scale: 2,
      fontScale: 1,
    }),
  }),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      pathname: '/boards',
    }).module,
);

import {
  CollectionList,
  CollectionListGroupLabel,
  CollectionNavigationRow,
  CollectionRows,
} from './CollectionList';

const noop = () => {};

function rows(selectedIndex: number | null, count: number) {
  return Array.from({ length: count }, (_, index) => (
    <CollectionNavigationRow
      key={index}
      testID={`row-${index}`}
      title={`Row ${index}`}
      selected={index === selectedIndex}
      onPress={noop}
    />
  ));
}

/** The rows under which the list draws its rule, by the row's testID. */
function ruledRows(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  count: number,
): number[] {
  const ruled: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = screen.tree.root.findAll(
      (node) => node.props?.testID === `row-${index}`,
    )[0];
    let frame = row?.parent ?? null;
    // The rule is drawn inside the row's own frame, as an overlay at its foot.
    for (let depth = 0; frame && depth < 6; depth += 1, frame = frame.parent) {
      if (
        frame.findAll((node) => node.props?.testID === 'happier-list-row-rule')
          .length > 0
      ) {
        const inOtherRow =
          frame.findAll(
            (node) =>
              typeof node.props?.testID === 'string' &&
              /^row-\d+$/.test(node.props.testID) &&
              node.props.testID !== `row-${index}`,
          ).length > 0;
        if (!inOtherRow) ruled.push(index);
        break;
      }
    }
  }
  return ruled;
}

describe("the rule between a column's rows (owner 2026-11-15: inset hairlines in every list and column)", () => {
  it('draws one under every row another row follows, never after the last', async () => {
    const screen = await renderScreen(
      <CollectionList title="Boards">
        <CollectionRows>{rows(null, 4)}</CollectionRows>
      </CollectionList>,
    );
    try {
      expect(ruledRows(screen, 4)).toEqual([0, 1, 2]);
    } finally {
      await screen.unmount();
    }
  });

  it('leaves out the lines on both sides of the selected row', async () => {
    const screen = await renderScreen(
      <CollectionList title="Boards">
        <CollectionRows>{rows(1, 4)}</CollectionRows>
      </CollectionList>,
    );
    try {
      expect(ruledRows(screen, 4)).toEqual([2]);
    } finally {
      await screen.unmount();
    }
  });

  it('orders a column\'s own rows between its group labels, with no rule above a label', async () => {
    const screen = await renderScreen(
      <CollectionList title="Store">
        {rows(null, 2)}
        <CollectionListGroupLabel title="Browse" />
        <CollectionNavigationRow testID="row-2" title="Row 2" selected={false} onPress={noop} />
        <CollectionNavigationRow testID="row-3" title="Row 3" selected={false} onPress={noop} />
      </CollectionList>,
    );
    try {
      expect(ruledRows(screen, 4)).toEqual([0, 2]);
    } finally {
      await screen.unmount();
    }
  });

  it('draws none for a row no list orders', async () => {
    const screen = await renderScreen(<CollectionNavigationRow testID="row-0" title="Row 0" selected={false} onPress={noop} />);
    try {
      expect(screen.tree.root.findAll((node) => node.props?.testID === 'happier-list-row-rule')).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});
