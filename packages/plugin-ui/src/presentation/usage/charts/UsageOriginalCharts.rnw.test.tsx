import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { HappierText } from '../../text/Text.js';
import type { HappierLayoutChangeEvent } from '../../portableTypes.js';
import { UsageDailyChart } from './UsageDailyChart.js';
import { UsageRhythmChart, type UsageRhythmChartProps } from './UsageRhythmChart.js';

const levels = ['No activity', 'Quiet', 'Steady', 'Busy', 'Busiest'];
const cells = [
  { id: 'known', row: 'day', column: 'one', label: 'Monday', value: 4, valueLabel: 'Busiest' },
  { id: 'missing', row: 'day', column: 'two', label: 'Tuesday', value: null, valueLabel: 'Not recorded' },
];
const series = [{ id: 'levels', label: 'Activity level', color: '#007aff', points: cells.map(cell => ({ id: cell.id, x: cell.label, y: cell.value })) }];
const rhythm: UsageRhythmChartProps = {
  label: 'Work rhythm', values: { show: 'Exact values', hide: 'Hide values', valueColumn: 'Activity level' },
  theme, testID: 'rhythm', spacing: { body: 12, blocks: 20, block: 8 },
  headings: { calendar: <HappierText>Active days</HappierText>, weekdayHour: <HappierText>Weekday and hour</HappierText>, byHour: <HappierText>By hour</HappierText> },
  calendar: { label: 'Calendar levels', unknownLabel: 'Not recorded', cells, rows: [{ id: 'day', label: '' }], columns: [{ id: 'one', label: '' }, { id: 'two', label: '' }] },
  punch: { label: 'Punch levels', unknownLabel: 'Not recorded', cells, rows: [{ id: 'day', label: '' }], columns: [{ id: 'one', label: '' }, { id: 'two', label: '' }] },
  hours: { label: 'Hourly levels', series, variant: 'bar', size: 'tile', width: 300, valueFormatter: value => levels[value] ?? 'Not recorded' },
};

describe('Original shared Usage forms', () => {
  it.each([320, 430])('offers one exact-values path for every visible rhythm mark at width %s', width => {
    const mount = mountThroughReactNativeWeb(<UsageRhythmChart {...rhythm} width={width} />);
    try {
      expect(mount.container.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
      const toggle = mount.container.querySelector<HTMLButtonElement>('[aria-label="Work rhythm · Exact values"]');
      expect(toggle).not.toBeNull();
      act(() => toggle!.click());
      const table = mount.container.querySelector('[role="table"]');
      expect(table?.textContent).toContain('Monday');
      expect(table?.textContent).toContain('Busiest');
      expect(table?.textContent).toContain('Not recorded');
    } finally { mount.unmount(); }
  });
  it('renders Daily ordinal data without turning unknown into zero or levels into amounts', () => {
    const mount = mountThroughReactNativeWeb(<UsageDailyChart theme={theme} testID="daily" gap={10}
      chart={{ label: 'Daily activity levels', series, size: 'tile', width: 300, valueFormatter: value => levels[value] ?? 'Not recorded' }} />);
    try {
      const chart = mount.container.querySelector('[data-testid="daily.chart"]')!;
      expect(chart).not.toBeNull();
      expect(chart.getAttribute('aria-label')).toContain('Monday: Activity level 4');
      expect(chart.getAttribute('aria-label')).toContain('Tuesday: Activity level Not reported');
      expect(chart.getAttribute('aria-label')).not.toMatch(/tokens|events|hours/u);
    } finally { mount.unmount(); }
  });

  it.each([430, 1000])('retains calendar and punch levels with their unknown labels at width %s', width => {
    const mount = mountThroughReactNativeWeb(<UsageRhythmChart {...rhythm} width={width} />);
    try {
      expect(mount.container.querySelector('[data-testid="rhythm.calendar"]')).not.toBeNull();
      expect(mount.container.querySelector('[data-testid="rhythm.punchcard"]')).not.toBeNull();
      expect(mount.container.querySelector('[data-testid="rhythm.hours"]')).toBeNull();
      expect(mount.container.textContent).toContain('Weekday and hour');
      act(() => mount.container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click());
      const table = mount.container.querySelector('[role="table"]')!;
      expect(table.textContent).toContain('MondayBusiest');
      expect(table.textContent).toContain('TuesdayNot recorded');
    } finally { mount.unmount(); }
  });

  it('uses the host-projected hour strip on phones and keeps a punch-only form legible', () => {
    const mount = mountThroughReactNativeWeb(<UsageRhythmChart {...rhythm} calendar={undefined} width={320} />);
    try {
      expect(mount.container.querySelector('[data-testid="rhythm.calendar"]')).toBeNull();
      expect(mount.container.querySelector('[data-testid="rhythm.punchcard"]')).toBeNull();
      expect(mount.container.querySelector('[data-testid="rhythm.hours"]')).not.toBeNull();
      expect(mount.container.textContent).toContain('By hour');
      expect(mount.container.querySelector('[data-testid="rhythm.hours"]')!.getAttribute('aria-label')).toContain('Monday: Activity level 4');
    } finally { mount.unmount(); }
  });

  it('measures an interactive host without a fixed width and recomposes its admitted punch levels', () => {
    const mount = mountThroughReactNativeWeb(<UsageRhythmChart {...rhythm} />);
    try {
      // The unmeasured (including cold SSR) form stays a matrix until the platform reports its box.
      expect(mount.container.querySelector('[data-testid="rhythm.punchcard"]')).not.toBeNull();
      const body = mount.container.querySelector('[data-testid="rhythm.rhythm"]')!;
      const onLayout = (body as unknown as { __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void }).__reactLayoutHandler;
      expect(onLayout).toBeTypeOf('function');
      for (const width of [320, 430, 320]) {
        act(() => onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width, height: 200 } } }));
        expect(mount.container.querySelector('[data-testid="rhythm.punchcard"]') !== null).toBe(width >= 360);
        expect(mount.container.querySelector('[data-testid="rhythm.hours"]') !== null).toBe(width < 360);
      }
    } finally { mount.unmount(); }
  });
});
