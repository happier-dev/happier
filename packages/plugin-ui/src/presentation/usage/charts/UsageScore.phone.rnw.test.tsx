import { describe, expect, it } from 'vitest';

import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
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
});
