import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

const initialLocalSettings = storage.getState().localSettings;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    useWindowDimensions: () => ({
      width: 390,
      height: 844,
      scale: 3,
      fontScale: 1,
    }),
    Dimensions: {
      get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
    },
  });
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

afterEach(() => {
  standardCleanup();
  storage.setState({ localSettings: initialLocalSettings });
});

async function titleLines(
  element: (
    PaneHeader: typeof import('./PaneHeader').PaneHeader,
  ) => React.ReactElement,
  uiFontScale: number,
) {
  await act(async () => {
    storage.setState((state) => ({
      localSettings: { ...state.localSettings, uiFontScale },
    }));
  });
  const { PaneHeader } = await import('./PaneHeader');
  const screen = await renderScreen(element(PaneHeader));
  const lines = screen.findByTestId('header.title')!.props.numberOfLines as
    | number
    | undefined;
  await screen.unmount();
  return lines;
}

const LONG_NAME =
  'Refactor the session handoff path normalisation across every platform';

/**
 * Owner round 2 item 4 (2026-11-16): an entity's name in a phone's large header wraps before it truncates, as a page
 * title does — never one clipped line, never unbounded — and holds as much of the name at 200% as at the default size.
 */
describe('PaneHeader large title lines', { timeout: 240_000 }, () => {
  it('takes the page title line rule on a phone; the band keeps its one line', async () => {
    const large = (PaneHeader: typeof import('./PaneHeader').PaneHeader) => (
      <PaneHeader
        testID="header"
        size="large"
        title={LONG_NAME}
        subtitle="MacBook Pro"
      />
    );
    const band = (PaneHeader: typeof import('./PaneHeader').PaneHeader) => (
      <PaneHeader testID="header" title={LONG_NAME} subtitle="MacBook Pro" />
    );

    expect(await titleLines(large, 1)).toBe(2);
    const atLarge = await titleLines(large, 2);
    expect(atLarge).toBeGreaterThan(2);
    expect(Number.isFinite(atLarge)).toBe(true);
    expect(await titleLines(band, 1)).toBe(1);
  });
});
