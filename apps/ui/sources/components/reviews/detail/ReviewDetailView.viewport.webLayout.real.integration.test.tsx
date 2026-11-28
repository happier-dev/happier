// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { View, ScrollView } from 'react-native';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { ReviewDetailView } from './ReviewDetailView';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/navigationTitleChrome';
import { useScmComparisonLayout } from '@/components/projects/scm/useScmComparisonLayout';
import { resolveScmChangeCompactRowHeight } from '@/components/workspaces/scm/changes/ScmChangeRow';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const navigation = vi.hoisted(() => ({ setOptions: vi.fn() }));
vi.mock('@/components/appShell/workspace/destinationInstanceContext', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/appShell/workspace/destinationInstanceContext')>(),
  useDestinationRouteNavigation: () => navigation,
}));

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

it('holds the warm phone header and body in place when the review read supplies Submit', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const viewport = { width: 390, height: 844 };
  const action = { title: 'Submit review', testID: 'submit-review', onPress: vi.fn() };
  function PhoneShell({ pending }: { pending: boolean }) {
    const [right, setRight] = React.useState<React.ReactNode>(null);
    React.useLayoutEffect(() => {
      navigation.setOptions.mockImplementation((options: { headerRight?: () => React.ReactNode }) => {
        setRight(options.headerRight?.() ?? null);
      });
      return () => { navigation.setOptions.mockReset(); };
    }, []);
    return (
      <NavigationTitleChromeProvider showsTitle>
        <View style={viewport}>
          <View style={{ width: 60, alignSelf: 'flex-end' }}>{right}</View>
          <ReviewDetailView title="Private access and invoice totals" meta={[{ key: 'round', text: 'Round 1' }]}
            menu={[]} glance={null} detailPending={pending} primaryAction={pending ? null : action}
            rounds={[]} selectedRound={1} onSelectRound={() => {}} tabs={[{ id: 'findings' }]}
            activeTab="findings" onSelectTab={() => {}}>
            <View />
          </ReviewDetailView>
        </View>
      </NavigationTitleChromeProvider>
    );
  }
  const render = (pending: boolean) => act(async () => root!.render(<PhoneShell pending={pending} />));
  const measure = () => measureWebLayout(host!, { viewport, settle: replay => act(replay) });
  await render(true);
  expect(host.querySelector('[data-testid="submit-review"]')).toBeNull();
  const held = (await measure()).rect('review-detail:header');
  await render(false);
  const settled = await measure();
  expect(host.querySelector('[data-testid="review-detail:header"] [data-testid="submit-review"]')).not.toBeNull();
  expect(settled.rect('review-detail:header').height).toBe(held.height);
  expect(settled.rect('review-detail:header').bottom).toBe(held.bottom);
});
