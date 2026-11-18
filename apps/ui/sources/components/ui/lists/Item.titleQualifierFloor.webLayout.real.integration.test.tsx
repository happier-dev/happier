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

// LABPARITY-ACCEPT-D-1118: a folded Project read "SWEEP-A1 D…" beside its quiet end fact. A passive end (facts that
// only draw) gives way first: the name keeps the title floor, then the fact ellipsizes (UI refinements 14:58Z).
it('keeps a title at the title floor before a quiet end fact ellipsizes', async () => {
    const { Text } = await import('react-native');
    const name = 'SWEEP-A1 DJ28 private registry preview';
    const fact = 'NLDW3-5-36-33 · eadc · 2 environments';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(
            <View style={{ width: 272 }}>
                <Item testID="row" title={name} density="compact" showChevron={false} onPress={() => {}}
                    rightElementPassive rightElement={<Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}>{fact}</Text>} />
            </View>,
        ));
        const layout = await measureWebLayout(host, {
            viewport: { width: 400, height: 200 }, texts: [name, fact], settle: (replay) => act(replay),
        });
        expect(layout.textRects(name)[0]!.width).toBeGreaterThanOrEqual(119);
        expect(layout.textRects(fact)[0]!.width).toBeGreaterThan(0);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

// The Projects tree's rows are split: the press target and the end facts share the line as siblings
// (`rightElementOutsidePressable`). The floor holds there too, and the end fact never draws over the name.
it('keeps the floor in a split row, the end fact starting after the name', async () => {
    const { Text } = await import('react-native');
    const name = 'sweep-a1-1113-starter-registry';
    const fact = 'Running, not verified';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(
            <View style={{ width: 272 }}>
                <Item testID="row" title={name} density="compact" showChevron={false} onPress={() => {}}
                    rightElementPassive rightElementOutsidePressable
                    rightElement={<Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}>{fact}</Text>} />
            </View>,
        ));
        const layout = await measureWebLayout(host, {
            viewport: { width: 400, height: 200 }, texts: [name, fact], settle: (replay) => act(replay),
        });
        const title = layout.textRects(name)[0]!;
        const end = layout.textRects(fact)[0]!;
        expect(title.width).toBeGreaterThanOrEqual(119);
        expect(end.left).toBeGreaterThanOrEqual(title.right);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
