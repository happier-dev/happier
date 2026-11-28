import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { runRetentionSweep } from '@/app/retention/runtime/runRetentionSweep';
import { shareRoutes } from '@/app/api/routes/share/shareRoutes';
import { registerPublicShareOwnerRoutes } from '@/app/api/routes/share/registerPublicShareOwnerRoutes';
import { createRouteTestBuilder } from '@/app/api/testkit/routeTestBuilder';
import { createSessionMessage } from '@/app/session/sessionWriteService';
import { activityCache } from '@/app/presence/sessionCache';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { createEnvReset, restoreEnv, snapshotEnv } from '@/testkit/env';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { runCommand } from '../../../../scripts/runCommand';

const emitUpdate = vi.hoisted(() => vi.fn());
vi.mock('@/app/events/eventRouter', async () => {
    const actual = await vi.importActual<typeof import('@/app/events/eventRouter')>('@/app/events/eventRouter');
    return {
        ...actual,
        eventRouter: {
            ...actual.eventRouter,
            emitUpdate,
        },
    };
});

const providers = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
    ? ['sqlite', 'postgres'] as const
    : ['sqlite'] as const;

describe.each(providers)('sessionRetentionRule (%s)', (provider) => {
    let resetEnv: () => unknown;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
        if (provider === 'sqlite') {
            const harness = await createLightSqliteHarness({ tempDirPrefix: 'retention-session-rule-' });
            resetEnv = harness.resetEnv;
            close = harness.close;
            return;
        }
        const initialEnv = snapshotEnv();
        const schema = `session_retention_${randomUUID().replaceAll('-', '')}`;
        const url = new URL(process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL!);
        url.searchParams.set('schema', schema);
        process.env.DATABASE_URL = url.toString();
        process.env.HAPPIER_DB_PROVIDER = 'postgres';
        initDbPostgres();
        close = async () => {
            try {
                await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            } finally {
                await shutdownDbClient();
                restoreEnv(initialEnv);
            }
        };
        await runCommand('yarn', ['-s', 'migrate:deploy'], process.env);
        resetEnv = createEnvReset();
    });

    afterAll(async () => {
        activityCache.shutdown();
        await close?.();
    });

    beforeEach(async () => {
        emitUpdate.mockReset();
        activityCache.shutdown();
        resetEnv();
        for (const clear of [
            () => db.publicShareAccessLog.deleteMany(),
            () => db.publicSessionShare.deleteMany(),
            () => db.sessionShareAccessLog.deleteMany(),
            () => db.sessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.usageReport.deleteMany(),
            () => db.sessionMessage.deleteMany(),
            () => db.session.deleteMany(),
            () => db.userRelationship.deleteMany(),
            () => db.account.deleteMany(),
        ]) {
            await clear();
        }
    });

    it('keeps stale session metadata while removing its cloud transcript and shares', async () => {
        await db.account.createMany({
            data: [
                { id: 'owner' },
                { id: 'u2' },
            ],
        });

        await db.session.create({
            data: {
                id: 's1',
                tag: 'retention-target',
                accountId: 'owner',
                metadata: '{}',
                active: false,
            },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: 's1',
                seq: 1,
                content: { t: 'plain', v: { role: 'user', text: 'hello' } },
            },
        });
        await db.usageReport.create({
            data: {
                key: 'usage-1',
                accountId: 'owner',
                sessionId: 's1',
                data: {
                    tokens: { total: 3 },
                    cost: { total: 0 },
                },
            },
        });
        await db.sessionShare.create({
            data: {
                sessionId: 's1',
                sharedByUserId: 'owner',
                sharedWithUserId: 'u2',
            },
        });

        const { pruneInactiveSessionsOnce } = await import('./sessionRetentionRule');
        const result = await pruneInactiveSessionsOnce({
            cutoff: new Date('2027-02-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: false,
        });

        expect(result.deleted).toBe(1);
        expect(await db.session.findUnique({ where: { id: 's1' } })).toMatchObject({
            id: 's1',
            metadata: '{}',
            cloudCopyLeftAt: expect.any(Date),
        });
        expect(await db.sessionShare.count({ where: { sessionId: 's1' } })).toBe(0);
        expect(await db.sessionMessage.count({ where: { sessionId: 's1' } })).toBe(0);
        expect(await db.usageReport.count({ where: { sessionId: 's1' } })).toBe(0);
        expect(await db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: 'owner',
                    kind: 'session',
                    entityId: 's1',
                },
            },
        })).toBeTruthy();
        expect(await db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: 'u2',
                    kind: 'session',
                    entityId: 's1',
                },
            },
        })).toBeTruthy();
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });

    it('keeps pinned main transcripts, expires old sidechains, and previews the same sweep without writing', async () => {
        const stale = new Date('2026-09-01T00:00:00Z');
        const startsAt = new Date('2026-12-01T00:00:00Z');
        const now = new Date('2026-12-02T00:00:00Z');
        await db.account.createMany({
            data: [{ id: 'owner' }, { id: 'sharee' }, ...['lite', 'plus', 'unknown'].map(plan => ({ id: plan, plan }))],
        });
        for (const id of ['expired', 'pinned', 'active', 'link'] as const) {
            await db.session.create({
                data: {
                    id, accountId: 'owner', tag: id === 'link' ? 'direct:v1:linked' : id,
                    metadata: '{}', updatedAt: stale, lastActiveAt: stale,
                    active: id === 'active', seq: id === 'link' ? 0 : id === 'pinned' ? 2 : 1,
                },
            });
            if (id !== 'link') {
                await db.sessionMessage.create({
                    data: { sessionId: id, seq: 1, content: { t: 'plain', v: {} }, createdAt: stale },
                });
            }
        }
        const paidMainDate = new Date('2026-09-20T00:00:00Z');
        const paidSidechainDate = new Date('2026-11-22T00:00:00Z');
        for (const plan of ['lite', 'plus', 'unknown']) {
            const activity = plan === 'lite' ? paidMainDate : stale;
            await db.session.create({
                data: {
                    id: plan, accountId: plan, tag: plan, metadata: '{}', updatedAt: activity,
                    lastActiveAt: activity, active: false, seq: 2,
                },
            });
            await db.sessionMessage.createMany({
                data: [
                    { sessionId: plan, seq: 1, content: { t: 'plain', v: {} }, createdAt: activity },
                    { sessionId: plan, seq: 2, sidechainId: 'child', content: { t: 'plain', v: {} },
                        createdAt: plan === 'unknown' ? stale : plan === 'plus' ? new Date('2026-11-12T00:00:00Z') : paidSidechainDate },
                ],
            });
        }
        await db.sessionPin.create({ data: { sessionId: 'pinned', accountId: 'owner' } });
        await db.sessionMessage.create({
            data: { sessionId: 'pinned', seq: 2, sidechainId: 'child', content: { t: 'plain', v: {} }, createdAt: stale },
        });
        await db.sessionShare.create({
            data: { sessionId: 'expired', sharedByUserId: 'owner', sharedWithUserId: 'sharee' },
        });
        await db.publicSessionShare.create({
            data: { sessionId: 'expired', createdByUserId: 'owner', tokenHash: Buffer.alloc(32, 1) },
        });
        const env = {
            HAPPIER_PLANS__CONFIG: JSON.stringify({
                v: 1, graceDays: 90, teams: null, supporter: null,
                plans: [
                    { id: 'lite', name: 'Lite', sessionRetentionDays: 90, subagentRetentionDays: 14, pinnedSessions: 100 },
                    { id: 'plus', name: 'Plus', sessionRetentionDays: 365, subagentRetentionDays: 30, pinnedSessions: 500 },
                ].map(({ id, name, ...limits }) => ({
                    id, name, limits: { ...limits, toolOutputRetentionDays: null, artifactStorageBytes: null },
                    prices: [{ interval: 'month', amountMinor: 100, currency: 'usd' }],
                })),
            }),
            HAPPIER_SERVER_RETENTION__ENABLED: 'true',
            HAPPIER_SERVER_RETENTION__STARTS_AT: startsAt.toISOString(),
            HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
            HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: '60',
            HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__MODE: 'delete_older_than',
            HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__DAYS: '7',
        };
        const policy = readRetentionPolicyFromEnv(env);
        const unreadable = await runRetentionSweep({
            policy: { ...policy, dryRun: false }, now, env: { ...env, HAPPIER_PLANS__CONFIG: '{' },
        });
        expect(unreadable.details.sessions?.stopReason).toBe('config_invalid');
        expect(unreadable.details.sessionSidechainMessages?.stopReason).toBe('config_invalid');
        expect(await db.sessionMessage.count()).toBe(10);
        for (const options of [{ policy, now, env }, { policy: { ...policy, dryRun: false }, now: new Date(startsAt.getTime() - 1), env }]) {
            expect((await runRetentionSweep(options)).byRule).toMatchObject({ sessions: 1, sessionSidechainMessages: 1 });
            expect(await db.sessionMessage.count()).toBe(10);
            expect(await db.session.count({ where: { cloudCopyLeftAt: { not: null } } })).toBe(0);
            expect(await db.sessionShare.count()).toBe(1);
            expect(await db.publicSessionShare.count()).toBe(1);
            expect(await db.accountChange.count()).toBe(0);
        }
        const enforce = { policy: { ...policy, dryRun: false }, now: startsAt, env };
        expect((await runRetentionSweep(enforce)).byRule).toMatchObject({ sessions: 1, sessionSidechainMessages: 1 });
        expect(await db.session.count()).toBe(7);
        expect(await db.session.findUnique({ where: { id: 'expired' } })).toMatchObject({
            metadata: '{}', seq: 1, updatedAt: stale, cloudCopyLeftAt: startsAt,
        });
        expect(await db.sessionMessage.findMany({ orderBy: [{ sessionId: 'asc' }, { seq: 'asc' }], select: { sessionId: true, sidechainId: true } }))
            .toEqual(['active', 'lite', 'pinned', 'plus', 'unknown'].flatMap(sessionId => [
                { sessionId, sidechainId: null },
                ...(['lite', 'plus', 'unknown'].includes(sessionId) ? [{ sessionId, sidechainId: 'child' }] : []),
            ]));
        expect(await db.session.count({ where: { cloudCopyLeftAt: { not: null } } })).toBe(1);
        expect(await db.sessionShare.count()).toBe(0);
        expect(await db.publicSessionShare.count()).toBe(0);
        expect((await runRetentionSweep(enforce)).byRule).toMatchObject({ sessions: 0, sessionSidechainMessages: 0 });

        await db.userRelationship.create({ data: { fromUserId: 'owner', toUserId: 'sharee', status: 'friend' } });
        const share = createRouteTestBuilder({
            method: 'POST', path: '/v1/sessions/:sessionId/shares',
            registerRoutes: app => shareRoutes(app as unknown as Parameters<typeof shareRoutes>[0]),
        });
        const publicShare = createRouteTestBuilder({
            method: 'POST', path: '/v1/sessions/:sessionId/public-share',
            registerRoutes: app => registerPublicShareOwnerRoutes(app as unknown as Parameters<typeof shareRoutes>[0]),
        });
        const ownerRequest = { userId: 'owner', params: { sessionId: 'expired' } };
        const encryptedDataKey = Buffer.alloc(73).toString('base64');
        expect((await share.invoke({
            ...ownerRequest, body: { userId: 'sharee', accessLevel: 'view', encryptedDataKey },
        })).reply.statusCode).toBe(409);
        expect((await publicShare.invoke({
            ...ownerRequest, body: { token: 'new-link', encryptedDataKey },
        })).reply.statusCode).toBe(409);

        const resumed = await createSessionMessage({ sessionId: 'expired', actorUserId: 'owner', ciphertext: 'new-message' });
        expect(resumed).toMatchObject({ ok: true });
        expect(await db.session.findUnique({ where: { id: 'expired' } })).toMatchObject({ seq: 2, cloudCopyLeftAt: null });
        expect(await db.sessionMessage.count({ where: { sessionId: 'expired' } })).toBe(1);
        expect(await db.sessionShare.count()).toBe(0);
        expect(await db.publicSessionShare.count()).toBe(0);
    });

    it('skips sessions that are currently observed as active by the runtime cache', async () => {
        await db.account.create({
            data: { id: 'owner' },
        });

        await db.session.create({
            data: {
                id: 's1',
                tag: 'retention-active-cache',
                accountId: 'owner',
                metadata: '{}',
                active: true,
                lastActiveAt: new Date('2025-01-01T00:00:00.000Z'),
                updatedAt: new Date('2025-01-01T00:00:00.000Z'),
            },
        });

        await expect(activityCache.isSessionValid('s1', 'owner')).resolves.toBe(true);

        const { pruneInactiveSessionsOnce } = await import('./sessionRetentionRule');
        const result = await pruneInactiveSessionsOnce({
            cutoff: new Date('2027-02-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: false,
        });

        expect(result.deleted).toBe(0);
        expect(await db.session.findUnique({ where: { id: 's1' } })).toBeTruthy();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it('skips sessions that are still marked active even when timestamps are stale', async () => {
        await db.account.create({
            data: { id: 'owner' },
        });

        await db.session.create({
            data: {
                id: 's1',
                tag: 'retention-active-flag',
                accountId: 'owner',
                metadata: '{}',
                active: true,
                lastActiveAt: new Date('2025-01-01T00:00:00.000Z'),
                updatedAt: new Date('2025-01-01T00:00:00.000Z'),
            },
        });

        const { pruneInactiveSessionsOnce } = await import('./sessionRetentionRule');
        const result = await pruneInactiveSessionsOnce({
            cutoff: new Date('2027-02-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: false,
        });

        expect(result.deleted).toBe(0);
        expect(await db.session.findUnique({ where: { id: 's1' } })).toBeTruthy();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it('continues after the last examined session so an observed-active row cannot hide later candidates', async () => {
        await db.account.create({ data: { id: 'owner' } });
        for (const id of ['s1', 's2']) {
            await db.session.create({
                data: {
                    id,
                    tag: id,
                    accountId: 'owner',
                    metadata: '{}',
                    active: false,
                    lastActiveAt: new Date('2025-01-01T00:00:00.000Z'),
                    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
                },
            });
        }

        const { runSessionRetentionRule } = await import('./sessionRetentionRule');
        const result = await runSessionRetentionRule({
            cutoff: new Date('2026-01-01T00:00:00.000Z'),
            batchSize: 1,
            dryRun: true,
            after: { id: 's1', lastActiveAt: new Date('2025-01-01T00:00:00.000Z') },
            maxDeletesPerRulePerRun: 1,
        });

        expect(result).toEqual({
            deleted: 1,
            candidatesExamined: 1,
            hasMore: true,
            nextCursor: { id: 's2', lastActiveAt: new Date('2025-01-01T00:00:00.000Z') },
        });
    });
});
