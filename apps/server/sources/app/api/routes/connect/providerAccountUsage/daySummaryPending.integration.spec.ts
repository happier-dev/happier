import { afterAll, beforeAll, expect, it } from 'vitest';
import { isRecord } from '@happier-dev/protocol/common/records';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createUsageSnapshot } from '../providerAccountUsageTestkit';
import { writeProviderAccountUsageRecordWithPolicy } from './routeWritePolicy';
import { pruneProviderAccountUsageSummaryDetail, readProviderAccountUsageDaySummaries, writeProviderAccountUsageDaySummary } from './daySummaryStorage';
import { buildProviderAccountUsageDaySummaryV1 } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import { buildProviderAccountUsagePageProjectionV1, PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { sealProviderAccountUsagePageProjectionV1 } from '@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto';
import { writeProviderAccountUsagePageProjection } from './pageProjectionStorage';
import type { Prisma } from '@prisma/client';
import { measureSqliteQueryVisits } from '@/testkit/sqliteQueryCost';
import { createProviderAccountUsageRecord } from './recordStorage';
import { seedSqliteUsageHistory } from '@/testkit/seedSqliteUsageHistory';

let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'usage-day-pending-' }); }, 120_000);
afterAll(async () => { await harness?.close(); });

it.each(['producer', 'reader'] as const)('%s seeks each pending day without scanning detail between pending intervals', async mode => {
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const start = Date.UTC(2020, 0, 1);
    const dayMs = 86_400_000;
    const snapshots = Array.from({ length: 1000 }, (_, day) => createUsageSnapshot({ fetchedAt: start + day * dayMs + 1000 }));
    const latest = snapshots.at(-1)!;
    const write = (snapshot: typeof latest) => ({ accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
        payloadMode: 'plain_json_v1' as const, status: 'ok' as const, snapshot,
        fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
    await createProviderAccountUsageRecord({ ...write(latest), metadata: { daySummaryPendingDays: [start + 45 * dayMs, start + 845 * dayMs] } });
    await seedSqliteUsageHistory(db, snapshots.map((snapshot, index) => ({ id: `${account.id}-${index}`,
        accountId: account.id, recordId: latest.recordId, observedAt: new Date(snapshot.fetchedAtMs), payload: write(snapshot) })));
    const queries: Prisma.Sql[] = [];
    await inTx(async tx => {
        const boundary = new Proxy(tx, { get(target, property, receiver) {
            if (property === '$queryRaw') return async <T>(query: Prisma.Sql) => { queries.push(query); return target.$queryRaw<T>(query); };
            return Reflect.get(target, property, receiver);
        } });
        expect((await readProviderAccountUsageDaySummaries({ accountId: account.id, recordId: latest.recordId,
            range: { startAtMs: start, endAtMs: start + 1000 * dayMs },
            includeMissingDays: mode === 'producer', includeCoverage: mode === 'reader' }, boundary)).missingDays).toHaveLength(2);
    });
    const grouped = queries.filter(query => query.sql.includes('COUNT(*) OVER'));
    let detailVisits = 0;
    for (const query of grouped) {
        const measuredSql = query.sql.replaceAll('WHERE "accountId"', 'WHERE pending_interval_probe() AND "accountId"');
        const bindings = query.values.map(value => {
            if (value === null || typeof value === 'string' || typeof value === 'number') return value;
            throw new Error('Unexpected SQLite interval measurement binding');
        });
        expect(measuredSql).toContain('pending_interval_probe()');
        const measured = measureSqliteQueryVisits({ dbPath: harness.dbPath, sql: measuredSql, bindings, probeName: 'pending_interval_probe' });
        expect(measured.rowCount).toBe(2);
        detailVisits += measured.visits;
    }
    expect(detailVisits).toBe(2);
    await db.providerAccountUsageRecord.update({ where: { accountId_recordId: { accountId: account.id, recordId: latest.recordId } },
        data: { metadata: { daySummaryPendingDays: snapshots.map(snapshot => Math.floor(snapshot.fetchedAtMs / dayMs) * dayMs) } } });
    await inTx(async tx => {
        expect((await readProviderAccountUsageDaySummaries({ accountId: account.id, recordId: latest.recordId,
            range: { startAtMs: start, endAtMs: start + 1000 * dayMs },
            includeMissingDays: mode === 'producer', includeCoverage: mode === 'reader' }, tx)).missingDays).toHaveLength(1000);
    });
});

it('reader coverage retains summary prefixes while reporting pending and unsummarized days from the same read', async () => {
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const start = Date.UTC(2026, 0, 1);
    const dayMs = 86_400_000;
    const first = createUsageSnapshot({ fetchedAt: start + 1000 });
    const older = { ...first, fetchedAtMs: start - dayMs + 1000, observedAtMs: start - dayMs + 1000, planLabel: 'older' };
    const second = { ...first, fetchedAtMs: start + dayMs + 1000, observedAtMs: start + dayMs + 1000, planLabel: 'second' };
    const write = (snapshot: typeof first) => writeProviderAccountUsageRecordWithPolicy({ accountId: account.id,
        recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1', status: 'ok', snapshot,
        fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
    const query = { accountId: account.id, recordId: first.recordId, range: { startAtMs: start - dayMs, endAtMs: start + 3 * dayMs } };
    await write(older);
    await write(first);
    await write(second);
    await inTx(async tx => {
        const pending = await readProviderAccountUsageDaySummaries({ ...query, includeMissingDays: true }, tx);
        for (const [index, snapshot] of [older, first, second].entries()) {
            const dayStartAtMs = start + (index - 1) * dayMs;
            expect(await writeProviderAccountUsageDaySummary({ accountId: account.id, value: {
                recordId: first.recordId, dayStartAtMs, payload: { v: 1, coverage: pending.missingDays[index]!.coverage,
                    content: { t: 'plain', v: buildProviderAccountUsageDaySummaryV1({ recordId: first.recordId, dayStartAtMs, snapshots: [snapshot] }) } },
            } }, tx)).toBe(true);
        }
        expect((await pruneProviderAccountUsageSummaryDetail({ accountId: account.id, recordId: first.recordId,
            dayStartAtMs: start, cutoff: new Date(start + dayMs), limit: 1, dryRun: false }, tx)).deleted).toBe(1);
    });
    await inTx(async tx => {
        const queries: Prisma.Sql[] = [];
        const boundary = new Proxy(tx, { get(target, property, receiver) {
            if (property === '$queryRaw') return async <T>(sql: Prisma.Sql) => { queries.push(sql); return target.$queryRaw<T>(sql); };
            return Reflect.get(target, property, receiver);
        } });
        const complete = await readProviderAccountUsageDaySummaries({ ...query, includeCoverage: true }, boundary);
        expect(complete.summaries.map(day => day.dayStartAtMs)).toEqual([start - dayMs, start, start + dayMs]);
        expect(complete.summaries[1]!.payload.coverage).toEqual({ observationCount: 0, frontier: null });
        expect(complete.missingDays).toEqual([]);
        expect(queries.filter(sql => sql.sql.includes('ProviderAccountUsageHistory'))).toHaveLength(0);
    });
    const pendingSecond = { ...second, fetchedAtMs: second.fetchedAtMs + 1000, observedAtMs: second.observedAtMs + 1000 };
    const third = { ...second, fetchedAtMs: start + 2 * dayMs + 1000, observedAtMs: start + 2 * dayMs + 1000, planLabel: 'third' };
    await write(pendingSecond);
    await write(third);
    const expectedMissing = [{ dayStartAtMs: start + dayMs, coverage: { observationCount: 2, frontier: { observedAtMs: pendingSecond.fetchedAtMs } } },
        { dayStartAtMs: start + 2 * dayMs, coverage: { observationCount: 1, frontier: { observedAtMs: third.fetchedAtMs } } }];
    await inTx(async tx => {
        const ordinary = await readProviderAccountUsageDaySummaries(query, tx);
        expect(ordinary.summaries).toHaveLength(3);
        expect(ordinary.missingDays).toEqual([]);
        const reader = await readProviderAccountUsageDaySummaries({ ...query, includeCoverage: true }, tx);
        expect(reader.summaries).toEqual(ordinary.summaries);
        expect(reader.summaries[2]!.payload).toMatchObject({ coverage: { observationCount: 0, frontier: null },
            content: { t: 'plain', v: { lastSnapshot: second } } });
        expect(reader.missingDays).toMatchObject(expectedMissing);
        expect(reader.missingDays.every(day => day.precedingSummary === undefined)).toBe(true);
        let producerBodies = 0;
        const boundary = new Proxy(tx, { get(target, property, receiver) {
            if (property === 'providerAccountUsageDaySummary') return new Proxy(target.providerAccountUsageDaySummary, {
                get(model, method, modelReceiver) {
                    if (method === 'findMany') return async (args: Prisma.ProviderAccountUsageDaySummaryFindManyArgs) => {
                        const rows = await model.findMany(args); producerBodies += rows.length; return rows;
                    };
                    return Reflect.get(model, method, modelReceiver);
                },
            });
            return Reflect.get(target, property, receiver);
        } });
        const producer = await readProviderAccountUsageDaySummaries({ ...query, includeMissingDays: true }, boundary);
        expect(producer.summaries.map(day => day.dayStartAtMs)).toEqual([start + dayMs]);
        expect(producer.missingDays).toMatchObject(expectedMissing);
        expect(producer.missingDays.map(day => day.precedingSummary?.dayStartAtMs)).toEqual([start, start + dayMs]);
        expect(producerBodies).toBe(2);
    });
    // The legacy metadata path delegates to the same pending authority; a
    // compacted complete day is not mistaken for an invalidated retained day.
    await db.providerAccountUsageRecord.update({ where: { accountId_recordId: { accountId: account.id, recordId: first.recordId } }, data: { metadata: {} } });
    await inTx(async tx => {
        const legacy = await readProviderAccountUsageDaySummaries({ ...query, includeCoverage: true }, tx);
        expect(legacy.summaries).toHaveLength(3);
        expect(legacy.missingDays).toMatchObject(expectedMissing);
    });
});

it('clock-bound backfill selects legacy summaries even after their exact detail was compacted', async () => {
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const start = Date.UTC(2026, 0, 1);
    const dayMs = 86_400_000;
    const snapshots = Array.from({ length: 3 }, (_, index) => ({ ...createUsageSnapshot({ fetchedAt: start + index * dayMs + 1000 }),
        planLabel: `day-${index}` }));
    const first = snapshots[0]!;
    const query = { accountId: account.id, recordId: first.recordId,
        range: { startAtMs: start, endAtMs: start + 3 * dayMs }, includeMissingDays: true };
    for (const snapshot of snapshots) await writeProviderAccountUsageRecordWithPolicy({ accountId: account.id,
        recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1', status: 'ok', snapshot,
        fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
    await inTx(async tx => {
        const pending = await readProviderAccountUsageDaySummaries(query, tx);
        for (const [index, snapshot] of snapshots.entries()) {
            const dayStartAtMs = start + index * dayMs;
            expect(await writeProviderAccountUsageDaySummary({ accountId: account.id, value: {
                recordId: first.recordId, dayStartAtMs, payload: { v: 1, coverage: pending.missingDays[index]!.coverage,
                    ...(index === 2 ? { clockBoundsVersion: 1 as const } : {}),
                    content: { t: 'plain', v: buildProviderAccountUsageDaySummaryV1({ recordId: first.recordId, dayStartAtMs, snapshots: [snapshot] }) } },
            } }, tx)).toBe(true);
        }
        expect((await pruneProviderAccountUsageSummaryDetail({ accountId: account.id, recordId: first.recordId,
            dayStartAtMs: start, cutoff: new Date(start + dayMs), limit: 1, dryRun: false }, tx)).deleted).toBe(1);
        expect(await readProviderAccountUsageDaySummaries(query, tx)).toEqual({ summaries: [], missingDays: [] });
        const upgrade = await readProviderAccountUsageDaySummaries({ ...query, requireClockBounds: true }, tx);
        expect(upgrade.summaries.map(day => day.dayStartAtMs)).toEqual([start, start + dayMs]);
        expect(upgrade.missingDays).toMatchObject([
            { dayStartAtMs: start, coverage: { observationCount: 0, frontier: null } },
            { dayStartAtMs: start + dayMs, coverage: { observationCount: 1, frontier: { observedAtMs: snapshots[1]!.fetchedAtMs } } },
        ]);
        expect(upgrade.missingDays.map(day => day.precedingSummary?.dayStartAtMs)).toEqual([undefined, start]);
        for (const day of upgrade.missingDays) {
            const previous = upgrade.summaries.find(summary => summary.dayStartAtMs === day.dayStartAtMs)!;
            expect(await writeProviderAccountUsageDaySummary({ accountId: account.id, value: {
                recordId: first.recordId, dayStartAtMs: day.dayStartAtMs,
                payload: { ...previous.payload, coverage: day.coverage, clockBoundsVersion: 1 },
            } }, tx)).toBe(true);
        }
        expect(await readProviderAccountUsageDaySummaries({ ...query, requireClockBounds: true }, tx)).toEqual({ summaries: [], missingDays: [] });
    });
});

it('accepted observations own pending days, exact publication clears them and empty work stays initialized', async () => {
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const dayStartAtMs = Date.UTC(2026, 0, 1);
    const snapshot = createUsageSnapshot({ fetchedAt: dayStartAtMs + 1000 });
    const write = (value: typeof snapshot) => writeProviderAccountUsageRecordWithPolicy({ accountId: account.id,
        recordId: value.recordId, recordKey: value.recordKey, payloadMode: 'plain_json_v1', status: 'ok', snapshot: value,
        fetchedAt: value.fetchedAtMs, staleAfterMs: value.staleAfterMs, materialFingerprint: 'fixture' });
    const metadata = async (storage: Pick<typeof db, 'providerAccountUsageRecord'> = db) => (await storage.providerAccountUsageRecord.findUniqueOrThrow({ where: {
        accountId_recordId: { accountId: account.id, recordId: snapshot.recordId } }, select: { metadata: true } })).metadata;
    await write(snapshot);
    expect(await metadata()).toMatchObject({ daySummaryPendingDays: [dayStartAtMs] });
    const query = { accountId: account.id, recordId: snapshot.recordId,
        range: { startAtMs: 0, endAtMs: dayStartAtMs + 86_400_000 }, includeMissingDays: true };
    await inTx(async tx => {
        const missing = await readProviderAccountUsageDaySummaries(query, tx);
        const payload = { v: 1 as const, coverage: missing.missingDays[0]!.coverage,
            content: { t: 'plain' as const, v: buildProviderAccountUsageDaySummaryV1({ recordId: snapshot.recordId, dayStartAtMs, snapshots: [snapshot] }) } };
        expect(await writeProviderAccountUsageDaySummary({ accountId: account.id,
            value: { recordId: snapshot.recordId, dayStartAtMs, payload: { ...payload, coverage: { observationCount: 0, frontier: null } } } }, tx)).toBe(false);
        expect(await metadata(tx)).toMatchObject({ daySummaryPendingDays: [dayStartAtMs] });
        expect(await writeProviderAccountUsageDaySummary({ accountId: account.id,
            value: { recordId: snapshot.recordId, dayStartAtMs, payload } }, tx)).toBe(true);
    });
    expect(await metadata()).toMatchObject({ daySummaryPendingDays: [] });
    await db.providerAccountUsageRecord.update({ where: { accountId_recordId: { accountId: account.id, recordId: snapshot.recordId } },
        data: { metadata: { materialFingerprint: 'fixture' } } });
    await expect(write(snapshot)).resolves.toBe('noop');
    expect(await metadata()).toMatchObject({ daySummaryPendingDays: [] });
    const history = await db.providerAccountUsageHistory.findMany({ where: { accountId: account.id } });
    expect(history[0]!.payload).not.toHaveProperty('metadata.daySummaryPendingDays');
    await inTx(async tx => {
        let summaryKeyReads = 0;
        const boundary = new Proxy(tx, { get(target, property, receiver) {
            if (property === 'providerAccountUsageDaySummary') return new Proxy(target.providerAccountUsageDaySummary, {
                get(model, method, modelReceiver) {
                    if (method === 'findMany') return (args: Prisma.ProviderAccountUsageDaySummaryFindManyArgs) => { summaryKeyReads++; return model.findMany(args); };
                    return Reflect.get(model, method, modelReceiver);
                },
            });
            return Reflect.get(target, property, receiver);
        } });
        expect(await readProviderAccountUsageDaySummaries(query, boundary)).toEqual({ summaries: [], missingDays: [] });
        expect(summaryKeyReads).toBe(0);
    });
    const tomorrow = { ...snapshot, fetchedAtMs: snapshot.fetchedAtMs + 86_400_000,
        observedAtMs: snapshot.observedAtMs + 86_400_000, planLabel: 'new plan' };
    await write(tomorrow);
    expect(await metadata()).toMatchObject({ daySummaryPendingDays: [dayStartAtMs + 86_400_000] });
    await inTx(async tx => {
        const last = await tx.providerAccountUsageHistory.findFirstOrThrow({ where: { accountId: account.id }, orderBy: { observedAt: 'desc' } });
        const range = { startAtMs: dayStartAtMs + 86_400_000, endAtMs: dayStartAtMs + 2 * 86_400_000 };
        const projection = buildProviderAccountUsagePageProjectionV1({ recordId: snapshot.recordId, range,
            history: { entries: [{ id: last.id, observedAtMs: last.observedAt.getTime(), snapshot: tomorrow }], nextCursor: null } });
        expect(await writeProviderAccountUsagePageProjection({ accountId: account.id, value: {
            recordId: snapshot.recordId, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING,
            demand: { range, resolution: 'accepted_observations' }, observationCount: 1,
            frontier: { id: last.id, observedAtMs: last.observedAt.getTime() },
            content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection }),
        } }, tx)).not.toBeNull();
    });
    expect(await metadata()).toMatchObject({ daySummaryPendingDays: [dayStartAtMs + 86_400_000], pageProjection: { recordId: snapshot.recordId } });
    const raw = await metadata();
    if (!isRecord(raw)) throw new Error('Expected record metadata');
    const { daySummaryPendingDays: _legacy, ...legacyMetadata } = raw;
    await db.providerAccountUsageRecord.update({ where: { accountId_recordId: { accountId: account.id, recordId: snapshot.recordId } },
        data: { metadata: legacyMetadata } });
    const refreshedTomorrow = { ...tomorrow, fetchedAtMs: tomorrow.fetchedAtMs + 1000, observedAtMs: tomorrow.observedAtMs + 1000 };
    await expect(write(refreshedTomorrow)).resolves.toBe('written');
    expect(await metadata()).toMatchObject({ daySummaryPendingDays: [dayStartAtMs + 86_400_000], pageProjection: { recordId: snapshot.recordId } });
    const third = { ...tomorrow, fetchedAtMs: tomorrow.fetchedAtMs + 86_400_000,
        observedAtMs: tomorrow.observedAtMs + 86_400_000, planLabel: 'third plan' };
    await write(third);
    expect(await metadata()).toMatchObject({ daySummaryPendingDays: [dayStartAtMs + 86_400_000, dayStartAtMs + 2 * 86_400_000],
        pageProjection: { recordId: snapshot.recordId } });
});
