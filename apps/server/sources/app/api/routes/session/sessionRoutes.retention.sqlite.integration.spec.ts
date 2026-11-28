import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createRouteTestBuilder } from '@/app/api/testkit/routeTestBuilder';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

import { sessionRoutes } from './sessionRoutes';

describe('session retention routes', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'session-leaving-' }); });
    afterAll(async () => { await harness.close(); });
    afterEach(() => { vi.unstubAllEnvs(); });

    it('pages only the owner’s leaving rows and does not mark a pin or a moved row as leaving', async () => {
        const now = Date.now();
        const dayMs = 86_400_000;
        const startsAt = now + dayMs;
        const activity = new Date(now - 62 * dayMs);
        vi.stubEnv('HAPPIER_SERVER_RETENTION__ENABLED', 'true');
        vi.stubEnv('HAPPIER_SERVER_RETENTION__STARTS_AT', new Date(startsAt).toISOString());
        vi.stubEnv('HAPPIER_SERVER_RETENTION__SESSIONS__MODE', 'delete_inactive');
        vi.stubEnv('HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS', '60');

        await db.account.createMany({ data: [{ id: 'viewer' }, { id: 'other' }] });
        for (const id of ['due-a', 'due-b', 'kept', 'moved', 'shared']) {
            await db.session.create({ data: {
                id, tag: id, seq: 2, metadata: '{}', accountId: id === 'shared' ? 'other' : 'viewer',
                updatedAt: activity, lastActiveAt: activity, cloudCopyLeftAt: id === 'moved' ? activity : null,
            } });
        }
        await db.sessionPin.create({ data: { sessionId: 'kept', accountId: 'viewer' } });
        await db.sessionShare.create({ data: {
            sessionId: 'shared', sharedByUserId: 'other', sharedWithUserId: 'viewer',
        } });

        const leaving = createRouteTestBuilder({ method: 'GET', path: '/v2/sessions/leaving', registerRoutes: app => sessionRoutes(app as unknown as Parameters<typeof sessionRoutes>[0]) });
        const first = await leaving.invoke({ userId: 'viewer', query: { limit: 1 } });
        expect(first.response).toMatchObject({
            count: 2, newestLeavesAt: startsAt, sessions: [{ id: 'due-a', leavesAt: startsAt }], nextCursor: expect.any(String),
        });
        const cursor = (first.response as { nextCursor: string }).nextCursor;
        expect((await leaving.invoke({ userId: 'viewer', query: { cursor, limit: 1 } })).response).toMatchObject({
            count: 2, sessions: [{ id: 'due-b', leavesAt: startsAt }], nextCursor: null,
        });

        const summary = createRouteTestBuilder({ method: 'GET', path: '/v2/sessions/retention-summary', registerRoutes: app => sessionRoutes(app as unknown as Parameters<typeof sessionRoutes>[0]) });
        expect((await summary.invoke({ userId: 'viewer' })).response).toMatchObject({
            sessions: 3,
            pinnedOlderThanCutoff: 1,
            ticks: [
                { atMs: activity.getTime(), messages: 2, pinned: false, leaving: true },
                { atMs: activity.getTime(), messages: 2, pinned: false, leaving: true },
                { atMs: activity.getTime(), messages: 2, pinned: true, leaving: false },
            ],
        });

        vi.stubEnv('HAPPIER_SERVER_RETENTION__ENABLED', 'false');
        expect((await leaving.invoke({ userId: 'viewer' })).reply.statusCode).toBe(404);
    });

    it('keeps the known grace deadline as the notice floor when the account lapses to Free', async () => {
        const now = Date.now();
        const day = 86_400_000;
        const expiresAt = new Date(now - 10 * day);
        const activity = new Date(now - 85 * day);
        vi.stubEnv('HAPPIER_SERVER_RETENTION__ENABLED', 'true');
        vi.stubEnv('HAPPIER_SERVER_RETENTION__STARTS_AT', new Date(now - 60 * day).toISOString());
        vi.stubEnv('HAPPIER_SERVER_RETENTION__SESSIONS__MODE', 'delete_inactive');
        vi.stubEnv('HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS', '60');
        vi.stubEnv('HAPPIER_PLANS__CONFIG', JSON.stringify({
            v: 1, graceDays: 14, teams: null, supporter: null,
            plans: [{
                id: 'plus', name: 'Plus',
                limits: { sessionRetentionDays: 365, subagentRetentionDays: 30, pinnedSessions: 500,
                    toolOutputRetentionDays: null, artifactStorageBytes: null },
                prices: [{ interval: 'month', amountMinor: 699, currency: 'usd' }],
            }],
        }));
        await db.account.create({ data: { id: 'paid', plan: 'plus', planEndsAt: expiresAt } });
        await db.session.create({ data: {
            id: 'paid-history', tag: 'paid-history', seq: 1, metadata: '{}', accountId: 'paid',
            updatedAt: activity, lastActiveAt: activity,
        } });
        const leaving = createRouteTestBuilder({
            method: 'GET', path: '/v2/sessions/leaving',
            registerRoutes: app => sessionRoutes(app as unknown as Parameters<typeof sessionRoutes>[0]),
        });
        const invoke = () => leaving.invoke({ userId: 'paid' });
        const graceEndsAt = expiresAt.getTime() + 14 * day;
        expect((await invoke()).response).toMatchObject({
            rule: { retentionDays: 60, floorAt: graceEndsAt },
            sessions: [{ id: 'paid-history', leavesAt: graceEndsAt }],
        });

        const lapsedAt = new Date(now - 15 * day);
        await db.account.update({ where: { id: 'paid' }, data: { planEndsAt: lapsedAt } });
        expect((await invoke()).response).toMatchObject({
            rule: { retentionDays: 60, floorAt: lapsedAt.getTime() + 14 * day },
            sessions: [{ id: 'paid-history', leavesAt: lapsedAt.getTime() + 14 * day }],
        });

        await db.account.update({ where: { id: 'paid' }, data: { plan: 'unknown' } });
        expect((await invoke()).reply.statusCode).toBe(404);
    });

    it('publishes a paid-only policy before the leaving window without listing any rows', async () => {
        const day = 86_400_000;
        const startsAt = Date.now() + 30 * day;
        vi.stubEnv('HAPPIER_SERVER_RETENTION__ENABLED', 'true');
        vi.stubEnv('HAPPIER_SERVER_RETENTION__STARTS_AT', new Date(startsAt).toISOString());
        vi.stubEnv('HAPPIER_SERVER_RETENTION__SESSIONS__MODE', 'keep_forever');
        vi.stubEnv('HAPPIER_PLANS__CONFIG', JSON.stringify({
            v: 1, graceDays: 14, teams: null, supporter: null,
            plans: [{
                id: 'plus', name: 'Plus',
                limits: { sessionRetentionDays: 365, subagentRetentionDays: null, pinnedSessions: 500,
                    toolOutputRetentionDays: null, artifactStorageBytes: null },
                prices: [{ interval: 'month', amountMinor: 699, currency: 'usd' }],
            }],
        }));
        await db.account.createMany({ data: [{ id: 'advance-paid', plan: 'plus' }, { id: 'advance-free' }] });
        const leaving = createRouteTestBuilder({
            method: 'GET', path: '/v2/sessions/leaving',
            registerRoutes: app => sessionRoutes(app as unknown as Parameters<typeof sessionRoutes>[0]),
        });
        expect((await leaving.invoke({ userId: 'advance-paid' })).response).toEqual({
            rule: { retentionDays: 365, noticeDays: 7, floorAt: startsAt },
            count: 0, sessions: [], nextCursor: null, newestLeavesAt: null,
        });
        expect((await leaving.invoke({ userId: 'advance-free' })).reply.statusCode).toBe(404);
    });
});
