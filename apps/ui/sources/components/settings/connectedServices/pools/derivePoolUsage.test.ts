import { describe, expect, it } from 'vitest';

import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';

import { derivePoolUsage, resolvePoolManualSwitchSuggestion } from './derivePoolUsage';

const NOW = 1_000_000_000;
const MIN = 60_000;

function meter(meterId: string, label: string, remainingPct: number | null, resetsInMs: number | null, extra: Partial<ConnectedServiceQuotaMeterV1> = {}): ConnectedServiceQuotaMeterV1 {
    return {
        meterId,
        label,
        used: null,
        limit: null,
        remainingPct,
        unit: 'percent',
        utilizationPct: remainingPct === null ? null : 100 - remainingPct,
        resetsAt: resetsInMs === null ? null : NOW + resetsInMs,
        status: 'ok',
        details: {},
        ...extra,
    } as ConnectedServiceQuotaMeterV1;
}

const fiveHour = (pct: number | null, resetsIn: number) => meter('5h', '5-hour', pct, resetsIn, { windowDurationMs: 5 * 60 * MIN });
const weekly = (pct: number | null, resetsIn: number) => meter('wk', 'Weekly', pct, resetsIn, { windowDurationMs: 7 * 24 * 60 * MIN });

describe('derivePoolUsage', () => {
    it('averages each window over the members that are on and report it, with the earliest reset', () => {
        const usage = derivePoolUsage({
            now: NOW,
            members: [
                { accountId: 'work', enabled: true, meters: [fiveHour(42, 135 * MIN), weekly(64, 6000 * MIN)] },
                { accountId: 'lab', enabled: true, meters: [fiveHour(96, 238 * MIN), weekly(74, 8000 * MIN)] },
                // Off: never part of the pool's number, however much it has left.
                { accountId: 'personal', enabled: false, meters: [fiveHour(6, 23 * MIN), weekly(71, 3000 * MIN)] },
            ],
        });
        expect(usage.windows).toEqual([
            expect.objectContaining({ meterId: '5h', label: '5-hour', remainingPct: 69, resetsAt: NOW + 135 * MIN, reportingCount: 2 }),
            expect.objectContaining({ meterId: 'wk', label: 'Weekly', remainingPct: 69, resetsAt: NOW + 6000 * MIN, reportingCount: 2 }),
        ]);
        expect(usage.room).toEqual({ withRoom: 2, reporting: 2, unreported: 0 });
    });

    it('never counts a member without usage as empty: it is left out of the average and counted as not reported', () => {
        const usage = derivePoolUsage({
            now: NOW,
            members: [
                { accountId: 'work', enabled: true, meters: [fiveHour(40, 60 * MIN)] },
                { accountId: 'lab', enabled: true, meters: null },
                { accountId: 'bot', enabled: true, meters: [fiveHour(null, 60 * MIN)] },
            ],
        });
        expect(usage.windows).toEqual([expect.objectContaining({ meterId: '5h', remainingPct: 40, reportingCount: 1 })]);
        expect(usage.room).toEqual({ withRoom: 1, reporting: 1, unreported: 2 });
        expect(usage.roomByAccountId).toEqual({ work: 'room', lab: 'unknown', bot: 'unknown' });
    });

    it('marks a member with an exhausted window as waiting and names the first member back', () => {
        const usage = derivePoolUsage({
            now: NOW,
            members: [
                { accountId: 'work', enabled: true, meters: [fiveHour(0, 135 * MIN), weekly(60, 6000 * MIN)] },
                { accountId: 'lab', enabled: true, meters: [fiveHour(0, 30 * MIN), weekly(0, 9000 * MIN)] },
            ],
        });
        expect(usage.room).toEqual({ withRoom: 0, reporting: 2, unreported: 0 });
        expect(usage.roomByAccountId).toEqual({ work: 'waiting', lab: 'waiting' });
        // Lab's 5-hour resets first, but its weekly keeps it waiting; Work is back first.
        expect(usage.firstBack).toEqual({ accountId: 'work', atMs: NOW + 135 * MIN });
    });

    it('carries an estimated reading so the pool meter can say so', () => {
        const usage = derivePoolUsage({
            now: NOW,
            members: [{ accountId: 'work', enabled: true, meters: [fiveHour(50, 60 * MIN)].map((m) => ({ ...m, status: 'estimated' as const })) }],
        });
        expect(usage.windows[0]).toEqual(expect.objectContaining({ estimated: true }));
    });
});

describe('resolvePoolManualSwitchSuggestion', () => {
    const members = [
        { accountId: 'work', enabled: true, priority: 100 },
        { accountId: 'personal', enabled: true, priority: 200 },
        { accountId: 'lab', enabled: true, priority: 300 },
        { accountId: 'off', enabled: false, priority: 400 },
    ];
    const room = { work: 'room', personal: 'room', lab: 'room', off: 'room' } as const;

    it('skips the current, disabled and waiting members', () => {
        expect(resolvePoolManualSwitchSuggestion({ activeAccountId: 'work', members, roomByAccountId: { ...room, personal: 'waiting' } })).toBe('lab');
    });

    it('suggests the first available member in user order, without ranking quota', () => {
        expect(resolvePoolManualSwitchSuggestion({ activeAccountId: 'work', members, roomByAccountId: room })).toBe('personal');
    });

    it('nothing when no other member is on', () => {
        expect(resolvePoolManualSwitchSuggestion({ activeAccountId: 'work', members: members.map((m) => (m.accountId === 'work' ? m : { ...m, enabled: false })), roomByAccountId: room })).toBeNull();
    });
});
