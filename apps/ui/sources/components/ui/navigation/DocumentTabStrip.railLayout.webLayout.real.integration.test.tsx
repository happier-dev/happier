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

/** The phone's open-tabs rail as a browser lays it out, crowded with a person's synced tabs (NATIVE-SWEEP L7). */

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

const TAB_COUNT = 60;

// Resolve the strip's module graph during collection, not inside the test's own deadline.
const { DocumentTabStrip } = await import('./DocumentTabStrip');
const { createEntityDragDropRuntime } = await import('@/components/ui/treeDragDrop/entityDragDropRuntime');
const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');

it('keeps every tab of a crowded rail at its own width, with a 44 pt finger target that never overlaps its neighbour', async () => {
  const scope = { serverId: 'home', accountId: 'account' };
  const runtime = createEntityDragDropRuntime();
  const tabs = Array.from({ length: TAB_COUNT }, (_, index) => ({
    key: `t${index}`,
    title: `Session ${index}`,
    isPinned: index < 2,
    isPreview: false,
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <HappierUiPlatformProvider
        platform={{ platform: 'ios', colorScheme: 'light' }}
      >
        <View style={{ width: 390 }}>
          <DocumentTabStrip
            variant="rail"
            tabs={tabs}
            activeTabKey="t30"
            accessibilityLabel="Open tabs"
            onActivate={() => {}}
            onPin={() => {}}
            onUnpin={() => {}}
            onClose={() => {}}
            renderLeadingIcon={() => <View style={{ width: 14, height: 14 }} />}
            tabNativeId={(id) => `tab-${id}`}
            entityDragSource={{
              runtime,
              id: 'rail',
              scope,
              nativeDragAxis: 'vertical',
              getItem: (tabId) => ({ kind: 'workspace-tab', scope, tabId }),
            }}
            testIds={{
              tab: (id) => `tab-${id}`,
              tabClose: (id) => `close-${id}`,
            }}
          />
        </View>
      </HappierUiPlatformProvider>,
    ),
  );
  const layout = await measureWebLayout(host, {
    viewport: { width: 390, height: 300 },
    settle: (replay) => act(replay),
  });
  const frames = tabs.map((tab) =>
    layout.rect(`document-tab-frame-${tab.key}`),
  );
  // Every tab keeps a full finger target across, laid out after its neighbour (no shared slot).
  expect(frames.map((frame, index) => ({ index, width: Math.round(frame.width) })).filter(entry => entry.width < 44)).toEqual([]);
  expect(frames.slice(1).filter((frame, index) => frame.left < frames[index]!.right)).toEqual([]);
  // A pinned tab is its mark alone, but still a full finger target.
  expect(layout.rect('tab-t0').width).toBeGreaterThanOrEqual(44);
  // A titled tab shows its title rather than collapsing to its mark.
  expect(layout.rect('tab-t5').width).toBeGreaterThan(70);
});
