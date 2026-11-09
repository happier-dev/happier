import { describe, expect, it } from 'vitest';

import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol/connect/connected-service-schemas';

import { derivePoolUsage, projectPoolUsage, resolvePoolManualSwitchSuggestion } from './derivePoolUsage';

const NOW = 1_000_000_000;
const MIN = 60_000;

function meter(meterId: string, label: string, remainingPct: number | null, resetsInMs: number | null, extra: Partial<ConnectedServiceQuotaMeterV1> = {}): ConnectedServiceQuotaMeterV1 {
    return {
        meterId,
        label,
        used: null,
        limit: null,
        remainingPct,
        unit: 'requests',
        utilizationPct: remainingPct === null ? null : 100 - remainingPct,
        resetsAt: resetsInMs === null ? null : NOW + resetsInMs,
        status: 'ok',
        details: {},
        ...extra,
    };
}

const fiveHour = (pct: number | null, resetsIn: number) => meter('5h', '5-hour', pct, resetsIn, { windowDurationMs: 5 * 60 * MIN });
const weekly = (pct: number | null, resetsIn: number) => meter('wk', 'Weekly', pct, resetsIn, { windowDurationMs: 7 * 24 * 60 * MIN });

describe('projectPoolUsage', () => {
    it('counts selected limits and qualifies retained readings without changing their capacity', () => {
        const snapshot = { meters: [fiveHour(0, MIN), weekly(75, 10 * MIN)], fetchedAt: NOW - 2 * MIN, staleAfterMs: MIN };
        const summary = projectPoolUsage({ now: NOW, quotaLimitSelection: { mode: 'selected', providerLimitIds: ['wk'] },
            members: [{ accountId: 'work', enabled: true, credentialStatus: 'connected', snapshot, failed: true }] });
        expect(summary.usage.windows).toEqual([expect.objectContaining({ meterId: 'wk', remainingPct: 75 })]);
        expect(summary.usage.memberByAccountId.work).toMatchObject({ lowestRemainingPct: 75, room: 'room', isStale: true });
        expect(summary.freshness).toEqual({ asOf: snapshot.fetchedAt, isStale: true, notAnswering: true, staleMemberIds: ['work'] });
        expect(snapshot.meters).toHaveLength(2);
    });

    it('keeps the aggregate warning policy when only one reading is old or failed', () => {
        const old = { meters: [weekly(60, MIN)], fetchedAt: NOW - 2 * MIN, staleAfterMs: MIN };
        const summary = projectPoolUsage({ now: NOW, members: [
            { accountId: 'old', enabled: true, credentialStatus: 'connected', snapshot: old, failed: true },
            { accountId: 'fresh', enabled: true, credentialStatus: 'connected', snapshot: { ...old, fetchedAt: NOW } },
        ] });
        expect(summary.freshness).toMatchObject({ asOf: old.fetchedAt, isStale: true, notAnswering: false });
        expect(summary.usage.room.withRoom).toBe(2);
    });
});

describe('derivePoolUsage', () => {
    it.each([true, false])('keeps reused primary meter ids separate by their window (duration reported: %s)', (reportsDuration) => {
        const session = meter('primary', 'Session', 80, 60 * MIN,
            reportsDuration ? { windowDurationMs: 5 * 60 * MIN } : {});
        const week = meter('primary', 'Weekly', 10, 6000 * MIN,
            reportsDuration ? { windowDurationMs: 7 * 24 * 60 * MIN } : {});
        const usage = derivePoolUsage({ now: NOW, members: [
            { accountId: 'session', enabled: true, credentialStatus: 'connected', meters: [session] },
            { accountId: 'weekly', enabled: true, credentialStatus: 'connected', meters: [week] },
        ] });
        expect(usage.windows).toEqual([
            expect.objectContaining({ meterId: 'primary', label: 'Session', remainingPct: 80, reportingCount: 1 }),
            expect.objectContaining({ meterId: 'primary', label: 'Weekly', remainingPct: 10, reportingCount: 1 }),
        ]);
    });

    it('does not average different reported durations even when their primary labels agree', () => {
        const usage = derivePoolUsage({ now: NOW, members: [
            { accountId: 'short', enabled: true, credentialStatus: 'connected', meters: [meter('primary', 'Session', 80, 60 * MIN, { windowDurationMs: 5 * 60 * MIN })] },
            { accountId: 'long', enabled: true, credentialStatus: 'connected', meters: [meter('primary', 'Session', 10, 120 * MIN, { windowDurationMs: 24 * 60 * MIN })] },
        ] });
        expect(usage.windows.map((window) => window.remainingPct)).toEqual([80, 10]);
    });

    it('counts every member and exposes credential health and current room in one member state', () => {
        const usage = derivePoolUsage({ now: NOW, members: [
            { accountId: 'work', enabled: true, credentialStatus: 'connected', meters: [weekly(0, 60 * MIN)] },
            { accountId: 'lab', enabled: true, credentialStatus: 'connected', meters: [weekly(0, 30 * MIN)], isStale: true },
            { accountId: 'personal', enabled: true, credentialStatus: 'needs_reauth', meters: [weekly(100, 30 * MIN)] },
            { accountId: 'spare', enabled: true, credentialStatus: 'needs_reauth', meters: null },
            { accountId: 'off', enabled: false, credentialStatus: 'connected', meters: [weekly(90, 30 * MIN)], isStale: true },
        ] });
        expect(usage.room).toEqual({ withRoom: 0, total: 5, reporting: 2, unreported: 0 });
        expect(usage.memberByAccountId).toMatchObject({
            work: { health: 'error', credentialStatus: 'connected', isStale: false },
            lab: { health: 'error', credentialStatus: 'connected', isStale: true },
            personal: { health: 'error', credentialStatus: 'needs_reauth', isStale: false },
            off: { health: 'attention', credentialStatus: 'connected', isStale: true },
        });
        expect(usage.memberByAccountId.personal).toMatchObject({ room: 'unknown', lowestRemainingPct: null });
    });
    // ORCH r1107r: aging/revalidation must retain settled capacity, not turn it into "not reported".
    it('keeps reported capacity through freshness expiry without claiming a current recovery time', () => {
        const usage = derivePoolUsage({ now: NOW, members: [
            { accountId: 'stale-room', enabled: true, credentialStatus: 'connected', isStale: true, meters: [weekly(75, 30 * MIN)] },
            { accountId: 'stale-waiting', enabled: true, credentialStatus: 'connected', isStale: true, meters: [weekly(0, 60 * MIN)] },
        ] });
        expect(usage.room).toEqual({ withRoom: 1, total: 2, reporting: 2, unreported: 0 });
        expect(usage.windows).toEqual([expect.objectContaining({ remainingPct: 38, reportingCount: 2 })]);
        expect(usage.memberByAccountId).toMatchObject({
            'stale-room': { room: 'room', lowestRemainingPct: 75, meters: [expect.objectContaining({ remainingPct: 75 })] },
            'stale-waiting': { room: 'waiting', lowestRemainingPct: 0, meters: [expect.objectContaining({ remainingPct: 0 })] },
        });
        expect(usage.firstBack).toBeNull();
        expect(usage.memberByAccountId['stale-room']).toMatchObject({ health: 'attention', isStale: true });
    });
    it('keeps the five-member summary settled as readings age independently and then refresh', () => {
        const members = [68, 0, 0, 0, 96].map((pct, index) => ({
            accountId: String(index), enabled: true, credentialStatus: 'connected', meters: [fiveHour(pct, 90 * MIN)],
        }));
        for (const staleCount of [0, 2, 4, 5, 0]) {
            const usage = derivePoolUsage({ now: NOW, members: members.map((member, index) => ({
                ...member, isStale: index < staleCount,
            })) });
            expect(usage.room).toEqual({ withRoom: 2, total: 5, reporting: 5, unreported: 0 });
            expect(usage.firstBack).toBeNull();
        }
    });
    it('excludes signed-out members from pool capacity while retaining exhausted connected members and their reset', () => {
        const usage = derivePoolUsage({ now: NOW, members: [
            { accountId: 'work', enabled: true, credentialStatus: 'connected', meters: [weekly(0, 60 * MIN)] },
            { accountId: 'signed-out', enabled: true, credentialStatus: 'needs_reauth', meters: [weekly(100, 30 * MIN)] },
        ] });
        expect(usage.windows).toEqual([expect.objectContaining({ remainingPct: 0, reportingCount: 1 })]);
        expect(usage.room).toEqual({ withRoom: 0, total: 2, reporting: 1, unreported: 0 });
        expect(usage.firstBack).toEqual({ accountId: 'work', atMs: NOW + 60 * MIN });
        const signedOut = derivePoolUsage({ now: NOW, members: [
            { accountId: 'signed-out', enabled: true, credentialStatus: 'needs_reauth', meters: [weekly(100, 30 * MIN)] },
        ] });
        expect(signedOut.windows).toEqual([]);
        expect(signedOut.room).toEqual({ withRoom: 0, total: 1, reporting: 0, unreported: 0 });
        expect(signedOut.firstBack).toBeNull();
        expect(signedOut.memberByAccountId['signed-out']?.lowestRemainingPct).toBeNull();
    });
    it('averages each window over the members that are on and report it, with the earliest reset', () => {
        const usage = derivePoolUsage({
            now: NOW,
            members: [
                { accountId: 'work', enabled: true, credentialStatus: 'connected', meters: [fiveHour(42, 135 * MIN), weekly(64, 6000 * MIN)] },
                { accountId: 'lab', enabled: true, credentialStatus: 'connected', meters: [fiveHour(96, 238 * MIN), weekly(74, 8000 * MIN)] },
                // Off: never part of the pool's number, however much it has left.
                { accountId: 'personal', enabled: false, credentialStatus: 'connected', meters: [fiveHour(6, 23 * MIN), weekly(71, 3000 * MIN)] },
            ],
        });
        expect(usage.windows).toEqual([
            expect.objectContaining({ meterId: '5h', label: '5-hour', remainingPct: 69, resetsAt: NOW + 135 * MIN, reportingCount: 2 }),
            expect.objectContaining({ meterId: 'wk', label: 'Weekly', remainingPct: 69, resetsAt: NOW + 6000 * MIN, reportingCount: 2 }),
        ]);
        expect(usage.room).toEqual({ withRoom: 2, total: 3, reporting: 2, unreported: 0 });
    });

    it('never counts a member without usage as empty: it is left out of the average and counted as not reported', () => {
        const usage = derivePoolUsage({
            now: NOW,
            members: [
                { accountId: 'work', enabled: true, credentialStatus: 'connected', meters: [fiveHour(40, 60 * MIN)] },
                { accountId: 'lab', enabled: true, credentialStatus: 'connected', meters: null },
                { accountId: 'bot', enabled: true, credentialStatus: 'connected', meters: [fiveHour(null, 60 * MIN)] },
            ],
        });
        expect(usage.windows).toEqual([expect.objectContaining({ meterId: '5h', remainingPct: 40, reportingCount: 1 })]);
        expect(usage.room).toEqual({ withRoom: 1, total: 3, reporting: 1, unreported: 2 });
        expect(usage.memberByAccountId).toMatchObject({ work: { room: 'room' }, lab: { room: 'unknown' }, bot: { room: 'unknown' } });
    });

    it('marks a member with an exhausted window as waiting and names the first member back', () => {
        const usage = derivePoolUsage({
            now: NOW,
            members: [
                { accountId: 'work', enabled: true, credentialStatus: 'connected', meters: [fiveHour(0, 135 * MIN), weekly(60, 6000 * MIN)] },
                { accountId: 'lab', enabled: true, credentialStatus: 'connected', meters: [fiveHour(0, 30 * MIN), weekly(0, 9000 * MIN)] },
            ],
        });
        expect(usage.room).toEqual({ withRoom: 0, total: 2, reporting: 2, unreported: 0 });
        expect(usage.memberByAccountId).toMatchObject({ work: { room: 'waiting' }, lab: { room: 'waiting' } });
        // Lab's 5-hour resets first, but its weekly keeps it waiting; Work is back first.
        expect(usage.firstBack).toEqual({ accountId: 'work', atMs: NOW + 135 * MIN });
    });

    it.each([
        { label: 'stale room', isStale: true, meters: [fiveHour(86, 60 * MIN)] },
        { label: 'stale exhaustion', isStale: true, meters: [fiveHour(0, 60 * MIN)] },
        { label: 'unread usage', isStale: false, meters: null },
        { label: 'unreported usage', isStale: false, meters: [fiveHour(null, 60 * MIN)] },
    ])('does not claim the whole pool is waiting when a member has $label', ({ isStale, meters }) => {
        const usage = derivePoolUsage({ now: NOW, members: [
            { accountId: 'work', enabled: true, credentialStatus: 'connected', meters: [fiveHour(0, 90 * MIN)] },
            { accountId: 'backup', enabled: true, credentialStatus: 'connected', isStale, meters },
        ] });
        expect(usage.room.withRoom).toBe(isStale && meters?.[0]?.remainingPct === 86 ? 1 : 0);
        expect(usage.firstBack).toBeNull();
    });

    it('carries an estimated reading so the pool meter can say so', () => {
        const usage = derivePoolUsage({
            now: NOW,
            members: [{ accountId: 'work', enabled: true, credentialStatus: 'connected', meters: [fiveHour(50, 60 * MIN)].map((m) => ({ ...m, status: 'estimated' as const })) }],
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
    const room = { work: { room: 'room' }, personal: { room: 'room' }, lab: { room: 'room' }, off: { room: 'room' } } as const;

    it('skips the current, disabled and waiting members', () => {
        expect(resolvePoolManualSwitchSuggestion({ activeAccountId: 'work', members, memberByAccountId: { ...room, personal: { room: 'waiting' } } })).toBe('lab');
    });

    it('suggests the first available member in user order, without ranking quota', () => {
        expect(resolvePoolManualSwitchSuggestion({ activeAccountId: 'work', members, memberByAccountId: room })).toBe('personal');
    });

    it('nothing when no other member is on', () => {
        expect(resolvePoolManualSwitchSuggestion({ activeAccountId: 'work', members: members.map((m) => (m.accountId === 'work' ? m : { ...m, enabled: false })), memberByAccountId: room })).toBeNull();
    });
});
