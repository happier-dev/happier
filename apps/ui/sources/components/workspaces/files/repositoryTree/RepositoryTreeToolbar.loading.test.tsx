/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const { RepositoryTreeToolbar } = await import('./RepositoryTreeToolbar');

function toolbar(
  props: Readonly<{
    refreshing: boolean;
    changedCount: number | null | 'none';
  }>,
) {
  return (
    <RepositoryTreeToolbar
      testIDPrefix="repository-tree"
      searchValue=""
      onSearchValueChange={() => {}}
      changedOnly={false}
      changedCount={props.changedCount}
      onChangedOnlyChange={() => {}}
      detailsMode={false}
      onDetailsModeChange={() => {}}
      onCollapseAll={null}
      onRefresh={() => {}}
      refreshing={props.refreshing}
    />
  );
}

/** The text a node and its descendants draw, in order. */
function drawnText(node: { children?: unknown[] } | null): string {
  if (!node) return '';
  return (node.children ?? [])
    .map((child) =>
      typeof child === 'string' ? child : drawnText(child as never),
    )
    .join('');
}

describe('RepositoryTreeToolbar first paint', () => {
  it('holds the Changed count slot before the count is known, so its arrival does not widen the segment', async () => {
    const screen = await renderScreen(
      toolbar({ refreshing: true, changedCount: null }),
    );
    const pending = drawnText(
      screen.findByTestId('repository-tree-show-changed') as never,
    );
    await screen.update(toolbar({ refreshing: false, changedCount: 4 }));
    const known = drawnText(
      screen.findByTestId('repository-tree-show-changed') as never,
    );
    // Same caption length: the count fills a slot that was already drawn (one digit wide).
    expect(known).toContain('4');
    expect(pending.length).toBe(known.length);
    await screen.unmount?.();
  });
});
