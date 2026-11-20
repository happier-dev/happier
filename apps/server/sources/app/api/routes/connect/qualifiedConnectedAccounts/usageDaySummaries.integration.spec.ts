import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '../../../testkit/sqliteFastify';
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from './registerQualifiedConnectedAccountCredentialRoutesV4';
import { createUsageSnapshot } from '../providerAccountUsageTestkit';
import { buildProviderAccountUsageDaySummaryV1, packProviderAccountUsageDaySummaryV1,
    PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING, sealProviderAccountUsageDaySummaryV1 } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import { sealProviderAccountUsageSnapshot } from '@happier-dev/protocol/connect/accountUsage';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { createProviderAccountUsageHistoryRetentionRule } from '@/app/retention/rules/providerAccountUsageHistoryRetentionRule';
import { buildProviderAccountUsagePageProjectionV1, PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { sealProviderAccountUsagePageProjectionV1 } from '@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto';
import { createProviderAccountUsageRecord } from '../providerAccountUsage/recordStorage';
import { readExpiredProviderAccountUsageSummaryDays, readProviderAccountUsageDaySummaries } from '../providerAccountUsage/daySummaryStorage';
import { inReadSnapshot } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';
import { seedSqliteUsageHistory } from '@/testkit/seedSqliteUsageHistory';
import type { Prisma } from '@prisma/client';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { measureSqliteQueryVisits } from '@/testkit/sqliteQueryCost';
import { ChangesResponseSchema } from '@happier-dev/protocol/changes';
import { readProviderAccountUsageDayChangeV1 } from '@happier-dev/protocol/changes/providerAccountUsage';
import { changesRoutes } from '../../changes/changesRoutes';

describe('qualified usage day summaries', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-days-', initAuth: true, initEncrypt: true }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => { await db.account.deleteMany(); });

    it('certifies one changed accepted-history day only after the last differently scoped publication', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const headers = { 'x-test-user-id': account.id };
        const ref = { service: { pluginId: 'example.connected-accounts', localId: 'usage-days' }, accountId: 'usage-days' };
        const firstDay = Date.UTC(2026, 0, 1);
        const nextDay = Date.UTC(2026, 0, 2);
        await withAuthenticatedTestApp(app => {
            changesRoutes(app);
            registerQualifiedConnectedAccountCredentialRoutesV4(app);
        }, async app => {
            const accepted = '/v4/connect/qualified/provider-account-usage';
            const first = createUsageSnapshot({ fetchedAt: firstDay + 1000 });
            const credential = await app.inject({ method: 'POST', url: '/v4/connect/qualified/credential', headers, payload: {
                ref, authenticationModeId: 'api-key', expectedCredentialRevision: null, content: { t: 'plain', v: { token: 'fixture' } },
                metadata: { scopes: [], providerIdentity: { accountId: first.recordKey.accountSubjectId } },
            } });
            expect(credential.statusCode, credential.body).toBe(200);
            const write = async (snapshot: typeof first) => {
                const reply = await app.inject({ method: 'POST', url: accepted, headers, payload: {
                    source: { ref, bindingKind: 'account' }, expectedCredentialRevision: credential.json().credentialRevision,
                    expectedConfigurationRevision: null, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
                    payloadMode: 'plain_json_v1', status: 'ok', snapshot, fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs,
                } });
                expect(reply.statusCode, reply.body).toBe(200);
            };
            const read = async (after: number) => {
                const reply = await app.inject({ method: 'GET', url: `/v2/changes?after=${after}`, headers });
                expect(reply.statusCode, reply.body).toBe(200);
                return ChangesResponseSchema.parse(reply.json());
            };
            const prior = (await read(0)).nextCursor;
            await write(first);
            const firstPublication = (await read(prior)).nextCursor;
            const change = (at: number, used: number) => {
                const snapshot = createUsageSnapshot({ fetchedAt: at });
                return { ...snapshot, meters: snapshot.meters.map(meter => ({ ...meter, used })) };
            };
            const second = change(nextDay + 1000, 41);
            await write(second);
            const secondPublication = (await read(firstPublication)).nextCursor;
            const third = change(nextDay + 2000, 42);
            await write(third);
            const coalesced = await read(prior);
            expect(readProviderAccountUsageDayChangeV1(coalesced.changes)).toEqual({ recordId: first.recordId,
                dayStartAtMs: nextDay, afterCursor: firstPublication, throughCursor: coalesced.nextCursor,
                publication: { kind: 'observation', afterCursor: secondPublication },
                history: { fromAtMs: third.fetchedAtMs, afterCursor: secondPublication } });
            expect(firstPublication).toBeGreaterThan(prior);
            expect(secondPublication).toBeGreaterThan(firstPublication);
            const summary = buildProviderAccountUsageDaySummaryV1({ recordId: first.recordId, dayStartAtMs: firstDay, snapshots: [first] });
            const retained = await db.providerAccountUsageHistory.findFirstOrThrow({ where: { accountId: account.id, observedAt: new Date(first.fetchedAtMs) }, select: { id: true } });
            const summaryReply = await app.inject({ method: 'PUT', url: `${accepted}/day-summaries`, headers, payload: {
                recordId: first.recordId, dayStartAtMs: firstDay, payload: { v: 1, coverage: { observationCount: 1,
                    frontier: { id: retained.id, observedAtMs: first.fetchedAtMs } }, content: { t: 'plain', v: summary } },
            } });
            expect(summaryReply.statusCode, summaryReply.body).toBe(200);
            const rewritten = await read(coalesced.nextCursor);
            expect(readProviderAccountUsageDayChangeV1(rewritten.changes)).toEqual({ recordId: first.recordId, dayStartAtMs: firstDay,
                afterCursor: coalesced.nextCursor, throughCursor: rewritten.nextCursor,
                publication: { kind: 'summary', afterCursor: coalesced.nextCursor } });
        });
    });

    it('groups only missing detail and seeks old completed days without fetching their bodies', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const start = Date.UTC(2020, 0, 1);
        const dayMs = 86_400_000;
        const snapshots = Array.from({ length: 100 }, (_, day) => Array.from({ length: 20 }, (_, index) =>
            createUsageSnapshot({ fetchedAt: start + day * dayMs + index * 1000 })));
        const latest = snapshots.at(-1)!.at(-1)!;
        const write = (snapshot: typeof latest) => ({ accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
            payloadMode: 'plain_json_v1' as const, status: 'ok' as const, snapshot,
            fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
        await createProviderAccountUsageRecord(write(latest));
        await seedSqliteUsageHistory(db, snapshots.flatMap((day, dayIndex) => day.map((snapshot, index) => ({
            id: `${account.id}-${dayIndex}-${String(index).padStart(2, '0')}`, accountId: account.id, recordId: snapshot.recordId,
            observedAt: new Date(snapshot.fetchedAtMs), payload: write(snapshot),
        }))));
        await db.providerAccountUsageDaySummary.createMany({ data: snapshots.flatMap((day, index) => index === 45 ? [] : [{
            accountId: account.id, recordId: latest.recordId, dayStartAt: new Date(start + index * dayMs), payload: {
                v: 1, coverage: { observationCount: day.length, frontier: { id: `${account.id}-${index}-19`, observedAtMs: day.at(-1)!.fetchedAtMs } },
                content: { t: 'plain', v: buildProviderAccountUsageDaySummaryV1({ recordId: latest.recordId, dayStartAtMs: start + index * dayMs, snapshots: day }) },
            },
        }]) });
        await db.providerAccountUsageRecord.update({ where: { accountId_recordId: { accountId: account.id, recordId: latest.recordId } },
            data: { metadata: { daySummaryPendingDays: [start + 45 * dayMs] } } });
        await inReadSnapshot(async tx => {
            const queries: Prisma.Sql[] = [];
            let bodyRows = 0;
            const boundary = new Proxy(tx, { get(target, property, receiver) {
                if (property === '$queryRaw') return async <T>(query: Prisma.Sql) => { queries.push(query); return target.$queryRaw<T>(query); };
                if (property === 'providerAccountUsageDaySummary') return new Proxy(target.providerAccountUsageDaySummary, {
                    get(model, method, modelReceiver) {
                        if (method === 'findMany') return async (args: Prisma.ProviderAccountUsageDaySummaryFindManyArgs) => {
                            const rows = await model.findMany(args); if (args.select?.payload) bodyRows += rows.length; return rows;
                        };
                        return Reflect.get(model, method, modelReceiver);
                    },
                });
                return Reflect.get(target, property, receiver);
            } });
            const result = await readProviderAccountUsageDaySummaries({ accountId: account.id, recordId: latest.recordId,
                range: { startAtMs: start, endAtMs: start + 100 * dayMs }, includeMissingDays: true }, boundary);
            expect(result.missingDays).toMatchObject([{ dayStartAtMs: start + 45 * dayMs, coverage: { observationCount: 20 },
                precedingSummary: { dayStartAtMs: start + 44 * dayMs } }]);
            expect(result.missingDays).toHaveLength(1);
            expect(bodyRows).toBe(1); // Only the preceding body exists; the missing day is not sealed yet.
            const grouped = queries.filter(query => query.sql.includes('COUNT(*) OVER'));
            expect(grouped).toHaveLength(1);
            expect(grouped[0]!.values).toContain(start + 45 * dayMs);
            expect(grouped[0]!.values).toContain(start + 46 * dayMs);
            expect(grouped[0]!.sql).not.toContain('"payload"');
            for (const query of queries.filter(query => query.sql.includes('ProviderAccountUsageHistory'))) {
                const plan = await tx.$queryRaw<Array<{ detail: string }>>(prismaRuntime.sql`EXPLAIN QUERY PLAN ${query}`);
                expect(plan.some(row => row.detail.includes('SEARCH') && row.detail.includes('pauh_record_time_idx'))).toBe(true);
                expect(plan.some(row => /SCAN (h|ProviderAccountUsageHistory)(?:\s|$)/u.test(row.detail))).toBe(false);
            }
        });
        let inserted = 0;
        let completedRetainedDays = 100;
        for (const retainedEmptyDays of [100, 1000]) {
            if (retainedEmptyDays === 1000) {
                const extra = Array.from({ length: 900 }, (_, offset) => Array.from({ length: 20 }, (_, index) =>
                    createUsageSnapshot({ fetchedAt: start + (100 + offset) * dayMs + index * 1000 })));
                await seedSqliteUsageHistory(db, extra.flatMap((day, offset) => day.map((snapshot, index) => ({
                    id: `${account.id}-${100 + offset}-${String(index).padStart(2, '0')}`, accountId: account.id, recordId: snapshot.recordId,
                    observedAt: new Date(snapshot.fetchedAtMs), payload: write(snapshot),
                }))));
                const summaries = extra.map((day, offset) => ({ accountId: account.id, recordId: latest.recordId,
                    dayStartAt: new Date(start + (100 + offset) * dayMs), payload: { v: 1, coverage: { observationCount: 20,
                        frontier: { id: `${account.id}-${100 + offset}-19`, observedAtMs: day.at(-1)!.fetchedAtMs } },
                    content: { t: 'plain', v: buildProviderAccountUsageDaySummaryV1({ recordId: latest.recordId,
                        dayStartAtMs: start + (100 + offset) * dayMs, snapshots: day }) } } }));
                for (const chunk of portableQueryChunks({ values: summaries, bindingsPerValue: 4 })) {
                    await db.providerAccountUsageDaySummary.createMany({ data: [...chunk] });
                }
                completedRetainedDays = 1000;
            }
            const additional = Array.from({ length: retainedEmptyDays - inserted }, (_, offset) => {
                const dayStartAtMs = start - (inserted + offset + 1) * dayMs;
                const snapshot = createUsageSnapshot({ fetchedAt: dayStartAtMs + 1000 });
                return { accountId: account.id, recordId: latest.recordId, dayStartAt: new Date(dayStartAtMs), payload: {
                    v: 1, coverage: { observationCount: 0, frontier: null },
                    content: { t: 'plain', v: buildProviderAccountUsageDaySummaryV1({ recordId: latest.recordId, dayStartAtMs, snapshots: [snapshot] }) },
                } };
            });
            for (const chunk of portableQueryChunks({ values: additional, bindingsPerValue: 4 })) {
                await db.providerAccountUsageDaySummary.createMany({ data: [...chunk] });
            }
            inserted = retainedEmptyDays;
            await inReadSnapshot(async tx => {
                const queries: Prisma.Sql[] = [];
                const boundary = new Proxy(tx, { get(target, property, receiver) {
                    if (property === '$queryRaw') return async <T>(query: Prisma.Sql) => { queries.push(query); return target.$queryRaw<T>(query); };
                    return Reflect.get(target, property, receiver);
                } });
                const started = performance.now();
                const candidates = await readExpiredProviderAccountUsageSummaryDays({ cutoff: new Date(start + completedRetainedDays * dayMs), limit: 1 }, boundary);
                const elapsedMs = performance.now() - started;
                expect(candidates).toMatchObject([{ dayStartAtMs: start }]);
                expect(queries).toHaveLength(1);
                expect(queries[0]!.sql.split('FROM')[0]).not.toContain('payload');
                const plan = await tx.$queryRaw<Array<{ detail: string }>>(prismaRuntime.sql`EXPLAIN QUERY PLAN ${queries[0]!}`);
                expect(plan.some(row => row.detail.includes('INDEX pauds_day_idx'))).toBe(true);
                expect(plan.some(row => /^SEARCH h (?:EXISTS )?USING COVERING INDEX pauh_record_time_idx \(/.test(row.detail))).toBe(true);
                const measuredSql = queries[0]!.sql.replace('AND EXISTS', 'AND summary_candidate_probe() AND EXISTS');
                const bindings = queries[0]!.values.map(value => {
                    if (value === null || typeof value === 'string' || typeof value === 'number') return value;
                    throw new Error('Unexpected SQLite candidate measurement binding');
                });
                const measured = measureSqliteQueryVisits({ dbPath: harness.dbPath, sql: measuredSql, bindings, probeName: 'summary_candidate_probe' });
                expect(measured.rowCount).toBe(1);
                const candidateVisits = measured.visits;
                expect(candidateVisits).toBe(1);
                console.info('USAGE_RETENTION_CANDIDATE_COST', JSON.stringify({ retainedEmptyDays, detailedDays: completedRetainedDays,
                    detailedRows: completedRetainedDays * 20, candidateDays: candidates.length, candidateVisits, elapsedMs, plan: plan.map(row => row.detail) }));
                let summaryKeys = 0;
                const discoveryQueries: Prisma.Sql[] = [];
                const discoveryBoundary = new Proxy(tx, { get(target, property, receiver) {
                    if (property === '$queryRaw') return async <T>(query: Prisma.Sql) => { discoveryQueries.push(query); return target.$queryRaw<T>(query); };
                    if (property === 'providerAccountUsageDaySummary') return new Proxy(target.providerAccountUsageDaySummary, {
                        get(model, method, modelReceiver) {
                            if (method === 'findMany') return async (args: Prisma.ProviderAccountUsageDaySummaryFindManyArgs) => {
                                const rows = await model.findMany(args); if (!args.select?.payload) summaryKeys += rows.length; return rows;
                            };
                            return Reflect.get(model, method, modelReceiver);
                        },
                    });
                    return Reflect.get(target, property, receiver);
                } });
                const discoveryStarted = performance.now();
                const missing = await readProviderAccountUsageDaySummaries({ accountId: account.id, recordId: latest.recordId,
                    range: { startAtMs: 0, endAtMs: start + completedRetainedDays * dayMs }, includeMissingDays: true }, discoveryBoundary);
                const discoveryElapsedMs = performance.now() - discoveryStarted;
                expect(missing.missingDays).toHaveLength(1);
                expect(summaryKeys).toBe(0);
                const grouped = discoveryQueries.filter(query => query.sql.includes('COUNT(*) OVER'));
                expect(grouped).toHaveLength(1);
                const measuredDetailSql = grouped[0]!.sql.replaceAll('WHERE "accountId"', 'WHERE summary_detail_probe() AND "accountId"');
                expect(measuredDetailSql).toContain('summary_detail_probe()');
                const detailBindings = grouped[0]!.values.map(value => {
                    if (value === null || typeof value === 'string' || typeof value === 'number') return value;
                    throw new Error('Unexpected SQLite discovery measurement binding');
                });
                const measuredDetail = measureSqliteQueryVisits({ dbPath: harness.dbPath, sql: measuredDetailSql, bindings: detailBindings, probeName: 'summary_detail_probe' });
                expect(measuredDetail.rowCount).toBe(1);
                const detailVisits = measuredDetail.visits;
                expect(detailVisits).toBe(20);
                console.info('USAGE_SUMMARY_DISCOVERY_COST', JSON.stringify({ retainedEmptyDays, completedRetainedDays, missingDays: missing.missingDays.length,
                    summaryKeys, detailVisits, elapsedMs: discoveryElapsedMs }));
            });
        }
    });

    it.each([
        { mode: 'plain', packed: false },
        { mode: 'plain', packed: true },
        { mode: 'e2ee', packed: true },
    ] as const)('admits $mode summaries (packed: $packed) only for the exact accepted day and authenticated Account', async ({ mode, packed }) => {
        const account = await db.account.create({ data: mode === 'plain' ? { publicKey: null, encryptionMode: 'plain' }
            : { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' }, select: { id: true } });
        const headers = { 'x-test-user-id': account.id };
        const dayStartAtMs = Date.UTC(2026, 0, 1);
        const snapshot = createUsageSnapshot({ fetchedAt: dayStartAtMs + 1000 });
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const ref = { service: { pluginId: 'example.connected-accounts', localId: 'usage-days' }, accountId: 'usage-days' };
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const credential = await app.inject({ method: 'POST', url: '/v4/connect/qualified/credential', headers, payload: {
                ref, authenticationModeId: 'api-key', expectedCredentialRevision: null,
                content: mode === 'plain' ? { t: 'plain', v: { token: 'fixture' } } : { t: 'encrypted', c: 'fixture' },
                metadata: { scopes: [], providerIdentity: { accountId: snapshot.recordKey.accountSubjectId } },
            } });
            expect(credential.statusCode, credential.body).toBe(200);
            const accepted = await app.inject({ method: 'POST', url: '/v4/connect/qualified/provider-account-usage', headers, payload: {
                source: { ref, bindingKind: 'account' }, expectedCredentialRevision: credential.json().credentialRevision,
                expectedConfigurationRevision: null, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
                payloadMode: mode === 'plain' ? 'plain_json_v1' : 'sealed_account_scoped_v1', status: 'ok',
                ...(mode === 'plain' ? { snapshot } : { sealedPayload: sealProviderAccountUsageSnapshot({ snapshot, material,
                    randomBytes: length => new Uint8Array(length).fill(3) }) }),
                fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs,
            } });
            expect(accepted.statusCode, accepted.body).toBe(200);
            const query = { recordId: snapshot.recordId, range: { startAtMs: dayStartAtMs, endAtMs: dayStartAtMs + 86_400_000 } };
            const url = (includeMissingDays = false) => `/v4/connect/qualified/provider-account-usage/day-summaries?${new URLSearchParams({ query: JSON.stringify({ ...query, ...(includeMissingDays ? { includeMissingDays: true } : {}) }) })}`;
            const ordinary = await app.inject({ method: 'GET', url: url(), headers });
            expect(ordinary.statusCode, ordinary.body).toBe(200);
            expect(ordinary.json()).toEqual({ summaries: [], missingDays: [] });
            const coverageUrl = `/v4/connect/qualified/provider-account-usage/day-summaries?${new URLSearchParams({ query: JSON.stringify({ ...query, includeCoverage: true }) })}`;
            const uncoveredRead = await app.inject({ method: 'GET', url: coverageUrl, headers });
            expect(uncoveredRead.statusCode, uncoveredRead.body).toBe(200);
            expect(uncoveredRead.json()).toMatchObject({ summaries: [], missingDays: [{ dayStartAtMs, coverage: { observationCount: 1 } }] });
            const allDaysUrl = `/v4/connect/qualified/provider-account-usage/day-summaries?${new URLSearchParams({
                query: JSON.stringify({ recordId: snapshot.recordId, includeCoverage: true }),
            })}`;
            const allUncovered = await app.inject({ method: 'GET', url: allDaysUrl, headers });
            expect(allUncovered.statusCode, allUncovered.body).toBe(200);
            expect(allUncovered.json()).toEqual(uncoveredRead.json());
            const missingDemand = await app.inject({ method: 'GET', headers,
                url: `/v4/connect/qualified/provider-account-usage/day-summaries?${new URLSearchParams({ query: JSON.stringify({ recordId: snapshot.recordId }) })}` });
            expect(missingDemand.statusCode).toBe(400);
            const backfill = await app.inject({ method: 'GET', url: url(true), headers });
            expect(backfill.statusCode, backfill.body).toBe(200);
            expect(backfill.json()).toMatchObject({ summaries: [], missingDays: [{ dayStartAtMs, coverage: {
                observationCount: 1, frontier: { observedAtMs: snapshot.fetchedAtMs, id: expect.any(String) },
            } }] });
            const summary = buildProviderAccountUsageDaySummaryV1({ recordId: snapshot.recordId, dayStartAtMs, snapshots: [snapshot] });
            const payload = { v: 1, coverage: backfill.json().missingDays[0].coverage,
                ...(packed ? { encoding: PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING } : {}),
                content: mode === 'plain' ? { t: 'plain', v: packed ? packProviderAccountUsageDaySummaryV1(summary) : summary } : sealProviderAccountUsageDaySummaryV1({ summary, material,
                    randomBytes: length => new Uint8Array(length).fill(5) }) };
            const write = (value: unknown, writeHeaders = headers) => app.inject({ method: 'PUT',
                url: '/v4/connect/qualified/provider-account-usage/day-summaries', headers: writeHeaders,
                payload: { recordId: snapshot.recordId, dayStartAtMs, payload: value } });
            const wrongCoverage = await write({ ...payload, coverage: { ...payload.coverage, observationCount: 2 } });
            expect(wrongCoverage.json()).toEqual({ error: 'provider_account_usage_day_summary_conflict' });
            const wrongMode = await write({ ...payload, content: mode === 'plain'
                ? sealProviderAccountUsageDaySummaryV1({ summary, material, randomBytes: length => new Uint8Array(length).fill(4) })
                : { t: 'plain', v: summary } });
            expect(wrongMode.statusCode, wrongMode.body).toBe(409);
            if (mode === 'plain' && packed) {
                const body = packProviderAccountUsageDaySummaryV1(summary);
                const foreign = createUsageSnapshot({ fetchedAt: snapshot.fetchedAtMs,
                    recordKey: { ...snapshot.recordKey, accountSubjectId: 'foreign-provider-subject' } });
                const wrongRecord = await write({ ...payload, content: { t: 'plain', v: { ...body,
                    snapshots: { ...body.snapshots, bases: body.snapshots.bases.map(base => ({ ...base,
                        recordId: foreign.recordId, recordKey: foreign.recordKey, accountSubject: foreign.accountSubject })) } } } });
                expect(wrongRecord.json()).toEqual({ error: 'provider_account_usage_storage_mode_mismatch' });
            }
            const written = await write(payload);
            expect(written.statusCode, written.body).toBe(200);
            expect((await app.inject({ method: 'GET', url: url(true), headers })).json())
                .toEqual({ summaries: [], missingDays: [] });
            expect((await app.inject({ method: 'GET', url: url(), headers })).json())
                .toEqual({ summaries: [{ dayStartAtMs, payload }], missingDays: [] });
            expect((await app.inject({ method: 'GET', url: coverageUrl, headers })).json())
                .toEqual({ summaries: [{ dayStartAtMs, payload }], missingDays: [] });
            // All-days coverage includes valid stored dates beyond the reader's
            // wall clock, without a client-selected upper timestamp.
            const futureDay = Date.UTC(2400, 0, 1);
            const futureSnapshot = { ...snapshot, fetchedAtMs: futureDay + 1000, observedAtMs: futureDay + 1000 };
            const futureSummary = buildProviderAccountUsageDaySummaryV1({ recordId: snapshot.recordId, dayStartAtMs: futureDay, snapshots: [futureSnapshot] });
            const futurePayload = { v: 1, coverage: { observationCount: 0, frontier: null },
                content: mode === 'plain' ? { t: 'plain', v: futureSummary }
                    : sealProviderAccountUsageDaySummaryV1({ summary: futureSummary, material, randomBytes: length => new Uint8Array(length).fill(6) }) };
            await db.providerAccountUsageDaySummary.create({ data: { accountId: account.id, recordId: snapshot.recordId,
                dayStartAt: new Date(futureDay), payload: futurePayload } });
            const allSealed = await app.inject({ method: 'GET', url: allDaysUrl, headers });
            expect(allSealed.statusCode, allSealed.body).toBe(200);
            expect(allSealed.json()).toEqual({ summaries: [{ dayStartAtMs, payload }, { dayStartAtMs: futureDay, payload: futurePayload }], missingDays: [] });
            expect((await app.inject({ method: 'GET', url: coverageUrl, headers })).json())
                .toEqual({ summaries: [{ dayStartAtMs, payload }], missingDays: [] });
            const stranger = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            expect((await app.inject({ method: 'GET', url: coverageUrl, headers: { 'x-test-user-id': stranger.id } })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: allDaysUrl, headers: { 'x-test-user-id': stranger.id } })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: url(), headers: { 'x-test-user-id': stranger.id } })).statusCode).toBe(404);
            expect((await write(payload, { 'x-test-user-id': stranger.id })).statusCode).toBe(404);
            const later = { ...snapshot, fetchedAtMs: snapshot.fetchedAtMs + 1000, observedAtMs: snapshot.observedAtMs + 1000, planLabel: 'changed plan' };
            const appended = await app.inject({ method: 'POST', url: '/v4/connect/qualified/provider-account-usage', headers, payload: {
                source: { ref, bindingKind: 'account' }, expectedCredentialRevision: credential.json().credentialRevision,
                expectedConfigurationRevision: null, recordId: later.recordId, recordKey: later.recordKey,
                payloadMode: mode === 'plain' ? 'plain_json_v1' : 'sealed_account_scoped_v1', status: 'ok',
                ...(mode === 'plain' ? { snapshot: later } : { sealedPayload: sealProviderAccountUsageSnapshot({ snapshot: later, material,
                    randomBytes: length => new Uint8Array(length).fill(3) }) }), fetchedAt: later.fetchedAtMs, staleAfterMs: later.staleAfterMs,
            } });
            expect(appended.statusCode, appended.body).toBe(200);
            expect((await app.inject({ method: 'GET', url: url(true), headers })).json()).toMatchObject({
                missingDays: [{ dayStartAtMs, coverage: { observationCount: 2, frontier: { observedAtMs: later.fetchedAtMs } } }],
            });
            const invalidatedRead = await app.inject({ method: 'GET', url: coverageUrl, headers });
            expect(invalidatedRead.statusCode, invalidatedRead.body).toBe(200);
            expect(invalidatedRead.json()).toMatchObject({ summaries: [{ dayStartAtMs, payload: { ...payload, coverage: { observationCount: 0, frontier: null } } }],
                missingDays: [{ dayStartAtMs, coverage: { observationCount: 2, frontier: { observedAtMs: later.fetchedAtMs } } }] });
            expect((await write(payload)).statusCode).toBe(409);
            // Invalidated proof never authorizes deletion before the normal
            // producer merges and seals the newly accepted detail.
            const policy = { ...readRetentionPolicyFromEnv({}), enabled: true };
            const sweep = (rule = createProviderAccountUsageHistoryRetentionRule(), dryRun = false, now = new Date(dayStartAtMs + 91 * 86_400_000)) => rule.run({
                policy, now, batchSize: 1, maxDeletesPerRulePerRun: 1, maxCandidatesPerRulePerRun: 1, dryRun,
            });
            expect((await sweep()).deleted).toBe(0);
            expect(await db.providerAccountUsageHistory.count({ where: { accountId: account.id } })).toBe(2);
            const missing = (await app.inject({ method: 'GET', url: url(true), headers })).json();
            const completeSummary = buildProviderAccountUsageDaySummaryV1({ recordId: snapshot.recordId, dayStartAtMs, snapshots: [snapshot, later] });
            const refreshed = { ...payload, coverage: missing.missingDays[0].coverage,
                content: mode === 'plain' ? { t: 'plain', v: completeSummary }
                    : sealProviderAccountUsageDaySummaryV1({ summary: completeSummary, material, randomBytes: length => new Uint8Array(length).fill(6) }) };
            expect((await write(refreshed)).statusCode).toBe(200);
            const detail = await db.providerAccountUsageHistory.findMany({ where: { accountId: account.id }, orderBy: [{ observedAt: 'asc' }, { id: 'asc' }] });
            const projection = buildProviderAccountUsagePageProjectionV1({ recordId: snapshot.recordId, range: query.range,
                history: { entries: detail.map((row, index) => ({ id: row.id, observedAtMs: row.observedAt.getTime(), snapshot: index === 0 ? snapshot : later })), nextCursor: null } });
            const pageWritten = await app.inject({ method: 'PUT', url: '/v4/connect/qualified/provider-account-usage/history', headers, payload: {
                recordId: snapshot.recordId, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING,
                demand: { range: query.range, resolution: 'accepted_observations' }, observationCount: 2,
                frontier: refreshed.coverage.frontier, content: sealProviderAccountUsagePageProjectionV1({ projection, accountMode: mode, material,
                    randomBytes: length => new Uint8Array(length).fill(8) }),
            } });
            expect(pageWritten.statusCode, pageWritten.body).toBe(200);
            const parent = await db.providerAccountUsageRecord.findUniqueOrThrow({ where: { accountId_recordId: { accountId: account.id, recordId: snapshot.recordId } } });
            const metadata = parent.metadata && typeof parent.metadata === 'object' && !Array.isArray(parent.metadata) ? parent.metadata : {};
            await db.providerAccountUsageRecord.update({ where: { accountId_recordId: { accountId: account.id, recordId: snapshot.recordId } },
                data: { metadata: { ...metadata, materialFingerprint: 'preserved-sibling' } } });
            // A separate, unsummarized day is deliberately retained.
            await db.providerAccountUsageHistory.create({ data: { accountId: account.id, recordId: snapshot.recordId,
                observedAt: new Date(dayStartAtMs - 1000), payload: detail[0]!.payload } });
            const historyUrl = (value: Record<string, unknown>) => `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({ query: JSON.stringify({ recordId: snapshot.recordId, ...value }) })}`;
            const witness = { id: detail[0]!.id, observedAtMs: detail[0]!.observedAt.getTime() };
            expect((await app.inject({ method: 'GET', url: historyUrl({ witness }), headers })).json().entries).toHaveLength(1);
            expect((await sweep(createProviderAccountUsageHistoryRetentionRule(), false,
                new Date(dayStartAtMs + 90 * 86_400_000 + 1000))).deleted).toBe(0);
            const dryRule = createProviderAccountUsageHistoryRetentionRule();
            expect((await sweep(dryRule, true)).deleted).toBe(1);
            expect((await sweep(dryRule, true)).deleted).toBe(1);
            expect(await db.providerAccountUsageHistory.count({ where: { accountId: account.id } })).toBe(3);
            const rule = createProviderAccountUsageHistoryRetentionRule();
            expect((await sweep(rule)).deleted).toBe(1);
            const partlyCompacted = (await app.inject({ method: 'GET', url: url(), headers })).json().summaries[0].payload;
            expect(partlyCompacted.content).toEqual(refreshed.content);
            expect(partlyCompacted.coverage).toEqual({ observationCount: 1, frontier: refreshed.coverage.frontier });
            expect((await app.inject({ method: 'GET', url: historyUrl({ witness }), headers })).json().entries).toEqual([]);
            expect((await app.inject({ method: 'GET', url: historyUrl({ history: { range: query.range, pageSize: 100 } }), headers })).json().entries).toHaveLength(1);
            const projected = await app.inject({ method: 'GET', url: historyUrl({ projection: { range: query.range, resolution: 'accepted_observations' } }), headers });
            expect(projected.json()).toEqual({ projection: null, complete: false });
            const after = await db.providerAccountUsageRecord.findUniqueOrThrow({ where: { accountId_recordId: { accountId: account.id, recordId: snapshot.recordId } } });
            expect(after.metadata).toMatchObject({ materialFingerprint: 'preserved-sibling' });
            expect(after.metadata).not.toHaveProperty('pageProjection');
            expect((await sweep(rule)).deleted).toBe(1);
            expect((await app.inject({ method: 'GET', url: url(), headers })).json().summaries[0].payload)
                .toEqual({ ...refreshed, coverage: { observationCount: 0, frontier: null } });
            expect(await db.providerAccountUsageHistory.count({ where: { accountId: account.id } })).toBe(1);
            expect((await app.inject({ method: 'GET', url: url(true), headers })).json()).toEqual({ summaries: [], missingDays: [] });
            // A fresh accepted observation can reopen the same old day after
            // all of its earlier exact detail has been compacted.
            const reopened = { ...later, fetchedAtMs: later.fetchedAtMs + 1000, observedAtMs: later.observedAtMs + 1000, planLabel: 'reopened day' };
            const reopenedWrite = await app.inject({ method: 'POST', url: '/v4/connect/qualified/provider-account-usage', headers, payload: {
                source: { ref, bindingKind: 'account' }, expectedCredentialRevision: credential.json().credentialRevision,
                expectedConfigurationRevision: null, recordId: reopened.recordId, recordKey: reopened.recordKey,
                payloadMode: mode === 'plain' ? 'plain_json_v1' : 'sealed_account_scoped_v1', status: 'ok',
                ...(mode === 'plain' ? { snapshot: reopened } : { sealedPayload: sealProviderAccountUsageSnapshot({ snapshot: reopened, material,
                    randomBytes: length => new Uint8Array(length).fill(3) }) }), fetchedAt: reopened.fetchedAtMs, staleAfterMs: reopened.staleAfterMs,
            } });
            expect(reopenedWrite.statusCode, reopenedWrite.body).toBe(200);
            const reopenedMissing = (await app.inject({ method: 'GET', url: url(true), headers })).json();
            expect(reopenedMissing).toMatchObject({ summaries: [{ payload: { content: refreshed.content } }],
                missingDays: [{ dayStartAtMs, coverage: { observationCount: 1, frontier: { observedAtMs: reopened.fetchedAtMs } } }] });
            expect((await sweep()).deleted).toBe(0);
            const merged = buildProviderAccountUsageDaySummaryV1({ recordId: snapshot.recordId, dayStartAtMs, snapshots: [snapshot, later, reopened] });
            expect((await write({ ...payload, coverage: reopenedMissing.missingDays[0].coverage,
                content: mode === 'plain' ? { t: 'plain', v: merged } : sealProviderAccountUsageDaySummaryV1({ summary: merged, material,
                    randomBytes: length => new Uint8Array(length).fill(6) }) })).statusCode).toBe(200);
            expect((await sweep()).deleted).toBe(1);
            expect(await db.providerAccountUsageHistory.count({ where: { accountId: account.id } })).toBe(1);
        });
    });
});
