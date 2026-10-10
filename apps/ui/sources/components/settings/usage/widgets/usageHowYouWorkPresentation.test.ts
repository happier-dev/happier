import { describe, expect, it } from 'vitest';
import {
  groupUsageTodayLanes,
  listUsageNightHours,
  readUsageAnsweringShares,
  readUsageWorkSessionId,
  sumUsageWaitingOnYouMs,
  usageNightGridPresentation,
  formatUsageUtcOffset,
} from './usageHowYouWorkPresentation';

const MIN = 60_000;
const today = { startMs: 1_000 * MIN, endMs: 1_000 * MIN + 1_440 * MIN };
const labels = {
  session: (workId: string) => readUsageWorkSessionId(workId) ?? 'untitled',
  machine: (machineId: string | null) => machineId ?? 'unknown',
  agent: (agentId: string) => agentId,
  agentColor: (agentId: string) => `agent-${agentId}`,
  waitColor: 'amber',
};

describe('How you work presentation', () => {
  it('draws only witnessed busy spans and waits inside today, by machine, without filling run gaps', () => {
    const groups = groupUsageTodayLanes(
      [
        {
          workId: JSON.stringify(['s1', 't1']),
          agentId: 'codex',
          machineId: 'devbox',
          parentWorkId: null,
          // Starts before today: only its inside part is drawn. Two spans with a gap stay two rows.
          busy: [
            {
              startMs: today.startMs - 30 * MIN,
              endMs: today.startMs + 60 * MIN,
            },
            {
              startMs: today.startMs + 120 * MIN,
              endMs: today.startMs + 150 * MIN,
            },
          ],
          waits: [
            {
              startMs: today.startMs + 60 * MIN,
              endMs: today.startMs + 90 * MIN,
              kind: 'permission_wait',
              evidenceId: 'r1',
            },
            {
              startMs: today.startMs + 90 * MIN,
              endMs: today.startMs + 100 * MIN,
              kind: 'child_wait',
              evidenceId: 'c1',
            },
          ],
        },
        {
          workId: JSON.stringify(['s2', 't2']),
          agentId: 'claude',
          machineId: 'laptop',
          parentWorkId: null,
          busy: [
            {
              startMs: today.startMs - 120 * MIN,
              endMs: today.startMs - 60 * MIN,
            },
          ],
          waits: [],
        },
      ],
      today,
      labels,
    );
    // The laptop's only span ended before today, so it has no group at all.
    expect(groups.map((group) => group.id)).toEqual(['devbox']);
    const rows = groups[0]!.intervals;
    expect(rows.map((row) => [row.start, row.end])).toEqual([
      [0, 60],
      [60, 90],
      [90, 100],
      [120, 150],
    ]);
    expect(rows.filter((row) => row.pattern === 'hatched')).toHaveLength(2);
    expect(rows[0]!.label).toBe('s1');
    // Approvals count as waiting on you; a sub-agent wait is the agent's own.
    expect(sumUsageWaitingOnYouMs(groups)).toBe(30 * MIN);
    expect(
      rows.every((row) => !String(row.annotation ?? '').includes('_wait')),
    ).toBe(true);
  });

  it('splits answering devices over witnessed categories only and keeps unknown as its own count', () => {
    const shares = readUsageAnsweringShares({
      requestCount: 6,
      pairedDecisionCount: 6,
      decisionLatencyMs: 1,
      unknownRequestTimeCount: 0,
      unknownDecisionTimeCount: 0,
      byAnsweringClient: { ios: 2, android: 0, web: 0, desktop: 3, unknown: 1 },
      byTool: [],
    });
    expect(shares).toEqual({
      witnessed: 5,
      unknown: 1,
      shares: [
        { client: 'desktop', count: 3 },
        { client: 'ios', count: 2 },
      ],
    });
  });

  it('lists a night window across midnight and positions only night-hour activity', () => {
    const night = { startHour: 23, endHour: 7 };
    expect(listUsageNightHours(night)).toEqual([23, 0, 1, 2, 3, 4, 5, 6]);
    const grid = usageNightGridPresentation({
      night,
      accentColor: '#3366ff',
      emptyColor: 'empty',
      weekdayLabel: (day) => `d${day}`,
      eventsLabel: (count) => `${count} events`,
      buckets: [
        { weekday: 2, hour: 23, eventCount: 4 },
        { weekday: 2, hour: 12, eventCount: 99 },
        { weekday: 3, hour: 3, eventCount: 2 },
      ],
    });
    expect(grid.columns.map((column) => column.id)).toEqual([
      '23',
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
    expect(grid.cells).toHaveLength(7 * 8);
    expect(grid.cells.find((cell) => cell.id === '2:23')?.value).toBe(4);
    expect(grid.cells.find((cell) => cell.id === '3:3')?.value).toBe(2);
    expect(grid.cells.some((cell) => cell.value === 99)).toBe(false);
    expect(grid.cells.find((cell) => cell.id === '0:1')).toMatchObject({
      value: 0,
      color: 'empty',
    });
  });

  it('states the query calendar offset rather than assuming local time', () => {
    expect(formatUsageUtcOffset(120)).toBe('UTC+02:00');
    expect(formatUsageUtcOffset(-330)).toBe('UTC−05:30');
  });
});
