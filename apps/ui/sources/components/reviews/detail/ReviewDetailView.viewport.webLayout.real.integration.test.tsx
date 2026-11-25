// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { View, ScrollView } from 'react-native';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { ReviewDetailView } from './ReviewDetailView';
import { useScmComparisonLayout } from '@/components/projects/scm/useScmComparisonLayout';
import { resolveScmChangeCompactRowHeight } from '@/components/workspaces/scm/changes/ScmChangeRow';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

installWebLayoutBridge();
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

it.each([390, 1440])('keeps a large Changes comparison inside the physical page viewport at %s px', async width => {
  let demand: number | null = null;
  function Comparison() {
    const layout = useScmComparisonLayout();
    demand = layout.visibleFileRowCount;
    return <View testID="comparison" style={{ flex: 1, minHeight: 0 }} onLayout={layout.onLayout}>
      <ScrollView style={{ flex: 1, minHeight: 0 }}><View style={{ height: 8_802_633 }} /></ScrollView>
    </View>;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  for (const height of [600, 360, 600]) {
    await act(async () => root!.render(<View style={{ width, height }}>
      <ReviewDetailView title="Large review" meta={[]} menu={[]} glance={null} rounds={[]} selectedRound={1}
        onSelectRound={() => {}} tabs={[{ id: 'changes' }]} activeTab="changes" onSelectTab={() => {}}>
        <Comparison />
      </ReviewDetailView>
    </View>));
    const layout = await measureWebLayout(host, { viewport: { width, height: 700 }, settle: replay => act(replay) });
    const page = layout.rect('review-detail');
    const comparison = layout.rect('comparison');
    expect(demand).toBe(Math.ceil(page.height / resolveScmChangeCompactRowHeight(false)));
    expect(comparison.height).toBeCloseTo(page.height, 0);
  }
});
