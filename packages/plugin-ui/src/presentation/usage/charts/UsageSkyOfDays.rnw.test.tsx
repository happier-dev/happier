import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { UsageSkyOfDays, type UsageSkyLabels, type UsageSkyModel } from './UsageSkyOfDays.js';

const query = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const labels: UsageSkyLabels = {
  formatValue: (value) => `${value} min`, month: (date) => date.slice(5, 7), day: (date) => date,
  levels: { quiet: 'Quiet', steady: 'Steady', busy: 'Busy', busiest: 'Busiest' },
  streakBestOngoing: (days) => `${days}-day streak, still going`, streakBest: (days) => `Best ${days}`, streakNow: (days) => `Now ${days}`,
  streakShort: (days) => `${days}-day streak`,
  key: { tie: 'Tie', notAttributed: 'Not attributed', noActivity: 'No activity', notRecorded: 'Not recorded', quieter: 'Quieter', busier: 'Busier' },
  caption: ({ runs, band }) => `How to read it${runs ? ' · runs' : ''}${band ? ' · band' : ''}`,
  values: { show: 'Exact values', hide: 'Hide values', dateColumn: 'Day', valueColumn: 'Busy time', leaderColumn: 'Led by', noActivity: 'No activity',
    notRecorded: 'Not recorded', tie: 'Tie', notAttributed: 'Not attributed' },
};
const agents = [{ id: 'claude', name: 'Claude Code', color: '#eb6834' }, { id: 'codex', name: 'Codex', color: '#2a78d6' }];
const paint = { accent: '#007aff', paper: '#ffffff', dark: false };

describe('Sky of days', () => {

  it('keeps each drawing\'s gradients its own when two Skies share one page (wide and phone editions)', () => {
    const model: UsageSkyModel = { encoding: 'amount', colourBy: 'leadingAgent', days: [
      { date: '2026-09-01', state: 'active', value: 90, leader: { kind: 'agent', agentId: 'claude' } },
      { date: '2026-09-02', state: 'active', value: 40, leader: null },
    ] };
    const sky = (testID: string) => <UsageSkyOfDays theme={SURFACE_CONTEXT_THEME_FIXTURE} paint={paint} agents={agents} model={model}
      labels={labels} label="Sky of days" width={640} testID={testID} />;
    const mount = mountThroughReactNativeWeb(<>{sky('sky-wide')}{sky('sky-phone')}</>);
    try {
      const ids = [...mount.container.querySelectorAll('[id]')].map((node) => node.id).filter((id) => id.startsWith('usage-sky-'));
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      // A fill must resolve inside its own drawing: a hidden edition must never own the other's paint.
      for (const svg of mount.container.querySelectorAll('svg')) {
        for (const node of svg.querySelectorAll('[fill^="url(#"]')) {
          const id = node.getAttribute('fill')!.slice(5, -1);
          expect(svg.querySelector(`[id="${id}"]`)).not.toBeNull();
        }
      }
    } finally { mount.unmount(); }
  });
  it('keeps a month that starts in the last days of the period inside the drawing (a phone sky ending on Nov 1)', () => {
    const start = Date.UTC(2026, 7, 4);
    const days = Array.from({ length: 90 }, (_, index) => ({
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      state: 'active' as const, value: 30, leader: null,
    }));
    const model: UsageSkyModel = { encoding: 'amount', colourBy: 'leadingAgent', days };
    const mount = mountThroughReactNativeWeb(<UsageSkyOfDays theme={SURFACE_CONTEXT_THEME_FIXTURE} paint={paint} agents={agents} model={model}
      labels={labels} label="Sky of days" width={358} testID="sky-phone" />);
    try {
      const last = [...mount.container.querySelectorAll('svg text')].find((node) => node.textContent === '11');
      expect(last).toBeDefined();
      // A label that would start within a month label's width of the edge ends at the edge instead.
      expect(last!.getAttribute('text-anchor')).toBe('end');
    } finally { mount.unmount(); }
  });

  it('says each day exactly, keeps unknown apart from no activity, and names a tie by both Agents', () => {
    const model: UsageSkyModel = { encoding: 'amount', colourBy: 'leadingAgent', days: [
      { date: '2026-09-01', state: 'active', value: 90, leader: { kind: 'agent', agentId: 'claude' } },
      { date: '2026-09-02', state: 'active', value: 40, leader: { kind: 'tie', agentIds: ['claude', 'codex'] } },
      { date: '2026-09-03', state: 'inactive', value: 0 },
      { date: '2026-09-04', state: 'unknown' },
      { date: '2026-09-05', state: 'active', value: 10, leader: { kind: 'unknown' } },
    ] };
    const mount = mountThroughReactNativeWeb(<UsageSkyOfDays theme={SURFACE_CONTEXT_THEME_FIXTURE} paint={paint} agents={agents} model={model}
      labels={labels} label="Sky of days" width={640} testID="sky" />);
    try {
      const key = query(mount.container, 'sky-key')!.textContent;
      expect(key).toContain('Claude Code1');
      expect(key).toContain('Tie1');
      expect(key).toContain('Not attributed1');
      expect(key).toContain('No activity1');
      expect(key).toContain('Not recorded1');
      act(() => query(mount.container, 'sky-values-toggle')!.click());
      const values = query(mount.container, 'sky-values')!.textContent;
      expect(values).toContain('90 min');
      expect(values).toContain('Tie: Claude Code, Codex');
      // Unknown is not zero: the unrecorded day is never given an amount.
      expect(values).toContain('2026-09-04Not recorded');
      expect(values).not.toMatch(/2026-09-04\d/u);
    } finally { mount.unmount(); }
  });

  it('shows a busy day whose leader the owner could not name as not attributed, not as an unexplained gap', () => {
    const model: UsageSkyModel = { encoding: 'amount', colourBy: 'leadingAgent', days: [
      { date: '2026-09-01', state: 'active', value: 90, leader: null },
      { date: '2026-09-02', state: 'active', value: 40, leader: { kind: 'agent', agentId: 'codex' } },
    ] };
    const mount = mountThroughReactNativeWeb(<UsageSkyOfDays theme={SURFACE_CONTEXT_THEME_FIXTURE} paint={paint} agents={agents} model={model}
      labels={labels} label="Sky of days" width={640} testID="sky" />);
    try {
      expect(query(mount.container, 'sky-key')!.textContent).toContain('Not attributed1');
      act(() => query(mount.container, 'sky-values-toggle')!.click());
      expect(query(mount.container, 'sky-values')!.textContent).toContain('2026-09-0190 minNot attributed');
    } finally { mount.unmount(); }
  });

  it('draws an ordinal (public) model as levels only, never an amount', () => {
    const model: UsageSkyModel = { encoding: 'ordinal', colourBy: 'intensity', days: [
      { date: '2026-09-01', state: 'active', level: 4 }, { date: '2026-09-02', state: 'active', level: 1 }, { date: '2026-09-03', state: 'inactive' },
    ] };
    const mount = mountThroughReactNativeWeb(<UsageSkyOfDays theme={SURFACE_CONTEXT_THEME_FIXTURE} paint={paint} agents={[]} model={model}
      labels={labels} label="Sky of days" width={640} testID="sky" />);
    try {
      expect(mount.container.textContent).not.toMatch(/\d+ min/u);
      expect(query(mount.container, 'sky-key')!.textContent).toContain('Busiest1');
      act(() => query(mount.container, 'sky-values-toggle')!.click());
      expect(query(mount.container, 'sky-values')!.textContent).toContain('2026-09-01Busiest');
    } finally { mount.unmount(); }
  });
  it('explains the faint run lines and the 7-day band only when the sky draws them', () => {
    const day = (index: number, lit: boolean) => ({ date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      ...(lit ? { state: 'active' as const, value: 10 + index } : { state: 'inactive' as const, value: 0 }) });
    const sparse: UsageSkyModel = { encoding: 'amount', colourBy: 'intensity', days: Array.from({ length: 7 }, (_, index) => day(index, index % 3 === 0)) };
    const busy: UsageSkyModel = { encoding: 'amount', colourBy: 'intensity', days: Array.from({ length: 30 }, (_, index) => day(index, true)) };
    const caption = (model: UsageSkyModel) => {
      const mount = mountThroughReactNativeWeb(<UsageSkyOfDays theme={SURFACE_CONTEXT_THEME_FIXTURE} paint={paint} agents={[]} model={model}
        labels={labels} label="Sky of days" width={640} testID="sky" />);
      try { return mount.container.textContent ?? ''; } finally { mount.unmount(); }
    };
    const sparseText = caption(sparse);
    expect(sparseText).toContain('How to read it');
    expect(sparseText).not.toContain('· runs');
    expect(sparseText).not.toContain('· band');
    expect(caption(busy)).toContain('How to read it · runs · band');
  });
});
