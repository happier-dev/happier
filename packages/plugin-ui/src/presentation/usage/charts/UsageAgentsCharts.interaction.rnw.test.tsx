import { act, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { ChartInteractionProvider } from '../../data/ChartDatum.js';
import { UsageAgentRiver, UsageConstellation, UsageCrew, UsageOrbit, UsageScore, UsageShipped } from './UsageAgentsCharts.js';

const paint = { accent: '#007aff', paper: '#fff', dark: false };
const agents = [{ id: 'claude', name: 'Claude Code', color: '#eb6834' }, { id: 'codex', name: 'Codex', color: '#2a78d6' }];
const common = { theme, paint, agents, width: 720, label: 'Usage', testID: 'chart' };
const percent = (share: number) => `${Math.round(share * 100)}%`;
const values = { show: 'Values', hide: 'Hide' };

// This renderer is the host presentation boundary. The chart and shared datum owners stay real.
function mount(chart: ReactNode) {
  return mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual, testID) =>
    <button data-testid={testID} aria-label={`${datum.label}: ${datum.value}`} data-subtitle={datum.subtitle}>{visual}</button>}>
    {chart}
  </ChartInteractionProvider>);
}
function target(root: HTMLElement, label: string) {
  const result = root.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
  expect(result, `Missing inspectable datum: ${label}`).not.toBeNull();
  expect(result!.closest('svg')).toBeNull();
  return result!;
}

describe('Agent chart exact data targets', () => {
  it('inspects each River week through the actual sloping band shape', () => {
    const hovered: string[] = [];
    const chart = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual, _testID, renderTrigger) => renderTrigger
      ? renderTrigger({ onHoverChange: (active) => { if (active) hovered.push(`${datum.label}: ${datum.value}`); }, onFocusChange: () => {}, onPress: () => {} }) : visual}>
      <UsageAgentRiver {...common} model={{ width: 'share', weeks: [
        { start: 'First', end: 'Last', partial: false, total: null, shares: [{ agentId: 'claude', share: 0.01 }, { agentId: 'codex', share: 0.99 }] },
        { start: 'Next', end: 'End', partial: false, total: null, shares: [{ agentId: 'claude', share: 0.99 }, { agentId: 'codex', share: 0.01 }] },
      ] }} labels={{ week: String, partialWeek: String, inline: String, caption: '', unknownAgent: 'Unknown',
        values: { ...values, weekColumn: 'Week', totalColumn: 'Total', formatTotal: String, percent } }} />
    </ChartInteractionProvider>);
    try {
      const drawn = [...chart.container.querySelectorAll('path[fill-opacity="0.9"]')].map((path) => path.getAttribute('d'));
      const windows: number[][] = [];
      for (const index of [0, 1]) {
        const hit = chart.container.querySelector(`path[data-testid="chart.week.${index}.claude"]`);
        expect(hit, `River week ${index} has no interactive band`).not.toBeNull();
        expect(drawn).toContain(hit!.getAttribute('d'));
        windows.push(hit!.closest('svg')!.getAttribute('viewBox')!.split(' ').map(Number));
        act(() => { hit!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
      }
      expect(hovered).toEqual(['Claude Code · First: 1%', 'Claude Code · Next: 99%']);
      expect(windows[0]![0]).toBe(0);
      expect(windows[0]![0]! + windows[0]![2]!).toBe(windows[1]![0]);
      expect(windows[1]![0]! + windows[1]![2]!).toBe(common.width);
    } finally { chart.unmount(); }
  });

  it('inspects directed and self edges by hovering the drawn curve, not only its count label', () => {
    const hovered: string[] = [];
    const chart = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual, _testID, renderTrigger) => renderTrigger
      ? renderTrigger({ onHoverChange: (active) => { if (active) hovered.push(datum.value); }, onFocusChange: () => {}, onPress: () => {} }) : visual}>
      <UsageConstellation {...common} model={{ nodes: [{ agentId: 'claude', share: 0.2 }, { agentId: 'codex', share: 0.8 }],
        edges: [{ from: 'claude', to: 'codex', kind: 'session', count: 1234 }, { from: 'claude', to: 'claude', kind: 'run', count: 2 }], unknownStarts: null }}
        labels={{ kinds: { session: 'Session', run: 'Run', native: 'Native' }, arrowNote: '', unknownStarts: String, nodesOnly: 'Nodes only', unknownAgent: 'Unknown' }} />
    </ChartInteractionProvider>);
    try {
      const drawn = chart.container.querySelectorAll('path[marker-end]');
      for (const index of [0, 1]) {
        const hit = chart.container.querySelector(`path[data-testid="chart.edge.${index}"]`);
        expect(hit, `Edge ${index} has no interactive curve`).not.toBeNull();
        expect(hit!.getAttribute('d')).toBe(drawn[index]!.getAttribute('d'));
        act(() => { hit!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
      }
      expect(hovered).toEqual(['1,234', '2']);
    } finally { chart.unmount(); }
  });

  it.each([720, 390])('exposes Score hour values at width %s without exposing unrecorded hours', (width) => {
    const chart = mount(<UsageScore {...common} width={width} model={{ weekStart: '2026-10-26', encoding: 'minutes', rows: [
      { agentId: 'claude', hours: [[12.345, null]] },
    ] }} labels={{ day: () => 'Monday', clock: (hour) => `${hour}:00`, unknownAgent: 'Unknown',
      key: { light: 'Light', medium: 'Medium', strong: 'Strong', presence: 'Present', presenceNote: 'Presence only' },
      values: { ...values, agentColumn: 'Agent', dayColumn: 'Day', hoursColumn: 'Hours', formatHours: (hours) => hours.flatMap((n, hour) => n === null ? [] : [`${hour}:00 ${n} min`]).join(', ') },
    }} />);
    try {
      // The hour is said once, in the value beside its minutes, not again in the title.
      target(chart.container, 'Claude Code · Monday: 0:00 12.345 min');
      expect(chart.container.querySelectorAll('button[aria-label*="Claude Code · Monday"]')).toHaveLength(1);
    } finally { chart.unmount(); }
  });

  it('retains precise Orbit and Crew shares and does not turn unknown shares into zero', () => {
    const model = [{ agentId: 'claude', share: 0.123456 }, { agentId: 'codex', share: null }];
    for (const body of [<UsageOrbit {...common} model={model} labels={{ percent, unknown: (name) => name, unknownAgent: 'Unknown' }} />,
      <UsageCrew {...common} model={model} labels={{ percent, days: String, unknownAgent: 'Unknown' }} />]) {
      const chart = mount(body);
      try {
        target(chart.container, 'Claude Code: 12.35%');
        expect(chart.container.querySelector('button[aria-label="Codex: 0%"]')).toBeNull();
      } finally { chart.unmount(); }
    }
  });

  it('exposes each River week share with its own total and partial-week label', () => {
    const chart = mount(<UsageAgentRiver {...common} model={{ width: 'amount', weeks: [
      { start: 'first', end: 'last', partial: true, total: 1234.567, shares: [{ agentId: 'claude', share: 0.123456 }, { agentId: null, share: 0.876544 }] },
      { start: 'next', end: 'next-end', partial: false, total: null, shares: [{ agentId: 'claude', share: 1 }] },
    ] }} labels={{ week: String, partialWeek: (a, b) => `${a}–${b} partial`, inline: (name) => name, caption: '', unknownAgent: 'Unknown',
      values: { ...values, weekColumn: 'Week', totalColumn: 'Total', formatTotal: () => '1.2k tokens', percent } }} />);
    try {
      expect(target(chart.container, 'Claude Code · first–last partial: 12.35%').dataset.subtitle).toContain('1,234.567');
      expect(target(chart.container, 'Claude Code · first–last partial: 12.35%').dataset.subtitle).toContain('1.2k tokens');
      target(chart.container, 'Unknown · first–last partial: 87.65%');
      expect(target(chart.container, 'Claude Code · next: 100%').dataset.subtitle).toBeUndefined();
    } finally { chart.unmount(); }
  });

  it('exposes Shipped weekly, undated and count-only data without inventing PR identities', () => {
    const labels = { week: String, noDate: 'No date', countLine: (n: number) => `${n} merged PRs`, mixed: 'Mixed', noMergeDate: 'No merge date', colourBy: 'agent' as const };
    for (const model of [{ mode: 'weeks' as const, total: 3, undated: 1, weeks: [{ start: 'Week one', spines: ['claude', 'mixed'] }] }, { mode: 'count' as const, total: 3 }]) {
      const chart = mount(<UsageShipped {...common} labels={labels} model={model} />);
      try {
        if (model.mode === 'weeks') {
          target(chart.container, 'Week one · Claude Code: 1 merged PRs');
          target(chart.container, 'Week one · Mixed: 1 merged PRs');
          target(chart.container, 'No merge date: 1 merged PRs');
        } else target(chart.container, 'Usage: 3 merged PRs');
      } finally { chart.unmount(); }
    }
  });

  it('exposes Constellation node shares and typed directed edge counts, including self edges', () => {
    const chart = mount(<UsageConstellation {...common} model={{ nodes: [{ agentId: 'claude', share: 0.123456 }, { agentId: 'codex', share: null }],
      edges: [{ from: 'claude', to: 'codex', kind: 'session', count: 1234 }, { from: 'claude', to: 'claude', kind: 'run', count: 2 }], unknownStarts: null }}
      labels={{ kinds: { session: 'Session', run: 'Run', native: 'Native' }, arrowNote: '', unknownStarts: String, nodesOnly: 'Nodes only', unknownAgent: 'Unknown' }} />);
    try {
      target(chart.container, 'Claude Code: 12.35%');
      target(chart.container, 'Codex: —');
      target(chart.container, 'Claude Code → Codex · Session: 1,234');
      target(chart.container, 'Claude Code → Claude Code · Run: 2');
    } finally { chart.unmount(); }
  });
});
