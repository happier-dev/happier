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
      detail: steers => `${steers} steers`, caption: 'Accepted steering', unsteered: names => names.join(', '),
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

it('draws only the steered Agents, folds the busy rest into one line, and keeps every Agent in the values', () => {
  // USAGE-ACCEPT 1121 #5: sixteen flat lanes and a sixteen-row figure column for one Agent steered 0.1 an hour.
  const quiet = (agentId: string) => ({ agentId, steersByHour: Array(24).fill(0), phoneAnswersByHour: Array(24).fill(0),
    steers: 0, busyMs: 3600000, perBusyHour: 0, phoneAnswers: 0 });
  const chart = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={renderDatum}>
    <UsageSteeringTide {...common} width={1200} label="Human loop" model={{ night: null, rows: [
      { agentId: 'muse', steersByHour: Array.from({ length: 24 }, (_, hour) => hour === 9 ? 1 : 0), phoneAnswersByHour: Array(24).fill(0),
        steers: 1, busyMs: 36000000, perBusyHour: 0.1, phoneAnswers: 0 },
      quiet('claude'), quiet('codex'), quiet('grok'), quiet('kimi'),
    ] }} labels={{ clock: hour => `${hour}:00`, unknownAgent: 'Unknown', perBusyHourHeader: 'Steers per busy hour',
      fromPhoneHeader: 'From phone', perBusyHourUnit: 'per busy hour', answers: 'answers', rate: String, count: String,
      detail: steers => `${steers} steers`, caption: 'Accepted steering', unsteered: names => `Not steered: ${names.join(', ')}`,
      values: { show: 'Exact values', hide: 'Hide values', agentColumn: 'Agent and hour', steersColumn: 'Steers' } }} />
  </ChartInteractionProvider>);
  try {
    // One drawn lane: its 24 hourly pointer targets, and one figures row.
    expect(chart.container.querySelectorAll('button[tabindex="-1"]')).toHaveLength(24);
    expect(chart.container.textContent).toContain('Not steered: claude, Codex, grok, kimi');
    expect(chart.container.textContent).not.toContain('0 steers');
    const stop = [...chart.container.querySelectorAll<HTMLElement>('button,[role="button"]')].find(button => button.tabIndex === 0)!;
    act(() => stop.click());
    const table = chart.container.querySelector('[role="table"]')?.textContent ?? '';
    for (const agent of ['muse', 'claude', 'Codex', 'grok', 'kimi']) expect(table).toContain(`${agent} · 23:00`);
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

it('keeps a phone Run length readable: long names cut to their column, crowded tick labels left to their rules', () => {
  // USAGE-ACCEPT 1121 #17: "Custom ACP Agen" ran into the plot and the "1 h" and "4 h" ticks read "1 h4 h".
  const chart = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={renderDatum}>
    <UsageRunLength {...common} width={358} agents={[{ id: 'custom-acp', name: 'Custom ACP Agent', color: '#888' }]} label="Run-length"
      model={{ openCount: 0, croppedCount: 0, rows: [{ agentId: 'custom-acp', samples: 3, medianMs: 60000, p90Ms: 120000, durationsMs: [30000, 60000, 120000] }] }}
      labels={{ duration: ms => `${ms / 1000} s`, unknownAgent: 'Unknown', detail: (ms, n) => `p90 ${ms / 60000} min · ${n}`,
        ticks: { minute: '1 min', tenMinutes: '10 min', hour: '1 h', fourHours: '4 h' }, caption: 'Closed turns',
        values: { show: 'Exact values', hide: 'Hide values', agentColumn: 'Agent', medianColumn: 'Median', p90Column: 'p90', samplesColumn: 'Samples', formatCount: String } }} />
  </ChartInteractionProvider>);
  try {
    const drawn = [...chart.container.querySelectorAll('svg text')].map(node => node.textContent);
    expect(drawn).not.toContain('Custom ACP Agent');
    expect(drawn.some(text => text?.startsWith('Custom') && text.endsWith('…'))).toBe(true);
    expect(drawn).toContain('4 h');
    expect(drawn).not.toContain('1 h');
    const stop = [...chart.container.querySelectorAll<HTMLElement>('button,[role="button"]')].find(button => button.tabIndex === 0)!;
    act(() => stop.click());
    expect(chart.container.querySelector('[role="table"]')?.textContent).toContain('Custom ACP Agent');
  } finally { chart.unmount(); }
});
