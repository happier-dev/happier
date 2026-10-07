// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { Button, defineUiSurface, Stack, Text } from '@happier-dev/plugin-ui';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TriageDetailChangeSummary, TriageDetailChecks, TriageDetailSpread, TriageDetailStory } from './detailStory.js';
import { TriageDetailPanelNavigationProvider, useTriageDetailPanelOpener } from './detailPanelNavigation.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW_MS = 1_760_000_000_000;
const HOUR_MS = 3_600_000;
const mounted: PluginUiTestkit[] = [];

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mount(Body: () => React.ReactElement): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'story-fixture', mountNonce: 'story-mount' },
      authorPlugin: { id: 'happier.example.source', version: '0.0.0' },
      surface: defineUiSurface(() => <Body />),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: null,
    });
  });
  mounted.push(fixture);
  return fixture;
}

describe('the shared detail story for an error group', () => {
  it('titles ① "What happened" and shows the spread as the step after it', async () => {
    const page = await mount(() => (
      <TriageDetailStory kind="error" changes={(
        <TriageDetailSpread locale="en" nowMs={NOW_MS}
          tiles={[
            { id: 'events', label: 'Events', value: '1.2K' },
            { id: 'users', label: 'Users affected', value: '318' },
            { id: 'release', label: 'First seen in', value: '4.12.0' },
          ]}
          trend={{
            label: 'Events per hour',
            windowLabel: 'Last 24 hours',
            points: [3, 9, 44].map((count, index) => ({ atMs: NOW_MS - (2 - index) * HOUR_MS, count })),
          }} />
      )}>
        <Text value="TypeError: undefined" />
      </TriageDetailStory>
    ));

    await expect(page.getByRole('heading', { name: 'What happened' })).resolves.toBeDefined();
    await expect(page.queryByRole('heading', { name: 'The report' })).resolves.toBeUndefined();
    await expect(page.getByRole('heading', { name: 'Spread' })).resolves.toBeDefined();
    // Each tile shows its value and says what the value counts.
    for (const [value, label] of [['1.2K', 'Events'], ['318', 'Users affected'], ['4.12.0', 'First seen in']]) {
      await expect(page.getByText(value!)).resolves.toBeDefined();
      await expect(page.getByText(label!)).resolves.toBeDefined();
    }
    await expect(page.getByText('Last 24 hours')).resolves.toBeDefined();
    // The trend is one image whose label names every point, so its data is never shape-only.
    const chart = document.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '';
    expect(chart).toContain('Events per hour');
    expect(chart).toContain('44');
  });

  it('draws no spread at all when the source stated none of its facts', async () => {
    const page = await mount(() => (
      <TriageDetailStory kind="error" changes={<TriageDetailSpread locale="en" nowMs={NOW_MS} tiles={[]} trend={null} />}>
        <Text value="body" />
      </TriageDetailStory>
    ));
    await expect(page.queryByRole('heading', { name: 'Spread' })).resolves.toBeUndefined();
  });
});

describe('the shared story of a change request', () => {
  const file = (path: string, additions: number, deletions: number) => ({ path, lines: { additions, deletions } });

  it('states the whole-change totals, draws the largest files with their lines, and counts the rest', async () => {
    const page = await mount(() => (
      <TriageDetailStory kind="ask" changes={(
        <TriageDetailChangeSummary more={false} totals={{ files: 17, additions: 388, deletions: 142 }}
          rows={[file('src/cart/totals.ts', 96, 71), file('README.md', 1, 0), file('services/pricing/round.ts', 88, 0),
            file('src/cart/CartSummary.tsx', 40, 38), file('e2e/checkout/totals.spec.ts', 52, 6)]} />
      )}>
        <Text value="Cart totals were rounded on the client." />
      </TriageDetailStory>
    ));

    await expect(page.getByRole('heading', { name: 'What changed' })).resolves.toBeDefined();
    await expect(page.getByText('+388')).resolves.toBeDefined();
    await expect(page.getByText('−142')).resolves.toBeDefined();
    await expect(page.getByText('in 17 files')).resolves.toBeDefined();
    // Each drawn file is one bar named by its lines; the smallest read file is not drawn.
    const bars = [...document.querySelectorAll('[role="img"]')].map((node) => node.getAttribute('aria-label'));
    expect(bars).toEqual([
      'src/cart/totals.ts: 96 added, 71 removed',
      'services/pricing/round.ts: 88 added, 0 removed',
      'src/cart/CartSummary.tsx: 40 added, 38 removed',
      'e2e/checkout/totals.spec.ts: 52 added, 6 removed',
    ]);
    await expect(page.queryByText('README.md')).resolves.toBeUndefined();
    await expect(page.getByText('13 smaller files')).resolves.toBeDefined();
  });

  it('says a provider reports no line counts rather than drawing invented numbers', async () => {
    const page = await mount(() => (
      <TriageDetailChangeSummary more rows={[{ path: 'src/a.ts', note: 'edit' }, { path: 'src/b.ts', note: 'add' }]} />
    ));
    await expect(page.getByText('2+ files')).resolves.toBeDefined();
    await expect(page.getByText('Line counts not reported')).resolves.toBeDefined();
    await expect(page.getByText('src/a.ts')).resolves.toBeDefined();
    await expect(page.getByText('edit')).resolves.toBeDefined();
    expect(document.querySelector('[role="img"]')).toBeNull();
  });

  it('summarizes the checks the way the source counted them and lists what failed', async () => {
    const page = await mount(() => (
      <Stack gap="large">
        <TriageDetailChecks title="Checks" titleKey="checks" rollup={{ failingCount: 2, runningCount: 1, passingCount: 11 }}
          failing={[{ id: 'webkit', name: 'e2e / webkit', detail: 'failure' }, { id: 'lint', name: 'lint' }]} />
        <TriageDetailChecks title="Builds" titleKey="builds" rollup={{ failingCount: 0, runningCount: 2, passingCount: 3 }} />
        <TriageDetailChecks title="Pipelines" titleKey="pipelines" latestCommit rollup={{ failingCount: 0, runningCount: 0, passingCount: 6 }} />
        <TriageDetailChecks title="Policies" titleKey="policies" rollup={{ failingCount: 0, runningCount: 0, passingCount: 4 }} />
      </Stack>
    ));
    // The failing count leads in the danger tone; the rest of the line is quiet.
    await expect(page.getByText('2 failing')).resolves.toBeDefined();
    await expect(page.getByText('· 11 passed · 1 running')).resolves.toBeDefined();
    const lead = [...document.querySelectorAll('div,span')].find((node) => node.childElementCount === 0 && node.textContent === '2 failing');
    const rest = [...document.querySelectorAll('div,span')].find((node) => node.childElementCount === 0 && node.textContent === '· 11 passed · 1 running');
    expect(getComputedStyle(lead!).color).not.toBe(getComputedStyle(rest!).color);
    await expect(page.getByText('e2e / webkit')).resolves.toBeDefined();
    await expect(page.getByText('lint')).resolves.toBeDefined();
    await expect(page.getByText('2 running · 3 passed')).resolves.toBeDefined();
    await expect(page.getByText('All 6 passed on the latest commit')).resolves.toBeDefined();
    // Only a source whose counts are the latest commit's may say so.
    await expect(page.getByText('All 4 passed')).resolves.toBeDefined();
  });

  it('says one file and one check in the singular', async () => {
    const page = await mount(() => (
      <Stack gap="large">
        <TriageDetailChangeSummary more={false} rows={[file('a.ts', 3, 1)]} />
        <TriageDetailChangeSummary more={false} totals={{ files: 2 }} rows={[{ path: 'b.ts', note: 'edit' }]} />
        <TriageDetailChecks title="Builds" titleKey="builds" rollup={{ failingCount: 1, runningCount: 0, passingCount: 1 }} />
        <TriageDetailChecks title="Pipelines" titleKey="pipelines" rollup={{ failingCount: 0, runningCount: 0, passingCount: 1 }} />
      </Stack>
    ));
    await expect(page.getByText('in 1 file')).resolves.toBeDefined();
    await expect(page.getByText('2 files')).resolves.toBeDefined();
    await expect(page.getByText('1 more file')).resolves.toBeDefined();
    await expect(page.getByText('1 failing')).resolves.toBeDefined();
    await expect(page.getByText('· 1 passed')).resolves.toBeDefined();
    await expect(page.getByText('1 passed')).resolves.toBeDefined();
  });

  it('keeps the failures read when the source could not read every check, and says the count is incomplete', async () => {
    const page = await mount(() => (
      <Stack gap="large">
        <TriageDetailChecks title="Checks" titleKey="checks" rollup={{ incomplete: true, failingCount: 2, runningCount: 1 }}
          failing={[{ id: 'webkit', name: 'e2e / webkit' }, { id: 'lint', name: 'lint' }]} />
        <TriageDetailChecks title="Builds" titleKey="builds" rollup={{ incomplete: true, failingCount: 0, runningCount: 3 }} />
        <TriageDetailChecks title="Pipelines" titleKey="pipelines" rollup={{ incomplete: true, failingCount: 0, runningCount: 0, passingCount: 9 }} />
      </Stack>
    ));
    await expect(page.getByText('2 failing so far')).resolves.toBeDefined();
    await expect(page.getByText('· more checks not read')).resolves.toBeDefined();
    await expect(page.getByText('e2e / webkit')).resolves.toBeDefined();
    await expect(page.getByText('3 running so far · more checks not read')).resolves.toBeDefined();
    // Passing checks read so far are never a verdict about the checks nobody read.
    await expect(page.queryByRole('heading', { name: 'Pipelines' })).resolves.toBeUndefined();
  });
});

describe('opening a sibling panel through the detail frame', () => {
  function OpenStack(): React.ReactElement {
    const open = useTriageDetailPanelOpener('stack-trace');
    return open === undefined ? <Text value="no opener" /> : <Button title="Stack trace" onPress={open} />;
  }

  it('offers nothing without a frame', async () => {
    const page = await mount(() => <OpenStack />);
    await expect(page.getByText('no opener')).resolves.toBeDefined();
  });

  it('offers nothing when the frame has no such panel', async () => {
    const select = vi.fn();
    const page = await mount(() => (
      <TriageDetailPanelNavigationProvider navigation={{ panels: ['overview', 'activity'], select }}>
        <OpenStack />
      </TriageDetailPanelNavigationProvider>
    ));
    await expect(page.getByText('no opener')).resolves.toBeDefined();
    expect(select).not.toHaveBeenCalled();
  });

  it('asks the frame to select the panel it offers', async () => {
    const select = vi.fn();
    const page = await mount(() => (
      <TriageDetailPanelNavigationProvider navigation={{ panels: ['overview', 'stack-trace'], select }}>
        <OpenStack />
      </TriageDetailPanelNavigationProvider>
    ));
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Stack trace' })); });
    expect(select).toHaveBeenCalledWith('stack-trace');
  });
});
