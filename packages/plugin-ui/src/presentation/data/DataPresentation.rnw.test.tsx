import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Chart, DataTable, Metric } from '../../components/Data.js';
import { WidgetPresentationProvider } from '../../components/WidgetPresentation.js';
import { PluginUiProvider } from '../../components/PluginUiProvider.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { HappierDataChart } from './Chart.js';
import { HappierDataRows } from './DataRows.js';
import { HappierDataMetric } from './Metric.js';
import { ChartInteractionProvider } from './ChartDatum.js';

const query = (root: HTMLElement, testID: string) => root.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

function layout(element: Element | null, width: number) {
  const handler = (element as unknown as { __reactLayoutHandler: (event: HappierLayoutChangeEvent) => void }).__reactLayoutHandler;
  act(() => handler({ nativeEvent: { layout: { x: 0, y: 0, width, height: 120 } } }));
}

describe('public data nodes through React Native Web', () => {
  it('keeps a string amount datum beside its row action so inspecting its precision never navigates', () => {
    const navigate = vi.fn();
    const reveal = vi.fn();
    const mount = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual, testID) =>
      <button data-testid={testID} title={datum.value} onClick={reveal}>{visual}</button>}>
      <HappierDataRows theme={createSurfaceContext().theme} testID="work" showProportionShares={false}
        columns={[{ label: 'Session' }, { label: 'Cost', proportion: true }]} rows={[[ 'Review', '$1.23 reported' ]]}
        rowDatums={[{ label: 'Review', value: 'USD 1.23456', subtitle: 'Reported' }]}
        renderIdentity={(_row, visual) => <button data-testid="open-session" onClick={navigate}>{visual}</button>} />
    </ChartInteractionProvider>);
    try {
      const amount = query(mount.container, 'work-datum-0');
      expect(amount?.title).toBe('USD 1.23456');
      expect(mount.container.querySelector('button button')).toBeNull();
      act(() => amount!.click());
      expect(reveal).toHaveBeenCalledOnce();
      expect(navigate).not.toHaveBeenCalled();
      act(() => query(mount.container, 'open-session')!.click());
      expect(navigate).toHaveBeenCalledOnce();
      expect(reveal).toHaveBeenCalledOnce();
    } finally { mount.unmount(); }
  });
  it.each(['en', 'fr'])('reveals missing share precision without targeting exact whole percentages in %s', locale => {
    const context = createSurfaceContext({ locale });
    const theme = context.theme;
    const mount = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}><ChartInteractionProvider renderDatum={(datum, visual, testID) =>
      <span data-testid={testID} title={`${datum.label}: ${datum.value}`}>{visual}</span>}>
      <HappierDataRows theme={theme} testID="shares" columns={[{ label: 'Project' }, { label: 'Tokens', proportion: true }]}
        rows={[[ 'Glass', 100 ], [ 'Docs', 50 ]]} rowShares={[0.123456, 0.5]} showProportionShares={false} />
    </ChartInteractionProvider></PluginUiProvider>);
    try {
      expect(query(mount.container, 'shares-share-datum-0')?.title).toContain(locale === 'fr' ? '12,35%' : '12.35%');
      expect(query(mount.container, 'shares-share-datum-1')).toBeNull();
    } finally { mount.unmount(); }
  });
  it('offers exact metric precision only when the inline formatter hides it', () => {
    const theme = createSurfaceContext().theme;
    const mount = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual, testID) =>
      <span data-testid={testID} title={`${datum.label}: ${datum.value}; ${datum.subtitle ?? ''}`}>{visual}</span>}>
      <HappierDataMetric theme={theme} testID="compact" label="Tokens" value={4186010} unit="tokens" valueFormatter={() => '4.2M'} />
      <HappierDataMetric theme={theme} testID="complete" label="Sessions" value={48} />
      <HappierDataMetric theme={theme} testID="money" label="Cost" value={0} valueFormatter={() => '$0.00'} />
    </ChartInteractionProvider>);
    try {
      expect(query(mount.container, 'compact-datum')!.title).toContain('Tokens: 4,186,010 tokens');
      expect(query(mount.container, 'compact-value')!.textContent).toContain('4.2M');
      expect(query(mount.container, 'complete-datum')).toBeNull();
      expect(query(mount.container, 'money-datum')).toBeNull();
    } finally { mount.unmount(); }
  });

  it('offers exact row precision without adding a redundant target for complete inline counts', () => {
    const theme = createSurfaceContext().theme;
    const mount = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual, testID) =>
      <span data-testid={testID} title={`${datum.label}: ${datum.value}; ${datum.subtitle ?? ''}`}>{visual}</span>}>
      <HappierDataRows theme={theme} testID="precise" showProportionShares={false} columns={[{ label: 'Project' }, { label: 'Tokens', proportion: true }]}
        valueFormatter={value => value > 1000 ? '4.2M' : String(value)} rows={[[ 'Glass', 4186010 ], ['Small', 48]]} />
    </ChartInteractionProvider>);
    try {
      expect(query(mount.container, 'precise-datum-0')!.title).toContain('Glass: 4,186,010');
      expect(query(mount.container, 'precise-datum-1')).toBeNull();
      expect(query(mount.container, 'precise-row-0')!.textContent).toContain('4.2M');
    } finally { mount.unmount(); }
  });
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
      const bar = query(mount.container, 'sized-chart-bar-1-0')!;
      const compactHeight = Number.parseFloat(bar.style.height);
      await mount.render(render(384, 4));
      expect(Number.parseFloat(bar.style.height)).toBeGreaterThan(compactHeight);
      expect(query(mount.container, 'sized-chart')).toBe(chart);
      expect(mount.container.querySelectorAll('[data-testid^="sized-chart-bar-"]')).toHaveLength(3);
      expect(chart.getAttribute('aria-label')).toContain('Mon: Signups 214');
      act(() => query(mount.container, 'sized-chart-values-toggle')!.click());
      expect(query(mount.container, 'sized-chart-values-row-2')!.getAttribute('aria-label')).toContain('Signups: 183');
    } finally { mount.unmount(); }
  });
  it('draws a row\'s trailing identity marks after its title and before the amount, outside the spoken label', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(<HappierDataRows testID="ledger" theme={context.theme}
      columns={[{ label: 'Branch' }, { label: 'Cost', proportion: true }]} rows={[['glass', 38], ['relay', 12]]}
      showProportionShares={false} rowTrails={[<span data-testid="marks">CX</span>, undefined]} />);
    try {
      const row = query(mount.container, 'ledger-row-0')!;
      expect(query(row, 'marks')).not.toBeNull();
      expect(row.textContent).toBe('glassCX38');
      expect(row.getAttribute('aria-label')).toBe('glass, Cost: 38, 100%');
      expect(query(mount.container, 'ledger-row-1')!.textContent).toBe('relay12');
    } finally { mount.unmount(); }
  });
  it('draws the mark by what it means, so a true value that is bad never reads as a tick', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(<HappierDataRows testID="tests" theme={context.theme}
      columns={[{ label: 'Test' }]} rows={[[ 'pager' ], [ 'widget' ]]}
      marks={[{ passed: true, label: 'Flaky', meaning: 'bad' }, { passed: false, label: 'Stable', meaning: 'good' }]} />);
    try {
      expect(query(mount.container, 'tests-mark-0')!.textContent).toContain('✗');
      expect(query(mount.container, 'tests-mark-1')!.textContent).toContain('✓');
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
    // This table actually overflows a phone with the current shared text scale.
    const rows = Array.from({ length: 30 }, (_, index) => [`Person ${index}`, 'Professional', 'Paired 2 machines', '10:38']);
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
      expect(query(mount.container, 'people-row-29')!.getAttribute('aria-label')).toBe('Person: Person 29, Plan: Professional, Got to: Paired 2 machines, Joined: 10:38');
      expect(query(mount.container, 'people-incomplete')!.textContent).toBe('More in the full view');
      layout(table, 900);
      expect(query(mount.container, 'people-header-1')).not.toBeNull();
    } finally {
      mount.unmount();
    }
  });

  it('inks a column header in the secondary text role, not the muted one that falls under 3:1 on a light card', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <DataTable testID="ink" label="Orders by channel" columns={[{ label: 'Channel' }, { label: 'Orders' }]} rows={[['Web', 12]]} />
      </PluginUiProvider>,
    );
    try {
      const header = query(mount.container, 'ink-header-0')!;
      const rgb = (hex: string) => {
        const n = Number.parseInt(hex.slice(1), 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      };
      expect(context.theme.colors.secondaryText).not.toBe(context.theme.colors.mutedText);
      expect(header.style.color).toBe(rgb(context.theme.colors.secondaryText));
    } finally {
      mount.unmount();
    }
  });
  it('sets a column header at the cell size so it never outweighs the cells, and reads the figures in primary ink', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <DataTable testID="hier" label="Orders by channel" columns={[{ label: 'Channel' }, { label: 'Orders' }]} rows={[['Web', 12]]} />
      </PluginUiProvider>,
    );
    try {
      const header = query(mount.container, 'hier-header-1')!;
      const figure = Array.from(query(mount.container, 'hier-row-0')!.querySelectorAll<HTMLElement>('div')).find((node) => node.textContent === '12' && node.children.length === 0)!;
      const rgb = (hex: string) => {
        const n = Number.parseInt(hex.slice(1), 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      };
      expect(header.style.fontSize).toBe(figure.style.fontSize);
      expect(Number(header.style.fontWeight)).toBeGreaterThan(Number(figure.style.fontWeight));
      expect(figure.style.color).toBe(rgb(context.theme.colors.text));
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

  it('keeps exact values and bucket selection on the N=1 public chart', () => {
    const context = createSurfaceContext();
    const points = [{ x: 'Mon', y: 214 }, { x: 'Tue', y: 236 }, { x: 'Wed', y: 183 }];
    const mount = mountThroughReactNativeWeb(
      <HappierDataChart testID="signups" theme={context.theme} label="Signups per day" style="bar" points={points} />,
    );
    try {
      const chart = query(mount.container, 'signups')!;
      expect(query(mount.container, 'signups-bucket-1')!.getAttribute('role')).toBe('button');
      expect(chart.getAttribute('aria-label')).toContain('Tue: Signups per day 236');
      act(() => query(mount.container, 'signups-bucket-1')!.click());
      expect(query(mount.container, 'signups-readout')!.textContent).toContain('236');
      act(() => query(mount.container, 'signups-values-toggle')!.click());
      expect(query(mount.container, 'signups-values-row-2')!.getAttribute('aria-label')).toContain('Signups per day: 183');
    } finally {
      mount.unmount();
    }
  });

  it('draws one series in one ink: the public chart has no "latest" bucket to single out', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <HappierDataChart testID="orders" theme={context.theme} label="Orders" style="bar" points={[{ x: 'Mon', y: 17 }, { x: 'Tue', y: 23 }]} />,
    );
    try {
      const bars = [...mount.container.querySelectorAll<HTMLElement>('[data-testid^="orders-bar-"]')];
      expect(bars).toHaveLength(2);
      expect(new Set(bars.map(bar => `${bar.style.backgroundColor}|${bar.style.opacity}`)).size).toBe(1);
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

  it('never clamps a metric value to one line, so a long figure wraps instead of ending in an ellipsis', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Metric testID="metric" label="Agent time" size="stat" value={6840000} valueFormatter={() => '1 h 54 min'} />
      </PluginUiProvider>,
    );
    try {
      const style = getComputedStyle(query(mount.container, 'metric-value')!);
      expect(style.textOverflow).not.toBe('ellipsis');
      expect(style.whiteSpace).not.toBe('nowrap');
    } finally {
      mount.unmount();
    }
  });

  it('binds each number to its unit so a narrow cell wraps between "1 h" and "54 min", never before "min"', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Metric testID="metric" label="Agent time" size="stat" value={6840000} valueFormatter={() => '1 h 54 min'} />
      </PluginUiProvider>,
    );
    try {
      expect(query(mount.container, 'metric-value')!.textContent).toBe('1\u00a0h 54\u00a0min');
    } finally {
      mount.unmount();
    }
  });

  it('holds a pending comparison\'s room invisibly, and drops the hold once the comparison arrives', async () => {
    const theme = createSurfaceContext().theme;
    const element = (comparison?: { value: string; label: string; meaning: 'good' }) => (
      <HappierDataMetric testID="metric" theme={theme} size="stat" label="Per million tokens" value={0.43}
        comparisonRoom={{ value: '▼ 100%', label: 'vs before' }} {...(comparison ? { comparison } : {})} />
    );
    const mount = mountThroughReactNativeWeb(element());
    try {
      const room = query(mount.container, 'metric-comparison-room')!;
      expect(room.textContent).toBe('▼ 100%vs before');
      expect(getComputedStyle(room).opacity).toBe('0');
      expect(room.closest('[aria-hidden="true"]')).toBe(room);
      expect(query(mount.container, 'metric')!.getAttribute('aria-label')).toBe('Per million tokens: 0.43');
      await mount.render(element({ value: '▼ 57%', label: 'vs before', meaning: 'good' }));
      expect(query(mount.container, 'metric-comparison-room')).toBeNull();
    } finally {
      mount.unmount();
    }
  });
});
