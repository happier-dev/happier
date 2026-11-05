import { act, Profiler, type ReactNode } from 'react';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContextFixture, SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { StackedSeriesChart, type StackedSeriesChartProps } from './StackedSeriesChart.js';
import { HappierUiEnvironmentProvider, HappierUiPlatformProvider } from '../../environment/context.js';
import { projectHappierUiEnvironment } from '../../environment/projectEnvironment.js';
import { View } from 'react-native';
import { Path, Svg } from 'react-native-svg';
import { BurnUpChart } from '@happier-dev/plugin-ui/presentation';
import { HappierDataChart } from './Chart.js';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { ChartInteractionProvider } from './ChartDatum.js';

// RNW selects its instant AnimatedMock in NODE_ENV=test. Exercise its actual JS animation driver.
vi.hoisted(() => { process.env.NODE_ENV = 'development'; });
afterAll(() => { process.env.NODE_ENV = 'test'; });

const series = [
  { id: 'sold', label: 'Sold', points: [{ id: 'mon', x: 'Mon', y: 0.00004 }, { id: 'tue', x: 'Tue', y: null }, { id: 'wed', x: 'Wed', y: 0 }] },
  { id: 'returned', label: 'Returned', points: [{ id: 'mon', x: 'Mon', y: 2 }, { id: 'tue', x: 'Tue', y: 1 }, { id: 'wed', x: 'Wed', y: 0 }] },
];
const find = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
/** True when the browser is told to run keyframes on the element (react-native-web compiles them into its style sheet). */
function animates(element: Element): boolean {
  return [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => 'selectorText' in rule
    && [...element.classList].some((name) => String(rule.selectorText).includes(`.${name}`)) && /animation-name/u.test(rule.cssText)));
}

describe('neutral series dataset', () => {
  it('uses the pointer position for dense history datum precision instead of the first sample', () => {
    const drawInk = vi.fn((visual: ReactNode) => visual);
    const mount = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual, testID, renderTrigger) =>
      <span data-testid={testID} title={`${datum.label}: ${datum.value}`}>{renderTrigger ? renderTrigger({
        onHoverChange() {}, onFocusChange() {}, onPress() {},
      }) : visual}</span>}>
      <StackedSeriesChart theme={theme} label="Observed" testID="dense-hover" width={2} viewportHeight={24} variant="line" size="inline"
        renderInk={drawInk}
        series={[{ id: 'used', label: 'Used', points: [{ id: 'a', x: 'A', y: 10 }, { id: 'b', x: 'B', y: 20 }, { id: 'c', x: 'C', y: 30 }] }]} />
    </ChartInteractionProvider>);
    try {
      const control = find(mount.container, 'dense-hover-history-control');
      drawInk.mockClear();
      act(() => control.dispatchEvent(new MouseEvent('pointermove', { clientX: 1, bubbles: true })));
      expect(find(mount.container, 'dense-hover-history-datum')?.title).toContain('B: Used: 20');
      expect(mount.container.querySelectorAll('[data-testid="dense-hover-history-control"]')).toHaveLength(1);
      expect(drawInk).not.toHaveBeenCalled();
      act(() => control.focus());
      expect(find(mount.container, 'dense-hover-history-datum')?.title).toContain('A: Used: 10');
      act(() => control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
      act(() => control.dispatchEvent(new MouseEvent('pointermove', { clientX: 1, bubbles: true })));
      expect(find(mount.container, 'dense-hover-history-datum')?.title).toContain('B: Used: 20');
      act(() => control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
      expect(find(mount.container, 'dense-hover-history-datum')?.title).toContain('A: Used: 10');
    } finally { mount.unmount(); }
  });
  it.each([320, 2])('keeps an incumbent plot overlay authoritative at width %s', width => {
    const selected = vi.fn();
    const datums = vi.fn((_datum, visual) => visual);
    const mount = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={datums}>
      <StackedSeriesChart theme={theme} label="Observed" testID="adapted" width={width} viewportHeight={24} variant="line" size="inline"
        renderPlotOverlay={() => <View testID="incumbent-lens" />} onSelect={selected}
        series={[{ id: 'used', label: 'Used', points: [{ id: 'a', x: 'A', y: 10 }, { id: 'b', x: 'B', y: 20 }, { id: 'c', x: 'C', y: 30 }] }]} />
    </ChartInteractionProvider>);
    try {
      expect(find(mount.container, 'incumbent-lens')).toBeTruthy();
      expect(datums).not.toHaveBeenCalled();
      act(() => find(mount.container, width === 2 ? 'adapted-history-control' : 'adapted-bucket-a').click());
      expect(selected).toHaveBeenCalledExactlyOnceWith('a');
      expect(datums).not.toHaveBeenCalled();
    } finally { mount.unmount(); }
  });
  it('binds an unadapted series bucket to the host datum while retaining its selection control', () => {
    const selected = vi.fn();
    const mount = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual, testID, renderTrigger) =>
      <span data-testid={testID} title={`${datum.label}: ${datum.value}`}>{renderTrigger ? renderTrigger({
        onHoverChange() {}, onFocusChange() {}, onPress() {},
      }) : visual}</span>}>
      <BurnUpChart theme={theme} label="Allowance" testID="hover-burn" width={320} size="full" onSelect={selected}
        series={[{ id: 'used', label: 'Used', points: [{ id: 'mon', x: 'Mon', y: 12.345 }, { id: 'tue', x: 'Tue', y: 25 }] }]}
        valueFormatter={value => `${Math.round(value)}%`} />
    </ChartInteractionProvider>);
    try {
      expect(find(mount.container, 'hover-burn-bucket-mon-datum')?.title).toContain('12.345');
      act(() => find(mount.container, 'hover-burn-bucket-mon').click());
      expect(selected).toHaveBeenCalledExactlyOnceWith('mon');
      expect(find(mount.container, 'hover-burn-readout').textContent).toContain('12%');
    } finally { mount.unmount(); }
  });
  it.each(['web', 'android'] as const)('lets the caller control exact-value Details on %s without a competing disclosure state', async platform => {
    const onValuesExpandedChange = vi.fn();
    const render = (valuesExpanded: boolean) => <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
      <StackedSeriesChart theme={theme} label="Sales" width={160} viewportHeight={36}
        series={series} variant="bar" size="full" testID="controlled-details"
        valuesExpanded={valuesExpanded} onValuesExpandedChange={onValuesExpandedChange} />
    </HappierUiPlatformProvider>;
    const mount = mountThroughReactNativeWeb(render(true));
    try {
      expect(find(mount.container, 'controlled-details-values')?.textContent).toContain('0.00004');
      expect(find(mount.container, 'controlled-details-values-toggle').getAttribute('aria-expanded')).toBe('true');
      act(() => find(mount.container, 'controlled-details-values-toggle').click());
      expect(onValuesExpandedChange).toHaveBeenLastCalledWith(false);
      expect(find(mount.container, 'controlled-details-values')).toBeTruthy();
      await mount.render(render(false));
      expect(find(mount.container, 'controlled-details-values')).toBeNull();
      expect(find(mount.container, 'controlled-details-values-toggle').getAttribute('aria-expanded')).toBe('false');
      act(() => find(mount.container, 'controlled-details-values-toggle').click());
      expect(onValuesExpandedChange).toHaveBeenLastCalledWith(true);
      expect(find(mount.container, 'controlled-details-values')).toBeNull();
      await mount.render(render(true));
      expect(find(mount.container, 'controlled-details-values')?.textContent).toContain('0.00004');
    } finally { mount.unmount(); }
  });
  it.each(['inline', 'tile'] as const)('keeps a dense %s history exact without requiring a Details toggle', size => {
    const points = Array.from({ length: 45_000 }, (_, x) => ({ id: `p${x}`, x, y: x === 0 ? 0.00004 : x }));
    const input = [{ id: 'used', label: 'Used', points }];
    const warm = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Allowance" width={320}
      series={[{ ...input[0]!, points: points.slice(0, 2) }]} variant="line" size={size} />);
    warm.unmount();
    const before = process.memoryUsage();
    const started = performance.now();
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Allowance" width={320}
      series={input} variant="line" size={size} testID="compact-dense" />);
    const after = process.memoryUsage();
    console.info('compact-dense-history-mount', JSON.stringify({ size, elapsedMs: performance.now() - started,
      heapUsedDelta: after.heapUsed - before.heapUsed, rssDelta: after.rss - before.rss, elements: mount.container.querySelectorAll('*').length }));
    try {
      expect(mount.container.querySelectorAll('button').length).toBeLessThanOrEqual(1);
      const control = find(mount.container, 'compact-dense-history-control');
      expect(control).toBeTruthy();
      expect(control.getAttribute('aria-label')).toContain('0.00004');
      act(() => control.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
      expect(control.getAttribute('aria-label')).toContain('Used 44,999');
      expect(mount.container.querySelector('path')!.getAttribute('d')!.match(/ L/gu)).toHaveLength(44_999);
    } finally { mount.unmount(); }
  }, 180_000);
  it('keeps dense exact history selectable without a mounted hit target per subpixel sample', () => {
    const points = Array.from({ length: 45_000 }, (_, x) => ({ id: `p${x}`, x, y: x === 22_500 ? 0.00004 : x / 450 }));
    const warm = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Allowance" width={320}
      series={[{ id: 'used', label: 'Used', points: points.slice(0, 2) }]} variant="line" size="full" />);
    warm.unmount();
    let exactCount = 0;
    let middleValue: number | null = null;
    const before = process.memoryUsage();
    const started = performance.now();
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Allowance" width={320}
      series={[{ id: 'used', label: 'Used', points }]} variant="line" size="full" testID="dense"
      renderPlotOverlay={plot => { exactCount = plot.buckets.length; middleValue = plot.buckets[22_500]!.values[0]!.value; return null; }} />);
    const after = process.memoryUsage();
    console.info('dense-history-mount', JSON.stringify({ points: points.length, elapsedMs: performance.now() - started,
      heapUsedDelta: after.heapUsed - before.heapUsed, rssDelta: after.rss - before.rss,
      elements: mount.container.querySelectorAll('*').length }));
    try {
      expect(mount.container.querySelectorAll('[data-testid^="dense-bucket-"]').length).toBeLessThanOrEqual(320);
      expect(exactCount).toBe(45_000);
      expect(middleValue).toBe(0.00004);
      expect(mount.container.querySelector('path')!.getAttribute('d')!.match(/ L/gu)).toHaveLength(44_999);
      const control = find(mount.container, 'dense-history-control');
      expect(control).toBeTruthy();
      act(() => control.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
      expect(find(mount.container, 'dense-readout').textContent).toContain('Used · 99.9977777777778');
      act(() => control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
      expect(control.getAttribute('aria-label')).toContain('44998');
      act(() => control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
      expect(find(mount.container, 'dense-readout').textContent).toContain('Used · 0');
    } finally { mount.unmount(); }
  }, 180_000);
  it('names one dense history image by its range, its latest reading in the caller\'s units and its threshold', () => {
    // A range that has only begun: its start is a gap, and the newest sample is before its trailing gap.
    const points = Array.from({ length: 400 }, (_, x) => ({ id: `p${x}`, x, y: x === 0 || x === 399 ? null : x === 398 ? 41.5 : x / 10 }));
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Memory used" width={160}
      series={[{ id: 'used', label: 'Used', points }]} coordinateFormatter={x => `time ${x}`} valueFormatter={value => `${value.toFixed(1)} GB`} formattedReadings
      threshold={{ value: 60, label: 'Critical', tone: 'error' }} variant="line" size="tile" testID="named" />);
    try {
      const image = find(mount.container, 'named');
      expect(image.getAttribute('role')).toBe('img');
      const name = image.getAttribute('aria-label')!;
      expect(name).toContain('time 0');
      expect(name).toContain('time 399');
      expect(name).toContain('time 398');
      expect(name).toContain('Used 41.5 GB');
      expect(name).toContain('Critical 60.0 GB');
      expect(name).not.toContain('Used —');
      // The plot control keeps the exact sample it reads.
      const control = find(mount.container, 'named-history-control');
      act(() => control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
      expect(control.getAttribute('aria-label')).toContain('Used —');
      expect(image.getAttribute('aria-label')).toBe(name);
      // Walking the keyboard says each reading in the caller's units, as the image and the lens do.
      act(() => control.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
      act(() => control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
      expect(control.getAttribute('aria-label')).toContain('Used 41.5 GB');
    } finally { mount.unmount(); }
  });
  it('names a dense history image without a threshold as an image too', () => {
    const points = Array.from({ length: 400 }, (_, x) => ({ id: `p${x}`, x, y: x % 7 }));
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="CPU busy" width={160}
      series={[{ id: 'mean', label: 'Mean', points }]} valueFormatter={value => `${value}%`} variant="area" size="tile" testID="plain" />);
    try {
      expect(find(mount.container, 'plain').getAttribute('role')).toBe('img');
      expect(find(mount.container, 'plain').getAttribute('aria-label')).toContain(`Mean ${399 % 7}%`);
    } finally { mount.unmount(); }
  });
  it('keeps every dense exact fact in Details, including an unavailable sample, zero and an older tiny value', () => {
    const points = Array.from({ length: 400 }, (_, x) => ({ id: `p${x}`, x,
      y: x === 0 ? 0.00004 : x === 1 ? null : x === 2 ? 0 : x }));
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Allowance" width={160}
      series={[{ id: 'used', label: 'Used', points }]} coordinateFormatter={x => `time ${x}`}
      variant="line" size="full" testID="facts" />);
    try {
      const control = find(mount.container, 'facts-history-control');
      act(() => control.dispatchEvent(new MouseEvent('click', { detail: 1, clientX: 100, bubbles: true })));
      expect(control.getAttribute('aria-label')).toContain('time 249');
      act(() => find(mount.container, 'facts-values-toggle').click());
      expect(find(mount.container, 'facts-values').querySelectorAll('[data-testid^="facts-values-row-"]')).toHaveLength(400);
      expect(find(mount.container, 'facts-values-row-0').getAttribute('aria-label')).toContain('Used: 0.00004');
      expect(find(mount.container, 'facts-values-row-0').textContent).toContain('time 0');
      expect(find(mount.container, 'facts-values-row-1').getAttribute('aria-label')).toContain('Used: —');
      expect(find(mount.container, 'facts-values-row-2').getAttribute('aria-label')).toContain('Used: 0');
      expect(find(mount.container, 'facts-values-row-399').textContent).toContain('time 399');
    } finally { mount.unmount(); }
  });
  it('keeps the existing full-size native value controls outside a subpixel line plot', () => {
    const points = Array.from({ length: 400 }, (_, x) => ({ id: `p${x}`, x, y: x }));
    const mount = mountThroughReactNativeWeb(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'light' }}>
      <StackedSeriesChart theme={theme} label="Allowance" width={160} viewportHeight={36}
        series={[{ id: 'used', label: 'Used', points }]} variant="line" size="full" testID="native-dense" />
    </HappierUiPlatformProvider>);
    try {
      expect(mount.container.querySelectorAll('*').length).toBeLessThan(100);
      expect(find(mount.container, 'native-dense-history-control')).toBeNull();
      act(() => find(mount.container, 'native-dense-values-toggle').click());
      const values = find(mount.container, 'native-dense-values');
      expect(values.querySelectorAll('button')).toHaveLength(400);
      const last = find(values, 'native-dense-bucket-p399');
      // A stacked exact-value row is drawn as a row, and its hit area stays on it.
      expect(last.style.minHeight).toBe('');
      expect(last.querySelector(':scope > [data-happier-hit-area="true"]')).toBeNull();
      expect(last.getAttribute('aria-label')).toContain('Used 399');
    } finally { mount.unmount(); }
  });
  it('keeps keyboard focus on the selected exact sample when resizing between dense and separate hit targets', async () => {
    const points = Array.from({ length: 400 }, (_, x) => ({ id: `p${x}`, x, y: x }));
    const input = [{ id: 'used', label: 'Used', points }];
    const render = (width: number) => <StackedSeriesChart theme={theme} label="Allowance" width={width}
      series={input} variant="line" size="full" testID="resizing" />;
    const mount = mountThroughReactNativeWeb(render(160));
    try {
      const dense = find(mount.container, 'resizing-history-control');
      act(() => dense.focus());
      act(() => dense.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
      await mount.render(render(800));
      expect(document.activeElement).toBe(find(mount.container, 'resizing-bucket-p399'));
      await mount.render(render(160));
      expect(document.activeElement).toBe(find(mount.container, 'resizing-history-control'));
      expect(document.activeElement!.getAttribute('aria-label')).toContain('Used 399');
      const details = find(mount.container, 'resizing-values-toggle');
      act(() => details.focus());
      await mount.render(render(800));
      expect(document.activeElement).toBe(details);
    } finally { mount.unmount(); }
  });
  it('draws an observed upper edge on the area scale without stacking it onto the mean or filling it', () => {
    const input = [
      { id: 'mean', label: 'Mean', fillOpacity: 0.2, points: [10, 10, null, 10, 10].map((y, x) => ({ id: String(x), x, y })) },
      { id: 'maximum', label: 'Maximum', overlay: true, lineStyle: 'dotted' as const,
        points: [95, 95, null, 80, 80].map((y, x) => ({ id: String(x), x, y })) },
    ];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="CPU" series={input}
      width={200} viewportHeight={100} plotInset={0} domain={{ min: 0, max: 100 }} variant="area" size="tile" testID="peaks" />);
    try {
      const edges = [...mount.container.querySelectorAll('path[stroke-dasharray]')];
      expect(edges).toHaveLength(2);
      expect(edges[0]!.getAttribute('d')).toMatch(/^M0 5(?:\.\d+)? L50 5/u);
      expect(edges.every(edge => edge.getAttribute('fill') === 'none')).toBe(true);
      expect(edges.every(edge => !edge.getAttribute('d')?.endsWith('Z'))).toBe(true);
      expect(find(mount.container, 'peaks-bucket-0').getAttribute('aria-label')).toContain('Maximum 95');
    } finally { mount.unmount(); }
  });
  it('draws declared bucket shading and a reference box without converting unknown buckets to zero', () => {
    const input = [{ id: 'rain', label: 'Rainfall', points: [10, null, 0, 2].map((y, x) => ({ id: String(x), x, y })) }];
    const appearance = { bucketShading: [{ bucketId: '1' }, { bucketId: '3' }],
      barRanges: [{ bucketId: '3', lower: 2, upper: 6, label: 'Typical active day' }] };
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Rainfall" series={input}
      width={200} viewportHeight={100} variant="bar" size="full" testID="rain" reference={{ value: 6, label: 'Average' }} {...appearance} />);
    try {
      expect(find(mount.container, 'rain-shading-1')).toBeTruthy();
      const range = find(mount.container, 'rain-range-3');
      expect(range.style.top).toBe('40px');
      expect(range.style.height).toBe('40px');
      expect(find(mount.container, 'rain-gap-1')).toBeTruthy();
      expect(mount.container.querySelector('[data-testid="rain-bar-1-0"]')).toBeNull();
      expect(mount.container.querySelector('[data-testid="rain-gap-2"]')).toBeNull();
      expect(find(mount.container, 'rain-bar-2-0')).toBeTruthy();
      expect(find(mount.container, 'rain').getAttribute('aria-label')).toContain('Typical active day 2–6');
      expect(find(mount.container, 'rain').getAttribute('aria-label')).toContain('Average 6');
      act(() => find(mount.container, 'rain-values-toggle').click());
      expect(find(mount.container, 'rain-values-row-1').getAttribute('aria-label')).toContain('Rainfall: —');
      expect(find(mount.container, 'rain-values-row-2').getAttribute('aria-label')).toContain('Rainfall: 0');
    } finally { mount.unmount(); }
  });
  it('lets a reference label replace a scale value it would sit on, and keeps scale values it is clear of', () => {
    const input = [{ id: 'rain', label: 'Rainfall', points: [100, 1, 0, 2].map((y, x) => ({ id: String(x), x, y })) }];
    const chart = (value: number) => <StackedSeriesChart theme={theme} label="Rainfall" series={input} width={240} viewportHeight={100}
      variant="bar" size="full" testID="rain" showScaleValues scaleGutter={44} reference={{ value, label: 'avg' }} />;
    const near = mountThroughReactNativeWeb(chart(1));
    try {
      // The average sits on the baseline: "avg" stands there alone instead of printing over "0".
      expect(near.container.querySelector('[data-testid="rain-scale-0"]')).toBeNull();
      expect(find(near.container, 'rain-scale-1')).toBeTruthy();
    } finally { near.unmount(); }
    const clear = mountThroughReactNativeWeb(chart(75));
    try {
      expect(find(clear.container, 'rain-scale-0')).toBeTruthy();
      expect(find(clear.container, 'rain-scale-1')).toBeTruthy();
    } finally { clear.unmount(); }
  });
  it('sits the peak figure on its bar, and keeps the first bucket\'s figure inside the plot', () => {
    // Live (Usage daily): a 7M peak under a 10M scale floated far above its bar, and the first
    // column's figure was cut at the card's left edge ("7M").
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Tokens" variant="bar" size="full" testID="peak"
      width={300} viewportHeight={100} minimumMaximum={10} showPeakValue
      series={[{ id: 'tokens', label: 'Tokens', points: [7, 1, 2, 1, 3, 1, 2, 1, 2, 1].map((y, x) => ({ id: String(x), x: `D${x}`, y })) }]} />);
    try {
      const label = find(mount.container, 'peak-peak');
      // The bar's top is 70% up a 100px plot; the figure rests just above it, not at the plot's top.
      expect(Number.parseFloat(label.style.bottom)).toBeGreaterThanOrEqual(70);
      expect(Number.parseFloat(label.style.bottom)).toBeLessThan(80);
      expect(label.style.alignSelf).toBe('flex-start');
    } finally { mount.unmount(); }
  });
  it('keeps the N=1 adapter on identical geometry and accessible values for bars and lines', () => {
    const points = [{ x: 'Mon', y: 0.00004 }, { x: 'Tue', y: 7 }, { x: 'Wed', y: 0 }];
    for (const variant of ['bar', 'line'] as const) {
      const native = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Rainfall" variant={variant} size="full" testID="native"
        series={[{ id: 'value', label: 'Rainfall', points: points.map((point, index) => ({ ...point, id: String(index) })) }]} />);
      const adapter = mountThroughReactNativeWeb(<HappierDataChart theme={theme} label="Rainfall" style={variant} points={points} testID="adapter" />);
      try {
        for (const [container, id] of [[native.container, 'native'], [adapter.container, 'adapter']] as const) {
          const measured = find(container, id) as HTMLElement & { __reactLayoutHandler: (event: HappierLayoutChangeEvent) => void };
          act(() => measured.__reactLayoutHandler({ nativeEvent: { layout: { x: 0, y: 0, width: 180, height: 150 } } }));
        }
        const ink = (container: HTMLElement) => variant === 'line'
          ? [...container.querySelectorAll('svg path')].map(path => path.getAttribute('d'))
          : [...container.querySelectorAll<HTMLElement>('[data-testid*="-bar-"]')].map(bar => bar.style.height);
        expect(ink(adapter.container)).toEqual(ink(native.container));
        expect(find(adapter.container, 'adapter').getAttribute('aria-label')).toBe(find(native.container, 'native').getAttribute('aria-label'));
        act(() => find(adapter.container, 'adapter-values-toggle').click());
        act(() => find(native.container, 'native-values-toggle').click());
        expect(find(adapter.container, 'adapter-values-row-0').getAttribute('aria-label')).toBe(find(native.container, 'native-values-row-0').getAttribute('aria-label'));
      } finally { native.unmount(); adapter.unmount(); }
    }
  });
  it('draws a gap as a plain break, never a mark, and a lone sample as a dot, never a column', () => {
    const draw = (values: (number | null)[]) => mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Memory, last hour"
      series={[{ id: 'memory', label: 'Memory', points: values.map((y, x) => ({ id: String(x), x, y })) }]}
      width={200} viewportHeight={100} plotInset={0} minimumMaximum={10} variant="area" size="tile" testID="gap" />);
    const gappy = draw([2, 8, null, null, 3]);
    try {
      // Nothing is drawn across the two missing buckets: no baseline rule, dashed or otherwise.
      expect(gappy.container.querySelectorAll('[data-testid^="gap-gap-"]')).toHaveLength(0);
      expect(gappy.container.querySelectorAll('line')).toHaveLength(0);
      // The lone sample after the gap is a dot, not a filled column to the baseline.
      expect(gappy.container.querySelectorAll('[data-testid^="gap-lone-"]')).toHaveLength(1);
      expect([...gappy.container.querySelectorAll('path')].some((path) => /^M200 [\d.]+ L200 /.test(path.getAttribute('d') ?? ''))).toBe(false);
    } finally { gappy.unmount(); }
  });
  it('draws a run too short to read as a solid area as a line only, with no mark between runs', () => {
    const draw = (values: (number | null)[]) => mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Memory, last hour"
      series={[{ id: 'memory', label: 'Memory', points: values.map((y, x) => ({ id: String(x), x, y })) }]}
      width={200} viewportHeight={100} plotInset={0} minimumMaximum={10} variant="area" size="tile" testID="short" />);
    const filled = (view: ReturnType<typeof draw>) => [...view.container.querySelectorAll('path')].filter((path) => /Z$/u.test(path.getAttribute('d') ?? '') && path.getAttribute('fill') !== 'none');
    const long = draw([2, 8, 4, 9, 3, 5]);
    const mixed = draw([2, 8, 4, 9, null, 5, 6, 7, null, 3, 4]);
    try {
      // A long run keeps its area.
      expect(filled(long)).toHaveLength(1);
      // The 4-sample run keeps its area; the 3-sample and 2-sample runs are lines with no fill under them.
      expect(filled(mixed)).toHaveLength(1);
      const lines = [...mixed.container.querySelectorAll('path')].filter((path) => path.getAttribute('fill') === 'none' && path.getAttribute('stroke') !== 'none');
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(mixed.container.querySelectorAll('line')).toHaveLength(0);
    } finally { mixed.unmount(); long.unmount(); }
  });
  it('tones only geometry above the threshold and keeps missing samples as separate paths', () => {
    const input = [{ id: 'memory', label: 'Memory', points: [2, 8, null, 9, 3].map((y, x) => ({ id: String(x), x, y })) }];
    const options = { threshold: { value: 6, label: 'Critical', tone: 'error' as const } };
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Memory, last hour" series={input}
      width={200} viewportHeight={100} plotInset={0} minimumMaximum={10} variant="area" size="tile" testID="memory" {...options} />);
    try {
      const clip = find(mount.container, 'memory-threshold-clip');
      expect(clip.getAttribute('height')).toBe('40');
      const toned = [...mount.container.querySelectorAll('[data-testid^="memory-threshold-path-"]')];
      expect(toned).toHaveLength(2);
      expect(toned.every((path) => path.getAttribute('clip-path')?.includes('threshold'))).toBe(true);
      // Runs of two samples are too short to read as areas: lines, toned by stroke with no fill.
      expect(toned.every((path) => path.getAttribute('stroke') === theme.colors.danger && path.getAttribute('fill') === 'none')).toBe(true);
      expect(toned.map((path) => path.getAttribute('d'))).toEqual(['M0 80 L50 20', 'M150 10 L200 70']);
      expect(find(mount.container, 'memory').getAttribute('aria-label')).toContain('Critical 6');
      expect(find(mount.container, 'memory-bucket-2').getAttribute('aria-label')).toContain('Memory —');
    } finally { mount.unmount(); }
  });
  it('mirrors uploads below the baseline while every readout retains their absolute magnitude', () => {
    const input = [{ id: 'down', label: 'Down', points: [8, 4].map((y, x) => ({ id: String(x), x, y })) },
      { id: 'up', label: 'Up', points: [-2, -4].map((y, x) => ({ id: String(x), x, y })) }];
    const options = { mirrored: true };
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Network, last hour" series={input}
      width={200} viewportHeight={100} plotInset={0} variant="area" size="full" showScaleValues valuesLabel="Show values" testID="network" {...options} />);
    try {
      expect([...mount.container.querySelectorAll('svg path')].map((path) => path.getAttribute('d'))).toEqual([
        'M0 0 L200 33.33 L200 66.67 L0 66.67 Z', 'M0 83.33 L200 100 L200 66.67 L0 66.67 Z',
      ]);
      expect(find(mount.container, 'network').getAttribute('aria-label')).toContain('Up 2');
      expect(find(mount.container, 'network').getAttribute('aria-label')).not.toContain('Up -');
      act(() => find(mount.container, 'network-bucket-1').click());
      expect(find(mount.container, 'network-readout').textContent).toContain('Up · 4');
      act(() => find(mount.container, 'network-values-toggle').click());
      expect(find(mount.container, 'network-values-row-0').getAttribute('aria-label')).toContain('Up: 2');
      expect(mount.container.textContent).not.toContain('-8');
    } finally { mount.unmount(); }
  });
  it('does not commit React work on animation frames between live samples', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    // Browser compositor boundary: jsdom has no Web Animations implementation.
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate });
    const commits = vi.fn();
    const render = (sampleKey: number) => <Profiler id="live" onRender={commits}>
      <StackedSeriesChart theme={theme} label="CPU" series={series} variant="line" size="tile" width={200}
        reducedMotion={false} liveMotion={{ sampleKey, stepPx: 10, durationMs: 2_000 }} />
    </Profiler>;
    const mount = mountThroughReactNativeWeb(render(1));
    try {
      await mount.render(render(2));
      expect(animate).toHaveBeenCalledWith([{ transform: 'translateX(10px)' }, { transform: 'translateX(0px)' }],
        { duration: 2_000, easing: 'linear' });
      commits.mockClear();
      for (let frame = 0; frame < 10; frame++) await act(async () => { await vi.advanceTimersByTimeAsync(32); });
      expect(commits).not.toHaveBeenCalled();
    } finally {
      mount.unmount(); vi.useRealTimers();
      if (descriptor) Object.defineProperty(Element.prototype, 'animate', descriptor);
      else Reflect.deleteProperty(Element.prototype, 'animate');
    }
  });
  it('slides one incoming sample while the endpoint stays fixed, and redraws immediately when motion is reduced or inactive', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
    const animation = { cancel: vi.fn() };
    const animate = vi.fn(() => animation);
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate });
    const render = (sampleKey: number, reducedMotion: boolean, active = true) => <StackedSeriesChart theme={theme} label="CPU, last hour"
      series={[{ id: 'cpu', label: 'CPU', points: [20, 40].map((y, x) => ({ id: String(x), x, y })) }]}
      variant="line" size="tile" width={200} viewportHeight={100} plotInset={0} minimumMaximum={100} testID="live"
      reducedMotion={reducedMotion} {...{ liveMotion: { sampleKey, stepPx: 10, durationMs: 100, active } }} />;
    const mount = mountThroughReactNativeWeb(render(1, false));
    try {
      expect(find(mount.container, 'live').getAttribute('role')).toBe('img');
      expect(find(mount.container, 'live').getAttribute('aria-label')).toContain('CPU 40');
      expect(find(mount.container, 'live').getAttribute('aria-label')).not.toContain('CPU 20');
      await mount.render(render(2, false));
      expect(animate).toHaveBeenLastCalledWith([{ transform: 'translateX(10px)' }, { transform: 'translateX(0px)' }],
        { duration: 100, easing: 'linear' });
      expect(find(mount.container, 'live-endpoint-0').getAttribute('cx')).toBe('200');
      expect(find(mount.container, 'live-endpoint-0').closest('[data-testid="live-sliding-ink"]')).toBeNull();
      await mount.render(render(3, true));
      expect(animation.cancel).toHaveBeenCalled();
      expect(find(mount.container, 'live-sliding-ink').style.transform).toContain('translateX(0px)');
      await mount.render(render(4, false, false));
      expect(find(mount.container, 'live-sliding-ink').style.transform).toContain('translateX(0px)');
      expect(mount.container.querySelector('[data-testid="live-endpoint-0"]')).toBeNull();
    } finally {
      mount.unmount();
      if (descriptor) Object.defineProperty(Element.prototype, 'animate', descriptor);
      else Reflect.deleteProperty(Element.prototype, 'animate');
    }
  });
  it('names a live chart\'s range by the two ends the plot itself shows, not by two clock times that can drop the date', async () => {
    // A caller's time reading may elide today's date, so "Oct 26, 10:00 AM – 10:00 AM" cannot say the range spans a day.
    const clock = (x: number) => x === 0 ? 'Oct 26, 10:00 AM' : '10:00 AM';
    const points = [0, 1].map((x) => ({ id: String(x), x, y: 20 + x * 20 }));
    const render = (axisTicks?: StackedSeriesChartProps['axisTicks']) => <StackedSeriesChart theme={theme} label="CPU busy"
      series={[{ id: 'cpu', label: 'CPU', points }]} variant="line" size="tile" width={200} viewportHeight={100} plotInset={0}
      minimumMaximum={100} testID="range" coordinateFormatter={clock} showAxis={false} {...(axisTicks ? { axisTicks } : {})}
      reducedMotion liveMotion={{ sampleKey: 1, stepPx: 10, durationMs: 100 }} />;
    const mount = mountThroughReactNativeWeb(render(['24 h ago', 'now']));
    try {
      const name = () => find(mount.container, 'range').getAttribute('aria-label') ?? '';
      expect(name()).toContain('CPU busy, 24 h ago – now; ');
      expect(name()).not.toContain('Oct 26');
      expect(name()).toContain('CPU 40');
      // Ticks that are not the plot's two ends do not name its range: the chart's own readings do.
      await mount.render(render([{ label: 'early', bucket: 0 }, { label: 'mid', bucket: 0 }]));
      expect(name()).toContain('CPU busy, Oct 26, 10:00 AM – 10:00 AM; ');
      await mount.render(render());
      expect(name()).toContain('CPU busy, Oct 26, 10:00 AM – 10:00 AM; ');
    } finally { mount.unmount(); }
  });
  it('renders a source pattern on bars and area ribbons while retaining distinct exact series values', async () => {
    const input = [
      { id: 'onsite', label: 'Onsite orders', color: theme.colors.accent, points: [{ id: 'mon', x: 0, y: 12 }] },
      { id: 'remote', label: 'Remote orders', color: theme.colors.accent, fillPattern: 'hatch' as const, points: [{ id: 'mon', x: 0, y: 7 }] },
    ];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Orders" series={input} variant="bar" width={200} size="full" testID="source" />);
    try {
      expect(find(mount.container, 'source-bar-0-0').querySelector('pattern')).toBeNull();
      expect(find(mount.container, 'source-bar-0-1').querySelector('pattern')).not.toBeNull();
      expect(find(mount.container, 'source').getAttribute('aria-label')).toContain('Onsite orders 12, Remote orders 7');
      await mount.render(<StackedSeriesChart theme={theme} label="Orders" series={input} variant="area" width={200} size="full" testID="source" />);
      expect(mount.container.querySelector('svg path[fill^="url("]')).not.toBeNull();
      expect(find(mount.container, 'source').getAttribute('aria-label')).toContain('Onsite orders 12, Remote orders 7');
    } finally { mount.unmount(); }
  });
  it('fills only the area between two public line series in their shared scale, retaining exact values', () => {
    const input = [
      { id: 'low', label: 'Low temperature', points: [{ id: 'a', x: 0, y: 2.3456789 }, { id: 'b', x: 3, y: 4 }] },
      { id: 'high', label: 'High temperature', points: [{ id: 'a', x: 0, y: 6 }, { id: 'b', x: 3, y: 8 }] },
    ];
    const appearance = { bands: [{ id: 'spread', lowerSeriesId: 'low', upperSeriesId: 'high', color: theme.colors.accent, opacity: 0.2 }] };
    const mount = mountThroughReactNativeWeb(<BurnUpChart theme={theme} label="Temperature" series={input}
      width={200} viewportHeight={100} plotInset={0} size="full" minimumMaximum={10}
      valueFormatter={(value) => String(Math.round(value))} valuesLabel="Show values" testID="temperature" {...appearance} />);
    try {
      const band = find(mount.container, 'temperature-band-spread-0');
      expect(band).toBeTruthy();
      expect(band.getAttribute('d')).toBe('M0 40 L200 20 L200 60 L0 76.54 Z');
      expect(band.getAttribute('fill')).toBe(theme.colors.accent);
      expect(band.getAttribute('fill-opacity')).toBe('0.2');
      expect([...mount.container.querySelectorAll('svg path')].filter((path) => path !== band)
        .map((path) => path.getAttribute('d'))).toEqual(['M0 76.54 L200 60', 'M0 40 L200 20']);
      // Appearance does not become another series, sum, or approximate accessible value.
      expect(find(mount.container, 'temperature').getAttribute('aria-label')).toContain('Low temperature 2.3456789');
      act(() => find(mount.container, 'temperature-values-toggle').click());
      expect(find(mount.container, 'temperature-values-row-0').getAttribute('aria-label')).toContain('Low temperature: 2.3456789');
      act(() => find(mount.container, 'temperature-bucket-a').click());
      expect(find(mount.container, 'temperature-readout').textContent).toContain('High temperature');
    } finally { mount.unmount(); }
  });
  it('breaks bands at missing, non-finite, or inverted bounds without filling across the gap', () => {
    const lows = [1, 2, null, 1, 5, 2, 3, Number.NaN, 1, 2];
    const highs = [3, 4, 5, 3, 4, 4, 5, 6, 3, 4];
    const input = [lows, highs].map((values, index) => ({ id: index === 0 ? 'low' : 'high', label: index === 0 ? 'Low' : 'High',
      points: values.map((y, x) => ({ id: String(x), x, y })) }));
    const appearance = { bands: [{ id: 'spread', lowerSeriesId: 'low', upperSeriesId: 'high' },
      { id: 'absent', lowerSeriesId: 'low', upperSeriesId: 'absent' }] };
    const mount = mountThroughReactNativeWeb(<BurnUpChart theme={theme} label="Temperature" series={input}
      width={90} viewportHeight={60} plotInset={0} minimumMaximum={6} size="tile" testID="temperature" {...appearance} />);
    try {
      const bands = [...mount.container.querySelectorAll('[data-testid^="temperature-band-"]')];
      expect(bands.map((band) => band.getAttribute('d'))).toEqual([
        'M0 30 L10 20 L10 40 L0 50 Z',
        'M50 20 L60 10 L60 30 L50 40 Z',
        'M80 30 L90 20 L90 40 L80 50 Z',
      ]);
      expect(find(mount.container, 'temperature-bucket-2').getAttribute('aria-label')).toContain('Low —');
      expect(find(mount.container, 'temperature-bucket-4').getAttribute('aria-label')).toContain('Low 5');
    } finally { mount.unmount(); }
  });
  it('composes incumbent line ink around the owner path geometry', () => {
    const input = [{ id: 'water', label: 'Water', points: [{ id: 'a', x: 0, y: 1 }, { id: 'b', x: 2, y: 3 }] }];
    const lineAdapter = { renderLinePath: (path: string, ink: Readonly<{ width: number; height: number; color: string; strokeWidth: number; reducedMotion: boolean }>) =>
      <Svg testID="incumbent-line" width={ink.width} height={ink.height}><Path d={path} stroke={ink.color} strokeWidth={ink.strokeWidth} /></Svg> };
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Water" series={input}
      width={200} viewportHeight={150} strokeWidth={2} variant="line" size="full" testID="water" {...lineAdapter} />);
    try {
      expect(find(mount.container, 'incumbent-line')).toBeTruthy();
      expect(find(mount.container, 'incumbent-line').querySelector('path')?.getAttribute('d')).toBe('M0 99.67 L200 1');
    } finally { mount.unmount(); }
  });
  it('fades area ink inside its supplied scale gutter while controls remain selectable', () => {
      const input = [{ id: 'water', label: 'Water', points: [{ id: 'a', x: 0, y: 1 }, { id: 'b', x: 2, y: 3 }] }];
      const areaAdapter = { renderInk: (ink: ReactNode) => <View testID="incumbent-fade" style={{ opacity: 0 }}>{ink}</View>,
        plotInset: 4, scaleGutter: 40, scaleTicks: [{ value: 1, label: '100%' }, { value: 0.5, label: '50%' }, { value: 0, label: '0%' }] };
      const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Water" series={input} width={200} viewportHeight={150}
        variant="area" size="full" normalized testID="water" {...areaAdapter} />);
    try {
      const fade = find(mount.container, 'incumbent-fade');
      expect(fade).toBeTruthy();
      expect(fade.style.opacity).toBe('0');
      expect(fade.querySelector('svg')?.getAttribute('width')).toBe('160');
      expect(fade.querySelector('path')?.getAttribute('d')).toBe('M0 4 L160 4 L160 146 L0 146 Z');
      expect(fade.contains(find(mount.container, 'water-bucket-a'))).toBe(false);
      expect(mount.container.textContent).toContain('100%');
      act(() => find(mount.container, 'water-bucket-a').click());
      expect(find(mount.container, 'water-readout').textContent).toContain('Water · 1');
    } finally { mount.unmount(); }
  });
  it('keeps native touch targets outside dense glyph geometry with an exact selectable alternative', async () => {
    const points = Array.from({ length: 40 }, (_, index) => ({ id: String(index), x: index, y: index === 0 ? 0.00004 : index }));
    const input = [{ id: 'orders', label: 'Orders', points }];
    const render = (inline: boolean) => <HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'light' }}>
      <StackedSeriesChart theme={theme} width={160} label="Orders" series={input} variant="bar" size={inline ? 'inline' : 'tile'}
        valuesLabel={inline ? undefined : 'Show values'} valuesCollapseLabel="Hide values" testID="orders" />
    </HappierUiPlatformProvider>;
    const mount = mountThroughReactNativeWeb(render(true));
    try {
      expect(mount.container.querySelectorAll('button')).toHaveLength(0);
      expect(find(mount.container, 'orders').getAttribute('aria-label')).toContain('Orders 0.00004');
      expect(find(mount.container, 'orders-bar-0-0')).toBeTruthy();
      await mount.render(render(false));
      expect(mount.container.querySelectorAll('[data-testid^="orders-bucket-"]')).toHaveLength(0);
      act(() => find(mount.container, 'orders-values-toggle').click());
      expect(mount.container.querySelectorAll('[data-testid^="orders-bucket-"]')).toHaveLength(40);
      const first = find(mount.container, 'orders-bucket-0');
      expect(first.style.minWidth).toBe('');
      expect(first.style.minHeight).toBe('');
      expect(first.querySelector(':scope > [data-happier-hit-area="true"]')).toBeNull();
      expect(first.textContent).toContain('Orders 0.00004');
      act(() => first.click());
      expect(find(mount.container, 'orders-readout').textContent).toContain('0.00004');
      act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
      expect(document.activeElement).toBe(find(mount.container, 'orders-bucket-1'));
      await mount.render(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'light' }}>
        <StackedSeriesChart theme={theme} width={200} scaleGutter={120} label="Orders"
          series={[{ ...input[0]!, points: points.slice(0, 2) }]} variant="bar" size="full" testID="orders" />
      </HappierUiPlatformProvider>);
      // Reserved scale space cannot inflate the physical room available to plot controls.
      expect(find(mount.container, 'orders-values')).toBeTruthy();
      expect(find(mount.container, 'orders-values').querySelectorAll('button')).toHaveLength(2);
    } finally { mount.unmount(); }
  });
  it('raises a column as one unit on entrance, never drawing a segment short, and is static with reduced motion', async () => {
    const input = [{ id: 'orders', label: 'Orders', points: [{ id: 'one', x: 1, y: 10 }] }, { id: 'refunds', label: 'Refunds', points: [{ id: 'one', x: 1, y: 5 }] }];
    const motion = { entrance: { durationMs: 30 }, change: { stiffness: 180, damping: 22, mass: 1 } };
    const rises = (testID: string) => animates(find(mount.container, testID));
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Orders" series={input}
      variant="bar" size="full" barMotion={motion} reducedMotion={false} testID="orders" />);
    try {
      // Every segment has its own height on the first frame; the browser moves the stack that holds them together.
      expect(Number.parseFloat(find(mount.container, 'orders-bar-0-0').style.height)).toBeGreaterThan(50);
      expect(Number.parseFloat(find(mount.container, 'orders-bar-0-1').style.height)).toBeGreaterThan(20);
      expect(rises('orders-stack-0')).toBe(true);
      expect(find(mount.container, 'orders-bar-0-1').parentElement).toBe(find(mount.container, 'orders-stack-0'));
      expect(find(mount.container, 'orders-bar-0-0').parentElement).toBe(find(mount.container, 'orders-stack-0'));
      await mount.render(<HappierUiEnvironmentProvider environment={projectHappierUiEnvironment(createSurfaceContextFixture({ reducedMotion: true }))}>
        <StackedSeriesChart theme={theme} label="Orders" series={input} variant="bar" size="full"
          barMotion={motion} reducedMotion={false} testID="orders" />
      </HappierUiEnvironmentProvider>);
      expect(rises('orders-stack-0')).toBe(false);
    } finally { mount.unmount(); }
  });
  it('keeps retained buckets mounted, raises a joining bucket as one unit and drops a segment that joins at its final height', async () => {
    const motion = { change: { stiffness: 180, damping: 22, mass: 1 } };
    const at = (ids: readonly string[], extra = false) => [{ id: 'orders', label: 'Orders', points: ids.map((id) => ({ id, x: id, y: 10 })) },
      ...(extra ? [{ id: 'refunds', label: 'Refunds', points: ids.map((id) => ({ id, x: id, y: 5 })) }] : [])];
    const render = (ids: readonly string[], extra = false) => <StackedSeriesChart theme={theme} label="Orders" series={at(ids, extra)} width={200}
      variant="bar" size="full" barMotion={motion} reducedMotion={false} testID="orders" />;
    const mount = mountThroughReactNativeWeb(render(['b', 'c']));
    try {
      const retained = find(mount.container, 'orders-bar-0-0');
      
      expect(Number.parseFloat(retained.style.height)).toBe(150);
      await mount.render(render(['a', 'b', 'c']));
      // The day that stays is the same mark and does not replay; the day that joins rises whole, at its final height.
      expect(find(mount.container, 'orders-bar-1-0')).toBe(retained);
      expect(animates(find(mount.container, 'orders-stack-1'))).toBe(false);
      expect(Number.parseFloat(find(mount.container, 'orders-bar-0-0').style.height)).toBe(150);
      expect(animates(find(mount.container, 'orders-stack-0'))).toBe(true);
      // A segment joining a column that is already drawn appears at its final height, never as a floating sliver.
      await mount.render(render(['a', 'b', 'c'], true));
      expect(Number.parseFloat(find(mount.container, 'orders-bar-1-1').style.height)).toBeGreaterThan(20);
    } finally { mount.unmount(); }
  });
  it('keys series that look the same once, so many comparable lines read as one legend entry', () => {
    const line = (id: string, label: string, color: string) => ({ id, label, color, points: [0, 1, 2].map((x) => ({ id: String(x), x, y: x + id.length })) });
    const input = [line('now', 'This window', '#2a7'), line('e1', 'Earlier windows', '#999'), line('e22', 'Earlier windows', '#999'), line('e333', 'Earlier windows', '#999')];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Burn" series={input}
      width={200} viewportHeight={100} variant="line" size="full" showLegend testID="burn" />);
    try {
      const leaves = (label: string) => [...mount.container.querySelectorAll('div')].filter((node) => node.childElementCount === 0 && node.textContent === label);
      expect(leaves('This window')).toHaveLength(1);
      expect(leaves('Earlier windows')).toHaveLength(1);
    } finally { mount.unmount(); }
  });

  it('hands a host overlay the plot’s own bucket positions and lets a legend entry be chosen', () => {
    const input = ['one', 'two'].map((id) => ({ id, label: id, points: ['a', 'b', 'c', 'd'].map((point) => ({ id: point, x: point, y: 1 })) }));
    const plots: Readonly<{ width: number; height: number; centers: readonly number[]; buckets: readonly unknown[] }>[] = [];
    const chosen: string[] = [];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Orders" series={input} width={200} viewportHeight={100}
      variant="bar" size="full" barGap={4} scaleGutter={40} testID="orders"
      renderPlotOverlay={(plot) => { plots.push(plot); return <View testID="host-lens" />; }}
      onSeriesPress={(id) => chosen.push(id)} seriesPressLabel={(entry, selected) => `${selected ? 'Show all, not only' : 'Filter to'} ${entry.label}`} selectedSeriesIds={['two']} />);
    try {
      expect(find(mount.container, 'host-lens')).toBeTruthy();
      expect(plots.at(-1)).toMatchObject({ width: 160, height: 100, centers: [18.5, 59.5, 100.5, 141.5] });
      expect(plots.at(-1)!.buckets).toHaveLength(4);
      const entry = find(mount.container, 'orders-series-one');
      expect(entry.getAttribute('aria-label')).toBe('Filter to one');
      expect(find(mount.container, 'orders-series-two').getAttribute('aria-label')).toBe('Show all, not only two');
      act(() => entry.click());
      expect(chosen).toEqual(['one']);
    } finally { mount.unmount(); }
  });
  it('offers every exact series value in the shared table alternative', () => {
    const labelled = series.map((entry) => ({ ...entry, points: entry.points.map((point) => point.id === 'mon' ? { ...point, x: 2.3456789, label: 'Noon' } : point) }));
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Orders" series={labelled}
      width={200} variant="line" size="full" valuesLabel="Show values" valuesCollapseLabel="Hide values" testID="orders" />);
    try {
      expect(find(mount.container, 'orders-values-toggle')).toBeTruthy();
      act(() => find(mount.container, 'orders-values-toggle').click());
      expect(find(mount.container, 'orders-values').getAttribute('role')).toBe('table');
      expect(find(mount.container, 'orders-values-row-0').getAttribute('aria-label')).toContain('Sold: 0.00004');
      expect(find(mount.container, 'orders-bucket-mon').getAttribute('aria-label')).toContain('2.3456789');
      expect(find(mount.container, 'orders-values-row-0').textContent).toContain('2.3456789');
      expect(find(mount.container, 'orders-values-row-1').getAttribute('aria-label')).toContain('Sold: —');
      expect(find(mount.container, 'orders-values-row-2').getAttribute('aria-label')).toContain('Sold: 0');
    } finally { mount.unmount(); }
  });
  it('names what the default Details toggle does once it is open', () => {
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Orders" series={series} variant="line" size="full" testID="orders" />);
    try {
      expect(find(mount.container, 'orders-values-toggle').textContent).toBe('Details');
      act(() => find(mount.container, 'orders-values-toggle').click());
      expect(find(mount.container, 'orders-values-toggle').textContent).toBe('Collapse');
      expect(find(mount.container, 'orders-values-toggle').getAttribute('aria-label')).toBe('Collapse');
    } finally { mount.unmount(); }
  });
  it('selects every series value by press and keyboard, preserving the semantic bucket across resize and reordering', async () => {
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Orders" series={series} variant="bar" size="full" testID="orders" />);
    try {
      expect(find(mount.container, 'orders').getAttribute('aria-label')).toContain('Sold 0.00004');
      act(() => find(mount.container, 'orders-bucket-mon').click());
      expect(find(mount.container, 'orders-readout').textContent).toContain('0.00004');
      act(() => find(mount.container, 'orders-bucket-mon').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
      expect(document.activeElement).toBe(find(mount.container, 'orders-bucket-tue'));
      expect(find(mount.container, 'orders-readout').textContent).toContain('Sold · —');
      act(() => find(mount.container, 'orders-bucket-tue').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
      expect(find(mount.container, 'orders-readout').textContent).toContain('Wed');
      expect(find(mount.container, 'orders-readout').textContent).toContain('Sold · 0');
      await mount.render(<StackedSeriesChart theme={theme} width={390} label="Orders" series={series.map((entry) => ({ ...entry, points: [...entry.points].reverse() }))} variant="bar" size="tile" testID="orders" />);
      expect(document.activeElement).toBe(find(mount.container, 'orders-bucket-wed'));
      await mount.render(<StackedSeriesChart theme={theme} width={390} label="Orders" series={series.map((entry) => ({ ...entry, points: [...entry.points].reverse() }))} variant="area" size="tile" testID="orders" />);
      expect(find(mount.container, 'orders-readout').textContent).toContain('Wed');
      expect(mount.container.querySelectorAll('svg path').length).toBeGreaterThan(0);
    } finally { mount.unmount(); }
  });
  it('keeps all buckets including older points and distinguishes visible zero from missing', () => {
    const points = Array.from({ length: 40 }, (_, index) => ({ id: String(index), x: index, label: `Bucket ${index}`, y: index === 0 ? null : index === 1 ? 0 : index }));
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Orders" series={[{ id: 'orders', label: 'Orders', points }]} variant="bar" size="full"
      showPointLabels summary="Supplied total" renderFrame={(visual) => <View testID="wide-frame">{visual}</View>} testID="orders" />);
    try {
      expect(mount.container.querySelectorAll('[data-testid^="orders-bucket-"]')).toHaveLength(40);
      expect(mount.container.querySelector('[data-testid="orders-bar-0-0"]')).toBeNull();
      const zero = find(mount.container, 'orders-bar-1-0');
      expect(Number.parseFloat(zero.style.top)).toBeLessThan(150);
      expect(Number.parseFloat(zero.style.height)).toBeGreaterThan(0);
      expect(find(mount.container, 'wide-frame').textContent).toContain('Bucket 39');
      expect(find(mount.container, 'wide-frame').textContent).not.toContain('Supplied total');
    } finally { mount.unmount(); }
  });
  it('respects a supplied magnitude floor for tiny costs and keeps zero at the baseline', () => {
    const input = [{ id: 'cost', label: 'Cost', points: [{ id: 'none', x: 0, y: 0 }, { id: 'tiny', x: 1, y: 0.00004 }] }];
    const options = { minimumMaximum: 1 };
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Cost" series={input} variant="bar"
      width={100} viewportHeight={150} size="full" barMinHeight={10} {...options} testID="cost" />);
    try {
      expect(Number.parseFloat(find(mount.container, 'cost-bar-0-0').style.top)).toBe(140);
      expect(Number.parseFloat(find(mount.container, 'cost-bar-1-0').style.height)).toBe(10);
      expect(find(mount.container, 'cost').getAttribute('aria-label')).toContain('Cost 0.00004');
    } finally { mount.unmount(); }
  });
  it('washes an area under its own edge line when the series asks for a wash', () => {
    const input = [{ id: 'cpu', label: 'CPU', color: theme.colors.accent, fillOpacity: 0.08, points: [2, 6].map((y, x) => ({ id: String(x), x, y })) }];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="CPU, last hour" series={input}
      width={200} viewportHeight={100} plotInset={0} minimumMaximum={10} variant="area" size="tile" testID="cpu" />);
    try {
      const paths = [...mount.container.querySelectorAll('svg path')];
      expect(paths).toHaveLength(2);
      const [wash, edge] = paths;
      expect(wash!.getAttribute('fill')).toBe(theme.colors.accent);
      expect(wash!.getAttribute('fill-opacity')).toBe('0.08');
      expect(wash!.getAttribute('d')).toBe('M0 80 L200 40 L200 100 L0 100 Z');
      expect(edge!.getAttribute('fill')).toBe('none');
      expect(edge!.getAttribute('stroke')).toBe(theme.colors.accent);
      expect(edge!.getAttribute('d')).toBe('M0 80 L200 40');
    } finally { mount.unmount(); }
  });
  it('keeps the wash under each run of a washed history that gaps break, with the edge line over it', () => {
    const input = [{ id: 'cpu', label: 'CPU', color: theme.colors.accent, fillOpacity: 0.08,
      points: [2, 4, 6, 4, 2, null, 2, 4, 6, 4].map((y, x) => ({ id: String(x), x, y })) }];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="CPU, last hour" series={input}
      width={180} viewportHeight={100} plotInset={0} minimumMaximum={10} variant="area" size="tile" testID="cpu" />);
    try {
      const paths = [...mount.container.querySelectorAll('svg path')];
      const washes = paths.filter(path => path.getAttribute('fill') === theme.colors.accent);
      expect(washes).toHaveLength(2);
      expect(washes.every(path => path.getAttribute('fill-opacity') === '0.08' && path.getAttribute('d')?.endsWith('Z'))).toBe(true);
      // Each run is edged by its own line; nothing bridges the missing sample.
      expect(paths.filter(path => path.getAttribute('fill') === 'none' && path.getAttribute('stroke') === theme.colors.accent)).toHaveLength(2);
      expect(mount.container.querySelectorAll('line')).toHaveLength(0);
    } finally { mount.unmount(); }
  });
  it('holds a supplied value domain so a zoomed line keeps its honest floor', () => {
    const input = [{ id: 'memory', label: 'Memory', points: [55, 60].map((y, x) => ({ id: String(x), x, y })) }];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Memory in use" series={input}
      width={200} viewportHeight={100} plotInset={0} variant="line" size="tile" fitLine domain={{ min: 50, max: 60 }} testID="memory" />);
    try {
      expect([...mount.container.querySelectorAll('svg path')].map((path) => path.getAttribute('d'))).toEqual(['M0 50 L200 0']);
    } finally { mount.unmount(); }
  });
  it('inks each run of points in the colour its points carry, joined at the shared point', () => {
    const tone = theme.colors.danger;
    const input = [{ id: 'memory', label: 'Memory', color: theme.colors.accent,
      points: [2, 4, 6, 8, 4].map((y, x) => ({ id: String(x), x, y, ...(x === 2 || x === 3 ? { color: tone } : {}) })) }];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Memory in use" series={input}
      width={200} viewportHeight={100} plotInset={0} minimumMaximum={10} variant="line" size="tile" testID="memory" />);
    try {
      const paths = [...mount.container.querySelectorAll('svg path')];
      expect(paths.map((path) => [path.getAttribute('d'), path.getAttribute('stroke')])).toEqual([
        ['M0 80 L50 60', theme.colors.accent],
        ['M50 60 L100 40 L150 20', tone],
        ['M150 20 L200 60', theme.colors.accent],
      ]);
      // The exact values are unchanged by ink.
      expect(find(mount.container, 'memory-bucket-2').getAttribute('aria-label')).toContain('Memory 6');
    } finally { mount.unmount(); }
  });
});

describe('uncoloured series ramp', () => {
  it('draws two uncoloured lines far enough apart on the accent ramp to tell apart', async () => {
    const { resolveHappierSeriesRampColor } = await import('./dataModel.js');
    const input = [
      { id: 'sonnet', label: 'Sonnet', points: [4, 6, 5].map((y, x) => ({ id: String(x), x, y })) },
      { id: 'haiku', label: 'Haiku', points: [1, 2, 3].map((y, x) => ({ id: String(x), x, y })) },
    ];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Tokens" series={input}
      width={200} viewportHeight={100} variant="line" size="tile" testID="ramp" />);
    try {
      const strokes = [...mount.container.querySelectorAll('path')].map(path => path.getAttribute('stroke')).filter(Boolean);
      expect(strokes).toContain(resolveHappierSeriesRampColor(theme.colors.accent, theme.colors.surface, 0));
      expect(strokes).toContain(resolveHappierSeriesRampColor(theme.colors.accent, theme.colors.surface, 4));
      expect(strokes).not.toContain(resolveHappierSeriesRampColor(theme.colors.accent, theme.colors.surface, 1));
    } finally { mount.unmount(); }
  });
});

describe('few-bucket bar columns', () => {
  it('keeps a full chart column at its readable width however few buckets share the plot', async () => {
    const { HAPPIER_DATA_METRICS } = await import('./dataText.js');
    const input = [{ id: 'orders', label: 'Orders', points: [{ id: 'mon', x: 'Mon', y: 17 }, { id: 'tue', x: 'Tue', y: 19 }] }];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Orders" series={input}
      width={600} viewportHeight={120} variant="bar" size="full" testID="few" />);
    try {
      const column = find(mount.container, 'few-stack-0').parentElement!;
      expect(getComputedStyle(column).maxWidth).toBe(`${HAPPIER_DATA_METRICS.barMaxWidthPx}px`);
    } finally { mount.unmount(); }
  });
  it('sets an indexed axis tick under its own bar, not at a third of the width', () => {
    const input = [{ id: 'hours', label: 'Hours', points: Array.from({ length: 24 }, (_, hour) => ({ id: `h${hour}`, x: hour, y: hour })) }];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="By hour" series={input}
      width={240} viewportHeight={60} variant="bar" size="tile" testID="hours" axisTicks={[{ label: '6A', bucket: 6 }, { label: '12P', bucket: 12 }]} />);
    try {
      const axis = (index: number) => find(mount.container, `hours-axis-${index}`);
      expect(axis(6).textContent).toBe('6A');
      expect(axis(12).textContent).toBe('12P');
      expect(axis(7).textContent).toBe('');
      expect(axis(6).parentElement!.children).toHaveLength(24);
    } finally { mount.unmount(); }
  });
  it('centres an edge bar tick under its bar when the slot is wide, so a two-bar chart names each bar', () => {
    const input = [{ id: 'a', label: 'QA A', points: [{ id: 'q1', x: 0, y: 3, label: 'QA 1' }, { id: 'q2', x: 1, y: 2, label: 'QA 2' }] }];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Two" series={input}
      width={480} viewportHeight={60} variant="bar" size="tile" testID="two" />);
    try {
      const label = (index: number) => find(mount.container, `two-axis-${index}`).firstElementChild as HTMLElement;
      expect(label(0).textContent).toBe('QA 1');
      expect(label(1).textContent).toBe('QA 2');
      expect([label(0).style.textAlign, label(1).style.textAlign]).toEqual(['center', 'center']);
      expect([label(0).style.left, label(0).style.right]).toEqual(['0px', '0px']);
    } finally { mount.unmount(); }
  });
  it('places plain string ticks on buckets (first on the first, last on the last), never between bars', () => {
    const input = [{ id: 'days', label: 'Days', points: Array.from({ length: 7 }, (_, day) => ({ id: `d${day}`, x: day, y: day + 1 })) }];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Daily" series={input}
      width={280} scaleGutter={40} viewportHeight={60} variant="bar" size="tile" testID="days" axisTicks={['Oct 12', 'Oct 15', 'Oct 18']} />);
    try {
      const axis = (index: number) => find(mount.container, `days-axis-${index}`);
      expect([0, 3, 6].map((index) => axis(index).textContent)).toEqual(['Oct 12', 'Oct 15', 'Oct 18']);
      expect([1, 2, 4, 5].map((index) => axis(index).textContent)).toEqual(['', '', '', '']);
      // The slots share the plot's width, which stops short of the scale gutter.
      const slots = axis(0).parentElement!;
      expect(Number.parseFloat(getComputedStyle(slots).paddingRight)).toBe(40);
    } finally { mount.unmount(); }
  });
  it('sets a bucket tick at that bucket on a line, and the default ends on the first and last bucket', () => {
    const input = [{ id: 'cpu', label: 'CPU', points: [0, 1, 2, 3, 4].map((x) => ({ id: `p${x}`, x, y: x })) }];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="CPU" series={input}
      width={240} viewportHeight={60} variant="line" size="tile" testID="line" axisTicks={[{ label: 'start', bucket: 0 }, { label: 'mid', bucket: 2 }, { label: 'end', bucket: 4 }]} />);
    try {
      const axis = (index: number) => find(mount.container, `line-axis-${index}`);
      const middle = axis(2);
      expect(middle.textContent).toBe('mid');
      expect(Number.parseFloat(middle.style.left) + Number.parseFloat(middle.style.width) / 2).toBe(120);
      expect(axis(0).textContent).toBe('start');
      expect(axis(4).textContent).toBe('end');
      expect(axis(4).style.right).toBe('0px');
    } finally { mount.unmount(); }
  });
  it('without ticks names the first and last bucket at the plot edges', () => {
    const input = [{ id: 'cpu', label: 'CPU', points: [0, 1, 2, 3].map((x) => ({ id: `p${x}`, x, y: x, label: `t${x}` })) }];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="CPU" series={input}
      width={200} viewportHeight={60} variant="area" size="tile" testID="ends" />);
    try {
      expect([0, 1, 2, 3].map((index) => find(mount.container, `ends-axis-${index}`)?.textContent)).toEqual(['t0', undefined, undefined, 't3']);
    } finally { mount.unmount(); }
  });
});

describe('default series colour', () => {
  it('draws unnamed series in the host data accent ramp, never the action ink', () => {
    const dataTheme = { ...theme, colors: { ...theme.colors, accent: '#111111', dataAccent: '#2BACCC' } };
    const input = [
      { id: 'copper', label: 'Copper', points: [{ id: 'mon', x: 'Mon', y: 4 }] },
      { id: 'silver', label: 'Silver', points: [{ id: 'mon', x: 'Mon', y: 3 }] },
    ];
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={dataTheme} label="Metals" width={160} viewportHeight={60}
      series={input} variant="bar" size="full" testID="palette" />);
    try {
      const first = getComputedStyle(find(mount.container, 'palette-bar-0-0')).backgroundColor;
      const second = getComputedStyle(find(mount.container, 'palette-bar-0-1')).backgroundColor;
      expect(first).toBe('rgb(43, 172, 204)');
      expect(second).not.toBe(first);
      expect(second).not.toMatch(/^rgb\(17, 17, 17\)$/u);
    } finally { mount.unmount(); }
  });
  it('keeps the accent for a host snapshot that names no data accent', () => {
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Metals" width={160} viewportHeight={60}
      series={[{ id: 'copper', label: 'Copper', points: [{ id: 'mon', x: 'Mon', y: 4 }] }]} variant="bar" size="full" testID="fallback" />);
    try {
      const probe = document.createElement('div'); probe.style.backgroundColor = theme.colors.accent; document.body.append(probe);
      expect(getComputedStyle(find(mount.container, 'fallback-bar-0-0')).backgroundColor).toBe(getComputedStyle(probe).backgroundColor);
      probe.remove();
    } finally { mount.unmount(); }
  });
});
