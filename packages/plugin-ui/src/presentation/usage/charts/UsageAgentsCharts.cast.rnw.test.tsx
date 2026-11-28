import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import {
  UsageConstellation,
  UsageOrbit,
  UsageScore,
} from './UsageAgentsCharts.js';

// How a large or a single-Agent cast reads (USAGE-ACCEPT-1118 #8, #21): the drawing names a few leaders and folds
// the rest into one Other; every Agent stays in the exact values table.
const paint = { accent: '#007aff', paper: '#fff', dark: false };
const cast = Array.from({ length: 12 }, (_, index) => ({
  id: `a${index}`,
  name: `Agent ${index}`,
  color: '#2a78d6',
}));
const values = { show: 'Values', hide: 'Hide' };
const percent = (share: number) => `${Math.round(share * 100)}%`;
const openValues = (root: HTMLElement) =>
  act(() =>
    root.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click(),
  );
const tableText = (root: HTMLElement) =>
  root.querySelector('[role="table"]')!.textContent ?? '';

describe('a large cast', () => {
  it.each([720, 360])(
    'Score draws six leading Agents and one Other row at width %s',
    (width) => {
      const rows = cast.map((agent, index) => ({
        agentId: agent.id,
        hours: [
          Array.from({ length: 24 }, (_, hour) =>
            hour === index ? 60 - index : 0,
          ),
        ],
      }));
      const chart = mountThroughReactNativeWeb(
        <UsageScore
          theme={theme}
          paint={paint}
          agents={cast}
          width={width}
          label="Score"
          testID="chart"
          model={{
            weekStart: '2026-11-12',
            dayCount: 1,
            encoding: 'minutes',
            rows,
          }}
          labels={{
            day: () => 'Thu 12',
            clock: String,
            unknownAgent: 'Unknown',
            other: 'Other',
            key: {
              light: 'Light',
              medium: 'Medium',
              strong: 'Strong',
              presence: 'Present',
              presenceNote: '',
            },
            values: {
              ...values,
              agentColumn: 'Agent',
              dayColumn: 'Day',
              hoursColumn: 'Hours',
              formatHours: (hours) => hours.filter(Boolean).join(', '),
            },
          }}
        />,
      );
      try {
        const sub = new Set(
          [...chart.container.querySelectorAll('svg circle')].map((dot) =>
            dot.getAttribute('cy'),
          ),
        );
        expect(sub.size).toBe(7);
        if (width === 720)
          expect(
            [...chart.container.querySelectorAll('svg text')].map(
              (text) => text.textContent,
            ),
          ).toContain('Other');
        openValues(chart.container);
        expect(tableText(chart.container)).toContain('Agent 11');
      } finally {
        chart.unmount();
      }
    },
  );

  it('Score\'s Other row adds up the folded Agents\' time in an hour (20 + 30 min is a 40-min-or-more hour)', () => {
    const busy = (minutes: number, at: number) => Array.from({ length: 24 }, (_, hour) => hour === at ? minutes : 0);
    const rows = cast.slice(0, 8).map((agent, index) => ({ agentId: agent.id, hours: [index < 6 ? busy(60, index + 10) : busy(index === 6 ? 20 : 30, 5)] }));
    const chart = mountThroughReactNativeWeb(<UsageScore theme={theme} paint={paint} agents={cast} width={720} label="Score" testID="chart"
      model={{ weekStart: '2026-11-12', dayCount: 1, encoding: 'minutes', rows }}
      labels={{ day: () => 'Thu 12', clock: String, unknownAgent: 'Unknown', other: 'Other',
        key: { light: 'Light', medium: 'Medium', strong: 'Strong', presence: 'Present', presenceNote: '' },
        values: { ...values, agentColumn: 'Agent', dayColumn: 'Day', hoursColumn: 'Hours', formatHours: (hours) => hours.filter(Boolean).join(', ') } }} />);
    try {
      const dots = [...chart.container.querySelectorAll('svg circle')];
      const bottom = Math.max(...dots.map((dot) => Number(dot.getAttribute('cy'))));
      const other = dots.filter((dot) => Number(dot.getAttribute('cy')) === bottom);
      expect(other).toHaveLength(1);
      // The combined 50 min draws at the strong tier's size, the same as a leader's 60-min hour.
      expect(other[0]!.getAttribute('r')).toBe(dots[0]!.getAttribute('r'));
    } finally { chart.unmount(); }
  });

  it('Orbit draws five leading planets and one Other planet carrying the rest of the share', () => {
    const shares = cast.map((agent, index) => ({
      agentId: agent.id,
      share: index < 3 ? 0.3 : 0.1 / 9,
    }));
    const chart = mountThroughReactNativeWeb(
      <UsageOrbit
        theme={theme}
        paint={paint}
        agents={cast}
        width={720}
        label="Orbit"
        testID="chart"
        model={shares}
        labels={{
          percent,
          unknown: String,
          unknownAgent: 'Unknown',
          other: 'Other',
          values: { ...values, agentColumn: 'Agent', shareColumn: 'Share' },
        }}
      />,
    );
    try {
      expect(chart.container.querySelectorAll('svg circle')).toHaveLength(6);
      const texts = [...chart.container.querySelectorAll('svg text')].map(
        (text) => text.textContent,
      );
      expect(texts).toContain(`Other ${percent((0.1 / 9) * 7)}`);
      openValues(chart.container);
      expect(tableText(chart.container)).toContain('Agent 11');
    } finally {
      chart.unmount();
    }
  });

  it('Constellation draws every linked Agent and fills the composed slots with the largest unlinked ones', () => {
    const nodes = cast.map((agent, index) => ({
      agentId: agent.id,
      share: (12 - index) / 78,
    }));
    const chart = mountThroughReactNativeWeb(
      <UsageConstellation
        theme={theme}
        paint={paint}
        agents={cast}
        width={720}
        label="Constellation"
        testID="chart"
        model={{
          nodes,
          edges: [{ from: 'a10', to: 'a11', kind: 'run', count: 3 }],
          unknownStarts: 0,
        }}
        labels={{
          kinds: { session: 'Session', run: 'Run', native: 'Native' },
          arrowNote: '',
          unknownStarts: String,
          nodesOnly: '',
          unknownAgent: 'Unknown',
          unknownLabel: 'Unknown',
          values: {
            ...values,
            agentColumn: 'Agent',
            shareColumn: 'Share',
            kindColumn: 'Kind',
            countColumn: 'Count',
          },
        }}
      />,
    );
    try {
      const names = [...chart.container.querySelectorAll('svg text')].map(
        (text) => text.textContent,
      );
      expect(names.filter((name) => name?.startsWith('Agent '))).toEqual(
        expect.arrayContaining(['Agent 10', 'Agent 11', 'Agent 0']),
      );
      expect(chart.container.querySelectorAll('svg circle')).toHaveLength(7);
      openValues(chart.container);
      expect(tableText(chart.container)).toContain('Agent 5');
    } finally {
      chart.unmount();
    }
  });
});

describe('a single Agent', () => {
  it.each([720, 340])(
    'Orbit keeps the label off its planet at width %s',
    (width) => {
      const chart = mountThroughReactNativeWeb(
        <UsageOrbit
          theme={theme}
          paint={paint}
          agents={[{ id: 'opencode', name: 'OpenCode', color: '#5b4fc8' }]}
          width={width}
          label="Orbit"
          testID="chart"
          model={[{ agentId: 'opencode', share: 1 }]}
          labels={{
            percent,
            unknown: String,
            unknownAgent: 'Unknown',
            values: { ...values, agentColumn: 'Agent', shareColumn: 'Share' },
          }}
        />,
      );
      try {
        const planet = chart.container.querySelector('svg circle')!;
        const cx = Number(planet.getAttribute('cx')),
          r = Number(planet.getAttribute('r'));
        const label = [...chart.container.querySelectorAll('svg text')]
          .filter((text) => text.textContent === 'OpenCode 100%')
          .at(-1)!;
        const x = Number(label.getAttribute('x')),
          span =
            label.textContent!.length *
            Number(label.getAttribute('font-size')) *
            0.6;
        const [from, to] =
          label.getAttribute('text-anchor') === 'end'
            ? [x - span, x]
            : [x, x + span];
        // Beside the planet or under it, never over it and never off the drawing (D Orbit, USAGE-ACCEPT-1118 #21).
        const size = Number(label.getAttribute('font-size'));
        const below = Number(label.getAttribute('y')) - size >= Number(planet.getAttribute('cy')) + r;
        expect(to <= cx - r || from >= cx + r || below).toBe(true);
        expect(from).toBeGreaterThanOrEqual(0);
        expect(to).toBeLessThanOrEqual(width);
      } finally {
        chart.unmount();
      }
    },
  );
});
