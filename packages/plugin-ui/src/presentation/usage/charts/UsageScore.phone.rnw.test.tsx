import { describe, expect, it } from 'vitest';

import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { UsageScore } from './UsageAgentsCharts.js';

const agents = [
  { id: 'claude', name: 'Claude Code', color: '#eb6834' },
  { id: 'codex', name: 'Codex', color: '#2a78d6' },
];
const hours = Array.from({ length: 24 }, () => 30);

describe('Score on a phone', () => {
  it('gives each day its own label line, so the first hours never draw under the day name (native N5)', () => {
    const chart = mountThroughReactNativeWeb(
      <UsageScore
        theme={theme}
        paint={{ accent: '#007aff', paper: '#fff', dark: false }}
        agents={agents}
        width={360}
        label="Score"
        testID="chart"
        model={{
          weekStart: '2026-11-09',
          encoding: 'minutes',
          rows: [
            { agentId: 'codex', hours: [hours, hours] },
            { agentId: 'claude', hours: [hours] },
          ],
        }}
        labels={{
          day: (day) => `Mon ${day + 9}`,
          clock: String,
          unknownAgent: 'Unknown',
          key: {
            light: 'Light',
            medium: 'Medium',
            strong: 'Strong',
            presence: 'Present',
            presenceNote: '',
          },
          values: {
            show: 'Values',
            hide: 'Hide',
            agentColumn: 'Agent',
            dayColumn: 'Day',
            hoursColumn: 'Hours',
            formatHours: (value) => value.join(', '),
          },
        }}
      />,
    );
    try {
      const days = [...chart.container.querySelectorAll('svg')].filter((svg) =>
        svg.querySelector('circle'),
      );
      expect(days.length).toBe(2);
      for (const day of days) {
        const label = [...day.querySelectorAll('text')].find((text) =>
          text.textContent?.startsWith('Mon'),
        );
        expect(label).toBeDefined();
        const baseline = Number(label!.getAttribute('y'));
        const top = Math.min(
          ...[...day.querySelectorAll('circle')].map(
            (dot) =>
              Number(dot.getAttribute('cy')) - Number(dot.getAttribute('r')),
          ),
        );
        // The day name's line ends at its baseline; every hour mark starts below it.
        expect(top).toBeGreaterThan(baseline);
      }
    } finally {
      chart.unmount();
    }
  });
});
