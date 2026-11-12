import { describe, expect, it } from 'vitest';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import {
  projectUsageAgentShares,
  projectUsageConstellationModel,
  projectUsageDaylight,
  projectUsageDayModel,
  projectUsagePortraitModel,
  projectUsageScoreModel,
  projectUsageRiverModel,
  projectUsageRunLengthModel,
  projectUsageSkyModel,
  projectUsageSteeringModel,
  usageSteeringRecorded,
  projectUsageWeekHours,
  type UsageAgentCalendar,
} from './usageChartModels';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectUsagePlanetFamilyModels } from './usageChartModels';

const DAY = 86_400_000;
const START = Date.UTC(2026, 8, 7); // Monday 7 Sep 2026, UTC calendar
type Metrics = UsageAgentCalendar['days'][number]['totals'];
const metrics = (values: Partial<Metrics>): Metrics => ({
  tokens: null,
  eventCount: null,
  sessions: null,
  cost: null,
  busyMs: null,
  steeringCount: null,
  peakParallel: null,
  ...values,
});
const coverage = {
  accounting: 'complete_for_supplied_facts',
  busy: 'complete_for_supplied_facts',
  steering: 'complete_for_supplied_facts',
} as const;
type Leader = UsageAgentCalendar['days'][number]['leaders']['tokens'];
const none: Leader = {
  status: 'unavailable',
  agentIds: [],
  includesUnknown: false,
};
const leaders = (overrides: Partial<Record<keyof Metrics, Leader>> = {}) => ({
  tokens: none,
  eventCount: none,
  sessions: none,
  cost: none,
  busyMs: none,
  steeringCount: none,
  peakParallel: none,
  ...overrides,
});
const bucket = (
  dayIndex: number,
  totals: Partial<Metrics>,
  agents: readonly [string | null, Partial<Metrics>][] = [],
  leaderOverrides = {},
  hour: number | null = null,
) => {
  const startMs = START + dayIndex * DAY + (hour ?? 0) * 3_600_000;
  return {
    startMs,
    endMs: startMs + (hour === null ? DAY : 3_600_000),
    date: new Date(START + dayIndex * DAY).toISOString().slice(0, 10),
    weekday: new Date(START + dayIndex * DAY).getUTCDay(),
    hour,
    totals: metrics(totals),
    agents: agents.map(([agentId, values]) => ({
      agentId,
      metrics: metrics(values),
      coverage,
    })),
    leaders: leaders(leaderOverrides),
  };
};
const calendar = (input: Partial<UsageAgentCalendar>): UsageAgentCalendar =>
  ({
    period: { startMs: START, endMs: START + 5 * DAY },
    timeZoneOffsetMinutes: 0,
    costMode: 'auto',
    coverage,
    days: [],
    weeks: [],
    hours: [],
    weekdayHourBuckets: [],
    hourOfDayBuckets: [],
    periodSummary: { totals: metrics({}), agents: [], leaders: leaders() },
    agentActiveDays: [],
    weeklyAgentMix: [],
    weeklyPeakParallel: [],
    dayNightActivity: null,
    machineKinds: { status: 'unavailable', reason: 'no_witnessed_kind' },
    ...input,
  }) satisfies UsageAgentCalendar;

describe('Usage chart models', () => {
  it('feeds planet art from recorded calendar days, actual weekly peaks and explicit unavailable evidence', () => {
    const value = calendar({
      period: { startMs: START, endMs: START + 4 * DAY },
      coverage: { ...coverage, accounting: 'partial' },
      days: [
        bucket(0, { eventCount: 3 }),
        bucket(1, { eventCount: 3 }),
        bucket(2, { eventCount: 0 }),
      ],
      agentActiveDays: [{ agentId: 'codex', days: 2, coverage: 'partial' }],
      periodSummary: {
        totals: metrics({ tokens: 10 }),
        leaders: leaders(),
        agents: [
          {
            agentId: 'codex',
            metrics: metrics({ tokens: 10 }),
            shares: { tokens: 1, cost: null },
            coverage,
          },
        ],
      },
      weeklyPeakParallel: [
        {
          startMs: START,
          endMs: START + 4 * DAY,
          peak: 2,
          coverage: 'partial',
        },
      ],
    });
    const models = projectUsagePlanetFamilyModels(value, null, START + 4 * DAY);
    expect(models.calendarArt.days.map((day) => day.level)).toEqual([
      4,
      4,
      0,
      null,
    ]);
    expect(models.calendarArt.bestStreakDays).toBe(2);
    expect(models.moons).toEqual({
      agents: [{ agentId: 'codex', share: 1, activeDays: 2 }],
      periodDays: 4,
    });
    expect(models.atmosphere?.weeks).toEqual([
      {
        startMs: START,
        endMs: START + 4 * DAY,
        peak: 2,
        coverage: { status: 'partial', method: 'runtime' },
      },
    ]);
    expect(models.machines.kinds).toBeNull();
    expect(models.projects.links).toBeNull();
    expect(models.galaxy).toBeNull();
  });
  it.each([
    [null, 'unknown', {}],
    [0, 'complete_for_supplied_facts', { activeDays: { active: 0, of: 1 }, peakParallel: 0, streak: { current: 0, best: 0 } }],
  ] as const)('keeps unrecorded portrait activity distinct from a measured %s', (eventCount, accountingCoverage, expected) => {
    const value = calendar({
      period: { startMs: START, endMs: START + DAY },
      coverage: { ...coverage, accounting: accountingCoverage },
      days: [bucket(0, { eventCount })],
      periodSummary: { totals: metrics({ eventCount, peakParallel: eventCount }), leaders: leaders(), agents: [] },
    });
    expect(projectUsagePortraitModel(value, START + DAY - 1)).toEqual(expected);
  });
  it.each([7, 30])(
    'counts all %s calendar dates including the partial current day in the private portrait',
    (days) => {
      const value = calendar({
        period: {
          startMs: START,
          endMs: START + (days - 1) * DAY + 10 * 3_600_000,
        },
        days: Array.from({ length: days }, (_, day) =>
          bucket(day, { eventCount: 1 }),
        ),
      });
      expect(
        projectUsagePortraitModel(value, value.period.endMs).activeDays,
      ).toEqual({ active: days, of: days });
    },
  );

  it('counts dates at the selected offset for a clipped period, excluding an exact end boundary', () => {
    const value = calendar({
      period: {
        startMs: START + 23 * 3_600_000,
        endMs: START + 3 * DAY - 2 * 3_600_000,
      },
      timeZoneOffsetMinutes: 120,
    });
    expect(
      projectUsagePortraitModel(value, value.period.endMs).activeDays?.of,
    ).toBe(2);
  });
  it('keeps unavailable phone-answer observations unknown beside observed zero steering', () => {
    const query = normalizeUsageQuery({
      period: { startMs: START, endMs: START + DAY },
      includeActivity: true,
    });
    const slice = resolveUsagePageAggregation({
      queries: [query],
      howYouWork: [
        {
          query,
          detail: {
            status: 'partial',
            acceptedInputs: [],
            facts: [
              {
                workId: 'one',
                evidenceId: 'one',
                agentId: 'claude',
                machineId: null,
                kind: 'busy',
                startMs: START,
                endMs: START + 60_000,
              },
            ],
          },
        },
      ],
    }).results[0]!;
    expect(slice.howYouWork!.steering!.inputsObserved).toBe(true);
    const row = projectUsageSteeringModel(slice)!.rows[0]!;
    // Busy with no steer and no phone answer: a measured zero the body says once, not a flat lane (R8 #5).
    expect(usageSteeringRecorded(projectUsageSteeringModel(slice)!)).toBe(false);
    expect(row.steers).toBe(0);
    expect(row.steersByHour).toEqual(Array(24).fill(0));
    expect(row.phoneAnswers).toBeNull();
    expect(row.phoneAnswersByHour).toEqual(Array(24).fill(null));
  });
  it('orders Human loop and Run length members like the other Agent charts, Unknown last, and omits members with nothing to show', () => {
    const query = normalizeUsageQuery({
      period: { startMs: START, endMs: START + DAY },
      includeActivity: true,
    });
    const hour = 3_600_000;
    const slice = resolveUsagePageAggregation({
      queries: [query],
      howYouWork: [
        {
          query,
          detail: {
            status: 'partial',
            facts: [
              {
                workId: 'lost',
                evidenceId: 'lost',
                agentId: null,
                machineId: null,
                kind: 'busy',
                startMs: START,
                endMs: START + hour,
              },
              {
                workId: 'c',
                evidenceId: 'c',
                agentId: 'codex',
                machineId: null,
                kind: 'busy',
                startMs: START + hour,
                endMs: START + 3 * hour,
              },
              {
                workId: 'a',
                evidenceId: 'a',
                agentId: 'claude',
                machineId: null,
                kind: 'busy',
                startMs: START + hour,
                endMs: START + 2 * hour,
              },
            ],
            closedTurns: [
              {
                workId: 'lost',
                agentId: null,
                status: 'completed',
                startMs: START,
                endMs: START + hour,
              },
              {
                workId: 'a',
                agentId: 'claude',
                status: 'completed',
                startMs: START + hour,
                endMs: START + 2 * hour,
              },
            ],
            acceptedInputs: [],
            permissions: [
              // Answered from a desktop on work no Agent claims: no busy time, no steer and no phone answer to show.
              {
                requestId: 'p',
                workId: 'orphan',
                requestedAtMs: START,
                decidedAtMs: START + 1000,
                toolId: 'shell',
                answeringClientCategory: 'desktop',
              },
            ],
          },
        },
      ],
    }).results[0]!;
    expect(
      projectUsageSteeringModel(slice)!.rows.map((row) => row.agentId),
    ).toEqual(['claude', 'codex', null]);
    expect(
      projectUsageRunLengthModel(slice)!.rows.map((row) => row.agentId),
    ).toEqual(['claude', null]);
  });
  it('omits a Run length member whose every closed turn took no wall time (R8 #5)', () => {
    const query = normalizeUsageQuery({ period: { startMs: START, endMs: START + DAY }, includeActivity: true });
    const hour = 3_600_000;
    const slice = resolveUsagePageAggregation({ queries: [query], howYouWork: [{ query, detail: { status: 'partial',
      facts: [{ workId: 'a', evidenceId: 'a', agentId: 'claude', machineId: null, kind: 'busy', startMs: START, endMs: START + hour }],
      closedTurns: [
        { workId: 'a', agentId: 'claude', status: 'completed', startMs: START, endMs: START + hour },
        { workId: 'k', agentId: 'kimi', status: 'completed', startMs: START + hour, endMs: START + hour },
      ],
      acceptedInputs: [] } }] }).results[0]!;
    expect(projectUsageRunLengthModel(slice)!.rows.map((row) => row.agentId)).toEqual(['claude']);
  });
  it('omits an Unknown Human loop member whose only fact is a non-phone answer', () => {
    const query = normalizeUsageQuery({
      period: { startMs: START, endMs: START + DAY },
      includeActivity: true,
    });
    const slice = resolveUsagePageAggregation({
      queries: [query],
      howYouWork: [
        {
          query,
          detail: {
            status: 'partial',
            facts: [
              {
                workId: 'a',
                evidenceId: 'a',
                agentId: 'claude',
                machineId: null,
                kind: 'busy',
                startMs: START,
                endMs: START + 60_000,
              },
            ],
            acceptedInputs: [],
            permissions: [
              {
                requestId: 'p',
                workId: 'orphan',
                requestedAtMs: START,
                decidedAtMs: START + 1000,
                toolId: 'shell',
                answeringClientCategory: 'desktop',
              },
            ],
          },
        },
      ],
    }).results[0]!;
    expect(
      projectUsageSteeringModel(slice)!.rows.map((row) => row.agentId),
    ).toEqual(['claude']);
  });
  it('keeps sub-bin concurrency peaks and wait bands at the actual witnessed boundaries', () => {
    const query = normalizeUsageQuery({
      period: { startMs: START, endMs: START + DAY },
      includeActivity: true,
    });
    const minute = 60_000;
    const slice = resolveUsagePageAggregation({
      queries: [query],
      howYouWork: [
        {
          query,
          detail: {
            status: 'partial',
            facts: [
              {
                workId: 'one',
                evidenceId: 'one',
                agentId: 'claude',
                machineId: null,
                kind: 'busy',
                startMs: START,
                endMs: START + 5 * minute,
              },
              {
                workId: 'two',
                evidenceId: 'two',
                agentId: 'codex',
                machineId: null,
                kind: 'busy',
                startMs: START + minute,
                endMs: START + 2 * minute,
              },
              {
                workId: 'one',
                evidenceId: 'wait',
                agentId: 'claude',
                machineId: null,
                kind: 'user_wait',
                startMs: START + 3 * minute,
                endMs: START + 4 * minute,
              },
            ],
          },
        },
      ],
    }).results[0]!;
    const day = slice.howYouWork!.agentCalendar!.days[0]!;
    const model = projectUsageDayModel(slice, day)!;
    expect(model.peak).toEqual({
      count: 2,
      atHour: 1 / 60,
      byAgent: [
        { agentId: 'claude', count: 1 },
        { agentId: 'codex', count: 1 },
      ],
    });
    expect(model.waitCount).toBe(1);
    expect(
      model.lanes
        .find((lane) => lane.agentId === 'claude')!
        .spans.flatMap((span) => span.waits),
    ).toEqual([[3 / 60, 4 / 60]]);
  });

  it('keeps Score minute precision and simultaneous Agent time rather than clipping it to one wall hour', () => {
    const value = calendar({
      weeks: [{ ...bucket(0, { busyMs: 7_201_000 }), endMs: START + 7 * DAY }],
      hours: [
        bucket(
          0,
          { busyMs: 7_201_000 },
          [['codex', { busyMs: 7_201_000 }]],
          {},
          9,
        ),
      ],
    });
    expect(
      projectUsageScoreModel(value, undefined)!.rows[0]!.hours[0]![9],
    ).toBeCloseTo(7_201_000 / 60_000);
  });

  it('retains unknown-only witnessed busy work in Score', () => {
    const query = normalizeUsageQuery({
      period: { startMs: START, endMs: START + DAY },
      includeActivity: true,
    });
    const slice = resolveUsagePageAggregation({
      queries: [query],
      howYouWork: [
        {
          query,
          detail: {
            status: 'partial',
            facts: [
              {
                workId: 'unknown',
                evidenceId: 'unknown',
                agentId: null,
                machineId: null,
                kind: 'busy',
                startMs: START,
                endMs: START + 60_000,
              },
            ],
          },
        },
      ],
    }).results[0]!;
    const score = projectUsageScoreModel(
      slice.howYouWork!.agentCalendar!,
      undefined,
    );
    expect(score?.rows.map((row) => row.agentId)).toEqual([null]);
    expect(score?.rows[0]?.hours[0]?.[0]).toBe(1);
  });

  it('keeps partial-range day clocks and Score weekdays on the query calendar, with out-of-range hours unknown', () => {
    const hour = 3_600_000;
    const query = normalizeUsageQuery({
      period: { startMs: START + DAY + 9 * hour, endMs: START + 3 * DAY },
      timeZoneOffsetMinutes: 120,
      includeActivity: true,
    });
    const slice = resolveUsagePageAggregation({
      queries: [query],
      howYouWork: [
        {
          query,
          detail: {
            status: 'partial',
            facts: [
              {
                workId: 'one',
                evidenceId: 'one',
                agentId: 'codex',
                machineId: null,
                kind: 'busy',
                startMs: START + DAY + 9 * hour,
                endMs: START + DAY + 10 * hour,
              },
            ],
          },
        },
      ],
    }).results[0]!;
    const owner = slice.howYouWork!.agentCalendar!;
    expect(projectUsageDayModel(slice, owner.days[0]!)!.peak.atHour).toBe(11);
    const score = projectUsageScoreModel(owner, undefined)!;
    expect(score.weekStart).toBe('2026-09-07');
    expect(score.rows[0]!.hours[0]![11]).toBeNull();
    expect(score.rows[0]!.hours[1]![11]).toBe(60);
  });

  it('keeps witnessed work with unknown Agent attribution instead of inventing an identity or dropping the lane', () => {
    const query = normalizeUsageQuery({
      period: { startMs: START, endMs: START + DAY },
      includeActivity: true,
    });
    const slice = resolveUsagePageAggregation({
      queries: [query],
      howYouWork: [
        {
          query,
          detail: {
            status: 'partial',
            facts: [
              {
                workId: 'unknown',
                evidenceId: 'unknown',
                agentId: null,
                machineId: null,
                kind: 'busy',
                startMs: START,
                endMs: START + 60_000,
              },
            ],
          },
        },
      ],
    }).results[0]!;
    const model = projectUsageDayModel(
      slice,
      slice.howYouWork!.agentCalendar!.days[0]!,
    )!;
    expect(model.lanes.map((lane) => [lane.agentId, lane.agentTimeMs])).toEqual(
      [[null, 60_000]],
    );
    expect(model.peak.byAgent).toEqual([{ agentId: null, count: 1 }]);
  });

  it('does not give a cost River token shares or replace its unavailable total with zero', () => {
    const usd = (amountUsd: number) => ({
      amountUsd,
      currency: 'USD',
      source: 'provider',
      kind: 'reported' as const,
    });
    const weeks = [0, 7].map((day) => ({
      ...bucket(day, { tokens: 100, cost: usd(10) }, [
        ['claude', { tokens: 90, cost: usd(2) }],
        ['codex', { tokens: 10, cost: usd(8) }],
      ]),
      endMs: START + (day + 7) * DAY,
    }));
    const value = calendar({
      period: { startMs: START, endMs: START + 14 * DAY },
      weeks,
      weeklyAgentMix: weeks.map((week) => ({
        startMs: week.startMs,
        endMs: week.endMs,
        mix: [
          { agentId: 'claude', share: 0.9, coverage: 'partial' },
          { agentId: 'codex', share: 0.1, coverage: 'partial' },
        ],
      })),
    });
    expect(projectUsageRiverModel(value, 'cost')!.weeks[0]!.shares).toEqual([
      { agentId: 'claude', share: 0.2 },
      { agentId: 'codex', share: 0.8 },
    ]);
    expect(
      projectUsageRiverModel(
        {
          ...value,
          weeks: weeks.map((week) => ({
            ...week,
            totals: metrics({ tokens: 100 }),
          })),
        },
        'cost',
      )!.weeks[0]!.total,
    ).toBeNull();
    expect(
      projectUsageRiverModel(
        {
          ...value,
          period: { ...value.period, endMs: START + 8 * DAY },
          weeks: [weeks[0]!, { ...weeks[1]!, endMs: START + 8 * DAY }],
        },
        'cost',
      )!.weeks,
    ).toHaveLength(2);
  });

  it('preserves unknown River compositions separately from measured empty weeks', () => {
    const usd = (amountUsd: number) => ({ amountUsd, currency: 'USD', source: 'provider', kind: 'reported' as const });
    const weeks = [
      bucket(0, {}),
      bucket(7, { tokens: 0, cost: usd(0) }),
      bucket(14, { tokens: 10, cost: usd(2) }, [['claude', { tokens: 10, cost: usd(2) }]]),
    ].map(week => ({ ...week, endMs: week.startMs + 7 * DAY }));
    const value = calendar({
      period: { startMs: START, endMs: START + 21 * DAY }, weeks,
      coverage: { ...coverage, accounting: 'partial' },
      weeklyAgentMix: [{ startMs: weeks[2]!.startMs, endMs: weeks[2]!.endMs,
        mix: [{ agentId: 'claude', share: 1, coverage: 'partial' }] }],
    });
    for (const metric of ['tokens', 'cost'] as const) {
      expect(projectUsageRiverModel(value, metric)?.weeks.map(week => week.shares))
        .toEqual([null, [], [{ agentId: 'claude', share: 1 }]]);
    }
  });

  it('retains both clipped weeks and nullable members from the canonical weekly mix', () => {
    const startMs = START + 3 * DAY,
      endMs = START + 10 * DAY + 3_600_000;
    const weeks = [
      { ...bucket(3, { tokens: 100 }), startMs, endMs: START + 7 * DAY },
      { ...bucket(7, { tokens: 200 }), endMs },
    ];
    const value = calendar({
      period: { startMs, endMs },
      weeks,
      weeklyAgentMix: weeks.map((week) => ({
        startMs: week.startMs,
        endMs: week.endMs,
        mix: [
          { agentId: null, share: 0.25, coverage: 'partial' },
          { agentId: 'codex', share: 0.75, coverage: 'partial' },
        ],
      })),
    });
    expect(projectUsageRiverModel(value, 'tokens')?.weeks).toEqual(
      weeks.map((week) => ({
        start: week.date,
        end: new Date(week.endMs - 1).toISOString().slice(0, 10),
        partial: true,
        total: week.totals.tokens,
        shares: [
          { agentId: null, share: 0.25 },
          { agentId: 'codex', share: 0.75 },
        ],
      })),
    );
  });
  it('does not turn an absent day of partial evidence into measured inactivity', () => {
    const model = projectUsageSkyModel(
      calendar({ coverage: { ...coverage, busy: 'partial' } }),
      'busy',
      'intensity',
      START + DAY,
    );
    expect(model.days.every((day) => day.state === 'unknown')).toBe(true);
  });
  it('reads the selected metric on Sky of days and keeps ties, unattributed and unrecorded days distinct', () => {
    const model = projectUsageSkyModel(
      calendar({
        days: [
          bucket(0, { tokens: 900, steeringCount: 4, eventCount: 3 }, [], {
            steeringCount: {
              status: 'leading',
              agentIds: ['codex'],
              includesUnknown: false,
            },
          }),
          bucket(1, { tokens: 10, steeringCount: 2, eventCount: 2 }, [], {
            steeringCount: {
              status: 'tied',
              agentIds: ['claude', 'codex'],
              includesUnknown: false,
            },
          }),
          bucket(2, { tokens: 50, steeringCount: 1, eventCount: 1 }, [], {
            steeringCount: {
              status: 'unattributed',
              agentIds: [],
              includesUnknown: true,
            },
          }),
          bucket(3, { tokens: 70, steeringCount: null, eventCount: 1 }),
        ],
      }),
      'steering',
      'leadingAgent',
      START + 4 * DAY,
    );
    expect(
      model.days.map((day) => [
        day.state,
        day.value ?? null,
        day.leader ?? null,
      ]),
    ).toEqual([
      ['active', 4, { kind: 'agent', agentId: 'codex' }],
      ['active', 2, { kind: 'tie', agentIds: ['claude', 'codex'] }],
      ['active', 1, { kind: 'unknown' }],
      // A day whose steering is not known is not a quiet day.
      ['unknown', null, null],
      ['inactive', null, null],
    ]);
  });

  it('gives a context-only Agent an unknown share instead of zero and keeps unknown attribution in the denominator', () => {
    const shares = projectUsageAgentShares(
      calendar({
        periodSummary: {
          totals: metrics({ tokens: 400 }),
          leaders: leaders(),
          agents: [
            {
              agentId: 'claude',
              metrics: metrics({ tokens: 300 }),
              coverage,
              shares: { tokens: 0.75, cost: null },
            },
            {
              agentId: 'pi',
              metrics: metrics({ tokens: null }),
              coverage,
              shares: { tokens: null, cost: null },
            },
            {
              agentId: null,
              metrics: metrics({ tokens: 100 }),
              coverage,
              shares: { tokens: 0.25, cost: null },
            },
          ],
        },
        days: [
          bucket(0, { tokens: 400 }, [
            ['claude', { tokens: 300 }],
            ['pi', { tokens: null, eventCount: 4 }],
            [null, { tokens: 100 }],
          ]),
        ],
      }),
      'tokens',
    );
    expect(shares).toEqual([
      { agentId: 'claude', share: 0.75, activeDays: null },
      { agentId: null, share: 0.25, activeDays: null },
      { agentId: 'pi', share: null, activeDays: null },
    ]);
  });

  it('reads full-period membership and shares rather than deriving them from calendar day sums', () => {
    const usd = (amountUsd: number) => ({
      amountUsd,
      currency: 'USD',
      source: 'provider',
      kind: 'reported' as const,
    });
    const shares = projectUsageAgentShares(
      calendar({
        days: [
          bucket(0, { tokens: 100, cost: usd(100) }, [
            ['claude', { tokens: 100, cost: usd(100) }],
          ]),
        ],
        periodSummary: {
          totals: metrics({ tokens: 400, cost: usd(40) }),
          leaders: leaders(),
          agents: [
            {
              agentId: 'claude',
              metrics: metrics({ tokens: 300, cost: usd(30) }),
              coverage,
              shares: { tokens: 0.75, cost: 0.75 },
            },
            {
              agentId: 'codex',
              metrics: metrics({ tokens: 100, cost: usd(10) }),
              coverage,
              shares: { tokens: 0.25, cost: 0.25 },
            },
          ],
        },
        agentActiveDays: [{ agentId: 'codex', days: 2, coverage: 'partial' }],
      }),
      'cost',
    );
    expect(shares).toEqual([
      { agentId: 'claude', share: 0.75, activeDays: null },
      { agentId: 'codex', share: 0.25, activeDays: 2 },
    ]);
  });

  it.each(['cost', 'tokens'] as const)(
    'does not infer a context-only method from an unavailable %s denominator',
    (metric) => {
      const value = calendar({
        periodSummary: {
          totals: metrics({ tokens: metric === 'tokens' ? 0 : 50 }),
          leaders: leaders(),
          agents: [
            {
              agentId: 'codex',
              metrics: metrics({ tokens: metric === 'tokens' ? 0 : 50 }),
              coverage,
              shares: { tokens: null, cost: null },
            },
          ],
        },
      });
      const rows = projectUsageAgentShares(value, metric, (status) =>
        status === 'complete_for_supplied_facts'
          ? { long: 'Measured', short: 'Measured' }
          : undefined,
      );
      expect(rows).toEqual([
        {
          agentId: 'codex',
          share: null,
          activeDays: null,
          coverage: { long: 'Measured', short: 'Measured' },
        },
      ]);
    },
  );

  it('keeps an eighth Agent and its only collaboration edge in the complete shared model', () => {
    const query = normalizeUsageQuery({
      period: { startMs: START, endMs: START + DAY },
    });
    const slice = resolveUsagePageAggregation({
      queries: [query],
      howYouWork: [{ query, detail: { status: 'partial', facts: [] } }],
    }).results[0]!;
    // Use the canonical summary type; no rendering projection may truncate this membership.
    const model = projectUsageConstellationModel(
      {
        ...slice,
        howYouWork: {
          ...slice.howYouWork!,
          collaboration: {
            coverage: 'partial',
            unknownTimestampCount: 0,
            unknownSourceAgentCount: 0,
            unknownTargetAgentCount: 0,
            edges: [
              {
                sourceAgentId: 'a0',
                targetAgentId: 'a7',
                relation: 'run',
                count: 1,
              },
            ],
          },
        },
      },
      Array.from({ length: 8 }, (_, index) => ({
        agentId: `a${index}`,
        share: 1 / 8,
      })),
    );
    expect(model.nodes).toHaveLength(8);
    expect(model.edges).toEqual([
      { from: 'a0', to: 'a7', kind: 'run', count: 1 },
    ]);
  });

  it('does not sum Sessions or peak parallel across hours, which would double count', () => {
    const value = calendar({
      hours: [
        bucket(0, { busyMs: 600_000, sessions: 3, peakParallel: 3 }, [], {}, 9),
        bucket(7, { busyMs: 300_000, sessions: 2, peakParallel: 2 }, [], {}, 9),
      ],
      weekdayHourBuckets: [
        {
          weekday: 1,
          hour: 9,
          totals: metrics({ busyMs: 900_000, sessions: 4, peakParallel: 3 }),
          agents: [],
          leaders: leaders(),
        },
      ],
    });
    expect(projectUsageWeekHours(value, 'sessions')!.grid[0]![9]).toBe(4);
    expect(projectUsageWeekHours(value, 'peakParallel')!.grid[0]![9]).toBe(3);
    // Monday first; the canonical owner supplies each metric's actual reduction.
    expect(projectUsageWeekHours(value, 'busy')!.grid[0]![9]).toBe(900_000);
  });

  it('preserves unknown weekday cells instead of painting partial history as measured zero', () => {
    const value = calendar({
      coverage: { ...coverage, accounting: 'partial' },
      hours: [
        bucket(0, { tokens: 5 }, [], {}, 9),
        bucket(0, { tokens: null }, [], {}, 10),
      ],
      weekdayHourBuckets: [
        {
          weekday: 1,
          hour: 9,
          totals: metrics({ tokens: 5 }),
          agents: [],
          leaders: leaders(),
        },
        {
          weekday: 1,
          hour: 10,
          totals: metrics({ tokens: null }),
          agents: [],
          leaders: leaders(),
        },
      ],
    });
    const model = projectUsageWeekHours(value, 'tokens')!;
    expect(model.grid[0]![9]).toBe(5);
    expect(model.grid[0]![10]).toBeNull();
    expect(model.grid[0]![11]).toBeNull();
  });

  it('uses the canonical typical-hour Sessions and peak instead of summing weekday counts', () => {
    const slice = resolveUsagePageAggregation({
      queries: [
        normalizeUsageQuery({
          period: { startMs: START, endMs: START + 8 * DAY },
        }),
      ],
    }).results[0]!;
    const value = calendar({
      weekdayHourBuckets: [
        {
          weekday: 1,
          hour: 9,
          totals: metrics({ sessions: 3, peakParallel: 3 }),
          agents: [],
          leaders: leaders(),
        },
        {
          weekday: 2,
          hour: 9,
          totals: metrics({ sessions: 2, peakParallel: 2 }),
          agents: [],
          leaders: leaders(),
        },
      ],
      hourOfDayBuckets: [
        {
          hour: 9,
          totals: metrics({ sessions: 4, peakParallel: 3 }),
          agents: [],
          leaders: leaders(),
        },
      ],
    });
    expect(projectUsageDaylight(value, 'sessions', slice)!.hours[9]).toBe(4);
    expect(projectUsageDaylight(value, 'peakParallel', slice)!.hours[9]).toBe(
      3,
    );
    const partial = calendar({
      coverage: { ...coverage, accounting: 'partial' },
      weekdayHourBuckets: [
        {
          weekday: 1,
          hour: 9,
          totals: metrics({ tokens: 5 }),
          agents: [],
          leaders: leaders(),
        },
      ],
      hourOfDayBuckets: [
        {
          hour: 9,
          totals: metrics({ tokens: 5 }),
          agents: [],
          leaders: leaders(),
        },
      ],
    });
    expect(
      projectUsageDaylight(partial, 'tokens', slice)!.hours[10],
    ).toBeNull();
  });

  it('keeps the private busy-window share on the plotted observed Agent-time basis', () => {
    const query = normalizeUsageQuery({
      period: { startMs: START, endMs: START + DAY },
      includeActivity: true,
    });
    const hour = 3_600_000;
    const slice = resolveUsagePageAggregation({
      queries: [query],
      nightHours: { startHour: 0, endHour: 1 },
      howYouWork: [
        {
          query,
          detail: {
            status: 'partial',
            facts: [
              {
                workId: 'night-a',
                evidenceId: 'night-a',
                agentId: 'a',
                machineId: null,
                kind: 'busy',
                startMs: START,
                endMs: START + hour,
              },
              {
                workId: 'night-b',
                evidenceId: 'night-b',
                agentId: 'b',
                machineId: null,
                kind: 'busy',
                startMs: START,
                endMs: START + hour,
              },
              {
                workId: 'day-a',
                evidenceId: 'day-a',
                agentId: 'a',
                machineId: null,
                kind: 'busy',
                startMs: START + 12 * hour,
                endMs: START + 13 * hour,
              },
            ],
          },
        },
      ],
    }).results[0]!;
    const model = projectUsageDaylight(
      slice.howYouWork!.agentCalendar!,
      'busy',
      slice,
    )!;
    expect(model.hours[0]).toBe(2 * hour);
    expect(model.hours[12]).toBe(hour);
    expect(model.night?.share).toBeCloseTo(2 / 3);
  });

  it.each([[100, null, null], [100, 0, 1], [0, 100, 0], [100, 100, 0.5]] as const)('preserves the busy-window share for hourly observations of %s and %s', (nightBusyMs, dayBusyMs, share) => {
    const value = calendar({
      coverage: { ...coverage, busy: 'partial' },
      hourOfDayBuckets: [
        { hour: 0, totals: metrics({ busyMs: nightBusyMs }), agents: [], leaders: leaders() },
        { hour: 1, totals: metrics({ busyMs: dayBusyMs }), agents: [], leaders: leaders() },
      ],
    });
    const slice = { howYouWork: { nightShift: { startHour: 0, endHour: 1 } } } as unknown as UsageQueryResultSlice;
    expect(projectUsageDaylight(value, 'busy', slice)!.night?.share).toBe(share);
  });

  it('draws only collaboration between Agents and says when no collaboration summary exists', () => {
    const slice = (collaboration: unknown) =>
      ({ howYouWork: { collaboration } }) as unknown as UsageQueryResultSlice;
    const model = projectUsageConstellationModel(
      slice({
        coverage: 'partial',
        unknownTimestampCount: 0,
        unknownSourceAgentCount: 3,
        unknownTargetAgentCount: 0,
        edges: [
          {
            sourceAgentId: 'claude',
            targetAgentId: 'codex',
            relation: 'run',
            count: 5,
          },
          {
            sourceAgentId: 'claude',
            targetAgentId: 'codex',
            relation: 'review',
            count: 2,
          },
          {
            sourceAgentId: 'claude',
            targetAgentId: 'codex',
            relation: 'handoff',
            count: 9,
          },
          {
            sourceAgentId: null,
            targetAgentId: 'codex',
            relation: 'spawn',
            count: 1,
          },
        ],
      }),
      [],
    );
    expect(model.edges).toEqual([
      { from: 'claude', to: 'codex', kind: 'run', count: 7 },
    ]);
    expect(model.unknownStarts).toBe(3);
    expect(
      projectUsageConstellationModel(slice(null), [
        { agentId: 'claude', share: 1 },
      ]).edges,
    ).toBeNull();
  });
});
