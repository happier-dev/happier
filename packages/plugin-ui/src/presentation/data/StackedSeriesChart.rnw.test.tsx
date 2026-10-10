import { act, type ReactNode } from 'react';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContextFixture, SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { StackedSeriesChart } from './StackedSeriesChart.js';
import { HappierUiEnvironmentProvider, HappierUiPlatformProvider } from '../../environment/context.js';
import { projectHappierUiEnvironment } from '../../environment/projectEnvironment.js';
import { View } from 'react-native';
import { Path, Svg } from 'react-native-svg';

// RNW selects its instant AnimatedMock in NODE_ENV=test. Exercise its actual JS animation driver.
vi.hoisted(() => { process.env.NODE_ENV = 'development'; });
afterAll(() => { process.env.NODE_ENV = 'test'; });

const series = [
  { id: 'sold', label: 'Sold', points: [{ id: 'mon', x: 'Mon', y: 0.00004 }, { id: 'tue', x: 'Tue', y: null }, { id: 'wed', x: 'Wed', y: 0 }] },
  { id: 'returned', label: 'Returned', points: [{ id: 'mon', x: 'Mon', y: 2 }, { id: 'tue', x: 'Tue', y: 1 }, { id: 'wed', x: 'Wed', y: 0 }] },
];
const find = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
describe('neutral series dataset', () => {
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
      expect(first.style.minWidth).toBe('48px');
      expect(first.style.minHeight).toBe('48px');
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
  it('grows a bar once but renders its final value statically with reduced motion', async () => {
    const input = [{ id: 'orders', label: 'Orders', points: [{ id: 'one', x: 1, y: 10 }] }];
    const motion = { entrance: { durationMs: 30 }, change: { stiffness: 180, damping: 22, mass: 1 } };
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Orders" series={input}
      variant="bar" size="full" barMotion={motion} reducedMotion={false} testID="orders" />);
    try {
      expect(Number.parseFloat(find(mount.container, 'orders-bar-0-0').style.height)).toBe(0);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
      expect(Number.parseFloat(find(mount.container, 'orders-bar-0-0').style.height)).toBeGreaterThan(100);
      await mount.render(<HappierUiEnvironmentProvider environment={projectHappierUiEnvironment(createSurfaceContextFixture({ reducedMotion: true }))}>
        <StackedSeriesChart theme={theme} label="Orders" series={input} variant="bar" size="full"
          barMotion={motion} reducedMotion={false} testID="orders" />
      </HappierUiEnvironmentProvider>);
      expect(Number.parseFloat(find(mount.container, 'orders-bar-0-0').style.height)).toBe(150);
      await mount.render(<StackedSeriesChart theme={theme} label="Orders" series={input}
        variant="bar" size="full" barMotion={motion} reducedMotion testID="orders" />);
      expect(Number.parseFloat(find(mount.container, 'orders-bar-0-0').style.height)).toBeGreaterThan(100);
    } finally { mount.unmount(); }
  });
  it('keeps retained buckets mounted and grows joining buckets from the baseline on a period change', async () => {
    const motion = { change: { stiffness: 180, damping: 22, mass: 1 } };
    const at = (ids: readonly string[]) => [{ id: 'orders', label: 'Orders', points: ids.map((id) => ({ id, x: id, y: 10 })) }];
    const render = (ids: readonly string[]) => <StackedSeriesChart theme={theme} label="Orders" series={at(ids)} width={200}
      variant="bar" size="full" barMotion={motion} reducedMotion={false} testID="orders" />;
    const mount = mountThroughReactNativeWeb(render(['b', 'c']));
    try {
      const retained = find(mount.container, 'orders-bar-0-0');
      expect(Number.parseFloat(retained.style.height)).toBe(150);
      await mount.render(render(['a', 'b', 'c']));
      // The day that stays is the same mark; the day that joins rises from the axis.
      expect(find(mount.container, 'orders-bar-1-0')).toBe(retained);
      expect(Number.parseFloat(find(mount.container, 'orders-bar-0-0').style.height)).toBe(0);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
      expect(Number.parseFloat(find(mount.container, 'orders-bar-0-0').style.height)).toBeGreaterThan(100);
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
      variant="line" size="full" valuesLabel="Show values" valuesCollapseLabel="Hide values" testID="orders" />);
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
});
