import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { seedSqliteUsageHistory } from '@/testkit/seedSqliteUsageHistory';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createUsageSnapshot } from '../providerAccountUsageTestkit';
import { createProviderAccountUsageRecord } from './recordStorage';
import { pruneProviderAccountUsageSummaryDetail } from './daySummaryStorage';
import { buildProviderAccountUsageDaySummaryV1 } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';

let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'usage-day-prune-' }); }, 120_000);
afterAll(async () => { await harness?.close(); });

it('prunes twenty one-row batches without recounting the day already proven by publication', async () => {
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const dayStartAtMs = Date.UTC(2026, 0, 1);
    const snapshots = Array.from({ length: 20 }, (_, index) => createUsageSnapshot({ fetchedAt: dayStartAtMs + index * 1000 }));
    const latest = snapshots.at(-1)!;
    const write = (snapshot: typeof latest) => ({ accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
        payloadMode: 'plain_json_v1' as const, status: 'ok' as const, snapshot, fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
    await createProviderAccountUsageRecord(write(latest));
    const id = (index: number) => `${account.id}-${String(index).padStart(2, '0')}`;
    await seedSqliteUsageHistory(db, snapshots.map((snapshot, index) => ({ id: id(index), accountId: account.id, recordId: latest.recordId,
        observedAt: new Date(snapshot.fetchedAtMs), payload: write(snapshot) })));
    const payload = { v: 1, coverage: { observationCount: 20, frontier: { id: id(19), observedAtMs: latest.fetchedAtMs } },
        content: { t: 'plain', v: buildProviderAccountUsageDaySummaryV1({ recordId: latest.recordId, dayStartAtMs, snapshots }) } };
    await db.providerAccountUsageDaySummary.create({ data: { accountId: account.id, recordId: latest.recordId, dayStartAt: new Date(dayStartAtMs), payload } });
    await inTx(async tx => {
        let recounts = 0;
        let frontierReads = 0;
        const boundary = new Proxy(tx, { get(target, property, receiver) {
            if (property === 'providerAccountUsageHistory') return new Proxy(target.providerAccountUsageHistory, {
                get(model, method, modelReceiver) {
                    if (method === 'count') return async (args: Prisma.ProviderAccountUsageHistoryCountArgs) => {
                        recounts++; return model.count(args);
                    };
                    if (method === 'findFirst') return async (args: Prisma.ProviderAccountUsageHistoryFindFirstArgs) => {
                        frontierReads++; return model.findFirst(args);
                    };
                    return Reflect.get(model, method, modelReceiver);
                },
            });
            return Reflect.get(target, property, receiver);
        } });
        for (let batch = 0; batch < 20; batch++) {
            expect((await pruneProviderAccountUsageSummaryDetail({ accountId: account.id, recordId: latest.recordId,
                dayStartAtMs, cutoff: new Date(dayStartAtMs + 86_400_000), limit: 1, dryRun: false }, boundary)).deleted).toBe(1);
        }
        expect(recounts).toBe(0);
        expect(frontierReads).toBe(0);
        expect(await tx.providerAccountUsageHistory.count({ where: { accountId: account.id } })).toBe(0);
        expect((await tx.providerAccountUsageDaySummary.findUniqueOrThrow({ where: { accountId_recordId_dayStartAt: {
            accountId: account.id, recordId: latest.recordId, dayStartAt: new Date(dayStartAtMs) } } })).payload)
            .toEqual({ ...payload, coverage: { observationCount: 0, frontier: null } });
    });
});
