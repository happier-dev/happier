// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const LONG_TITLE = 'mqa2-c14-cloud-review-checkout-with-a-long-name';

/**
 * A column row's ⋯ on a pointer screen (owner 11-15 A6, Projects column): quiet at rest and taking no width, so the
 * name runs to the row's end as far as a row without a menu does; it stands over the row's end when engaged.
 */
it('keeps no trailing slot for a column row menu at rest on a pointer screen', async () => {
  const { CollectionNavigationRow } = await import('./CollectionList');
  const { CollectionRowMenu } = await import('./CollectionRowMenu');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <View testID="column" style={{ width: 280 }}>
        <CollectionNavigationRow
          testID="with-menu"
          title={LONG_TITLE}
          selected={false}
          onPress={() => {}}
          rowMenu={
            <CollectionRowMenu testID="row-menu" renderMenu={() => null} />
          }
        />
        <CollectionNavigationRow
          testID="without-menu"
          title={LONG_TITLE}
          selected={false}
          onPress={() => {}}
        />
      </View>,
    ),
  );
  const layout = await measureWebLayout(host, {
    viewport: { width: 400, height: 400 },
    texts: [LONG_TITLE],
    settle: (replay) => act(replay),
  });
  const [withMenu, withoutMenu] = layout.textRects(LONG_TITLE);
  // The name ends where a menu-less row's does (the split row keeps only its end section's own gap).
  expect(withoutMenu!.right - withMenu!.right).toBeLessThanOrEqual(10);
  // The ⋯ is there, inside the row, over its end rather than past it.
  const menu = layout.rect('row-menu');
  const column = layout.rect('column');
  expect(menu.right).toBeLessThanOrEqual(column.right + 0.5);
  expect(menu.left).toBeLessThan(withMenu!.right + 10);
});
