import { describe, expect, it } from 'vitest';
import { canonicalUsageLimitMaximum, evaluateTeamCredentialUsageLimits, type TeamCredentialUsageLimitEvent, type TeamCredentialUsageLimitRow } from './teamCredentialUsageLimits';

const now = new Date('2026-09-07T12:00:00.000Z'); // Monday UTC
const limit = (overrides: Partial<TeamCredentialUsageLimitRow> = {}): TeamCredentialUsageLimitRow => ({
    id: 'limit-1', resourceId: 'resource-1', subjectKind: 'resource', subjectId: '', period: 'week',
    metric: 'inference_requests', maximum: '2', enabled: true, createdAt: new Date('2026-09-01T00:00:00.000Z'), ...overrides,
});
const event = (overrides: Partial<TeamCredentialUsageLimitEvent> = {}): TeamCredentialUsageLimitEvent => ({
    id: crypto.randomUUID(), observedAt: now, resourceId: 'resource-1', actorAccountId: 'member-1', requestCount: 1,
    totalTokens: 0, effectiveCostUsd: null, costMeasurementExpected: true, deliveryMode: 'brokered',
    groupAdmissions: [], turnStartedAtMs: null, ...overrides,
});

describe('Team credential usage limits', () => {
    it('uses Monday-start UTC windows and denies at the recorded ceiling', () => {
        const result = evaluateTeamCredentialUsageLimits({ limits: [limit()], events: [event(), event({ id: 'event-2' })], actorAccountId: 'member-1', now });
        expect(result).toMatchObject({
            ok: false,
            denied: { limitId: 'limit-1', recorded: 2, maximum: 2, resetsAt: new Date('2026-09-14T00:00:00.000Z') },
        });
    });

    it('applies resource, member and Group ceilings together', () => {
        const result = evaluateTeamCredentialUsageLimits({
            limits: [
                limit({ id: 'resource', maximum: '3' }),
                limit({ id: 'member', subjectKind: 'team_member', subjectId: 'member-1', maximum: '2' }),
                limit({ id: 'group', subjectKind: 'team_group', subjectId: 'group-1', maximum: '1' }),
            ],
            events: [
                event({ groupAdmissions: [{ groupId: 'group-1', observedAtMs: now.getTime() }] }),
                event({ id: 'event-2', groupAdmissions: [{ groupId: 'group-1', observedAtMs: now.getTime() }] }),
            ],
            actorAccountId: 'member-1', currentGroupIds: ['group-1'], now,
        });
        expect(result).toMatchObject({
            ok: false,
            denied: { limitId: 'group' },
            applied: [{ limitId: 'resource' }, { limitId: 'member' }, { limitId: 'group' }],
        });
    });

    it('uses the latest reset among every exhausted applicable limit', () => {
        const result = evaluateTeamCredentialUsageLimits({
            limits: [
                limit({ id: 'daily', period: 'day', maximum: '1' }),
                limit({ id: 'monthly', period: 'month', maximum: '1' }),
            ],
            events: [event()],
            actorAccountId: 'member-1',
            now,
        });
        expect(result).toMatchObject({
            ok: false,
            denied: { limitId: 'monthly', resetsAt: new Date('2026-10-01T00:00:00.000Z') },
            applied: [{ limitId: 'daily' }, { limitId: 'monthly' }],
        });
    });

    it('does not reinterpret the request-count admission fact as missing terminal cost', () => {
        const result = evaluateTeamCredentialUsageLimits({
            limits: [limit({ metric: 'cost_usd', maximum: '5' })],
            events: [
                event({ requestCount: 1, costMeasurementExpected: false }),
                event({ id: 'terminal', requestCount: 0, effectiveCostUsd: 2, costMeasurementExpected: true }),
            ],
            actorAccountId: 'member-1',
            now,
        });

        expect(result).toMatchObject({ ok: true, applied: [{ recorded: 2, maximum: 5 }] });
    });

    it('uses the current actor Account and current Groups, not a membership-row id or historical Group attribution', () => {
        const result = evaluateTeamCredentialUsageLimits({
            limits: [
                limit({ id: 'account', subjectKind: 'team_member', subjectId: 'account-1', maximum: '2' }),
                limit({ id: 'membership', subjectKind: 'team_member', subjectId: 'membership-1', maximum: '1' }),
                limit({ id: 'left-group', subjectKind: 'team_group', subjectId: 'group-old', maximum: '1' }),
            ],
            events: [event({
                actorAccountId: 'account-1',
                groupAdmissions: [{ groupId: 'group-old', observedAtMs: now.getTime() }],
            })],
            actorAccountId: 'account-1',
            currentGroupIds: [],
            now,
        });
        expect(result).toMatchObject({ ok: true, applied: [{ limitId: 'account', recorded: 1 }] });
    });

    it('treats each-member ceilings independently', () => {
        const result = evaluateTeamCredentialUsageLimits({
            limits: [limit({ subjectKind: 'each_member', subjectId: '', maximum: '2' })],
            events: [event(), event({ id: 'event-other', actorAccountId: 'member-2' })],
            actorAccountId: 'member-1',
            now,
        });
        expect(result).toMatchObject({ ok: true, applied: [{ recorded: 1 }] });
    });

    it('does not treat unknown cost as zero', () => {
        const result = evaluateTeamCredentialUsageLimits({
            limits: [limit({ metric: 'cost_usd', maximum: '1.00' })], events: [event({ effectiveCostUsd: null })], actorAccountId: 'member-1', now,
        });
        expect(result).toEqual({
            ok: false,
            unavailable: {
                limitId: 'limit-1',
                metric: 'cost_usd',
                reason: 'cost_limit_unavailable',
            },
        });
    });

    it('reports recorded usage for ceilings that still pass', () => {
        const result = evaluateTeamCredentialUsageLimits({
            limits: [limit({ maximum: '3' })],
            events: [event()],
            actorAccountId: 'member-1',
            now,
        });
        expect(result).toMatchObject({ ok: true, applied: [{ recorded: 1, maximum: 3 }] });
    });

    it('keeps concurrent recorded-usage checks honestly soft without inventing reservations', () => {
        const evaluateAgainstSameRecordedBaseline = () => evaluateTeamCredentialUsageLimits({
            limits: [limit({ metric: 'total_tokens', maximum: '100' })],
            events: [event({ totalTokens: 90 })],
            actorAccountId: 'member-1',
            now,
        });

        // Two requests admitted from the same recorded baseline may both
        // finish. The canonical owner stops later requests only after those
        // terminal observations are recorded; it does not claim a reservation.
        expect(evaluateAgainstSameRecordedBaseline()).toMatchObject({ ok: true, applied: [{ recorded: 90 }] });
        expect(evaluateAgainstSameRecordedBaseline()).toMatchObject({ ok: true, applied: [{ recorded: 90 }] });
    });

    it('normalizes only canonical safe ceilings', () => {
        expect(canonicalUsageLimitMaximum(' 010 ', 'inference_requests')).toBeNull();
        expect(canonicalUsageLimitMaximum('10.0', 'inference_requests')).toBeNull();
        expect(canonicalUsageLimitMaximum('10.00', 'cost_usd')).toBe('10.00');
        expect(canonicalUsageLimitMaximum('0', 'inference_requests')).toBeNull();
        expect(canonicalUsageLimitMaximum('0.00', 'cost_usd')).toBeNull();
    });

    it('includes the bucket start and excludes the exact bucket end', () => {
        const result = evaluateTeamCredentialUsageLimits({
            limits: [limit({ period: 'day', maximum: '3', createdAt: new Date('2026-09-01T00:00:00.000Z') })],
            events: [
                event({ id: 'prior-day', observedAt: new Date('2026-09-06T23:59:59.999Z') }),
                event({ id: 'first-ms', observedAt: new Date('2026-09-07T00:00:00.000Z') }),
                event({ id: 'last-ms', observedAt: new Date('2026-09-07T23:59:59.999Z') }),
                event({ id: 'next-bucket', observedAt: new Date('2026-09-08T00:00:00.000Z') }),
            ],
            actorAccountId: 'member-1',
            now,
        });
        expect(result).toMatchObject({ ok: true, applied: [{ recorded: 2 }] });
    });

    it('starts a new window at the limit creation time, not at earlier in-bucket usage', () => {
        const result = evaluateTeamCredentialUsageLimits({
            limits: [limit({ period: 'day', maximum: '3', createdAt: new Date('2026-09-07T09:00:00.000Z') })],
            events: [
                event({ id: 'bucket-start-before-creation', observedAt: new Date('2026-09-07T00:00:00.000Z') }),
                event({ id: 'before-creation', observedAt: new Date('2026-09-07T08:59:59.999Z') }),
                event({ id: 'at-creation', observedAt: new Date('2026-09-07T09:00:00.000Z') }),
            ],
            actorAccountId: 'member-1',
            now,
        });
        expect(result).toMatchObject({ ok: true, applied: [{ recorded: 1 }] });
    });

    it('starts token and cost limits on the next turn while request limits begin immediately', () => {
        const createdAt = new Date('2026-09-07T09:00:00.000Z');
        const activeTurnEvent = event({
            id: 'active-turn',
            observedAt: new Date('2026-09-07T10:00:00.000Z'),
            turnStartedAtMs: Date.parse('2026-09-07T08:00:00.000Z'),
            requestCount: 1,
            totalTokens: 90,
            effectiveCostUsd: 3,
        });
        const nextTurnEvent = event({
            id: 'next-turn',
            observedAt: new Date('2026-09-07T11:00:00.000Z'),
            turnStartedAtMs: Date.parse('2026-09-07T10:30:00.000Z'),
            requestCount: 1,
            totalTokens: 10,
            effectiveCostUsd: 1,
        });

        const limits = [
            limit({ id: 'requests', period: 'day', createdAt, maximum: '3' }),
            limit({ id: 'tokens', period: 'day', createdAt, metric: 'total_tokens', maximum: '100' }),
            limit({ id: 'cost', period: 'day', createdAt, metric: 'cost_usd', maximum: '5' }),
        ];
        const result = evaluateTeamCredentialUsageLimits({
            limits,
            events: [activeTurnEvent, nextTurnEvent],
            actorAccountId: 'member-1',
            now,
        });

        expect(result).toMatchObject({
            ok: true,
            applied: [
                { limitId: 'requests', recorded: 2 },
                { limitId: 'tokens', recorded: 10 },
                { limitId: 'cost', recorded: 1 },
            ],
        });
    });
});
