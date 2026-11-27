import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';

import { checkArtifactStorageBudgetInTx, readArtifactStorageUsageInTx } from './artifactStorageService';

describe('paid Team Artifact storage', () => {
    let close: () => Promise<void>;
    beforeAll(async () => {
        const postgresUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (postgresUrl) {
            if (postgresUrl !== process.env.DATABASE_URL) throw new Error('Use the disposable PostgreSQL database URL');
            initDbPostgres();
            await db.$connect();
            close = shutdownDbClient;
        } else {
            const harness = await createLightSqliteHarness({ tempDirPrefix: 'team-artifact-budget-', initAuth: false, initFiles: false });
            close = () => harness.close();
        }
    });
    afterAll(async () => { vi.unstubAllEnvs(); await close?.(); });

    it('shares billed bytes across Team members and leaves an individual on their per-Account budget', async () => {
        vi.stubEnv('HAPPIER_PLANS__CONFIG', JSON.stringify({
            v: 1, graceDays: 90,
            plans: [{ id: 'plus', name: 'Plus', prices: [], limits: {
                sessionRetentionDays: null, subagentRetentionDays: null, toolOutputRetentionDays: 90,
                pinnedSessions: null, artifactStorageBytes: 10,
            } }],
            teams: { freeSeats: 0, limitsFromPlanId: 'plus', seatPrices: [] },
            supporter: null,
        }));
        const [owner, member, individual] = await Promise.all([null, null, 'plus'].map(plan =>
            db.account.create({ data: { publicKey: randomUUID(), plan } })));
        const team = await db.team.create({ data: { name: randomUUID(), paidSeats: 2 } });
        await db.teamMembership.createMany({ data: [
            { accountId: owner!.id, teamId: team.id, role: 'owner' },
            { accountId: member!.id, teamId: team.id, role: 'member' },
        ] });
        await db.artifact.create({ data: {
            id: randomUUID(), accountId: owner!.id, header: new Uint8Array(4), body: new Uint8Array(8),
            headerVersion: 1, bodyVersion: 1, dataEncryptionKey: new Uint8Array(1),
        } });
        expect(await inTx(tx => readArtifactStorageUsageInTx(tx, member!.id)))
            .toMatchObject({ limitBytes: 20, usedBytes: 12 });
        expect(await inTx(tx => readArtifactStorageUsageInTx(tx, individual!.id)))
            .toMatchObject({ limitBytes: 10, usedBytes: 0 });
        const project = (nextBodyBytes: number) => inTx(tx => checkArtifactStorageBudgetInTx(tx, {
            accountId: member!.id, artifactId: randomUUID(), nextKind: null, nextHeaderBytes: 0, nextBodyBytes,
        }));
        expect(await project(8)).toBeNull();
        expect(await project(9)).toMatchObject({ error: 'quota_exceeded', budget: 'account', limitBytes: 20, usedBytes: 21 });
    });
});
