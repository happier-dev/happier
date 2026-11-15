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
// jsdom has no scrollBy; the real Legend runtime scrolls the rail with it (a platform gap, not app logic).
Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
  configurable: true,
  value(this: HTMLElement, options: ScrollToOptions) {
    this.scrollLeft += options.left ?? 0;
    this.scrollTop += options.top ?? 0;
    this.dispatchEvent(new Event('scroll'));
  },
});

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

async function renderRail(activeTabKey: string) {
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
            activeTabKey={activeTabKey}
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
  // The rail is virtualized: only the pills near its viewport are mounted (and measured).
  const mounted = tabs.flatMap((tab) => {
    const frame = layout.rects.get(`document-tab-frame-${tab.key}`)?.[0];
    return frame ? [{ key: tab.key, frame }] : [];
  });
  return { layout, mounted };
}

it('mounts a window of a crowded rail, each tab at its own width with a 44 pt finger target that never overlaps its neighbour', async () => {
  const { layout, mounted } = await renderRail('t1');
  expect(mounted.length).toBeGreaterThan(2);
  expect(mounted.length).toBeLessThan(TAB_COUNT / 2);
  const frames = mounted.map((entry) => entry.frame);
  // Every mounted tab keeps a full finger target across, laid out after its neighbour (no shared slot).
  expect(mounted.filter((entry) => Math.round(entry.frame.width) < 44).map((entry) => entry.key)).toEqual([]);
  expect(frames.slice(1).filter((frame, index) => frame.left < frames[index]!.right)).toEqual([]);
  // Pills sit inside the rail's finger-tall band, not above or below it.
  for (const frame of frames) expect(frame.height).toBeGreaterThanOrEqual(30);
  // A pinned tab is its mark alone, but still a full finger target.
  expect(layout.rect('tab-t0').width).toBeGreaterThanOrEqual(44);
  // A titled tab shows its title rather than collapsing to its mark.
  expect(layout.rect('tab-t2').width).toBeGreaterThan(70);
  // The pills are painted inside the rail's scroll clip, not clipped away by a collapsed scroller.
  expect(layout.rect('tab-t2').receivesPointer).toBe(true);
});

it('mounts and shows the open tab deep in a crowded rail', async () => {
  const { mounted } = await renderRail('t40');
  expect(mounted.length).toBeLessThan(TAB_COUNT / 2);
  // The rail scrolled its window to the open tab: it is mounted, and the start of the rail is not.
  // (The measuring page does not keep the list's scroll offset, so positions are content positions.)
  expect(mounted.map((entry) => entry.key)).toContain('t40');
  expect(mounted.map((entry) => entry.key)).not.toContain('t5');
});
