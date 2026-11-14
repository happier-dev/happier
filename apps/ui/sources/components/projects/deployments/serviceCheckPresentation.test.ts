import { describe, expect, it } from 'vitest';

import {
  readServiceCheckFacts,
  serviceCheckHistoryStrip,
} from './serviceCheckPresentation';

const DAY = 86_400_000;
const today = Date.UTC(2026, 10, 14);
const result = (status: 'up' | 'down' | 'degraded' | 'unknown') =>
  ({
    status,
    observedAt: today + 3_600_000,
    evidence: { kind: 'none' },
  }) as never;
const day = (
  offset: number,
  counts: Partial<Record<'up' | 'down' | 'degraded' | 'unknown', number>>,
  uptimePercent: number | null,
) => ({
  dayStartAt: today - offset * DAY,
  up: counts.up ?? 0,
  down: counts.down ?? 0,
  degraded: counts.degraded ?? 0,
  unknown: counts.unknown ?? 0,
  uptimePercent,
});

describe('Services → Checks (UPTIME-HISTORY-1113 history)', () => {
  it('reads the worst reported state and the lowest reported 30-day uptime, never computing one', () => {
    const facts = readServiceCheckFacts({
      kind: 'available',
      checks: [
        {
          checkId: 'a',
          result: result('up'),
          history: { lastObservedAt: today, uptimePercent: 99.9, days: [] },
        },
        {
          checkId: 'b',
          result: result('degraded'),
          history: { lastObservedAt: today, uptimePercent: 97.25, days: [] },
        },
        { checkId: 'c', result: result('up') },
      ],
    });
    expect(facts).toMatchObject({ status: 'degraded', uptimePercent: 97.25 });
  });

  it('keeps never-observed and unread states apart from a failing check', () => {
    expect(readServiceCheckFacts({ kind: 'neverObserved' }).status).toBe(
      'notChecked',
    );
    expect(readServiceCheckFacts({ kind: 'loading' }).status).toBe('loading');
    expect(
      readServiceCheckFacts({ kind: 'unavailable', code: 'x' }).status,
    ).toBe('unknown');
    expect(
      readServiceCheckFacts({ kind: 'available', checks: [] }).uptimePercent,
    ).toBeNull();
  });

  it('lays out today and the 29 days before it; a missing day is unobserved, never up', () => {
    const strip = serviceCheckHistoryStrip(
      {
        lastObservedAt: today,
        uptimePercent: 90,
        days: [
          day(0, { up: 10 }, 100),
          day(1, { up: 5, down: 1 }, 83.3),
          day(2, { up: 4, degraded: 2 }, 66.7),
        ],
      },
      today + 5_000,
    );
    expect(strip).toHaveLength(30);
    expect(strip.at(-1)).toMatchObject({
      dayStartAt: today,
      tone: 'up',
      uptimePercent: 100,
    });
    expect(strip.at(-2)).toMatchObject({ tone: 'down' });
    expect(strip.at(-3)).toMatchObject({ tone: 'degraded' });
    expect(strip.at(-4)).toMatchObject({
      tone: 'unobserved',
      uptimePercent: null,
    });
    expect(strip[0]!.dayStartAt).toBe(today - 29 * DAY);
  });
});
