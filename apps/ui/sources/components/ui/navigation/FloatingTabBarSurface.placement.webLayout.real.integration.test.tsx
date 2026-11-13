// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

installWebLayoutBridge();
const { FloatingTabBarSurface } = await import('./FloatingTabBarSurface');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

/** The phone's bottom chrome: a bar of `pillWidth` and the "+" beside it, in a window `width` wide. */
async function measureBottomChrome(width: number, pillWidth: number) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      React.createElement(
        View,
        { style: { width, position: 'relative' } },
        React.createElement(
          FloatingTabBarSurface,
          {
            bottomInset: 0,
            testID: 'tab-bar-surface',
            trailingAccessory: React.createElement(View, {
              testID: 'plus',
              style: { flex: 1 },
            }),
            children: React.createElement(View, {
              testID: 'tabs',
              style: { width: pillWidth, height: 36 },
            }),
          },
        ),
      ),
    );
  });
  const layout = await measureWebLayout(host, {
    viewport: { width, height: 200 },
    settle: (replay) => act(replay),
  });
  return { pill: layout.rect('tab-bar-surface'), plus: layout.rect('plus') };
}

const GUTTER = 16;
const GAP = 8;

describe('the phone bottom chrome, as a browser lays it out (owner 2026-11-10)', () => {
  it('centres the pill on the screen by itself and pins the "+" to the right gutter', async () => {
    // A 200-wide bar fits centred: 195 ± 100 leaves more than the gap before the "+" at 324.
    const { pill, plus } = await measureBottomChrome(390, 200);
    expect(Math.abs((pill.left + pill.right) / 2 - 195)).toBeLessThanOrEqual(1);
    expect(Math.abs(plus.right - (390 - GUTTER))).toBeLessThanOrEqual(1);
    expect(plus.left - pill.right).toBeGreaterThanOrEqual(GAP - 0.5);
  });

  it.each([
    // Five 50-wide tabs at 390: centred they would touch the "+", so the bar shifts left a little.
    { width: 390, pillWidth: 258 },
    // At 340 the bar reaches the left gutter and narrows rather than run under the "+".
    { width: 340, pillWidth: 258 },
  ])('shifts a wide pill left so it stops before the "+", which stays on the right gutter ($width)', async ({ width, pillWidth }) => {
    const { pill, plus } = await measureBottomChrome(width, pillWidth);
    expect(Math.abs(plus.right - (width - GUTTER))).toBeLessThanOrEqual(1);
    expect(Math.abs(plus.left - pill.right - GAP)).toBeLessThanOrEqual(1);
    expect(pill.left).toBeGreaterThanOrEqual(GUTTER - 0.5);
  });
});
