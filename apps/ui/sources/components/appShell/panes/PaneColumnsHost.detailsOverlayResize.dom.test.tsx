/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

// Real RNW hosts and real pane policy; only the viewport and native animation adapters are replaced.
const viewport = vi.hoisted(() => ({
  width: 1440,
  height: 900,
  scale: 1,
  fontScale: 1,
}));
vi.mock('react-native', async () => ({
  ...(await vi.importActual<typeof import('react-native-web')>(
    'react-native-web',
  )),
  useWindowDimensions: () => viewport,
  Dimensions: {
    get: () => viewport,
    addEventListener: () => ({ remove() {} }),
  },
}));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('react-native-reanimated', async () =>
  (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('react-native-gesture-handler', async () => ({
  ...(
    await import('@/dev/testkit/mocks/gestureHandler')
  ).createGestureHandlerMock(),
  ScrollView: (
    await vi.importActual<typeof import('react-native-web')>('react-native-web')
  ).ScrollView,
}));

await import('@/sync/syncEngine');
const { PaneColumnsHost } = await import('./PaneColumnsHost');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  viewport.width = 1440;
});

async function renderAt(width: number, panes: Readonly<{ right?: boolean }> = {}) {
  viewport.width = width;
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <PaneColumnsHost
        testID="columns"
        arrangement="session"
        destinationOwnsDetails
        main={<div data-testid="list" />}
        detailsPane={panes.right ? null : <div data-testid="detail" />}
        detailsOpen={!panes.right}
        rightPane={panes.right ? <div data-testid="side" /> : null}
        rightOpen={panes.right === true}
      />,
    ),
  );
  // jsdom has no layout engine. Deliver the RNW measured onLayout event; pane policy stays real.
  const measured = container.querySelector(
    '[data-testid="columns"]',
  ) as HTMLElement & {
    __reactLayoutHandler: (event: {
      nativeEvent: { layout: { width: number; height: number } };
    }) => void;
  };
  await act(async () =>
    measured.__reactLayoutHandler({
      nativeEvent: { layout: { width, height: viewport.height } },
    }),
  );
  return (id: string) => container.querySelector(`[data-testid="${id}"]`);
}

it('draws no resize handle on a phone details overlay, whose width the placement fixes to the window', async () => {
  const q = await renderAt(390);
  expect(q('multi-pane-details-overlay')).not.toBeNull();
  expect(q('multi-pane-details-overlay-resize-left')).toBeNull();
});

it('keeps the handle on a docked details pane beside its list', async () => {
  const q = await renderAt(1440);
  expect(q('multi-pane-details-docked')).not.toBeNull();
  expect(q('multi-pane-details-docked-resize-left')).not.toBeNull();
});

it('draws no resize handle on a phone side overlay either', async () => {
    const q = await renderAt(390, { right: true });
    expect(q('multi-pane-right-overlay')).not.toBeNull();
    expect(q('multi-pane-right-overlay-resize-left')).toBeNull();
});

it('keeps the handle on a desktop details overlay, which a drag back under its budget docks again', async () => {
    const q = await renderAt(900);
    expect(q('multi-pane-details-overlay')).not.toBeNull();
    expect(q('multi-pane-details-overlay-resize-left')).not.toBeNull();
});
