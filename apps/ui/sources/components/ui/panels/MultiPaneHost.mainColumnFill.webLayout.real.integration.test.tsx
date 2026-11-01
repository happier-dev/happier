// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

import type { ResolvedPaneLayout } from './paneBreakpoints';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const SESSION_SINGLE: ResolvedPaneLayout = {
  main: 'docked',
  kind: 'single',
  right: 'hidden',
  details: 'hidden',
};

/**
 * The pane host derives `mainDockWidthPx` from a host width it measures after paint, so right after a
 * window resize it still carries the previous window's number (live: 1060 px in a 390 px window for a
 * frame or more). The Session column must be laid out by its host, not by that number.
 */
async function measureSessionColumn(
  params: Readonly<{ hostWidthPx: number; mainDockWidthPx: number }>,
) {
  const { MultiPaneHost } = await import('./MultiPaneHost');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <View
        testID="host"
        style={{ width: params.hostWidthPx, height: 600, flexDirection: 'row' }}
      >
        <MultiPaneHost
          main={
            <View testID="session-content" style={{ flex: 1, minHeight: 0 }} />
          }
          rightPane={null}
          detailsPane={null}
          layout={SESSION_SINGLE}
          mainDockWidthPx={params.mainDockWidthPx}
          rightDockWidthPx={360}
          detailsDockWidthPx={520}
          onCloseRight={() => {}}
          onCloseDetails={() => {}}
          onCommitRightDockWidthPx={() => {}}
          onCommitDetailsDockWidthPx={() => {}}
        />
      </View>,
    );
  });
  return measureWebLayout(host, {
    viewport: { width: Math.max(params.hostWidthPx, 400), height: 700 },
  });
}

describe('the Session column, as a browser lays it out', () => {
  it('fills a phone-width host even while the measured dock width is still the desktop one', async () => {
    const layout = await measureSessionColumn({
      hostWidthPx: 390,
      mainDockWidthPx: 1060,
    });
    const hostRect = layout.rect('host');
    const content = layout.rect('session-content');
    expect(content.left).toBeCloseTo(hostRect.left, 0);
    expect(content.right).toBeCloseTo(hostRect.right, 0);
  });

  it('fills a desktop-width host while the measured dock width is still the phone one', async () => {
    const layout = await measureSessionColumn({
      hostWidthPx: 1060,
      mainDockWidthPx: 390,
    });
    const hostRect = layout.rect('host');
    const content = layout.rect('session-content');
    expect(content.right).toBeCloseTo(hostRect.right, 0);
  });
});
