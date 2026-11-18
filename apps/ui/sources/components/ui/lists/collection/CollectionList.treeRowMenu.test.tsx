import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
afterEach(standardCleanup);

const { CollectionNavigationRow } = await import('./CollectionList');
const { CollectionRowMenu } = await import('./CollectionRowMenu');

function treeRow(key: string, webTabIndex: 0 | -1) {
  return (
    <CollectionNavigationRow
      key={key}
      testID={`row:${key}`}
      title={`Project ${key}`}
      onPress={() => {}}
      treeItem={{ webRole: 'treeitem', webTabIndex, accessibilityLevel: 1 }}
      rowMenu={
        <CollectionRowMenu testID={`row:${key}:menu`} renderMenu={() => null} />
      }
    />
  );
}

describe('a tree row and its ⋯ in the keyboard order (web)', () => {
  it("keeps only the roving row's ⋯ in the tab order, so Tab leaves the tree after one row", async () => {
    const screen = await renderScreen(
      <>
        {treeRow('a', 0)}
        {treeRow('b', -1)}
        {treeRow('c', -1)}
      </>,
    );
    const menuTabIndex = (key: string) =>
      screen.root.findAll(
        (node) =>
          node.props?.testID === `row:${key}:menu` && 'tabIndex' in node.props,
      )[0]?.props.tabIndex;
    // The roving row: Tab reaches its ⋯ after the row itself, then leaves the tree.
    expect(menuTabIndex('a')).not.toBe(-1);
    // Every other row's ⋯ stays out of the tab order; arrows reach those rows, and their ⋯ once they hold the stop.
    expect(menuTabIndex('b')).toBe(-1);
    expect(menuTabIndex('c')).toBe(-1);
  });
});
