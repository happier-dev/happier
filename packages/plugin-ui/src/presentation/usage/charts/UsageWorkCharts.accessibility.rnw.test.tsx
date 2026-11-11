import { act } from 'react';
import { expect, it } from 'vitest';
import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { ChartInteractionProvider } from '../../data/ChartDatum.js';
import { UsageRunLength, UsageSteeringTide } from './UsageWorkCharts.js';

const common = { theme, paint: { accent: '#007aff', paper: '#fff', dark: false }, width: 390,
  agents: [{ id: 'codex', name: 'Codex', color: '#007aff' }], testID: 'chart' };

// The host presentation boundary implements the existing datum keyboard contract.
const renderDatum = (datum: import('../../data/ChartDatum.js').HappierChartDatum, visual: import('react').ReactNode) =>
  <button tabIndex={datum.keyboard === false ? -1 : 0} aria-hidden={datum.keyboard === false || undefined}
    aria-label={`${datum.label}: ${datum.value}`}>{visual}</button>;

it('gives Human loop one exact-values entry while retaining hourly pointer targets', () => {
  const chart = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={renderDatum}>
    <UsageSteeringTide {...common} label="Human loop" model={{ night: null, rows: Array.from({ length: 20 }, (_, index) => ({
      agentId: `agent-${index}`, steersByHour: Array(24).fill(2), phoneAnswersByHour: Array(24).fill(1),
      steers: 48, busyMs: 3600000, perBusyHour: 48, phoneAnswers: 24,
    })) }} labels={{ clock: hour => `${hour}:00`, unknownAgent: 'Unknown', perBusyHourHeader: 'Steers per busy hour',
      fromPhoneHeader: 'From phone', perBusyHourUnit: 'per busy hour', answers: 'answers', rate: String, count: String,
      detail: steers => `${steers} steers`, caption: 'Accepted steering',
      values: { show: 'Exact values', hide: 'Hide values', agentColumn: 'Agent and hour', steersColumn: 'Steers' } }} />
  </ChartInteractionProvider>);
  try {
    const stops = [...chart.container.querySelectorAll<HTMLElement>('button,[role="button"]')].filter(button => button.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.getAttribute('aria-label')).toContain('Human loop');
    expect(stops[0]!.getAttribute('aria-label')).toContain('Exact values');
    act(() => stops[0]!.focus());
    expect(document.activeElement).toBe(stops[0]);
    expect(chart.container.querySelectorAll('button[tabindex="-1"]')).toHaveLength(480);
    act(() => stops[0]!.click());
    expect(chart.container.querySelector('[role="table"]')?.getAttribute('aria-label')).toBe('Human loop');
    expect(chart.container.textContent).toContain('agent-19 · 23:00');
  } finally { chart.unmount(); }
});

it('gives Run-length one exact-values keyboard entry regardless of distribution size', () => {
  const chart = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={renderDatum}>
    <UsageRunLength {...common} label="Run-length" model={{ openCount: 0, croppedCount: 0, rows: Array.from({ length: 20 }, (_, index) => ({
      agentId: `agent-${index}`, samples: 40, medianMs: 60000, p90Ms: 120000, durationsMs: Array.from({ length: 40 }, (_, dot) => (dot + 1) * 10000),
    })) }} labels={{ duration: ms => `${ms / 1000} seconds`, unknownAgent: 'Unknown', detail: (ms, n) => `${ms} ms · ${n}`,
      ticks: { minute: '1m', tenMinutes: '10m', hour: '1h', fourHours: '4h' }, caption: 'Closed turns',
      values: { show: 'Exact values', hide: 'Hide values', agentColumn: 'Agent', medianColumn: 'Median', p90Column: 'p90', samplesColumn: 'Samples', formatCount: String } }} />
  </ChartInteractionProvider>);
  try {
    const stops = [...chart.container.querySelectorAll<HTMLElement>('button,[role="button"]')].filter(button => button.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.getAttribute('aria-label')).toContain('Exact values');
    expect(chart.container.querySelectorAll('button[tabindex="-1"]')).toHaveLength(840);
    act(() => stops[0]!.focus());
    expect(document.activeElement).toBe(stops[0]);
    act(() => stops[0]!.click());
    expect(stops[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(chart.container.querySelector('[role="table"]')?.getAttribute('aria-label')).toBe('Run-length');
    expect(chart.container.textContent).toContain('60 seconds');
    expect(chart.container.querySelector('[role="table"]')?.textContent).toContain('400000');
  } finally { chart.unmount(); }
});
