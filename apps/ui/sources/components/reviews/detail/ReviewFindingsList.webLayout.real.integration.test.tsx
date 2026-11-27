// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { ReviewFindingsList, ReviewFindingsLoading, type ReviewFindingsListRow } from './ReviewFindingsList';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

installWebLayoutBridge();
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const ROWS: readonly ReviewFindingsListRow[] = [
  { rowId: 'a', title: 'Token refresh races the retry', severity: 'high', decision: 'undecided' },
  { rowId: 'b', title: 'Cache key ignores the locale', severity: 'medium', decision: 'accept' },
];

async function measure(element: React.ReactElement, width: number) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<View style={{ width }}><View testID="above" style={{ height: 40 }} />{element}</View>));
  return measureWebLayout(host, { viewport: { width, height: 900 }, settle: replay => act(replay) });
}

const list = (followsSection: boolean) => <ReviewFindingsList rows={ROWS} followsSection={followsSection}
  selection={{ selectedRowIds: new Set(), onToggle: () => {}, active: false, onStart: () => {} }}
  renderRow={rowId => <View testID={`row:${rowId}`} style={{ height: 48 }} />} />;

async function unmount() {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

it.each([390, 1440])('opens the filter line at the column gap under the tabs and one section gap after an overview (%s px)', async width => {
  for (const [followsSection, gap] of [[false, 0], [true, HAPPIER_PAGE_METRICS.sectionGapPx]] as const) {
    const loaded = await measure(list(followsSection), width);
    const loadedTop = loaded.rect('review-findings:filter-line').top - loaded.rect('above').bottom;
    expect(Math.round(loadedTop)).toBe(gap);
    await unmount();
    // The placeholder opens where the settled line will, so nothing moves when the findings arrive.
    const loading = await measure(<ReviewFindingsLoading followsSection={followsSection} />, width);
    expect(loading.rect('review-findings:filter-line').top - loading.rect('above').bottom).toBe(loadedTop);
    await unmount();
  }
});

it.each([390, 1440])('centres Select on the filter pills (%s px)', async width => {
  const layout = await measure(list(false), width);
  const pill = layout.rect('review-findings:filter:all');
  const select = layout.rect('review-findings:select-mode');
  expect(Math.abs((select.top + select.bottom) / 2 - (pill.top + pill.bottom) / 2)).toBeLessThanOrEqual(0.5);
});
