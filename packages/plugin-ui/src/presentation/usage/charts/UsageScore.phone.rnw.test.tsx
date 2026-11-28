import { describe, expect, it } from 'vitest';

import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { ChartInteractionProvider } from '../../data/ChartDatum.js';
import { UsageScore } from './UsageAgentsCharts.js';

const agents = [
  { id: 'claude', name: 'Claude Code', color: '#eb6834' },
  { id: 'codex', name: 'Codex', color: '#2a78d6' },
];
const hours = Array.from({ length: 24 }, () => 30);
const labels = {
  day: (day: number) => `Wed ${day + 11}`,
  clock: String,
  unknownAgent: 'Unknown',
  key: { light: 'Light', medium: 'Medium', strong: 'Strong', presence: 'Present', presenceNote: '' },
  values: { show: 'Values', hide: 'Hide', agentColumn: 'Agent', dayColumn: 'Day', hoursColumn: 'Hours', formatHours: (value: readonly (number | null)[]) => value.join(', ') },
};

describe('Score on a phone', () => {
  it('is a weekday × hour grid: each day named in a left gutter that no hour mark draws under (lab u3ens-P, native N5)', () => {
    const chart = mountThroughReactNativeWeb(
      <UsageScore theme={theme} paint={{ accent: '#007aff', paper: '#fff', dark: false }} agents={agents} width={360} label="Score" testID="chart"
        model={{ weekStart: '2026-11-09', encoding: 'minutes', rows: [{ agentId: 'codex', hours: [hours, hours] }, { agentId: 'claude', hours: [hours] }] }}
        labels={labels} />,
    );
    try {
      const days = [...chart.container.querySelectorAll('svg')].filter((svg) => svg.querySelector('circle'));
      expect(days.length).toBe(2);
      for (const day of days) {
        const label = [...day.querySelectorAll('text')].find((text) => text.textContent?.startsWith('Wed'));
        expect(label).toBeDefined();
        const size = Number(label!.getAttribute('font-size'));
        const dots = [...day.querySelectorAll('circle')];
        const left = Math.min(...dots.map((dot) => Number(dot.getAttribute('cx')) - Number(dot.getAttribute('r'))));
        // The name sits beside its day's rows, and the gutter is at least as wide as the name.
        expect(left).toBeGreaterThanOrEqual(Number(label!.getAttribute('x')) + label!.textContent!.length * size * 0.6);
        const top = Math.min(...dots.map((dot) => Number(dot.getAttribute('cy'))));
        expect(top).toBeLessThan(Number(label!.getAttribute('y')));
      }
      // The clock axis starts where the hours start, not under the gutter.
      const axis = [...chart.container.querySelectorAll('svg text')].find((text) => text.textContent === '0')!;
      const firstDots = [...days[0]!.querySelectorAll('circle')].map((dot) => Number(dot.getAttribute('cx')));
      expect(Number(axis.getAttribute('x'))).toBeGreaterThan(Math.min(...firstDots) - 12);
    } finally {
      chart.unmount();
    }
  });

  // Hour 0 unread, hour 1 idle, hour 2 a light 10 min, hour 3 a strong 50 min.
  const read = [null, 0, 10, 50, ...Array.from({ length: 20 }, () => 0)];
  const mountPhone = (encoding: 'minutes' | 'presence') => mountThroughReactNativeWeb(
    <ChartInteractionProvider renderDatum={(_datum, visual, testID) => <button data-testid={testID}>{visual}</button>}>
      <UsageScore theme={theme} paint={{ accent: '#007aff', paper: '#fff', dark: false }} agents={agents} width={360} label="Score" testID="chart"
        model={{ weekStart: '2026-11-09', dayCount: 1, encoding, rows: [{ agentId: 'codex', hours: [read] }] }} labels={labels} />
    </ChartInteractionProvider>,
  );
  const dotAt = (chart: ReturnType<typeof mountPhone>, hour: number) => {
    const dots = [...chart.container.querySelectorAll('svg circle')].sort((a, b) => Number(a.getAttribute('cx')) - Number(b.getAttribute('cx')));
    // Unread hours draw nothing, so the drawn dots are hours 1–23 in order.
    expect(dots).toHaveLength(23);
    return Number(dots[hour - 1]!.getAttribute('r'));
  };

  it('draws an idle hour at the light tier\'s size and an unread hour not at all', () => {
    const chart = mountPhone('minutes');
    try {
      expect(dotAt(chart, 1)).toBe(dotAt(chart, 2));
      expect(dotAt(chart, 3)).toBeGreaterThan(dotAt(chart, 2));
    } finally {
      chart.unmount();
    }
  });

  it('draws every busy hour at full size under presence, keyed by one item, with idle hours not interactive', () => {
    const chart = mountPhone('presence');
    try {
      expect(dotAt(chart, 2)).toBe(dotAt(chart, 3));
      expect(dotAt(chart, 1)).toBeLessThan(dotAt(chart, 2));
      const text = chart.container.textContent ?? '';
      expect(text).toContain('Present');
      expect(text).not.toContain('Light');
      expect(chart.container.querySelector('[data-testid="chart.hour.0.0.1"]')).toBeNull();
      expect(chart.container.querySelector('[data-testid="chart.hour.0.0.2"]')).not.toBeNull();
      expect(chart.container.querySelector('[data-testid="chart.hour.0.0.3"]')).not.toBeNull();
    } finally {
      chart.unmount();
    }
  });
});
