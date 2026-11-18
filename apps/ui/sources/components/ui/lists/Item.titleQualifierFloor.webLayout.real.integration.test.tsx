// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

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
vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  const native = await import('react-native');
  const mock = createReanimatedModuleMock();
  const Animated = {
    ...mock.default,
    View: native.View,
    ScrollView: native.ScrollView,
    Text: native.Text,
  };
  return { ...mock, ...Animated, default: Animated };
});

installWebLayoutBridge();
const { Item } = await import('./Item');

const TITLE = 'sweep-a1-preview148-starter-app';
const QUALIFIER = 'NLDW3-5-36-33 · eadc';

// LABPARITY-ACCEPT-B fix 1: in a narrow column the qualifier kept half the line and the name read "sweep-a1…".
// The name keeps its width up to the title floor before its qualifier ellipsizes (owner choice "floor", 11-18).
it('keeps a qualified title at the title floor before its qualifier ellipsizes', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <View style={{ width: 240 }}>
          <Item
            testID="row"
            title={TITLE}
            titleQualifier={QUALIFIER}
            density="compact"
            showChevron={false}
            onPress={() => {}}
          />
        </View>,
      ),
    );
    const layout = await measureWebLayout(host, {
      viewport: { width: 400, height: 200 },
      texts: [TITLE, QUALIFIER],
      settle: (replay) => act(replay),
    });
    const title = layout.textRects(TITLE)[0]!;
    expect(title.width).toBeGreaterThanOrEqual(119);
    // The qualifier still shows what it can beside the name rather than vanishing.
    expect(layout.textRects(QUALIFIER)[0]!.width).toBeGreaterThan(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
