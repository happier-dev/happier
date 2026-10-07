import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { Chart, DataTable, Metric } from '../../components/Data.js';
import { WidgetPresentationProvider } from '../../components/WidgetPresentation.js';
import { PluginUiProvider } from '../../components/PluginUiProvider.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { HappierDataChart } from './Chart.js';
import { HappierDataRows } from './DataRows.js';

const query = (root: HTMLElement, testID: string) => root.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

function layout(element: Element | null, width: number) {
  const handler = (element as unknown as { __reactLayoutHandler: (event: HappierLayoutChangeEvent) => void }).__reactLayoutHandler;
  act(() => handler({ nativeEvent: { layout: { x: 0, y: 0, width, height: 120 } } }));
}

describe('public data nodes through React Native Web', () => {
  it('recomposes the same chart for compact and tall measured widget viewports without dropping or hiding points', async () => {
    const context = createSurfaceContext();
    const points = [{ x: 'Mon', y: 214 }, { x: 'Tue', y: 236 }, { x: 'Wed', y: 183 }];
    const render = (height: number, rowSpan: number) => <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <WidgetPresentationProvider value={{ size: rowSpan === 1 ? 'small' : 'tall',
        footprint: { columns: 2, columnSpan: 1, rowSpan, height: rowSpan === 1 ? 'compact' : 'tall', width: 'half' },
        geometry: { width: 350, height } }}>
        <Chart testID="sized-chart" label="Signups" style="bar" points={points} />
      </WidgetPresentationProvider>
    </PluginUiProvider>;
    const mount = mountThroughReactNativeWeb(render(96, 1));
    try {
      const chart = query(mount.container, 'sized-chart')!;
      const bar = query(mount.container, 'sized-chart-bar-1')!.firstElementChild as HTMLElement;
      const compactHeight = Number.parseFloat(bar.style.height);
      await mount.render(render(384, 4));
      expect(Number.parseFloat(bar.style.height)).toBeGreaterThan(compactHeight);
      expect(query(mount.container, 'sized-chart')).toBe(chart);
      expect(mount.container.querySelectorAll('[data-testid^="sized-chart-bar-"]')).toHaveLength(3);
      expect(chart.getAttribute('aria-label')).toBe('Signups: Mon 214, Tue 236, Wed 183');
    } finally { mount.unmount(); }
  });
  it('shows the status mark and announces its label for every CI row', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(<HappierDataRows testID="checks" theme={context.theme}
      columns={[{ label: 'Check' }]} rows={[[ 'Unit' ], [ 'Build' ]]}
      marks={[{ passed: true, label: 'Passed', meaning: 'good' }, { passed: false, label: 'Failed', meaning: 'bad' }]} />);
    try {
      expect(query(mount.container, 'checks-mark-0')!.textContent).toContain('✓');
      expect(query(mount.container, 'checks-mark-1')!.textContent).toContain('✗');
      expect(query(mount.container, 'checks-row-0')!.getAttribute('aria-label')).toContain('Passed');
      expect(query(mount.container, 'checks-row-1')!.getAttribute('aria-label')).toContain('Failed');
    } finally { mount.unmount(); }
  });
  it('keeps every table row, drops the secondary column on a phone width and still reads it in each row', () => {
    const context = createSurfaceContext();
    const rows = Array.from({ length: 30 }, (_, index) => [`Person ${index}`, 'Team', 'Paired 2 machines', '10:38']);
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <DataTable testID="people" label="Newest people" incomplete="More in the full view"
          columns={[{ label: 'Person' }, { label: 'Plan', priority: 'secondary' }, { label: 'Got to' }, { label: 'Joined' }]} rows={rows} />
      </PluginUiProvider>,
    );
    try {
      const table = query(mount.container, 'people')!;
      expect(table.getAttribute('role')).toBe('table');
      expect(query(mount.container, 'people-header-1')).not.toBeNull();
      layout(table, 300);
      expect(query(mount.container, 'people-header-1')).toBeNull();
      expect(query(mount.container, 'people-header-0')).not.toBeNull();
      expect(mount.container.querySelectorAll('[role="row"]')).toHaveLength(31);
      expect(query(mount.container, 'people-row-29')!.getAttribute('aria-label')).toBe('Person: Person 29, Plan: Team, Got to: Paired 2 machines, Joined: 10:38');
      expect(query(mount.container, 'people-incomplete')!.textContent).toBe('More in the full view');
      layout(table, 900);
      expect(query(mount.container, 'people-header-1')).not.toBeNull();
    } finally {
      mount.unmount();
    }
  });

  it('draws a funnel step as a share of the largest step', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <HappierDataRows testID="funnel" theme={context.theme} columns={[{ label: 'Step' }, { label: 'People', proportion: true }]}
        rows={[['Signed up', 1284], ['Paired a machine', 642]]} />,
    );
    try {
      expect(query(mount.container, 'funnel-fill-0')!.style.width).toBe('100%');
      expect(query(mount.container, 'funnel-fill-1')!.style.width).toBe('50%');
      expect(query(mount.container, 'funnel-row-1')!.getAttribute('aria-label')).toContain('People: 642');
    } finally {
      mount.unmount();
    }
  });

  it('is one labelled image naming every point, with the current period as the one strong bar', () => {
    const context = createSurfaceContext();
    const points = [{ x: 'Mon', y: 214 }, { x: 'Tue', y: 236 }, { x: 'Wed', y: 183 }];
    const mount = mountThroughReactNativeWeb(
      <HappierDataChart testID="signups" theme={context.theme} label="Signups per day" style="bar" points={points} />,
    );
    try {
      const chart = query(mount.container, 'signups')!;
      expect(chart.getAttribute('role')).toBe('img');
      expect(chart.getAttribute('aria-label')).toMatch(/^Signups per day: Mon 214, Tue 236, Wed 183$/u);
      const last = query(mount.container, 'signups-bar-2')!.firstElementChild as HTMLElement;
      const rest = query(mount.container, 'signups-bar-1')!.firstElementChild as HTMLElement;
      expect(last.style.opacity).toBe('1');
      expect(Number(rest.style.opacity)).toBeLessThan(1);
      // The tallest point fills the plot; a shorter one is proportionally lower.
      expect(rest.style.height).toBe('64px');
    } finally {
      mount.unmount();
    }
  });

  it('keeps the metric node identity when its value changes', async () => {
    const context = createSurfaceContext();
    const element = (value: number) => (
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Metric testID="metric" label="Signups this week" value={value} comparison={{ value: '+18%', label: 'vs the week before', meaning: 'good' }} />
      </PluginUiProvider>
    );
    const mount = mountThroughReactNativeWeb(element(1284));
    try {
      const node = query(mount.container, 'metric-value')!;
      expect(query(mount.container, 'metric')!.getAttribute('aria-label')).toBe('Signups this week: 1,284, +18% vs the week before');
      await mount.render(element(1290));
      expect(query(mount.container, 'metric-value')).toBe(node);
      expect(node.textContent).toBe('1,290');
    } finally {
      mount.unmount();
    }
  });
});
