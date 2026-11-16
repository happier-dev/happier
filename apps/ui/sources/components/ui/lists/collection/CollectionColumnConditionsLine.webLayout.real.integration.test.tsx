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

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

/**
 * SERVICES-ACCEPT-1116 F2: in a narrow column the title's control (Services' grouping switch) yields to the band
 * under the title and ends the strip's row. A condition token shared that row and was squeezed to 30 px, its words
 * gone. Conditions take a line of their own under the strip, so the control never narrows them.
 */
it('gives the conditions a line of their own under a strip that a yielded title control ends', async () => {
  const { CollectionList } = await import('./CollectionList');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <View style={{ width: 260, height: 400 }}>
        <CollectionList
          testID="column"
          title="All services"
          surface="plane"
          headerAction={
            <View testID="header-action" style={{ width: 30, height: 30 }} />
          }
          titleAccessory={
            <View testID="switch" style={{ width: 104, height: 28 }} />
          }
          strip={<View testID="strip" />}
          conditions={
            <View testID="conditions" style={{ flexDirection: 'row' }}>
              <View
                testID="token"
                style={{ width: 120, height: 28, flexShrink: 1 }}
              />
              <View
                testID="save"
                style={{ width: 96, height: 28, flexShrink: 1 }}
              />
            </View>
          }
        />
      </View>,
    ),
  );
  const layout = await measureWebLayout(host, {
    viewport: { width: 320, height: 480 },
    texts: ['All services'],
    settle: (replay) => act(replay),
  });
  const titleRow = layout.rect('header-action');
  const control = layout.rect('switch');
  const token = layout.rect('token');
  // The control yielded the title row (the title keeps its floor) …
  expect(control.top).toBeGreaterThanOrEqual(titleRow.bottom - 0.5);
  // … and the token stands under it at its own width, not beside it.
  expect(token.top).toBeGreaterThanOrEqual(control.bottom - 0.5);
  expect(token.width).toBe(120);
  expect(layout.rect('save').width).toBe(96);
});
