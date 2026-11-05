import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import {
  UsageConstellation,
  UsageCrew,
  UsageOrbit,
  UsageShipped,
} from './UsageAgentsCharts.js';
import {
  UsageStreakThread,
  type UsageCalendarLabels,
} from './UsageCalendarForms.js';
import {
  UsageAgentMoons,
  UsageAtmosphere,
  UsageMachines,
  UsageProjects,
  type UsageMoonsLabels,
} from './UsagePlanetFamily.js';
import type { UsageCalendarArtModel } from './publicUsageChartModels.js';
import type { UsagePlanetSpec } from './usagePlanetSlot.js';

const theme = SURFACE_CONTEXT_THEME_FIXTURE;
const paint = { accent: '#007aff', paper: '#ffffff', dark: false };
const values = { show: 'Exact values', hide: 'Hide values' };
const query = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const agents = [
  { id: 'claude', name: 'Claude Code', color: '#eb6834' },
  { id: 'codex', name: 'Codex', color: '#2a78d6' },
];
const period = {
  startMs: Date.UTC(2026, 8, 1),
  endMs: Date.UTC(2026, 8, 11),
  timeZoneOffsetMinutes: 0,
} as UsageCalendarArtModel['period'];

describe('Agent mix bodies keep the unattributed member', () => {
  it('names the null-identity member with the host Unknown label in Crew and Orbit', () => {
    const model = [
      { agentId: 'claude', share: 0.6 },
      { agentId: null, share: 0.4 },
    ];
    const crew = mountThroughReactNativeWeb(
      <UsageCrew
        theme={theme}
        paint={paint}
        agents={agents}
        model={model}
        width={480}
        label="Crew"
        testID="crew"
        labels={{
          percent: (share) => `${Math.round(share * 100)}%`,
          days: (days) => `${days} d`,
          unknownAgent: 'Unknown agent',
        }}
      />,
    );
    const orbit = mountThroughReactNativeWeb(
      <UsageOrbit
        theme={theme}
        paint={paint}
        agents={agents}
        model={model}
        width={480}
        label="Orbit"
        testID="orbit"
        labels={{
          percent: (share) => `${Math.round(share * 100)}%`,
          unknown: (names) => `${names} unknown`,
          unknownAgent: 'Unknown agent',
        }}
      />,
    );
    try {
      expect(query(crew.container, 'crew')!.textContent).toContain(
        'Unknown agent40%',
      );
      expect(query(orbit.container, 'orbit')!.textContent).toContain(
        'Unknown agent 40%',
      );
    } finally {
      crew.unmount();
      orbit.unmount();
    }
  });

  it('places every Constellation member, beyond the seven composed slots', () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];
    const mount = mountThroughReactNativeWeb(
      <UsageConstellation
        theme={theme}
        paint={paint}
        width={720}
        label="Constellation"
        testID="const"
        agents={ids.map((id) => ({
          id,
          name: `Agent ${id}`,
          color: '#555555',
        }))}
        model={{
          nodes: [
            ...ids.map((agentId) => ({ agentId, share: 0.1 })),
            { agentId: null, share: 0.1 },
          ],
          edges: null,
          unknownStarts: null,
        }}
        labels={{
          kinds: { session: 'Session', run: 'Run', native: 'Native' },
          arrowNote: '',
          unknownStarts: () => '',
          nodesOnly: 'Nodes only',
          unknownAgent: 'Unknown agent',
        }}
      />,
    );
    try {
      const text = query(mount.container, 'const')!.textContent!;
      for (const id of ids) expect(text).toContain(`Agent ${id}`);
      expect(text).toContain('Unknown agent');
    } finally {
      mount.unmount();
    }
  });
});

const calendarLabels: UsageCalendarLabels = {
  month: (date) => date.slice(5, 7),
  day: (date) => date,
  short: (date) => date.slice(5),
  weekdayInitials: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
  levels: {
    quiet: 'Quiet',
    steady: 'Steady',
    busy: 'Busy',
    busiest: 'Busiest',
  },
  noActivity: 'No activity',
  notRecorded: 'Not recorded',
  quieter: 'Quieter',
  busier: 'Busier',
  best: (days) => `Best ${days}`,
  now: (days) => `Now ${days}`,
  ongoingBest: (days) => `Longest ${days}`,
  values: {
    ...values,
    dateColumn: 'Day',
    levelColumn: 'How busy',
    weekColumn: 'Week',
    activeDaysColumn: 'Active days',
  },
};
const levels = (...values: UsageCalendarArtModel['days'][number]['level'][]) =>
  values.map((level, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    level,
  }));

describe('Streak thread', () => {
  it('draws a shared streak count on the run of exactly that length, and only says a count it cannot place', () => {
    const placed = mountThroughReactNativeWeb(
      <UsageStreakThread
        theme={theme}
        paint={paint}
        width={640}
        label="Streak"
        testID="placed"
        labels={calendarLabels}
        model={{
          period,
          days: levels(1, 2, 0, 3, 4, 2, 0, 1, 2, 3),
          currentStreakDays: 3,
          bestStreakDays: 3,
        }}
      />,
    );
    const unplaced = mountThroughReactNativeWeb(
      <UsageStreakThread
        theme={theme}
        paint={paint}
        width={640}
        label="Streak"
        testID="unplaced"
        labels={calendarLabels}
        model={{
          period,
          days: levels(1, 2, 0, 3, null, 2, 0, 1, 2, 3),
          currentStreakDays: 5,
        }}
      />,
    );
    try {
      // The latest three-day run is both the current and the longest: one label, no words.
      expect(query(placed.container, 'placed')!.textContent).toContain(
        'Longest 3',
      );
      expect(query(placed.container, 'placed-streaks')).toBeNull();
      // Five days now cannot be placed on the drawn calendar (an unrecorded day breaks the run): said in words only.
      expect(query(unplaced.container, 'unplaced-streaks')!.textContent).toBe(
        'Now 5',
      );
      expect(query(unplaced.container, 'unplaced')!.textContent).not.toContain(
        'Longest',
      );
    } finally {
      placed.unmount();
      unplaced.unmount();
    }
  });
});

describe('Planet family', () => {
  const moonLabels: UsageMoonsLabels = {
    percent: (share) => `${Math.round(share * 100)}%`,
    days: (active, of) => `${active} of ${of} days`,
    unknownAgent: 'Unknown agent',
    caption: () => 'Moons',
    values: {
      ...values,
      agentColumn: 'Agent',
      shareColumn: 'Share',
      daysColumn: 'Days',
    },
  };

  it('draws a moon phase only from the member’s own shared days', () => {
    const specs: UsagePlanetSpec[] = [];
    const slot = (spec: UsagePlanetSpec) => {
      specs.push(spec);
      return null;
    };
    const hidden = mountThroughReactNativeWeb(
      <UsageAgentMoons
        theme={theme}
        paint={paint}
        agents={agents}
        width={480}
        label="Moons"
        testID="hidden"
        labels={moonLabels}
        renderPlanet={slot}
        model={{
          agents: [
            { agentId: 'claude', share: 0.7 },
            { agentId: null, share: 0.3 },
          ],
          periodDays: 10,
        }}
      />,
    );
    try {
      expect(query(hidden.container, 'hidden')!.textContent).not.toContain(
        'of 10 days',
      );
      expect(query(hidden.container, 'hidden')!.textContent).toContain(
        'Unknown agent',
      );
      expect(specs.length).toBeGreaterThan(0);
      expect(specs.every((spec) => spec.light === undefined)).toBe(true);
    } finally {
      hidden.unmount();
    }
    specs.length = 0;
    const shared = mountThroughReactNativeWeb(
      <UsageAgentMoons
        theme={theme}
        paint={paint}
        agents={agents}
        width={480}
        label="Moons"
        testID="shared"
        labels={moonLabels}
        renderPlanet={slot}
        model={{
          agents: [{ agentId: 'claude', share: 0.7, activeDays: 5 }],
          periodDays: 10,
        }}
      />,
    );
    try {
      expect(query(shared.container, 'shared')!.textContent).toContain(
        '5 of 10 days',
      );
      expect(specs.at(-1)!.light).toBeCloseTo(0.55);
    } finally {
      shared.unmount();
    }
  });

  it('keeps unavailable machine evidence apart from a witnessed empty population', () => {
    const labels = {
      kind: (kind: string) => kind,
      percent: (share: number) => `${share}`,
      unavailable: 'Not recorded yet',
      empty: 'No machine ran agents',
      values: {
        ...values,
        kindColumn: 'Machine',
        countColumn: 'How many',
        shareColumn: 'Share',
      },
    };
    const coverage = { status: 'unavailable', method: 'unknown' } as const;
    const unavailable = mountThroughReactNativeWeb(
      <UsageMachines
        theme={theme}
        paint={paint}
        label="Machines"
        testID="m1"
        labels={labels}
        model={{ kinds: null, coverage }}
      />,
    );
    const empty = mountThroughReactNativeWeb(
      <UsageMachines
        theme={theme}
        paint={paint}
        label="Machines"
        testID="m2"
        labels={labels}
        model={{ kinds: [], coverage }}
      />,
    );
    try {
      expect(query(unavailable.container, 'm1-unavailable')!.textContent).toBe(
        'Not recorded yet',
      );
      expect(query(empty.container, 'm2-empty')!.textContent).toBe(
        'No machine ran agents',
      );
    } finally {
      unavailable.unmount();
      empty.unmount();
    }
  });

  it('renders linked projects as real links that open through the host', () => {
    const opened: string[] = [];
    const mount = mountThroughReactNativeWeb(
      <UsageProjects
        theme={theme}
        paint={paint}
        width={360}
        label="Projects"
        testID="projects"
        labels={{ empty: 'None' }}
        onOpen={(url) => opened.push(url)}
        model={{
          links: [
            {
              label: 'happier-dev/happier',
              url: 'https://github.com/happier-dev/happier',
            },
          ],
        }}
      />,
    );
    try {
      const link = mount.container.querySelector<HTMLAnchorElement>(
        'a[href="https://github.com/happier-dev/happier"]',
      )!;
      expect(link.textContent).toBe('happier-dev/happier');
      expect(link.getAttribute('rel')).toContain('nofollow');
      act(() => link.click());
      expect(opened).toEqual(['https://github.com/happier-dev/happier']);
    } finally {
      mount.unmount();
    }
  });

  it('says an unrecorded week as not recorded, never as a calm week', () => {
    const mount = mountThroughReactNativeWeb(
      <UsageAtmosphere
        theme={theme}
        paint={paint}
        width={480}
        label="Atmosphere"
        testID="atm"
        labels={{
          week: (startMs) => new Date(startMs).toISOString().slice(5, 10),
          peak: (count) => `Up to ${count}`,
          firstWeek: 'Week 1',
          caption: () => 'Halo',
          values: {
            ...values,
            weekColumn: 'Week',
            peakColumn: 'At once',
            notRecorded: 'Not recorded',
          },
        }}
        model={{
          weeks: [
            {
              startMs: Date.UTC(2026, 8, 7),
              endMs: Date.UTC(2026, 8, 14),
              peak: 3,
              coverage: {
                status: 'complete_for_supplied_facts',
                method: 'runtime',
              },
            },
            {
              startMs: Date.UTC(2026, 8, 14),
              endMs: Date.UTC(2026, 8, 21),
              peak: 0,
              coverage: { status: 'unavailable', method: 'unknown' },
            },
          ],
        }}
      />,
    );
    try {
      act(() => query(mount.container, 'atm-values-toggle')!.click());
      const table = query(mount.container, 'atm-values')!.textContent!;
      expect(table).toContain('Up to 3');
      expect(table).toContain('Not recorded');
      expect(table).not.toContain('Up to 0');
    } finally {
      mount.unmount();
    }
  });
});

describe('Shipped with nothing merged', () => {
  it('says the count and draws no axis, instead of an empty shelf', () => {
    const labels = { week: (start: string) => start, noDate: 'No date', countLine: (total: number) => `${total} merged pull requests`,
      mixed: 'Mixed', noMergeDate: 'No merge date', colourBy: 'agent' as const };
    const draw = (model: Parameters<typeof UsageShipped>[0]['model']) => mountThroughReactNativeWeb(
      <UsageShipped theme={theme} paint={paint} agents={[]} width={480} label="Shipped" testID="shipped" model={model} labels={labels} />);
    const empty = draw({ mode: 'count', total: 0 });
    const some = draw({ mode: 'count', total: 3 });
    try {
      expect(query(empty.container, 'shipped')!.textContent).toContain('0 merged pull requests');
      expect(empty.container.querySelector('svg')).toBeNull();
      expect(some.container.querySelector('svg')).not.toBeNull();
    } finally {
      empty.unmount();
      some.unmount();
    }
  });
});
