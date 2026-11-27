import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { runRetentionSweep } from '@/app/retention/runtime/runRetentionSweep';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';

const postgresUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
const now = new Date('2026-11-27T12:00:00Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
const tier = (id: string, toolOutputRetentionDays: number) => ({
    id, name: id, prices: [],
    limits: { sessionRetentionDays: null, subagentRetentionDays: null, toolOutputRetentionDays, pinnedSessions: null, artifactStorageBytes: null },
});
const env = {
    HAPPIER_SERVER_RETENTION__ENABLED: 'true',
    HAPPIER_SERVER_RETENTION__STARTS_AT: daysAgo(1).toISOString(),
    HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
    HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: '60',
    HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__MODE: 'delete_older_than',
    HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__DAYS: '7',
    HAPPIER_SERVER_RETENTION__TOOL_OUTPUTS__MODE: 'delete_older_than',
    HAPPIER_SERVER_RETENTION__TOOL_OUTPUTS__DAYS: '30',
    HAPPIER_SERVER_RETENTION__BATCH_SIZE: '2',
    HAPPIER_PLANS__CONFIG: JSON.stringify({
        v: 1, graceDays: 90, plans: [tier('lite', 60), tier('plus', 90)],
        teams: { freeSeats: 0, limitsFromPlanId: 'plus', seatPrices: [] }, supporter: null,
    }),
};
const content = { t: 'plain' as const, v: { type: 'tool-result', callId: 'fixture' } };
const bytes = new TextEncoder().encode(JSON.stringify({ t: 'plain', v: 'fixture body' }));

describe('plan retention through the production sweep', () => {
    let close: () => Promise<void>;
    beforeAll(async () => {
        if (postgresUrl) {
            if (process.env.DATABASE_URL !== postgresUrl) throw new Error('Use the disposable PostgreSQL database URL');
            initDbPostgres();
            await db.$connect();
            close = shutdownDbClient;
        } else {
            const harness = await createLightSqliteHarness({ tempDirPrefix: 'plans-retention-', initAuth: false, initFiles: false });
            close = () => harness.close();
        }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    it('keeps pinned main history, prunes its sidechain and expires each tier independently', async () => {
        const team = await db.team.create({ data: { name: randomUUID(), paidSeats: 2 } });
        const rows = [];
        for (const [plan, period] of [[null, 30], ['lite', 60], ['plus', 90], ['team', 90]] as const) {
            const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain', plan: plan === 'team' ? null : plan } });
            if (plan === 'team') await db.teamMembership.create({ data: { accountId: account.id, teamId: team.id, role: 'member' } });
            const session = await db.session.create({ data: {
                accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted',
                lastActiveAt: daysAgo(100), updatedAt: daysAgo(100),
            } });
            await db.sessionPin.create({ data: { accountId: account.id, sessionId: session.id } });
            const [expired, kept] = await Promise.all([period + 1, period].map((age, index) => db.sessionMessage.create({ data: {
                sessionId: session.id, seq: index + 1, content, createdAt: daysAgo(age), toolOutputBytes: bytes,
            } })));
            rows.push({ account, session, period, expired, kept });
        }
        const free = rows[0]!;
        const sidechain = await db.sessionMessage.create({ data: {
            sessionId: free.session.id, seq: 3, sidechainId: 'fixture-chain', content, createdAt: daysAgo(8),
        } });
        const unpinned = await db.session.create({ data: {
            accountId: free.account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
            currentStorageState: 'hosted', lastActiveAt: daysAgo(100), updatedAt: daysAgo(100),
        } });
        await db.sessionMessage.create({ data: { sessionId: unpinned.id, seq: 1, content } });

        const preview = await runRetentionSweep({ policy: readRetentionPolicyFromEnv(env), env, now });
        expect(preview.byRule).toMatchObject({ sessions: 1, sessionSidechainMessages: 1, toolOutputs: 4 });
        expect(await db.sessionMessage.count({ where: { id: { in: rows.map(row => row.expired.id) }, toolOutputExpiredAfterDays: null } })).toBe(4);
        const enforcing = { ...env, HAPPIER_SERVER_RETENTION__DRY_RUN: 'false' };
        const swept = await runRetentionSweep({ policy: readRetentionPolicyFromEnv(enforcing), env: enforcing, now });
        expect(swept.byRule).toMatchObject({ sessions: 1, sessionSidechainMessages: 1, toolOutputs: 4 });
        expect(await db.session.findUniqueOrThrow({ where: { id: unpinned.id } })).toMatchObject({
            currentStorageState: 'machine_only', cloudCopyLeftAt: now,
        });
        expect(await db.sessionMessage.count({ where: { sessionId: unpinned.id } })).toBe(0);
        expect(await db.sessionMessage.findUnique({ where: { id: sidechain.id } })).toBeNull();
        for (const { session, expired, kept, period } of rows) {
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ currentStorageState: 'hosted' });
            expect(await db.sessionMessage.findUniqueOrThrow({ where: { id: expired.id } })).toMatchObject({
                content, toolOutputBytes: null, toolOutputExpiredAfterDays: period,
            });
            expect(await db.sessionMessage.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({
                toolOutputBytes: bytes, toolOutputExpiredAfterDays: null,
            });
        }
    });
});
