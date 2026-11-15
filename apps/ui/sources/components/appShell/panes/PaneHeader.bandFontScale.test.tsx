import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

const initialLocalSettings = storage.getState().localSettings;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }),
    Dimensions: { get: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }) },
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

async function renderBand(uiFontScale: number) {
  await act(async () => {
    storage.setState(state => ({ localSettings: { ...state.localSettings, uiFontScale } }));
  });
  const { PaneHeader } = await import('./PaneHeader');
  const screen = await renderScreen(
    <PaneHeader testID="header" title="Files" subtitle="MacBook Pro" />,
  );
  const band = flattenTestStyle(screen.findByTestId('header')!.props.style);
  const facts = flattenTestStyle(screen.findByTestId('header.subtitle')!.props.style);
  await screen.unmount();
  return { band, facts };
}

describe('PaneHeader band at the in-app text size', { timeout: 240_000 }, () => {
  it('keeps the platform band at the default size and grows it to hold the title and its line at a larger size', async () => {
    const { HAPPIER_PAGE_METRICS } = await import('@happier-dev/plugin-ui/presentation');
    const { HEADER_BAND_TITLE_TEXT } = await import('@/components/ui/layout/headerBand');
    const atDefault = await renderBand(1);
    expect(atDefault.band.height).toBe(HAPPIER_PAGE_METRICS.paneHeaderHeightPx);

    // Files at 200% (QA-LAYOUT V3): the machine line overlapped the availability notice beneath the band.
    const atLarge = await renderBand(2);
    const wordsPx = HEADER_BAND_TITLE_TEXT.lineHeight * 2
      + (atLarge.facts.height as number) + (atLarge.facts.marginTop as number);
    expect(atLarge.band.height as number).toBeGreaterThanOrEqual(wordsPx);
  });
});
