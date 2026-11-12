import { expect, it } from 'vitest';
import { BurnUpChart, StackedSeriesChart } from '@happier-dev/plugin-ui/components';
import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { act } from 'react';
import { buildPublicSessionDeclarativeView } from '../../../../../apps/server/sources/app/api/routes/share/publicDeclarativeViewer.js';
import { externalChartVisual } from '../../../fixtures/external-authoring/src/sessionVisuals.js';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { HappierUiPlatformProvider } from '../../environment/context.js';

it.each(['web', 'ios'] as const)('retains units, exact precision, zero and unknown in %s series Details', platform => {
  for (const units of [
    { label: 'Cost', value: 30.05874, exact: '30.05874', format: (value: number) => `$${value.toFixed(2)}`, unit: '$' },
    { label: 'Tokens', value: 4186010, exact: '4,186,010', format: (value: number) => `${value === 0 ? '0' : '4.2M'} tokens`, unit: 'tokens' },
  ]) {
    const view = mountThroughReactNativeWeb(<HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
      <StackedSeriesChart theme={theme} label={units.label} variant="bar" size="full" width={30} testID="unit-series"
        unknownLabel="Not received" valueFormatter={units.format} formattedReadings
        series={[{ id: 'measured', label: 'Measured', points: [
          { id: 'amount', x: 'Amount', y: units.value }, { id: 'zero', x: 'Zero', y: 0 }, { id: 'unknown', x: 'Unknown', y: null },
        ] }]} />
    </HappierUiPlatformProvider>);
    try {
      act(() => view.container.querySelector<HTMLElement>('[data-testid="unit-series-values-toggle"]')!.click());
      const values = view.container.querySelector<HTMLElement>('[data-testid="unit-series-values"]')!;
      const rows = [...values.querySelectorAll<HTMLElement>('[role="row"], [role="button"]')];
      const amount = rows.find(row => row.getAttribute('aria-label')?.includes('Amount'))!;
      const zero = rows.find(row => row.getAttribute('aria-label')?.includes('Zero'))!;
      const unknown = rows.find(row => row.getAttribute('aria-label')?.includes('Unknown'))!;
      expect(amount.getAttribute('aria-label')).toContain(units.exact);
      expect(amount.getAttribute('aria-label')).toContain(units.unit);
      expect(zero.getAttribute('aria-label')).toContain(units.format(0));
      expect(unknown.getAttribute('aria-label')).toContain('Not received');
    } finally { view.unmount(); }
  }
});

it.each(['bar', 'line', 'area'] as const)('renders the same native and Session declarative %s series with identical geometry, exact values and accessibility', variant => {
  const root = { ...externalChartVisual.item.source.document.root, style: variant };
  const admission = getActionSpec('session.board.item.upsert').inputSchema;
  expect(admission.safeParse(externalChartVisual).success).toBe(true);
  expect(admission.safeParse({ ...externalChartVisual, destination: 'board',
    placement: { tabId: 'overview', width: 'full' } }).success).toBe(true);
  const native = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Rainfall" variant={variant} size="full" testID="native"
    series={[{ id: 'North', label: 'North', points: [{ id: '"Thu"', x: 'Thu', y: 0.00004 }] },
      { id: 'South', label: 'South', points: [{ id: '"Thu"', x: 'Thu', y: 7 }, { id: '"Fri"', x: 'Fri', y: 0 }] }]} />);
  const declarative = mountThroughReactNativeWeb(buildPublicSessionDeclarativeView({ version: 1, root }, theme));
  try {
    const chart = declarative.container.querySelector('[data-testid="plugin-declarative-chart"]')!;
    for (const container of [native.container, declarative.container]) {
      const measured = container.querySelector<HTMLElement & { __reactLayoutHandler: (event: HappierLayoutChangeEvent) => void }>(
        '[data-testid="native"], [data-testid="plugin-declarative-chart"]',
      )!;
      act(() => measured.__reactLayoutHandler({ nativeEvent: { layout: { x: 0, y: 0, width: 180, height: 150 } } }));
    }
    for (const svg of native.container.querySelectorAll('svg')) expect(svg.getAttribute('aria-hidden')).toBe('true');
    const ink = (container: HTMLElement) => variant === 'bar'
      ? [...container.querySelectorAll<HTMLElement>('[data-testid*="-bar-"]')].map(bar => [bar.style.top, bar.style.height])
      : [...container.querySelectorAll('svg path')].map(path => path.getAttribute('d'));
    expect(ink(declarative.container)).toEqual(ink(native.container));
    expect(chart.getAttribute('aria-label')).toBe(native.container.querySelector('[data-testid="native"]')!.getAttribute('aria-label'));
    for (const container of [native.container, declarative.container]) {
      act(() => container.querySelector<HTMLElement>('[data-testid$="-values-toggle"]')!.click());
    }
    const rows = (container: HTMLElement) => [...container.querySelectorAll('[data-testid*="-values-row-"]')].map(row => row.getAttribute('aria-label'));
    expect(rows(declarative.container)).toEqual(rows(native.container));
    expect(rows(declarative.container).join(';')).toContain('North: 0.00004');
    expect(rows(declarative.container).join(';')).toContain('North: —');
    expect(rows(declarative.container).join(';')).toContain('South: 0');
  } finally { native.unmount(); declarative.unmount(); }
});

it('reads an authored x/y document as the same N=1 chart, including the exact table', () => {
  const root = { kind: 'chart', label: 'Rainfall', style: 'line', rows: [],
    x: { path: ['day'], type: 'string' }, y: { path: ['rain'], type: 'number' },
    data: { kind: 'value', value: [{ day: 'Thu', rain: 0.00004 }, { day: 'Fri', rain: 0 }] } };
  const native = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Rainfall" variant="line" size="full" testID="native"
    series={[{ id: 'value', label: 'Rainfall', points: [{ id: '0', x: 'Thu', y: 0.00004 }, { id: '1', x: 'Fri', y: 0 }] }]} />);
  const declarative = mountThroughReactNativeWeb(buildPublicSessionDeclarativeView({ version: 1, root }, theme));
  try {
    const chart = declarative.container.querySelector('[data-testid="plugin-declarative-chart"]')!;
    const nativeChart = native.container.querySelector('[data-testid="native"]')!;
    expect(chart.getAttribute('aria-label')).toBe(nativeChart.getAttribute('aria-label'));
    expect(chart.getAttribute('role')).toBe(nativeChart.getAttribute('role'));
    for (const container of [native.container, declarative.container]) act(() => container.querySelector<HTMLElement>('[data-testid$="-values-toggle"]')!.click());
    const rows = (container: HTMLElement) => [...container.querySelectorAll('[data-testid*="-values-row-"]')].map(row => row.getAttribute('aria-label'));
    expect(rows(declarative.container)).toEqual(rows(native.container));
  } finally { native.unmount(); declarative.unmount(); }
});

it('renders an unrelated public author dataset with exact numerical semantics', () => {
  const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Rainfall" variant="bar" size="tile"
    series={[{ id: 'rainfall', label: 'Millimetres', points: [{ id: 'thu', x: 'Thu', y: 0.00004 }, { id: 'fri', x: 'Fri', y: null }] }]} />);
  try { expect(mount.container.querySelector('[aria-label*="Millimetres 0.00004"]')).not.toBeNull(); }
  finally { mount.unmount(); }
});

it('draws supplied observed, projected and target facts without calculating a forecast', () => {
  const mount = mountThroughReactNativeWeb(<BurnUpChart theme={theme} label="Water budget" width={180} size="tile"
    series={[
      { id: 'observed', label: 'Observed', points: [{ id: 'day1', x: 1, y: 10 }, { id: 'day2', x: 2, y: 16 }] },
      { id: 'projection', label: 'Projected', lineStyle: 'dashed', points: [{ id: 'day2', x: 2, y: 16 }, { id: 'day3', x: 3, y: 25 }] },
      { id: 'target', label: 'Target', lineStyle: 'dotted', points: [{ id: 'day1', x: 1, y: 25 }, { id: 'day2', x: 2, y: 25 }, { id: 'day3', x: 3, y: 25 }] },
    ]} />);
  try {
    expect(mount.container.querySelectorAll('svg path')).toHaveLength(3);
    expect(mount.container.querySelector('path[stroke-dasharray="4,4"]')).not.toBeNull();
    expect(mount.container.querySelector('[aria-label*="Projected 25"]')).not.toBeNull();
    expect(mount.container.querySelector('[aria-label*="Observed —"]')).not.toBeNull();
  } finally { mount.unmount(); }
});
