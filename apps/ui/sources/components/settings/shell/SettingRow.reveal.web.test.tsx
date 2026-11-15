// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { View } from 'react-native';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { RowArrivalReveal } from './SettingRow';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
  });
});

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ params: () => ({}) }).module;
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  return createReanimatedModuleMock();
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

/**
 * The browser boundary: a page scroller of `visibleHeight` holding the revealed host of `hostHeight`.
 * Sizes are the ones measured live on a 390×844 phone (Environment Settings, Backups):
 * the page scroller shows 671 px under its header; the Backups section is 1318 px tall.
 */
function mountInScroller(hostHeight: number, visibleHeight: number) {
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  Object.defineProperty(scroller, 'clientHeight', { value: visibleHeight });
  Object.defineProperty(scroller, 'scrollHeight', { value: 4472 });
  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    right: 390,
    bottom: hostHeight,
    width: 390,
    height: hostHeight,
    x: 0,
    y: 0,
    toJSON: () => null,
  });
  const landings: string[] = [];
  host.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
    landings.push(
      typeof options === 'object' ? (options.block ?? 'start') : 'start',
    );
  };
  scroller.appendChild(host);
  document.body.appendChild(scroller);
  return { host, landings };
}

async function reveal(hostHeight: number, visibleHeight: number) {
  vi.useFakeTimers();
  const { host, landings } = mountInScroller(hostHeight, visibleHeight);
  await renderScreen(
    <RowArrivalReveal active testID="reveal">
      <View />
    </RowArrivalReveal>,
    {
      createNodeMock: () => host,
    },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  return landings;
}

describe('useSettingReveal on the web', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('lands a section taller than the visible page at its top, so its heading stays below the page header', async () => {
    expect(await reveal(1318, 671)).toEqual(['start']);
  });

  it('still centres a row that fits', async () => {
    expect(await reveal(64, 671)).toEqual(['center']);
  });
});
