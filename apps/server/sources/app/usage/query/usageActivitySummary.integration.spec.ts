import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryRequestSchema, UsageEventIngestRequestSchema,
    type UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { collectUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery } from '@happier-dev/protocol/usage/usageAnalyticsBatchDelivery';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { readUsageActivityProjectionOperand, type UsageActivityProjectionOperand } from '@happier-dev/protocol/usage/usageActivityProjectionFacts';

import { db } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { recordLegacyUsageReport, recordUsageEvent, deleteNativeUsageHistory } from '../usageWriteService';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from '../usageSourceClassifier';
import { USAGE_MODEL_PRICE_CACHE_KEY } from '../usageModelPriceCatalog';
import { createUsageEventRetentionRule } from '@/app/retention/rules/usageEventRetentionRule';
import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { captureUsageAnalyticsBatchInTx, projectUsageAnalyticsBatch } from './readUsageAnalyticsBatch';
import { readUsageActivitySummaryChunks, readUsageActivitySummaryHead } from './usageActivitySummaryStore';
import type { ScopedUsageReplayFact } from './resolveScopedUsageContributions';
import { usageActivityRoutingKey, usageActivitySubjectKey, usageActivityProjectionDayKey,
    type UsageActivityRoutingHead } from './usageActivitySummaryRouting';

const day = 86_400_000;
const startMs = Date.UTC(2026, 0, 1);
const compactQuery = (range: { startMs?: number; endMs?: number } = { startMs, endMs: startMs + 7 * day }) =>
    UsageAnalyticsQueryRequestSchema.parse({ dateRange: range, granularity: 'day', includeActivity: true,
        activityResolution: 'both', includeSeries: false, includeInsights: false, includeLeaders: false,
        includeMessageStats: false, includeModelTimeline: false, breakdowns: [] });

async function deliver(capture: Awaited<ReturnType<typeof captureUsageAnalyticsBatchInTx>>, query: UsageAnalyticsQueryRequest) {
    const input = UsageAnalyticsQueryBatchRequestSchema.parse({ queries: [query], includeContributions: false,
        contributionQueries: [], sessionQueries: [query] });
    const batch = await projectUsageAnalyticsBatch(capture, [query], true, true, undefined, input);
    const delivery = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery(batch, input, false));
    return { capture, delivery, serialized: JSON.stringify(delivery) };
}

async function capture(accountId: string, query: UsageAnalyticsQueryRequest, summary = true) {
    return inReadSnapshot(tx => summary
        ? captureUsageAnalyticsBatchInTx(tx, accountId, [query], undefined,
            { contributionQueries: [], sessionQueries: [query] })
        : captureUsageAnalyticsBatchInTx(tx, accountId, [query]));
}

async function read(accountId: string, query: UsageAnalyticsQueryRequest, summary = true) {
    return deliver(await capture(accountId, query, summary), query);
}

function expectSameWire(actual: string, expected: string) {
    // Delivery includes private identities and a large catalog; failures must not print either body.
    const firstDifference = (left: unknown, right: unknown, path = '$'): string | undefined => {
        if (Object.is(left, right)) return undefined;
        if (Array.isArray(left) && Array.isArray(right)) {
            if (left.length !== right.length) return `${path}.length`;
            for (let index = 0; index < left.length; index++) {
                const difference = firstDifference(left[index], right[index], `${path}[${index}]`);
                if (difference) return difference;
            }
        } else if (left && right && typeof left === 'object' && typeof right === 'object') {
            const leftRecord = left as Record<string, unknown>;
            const rightRecord = right as Record<string, unknown>;
            if (JSON.stringify(Object.keys(leftRecord)) !== JSON.stringify(Object.keys(rightRecord))) return `${path} (property order)`;
            for (const key of Object.keys(leftRecord)) {
                const difference = firstDifference(leftRecord[key], rightRecord[key], `${path}.${key}`);
                if (difference) return difference;
            }
        } else return path;
        return undefined;
    };
    const difference = actual === expected ? undefined : firstDifference(JSON.parse(actual), JSON.parse(expected));
    expect(actual === expected, `Delivered JSON must be byte-identical to the canonical uncached delivery; first difference: ${difference ?? 'none'}`)
        .toBe(true);
}

async function readWithChunkReads(accountId: string, query: UsageAnalyticsQueryRequest) {
    const chunkReads = { rows: 0, bytes: 0 };
    const captured = await inReadSnapshot(tx => {
        const projection = tx.usageAccountingProjection;
        // Observe the real persistent boundary; every query executes unchanged against disposable SQLite.
        const observedProjection = new Proxy(projection, { get(target, key) {
            if (key !== 'findMany') return Reflect.get(target, key);
            return async (args: Prisma.UsageAccountingProjectionFindManyArgs) => {
                const rows = await target.findMany(args);
                chunkReads.rows += rows.length;
                chunkReads.bytes += rows.reduce((sum, row) => sum + Buffer.byteLength(row.payload, 'utf8'), 0);
                return rows;
            };
        } });
        const observedTx = new Proxy(tx, { get(target, key) {
            return key === 'usageAccountingProjection' ? observedProjection : Reflect.get(target, key);
        } });
        return captureUsageAnalyticsBatchInTx(observedTx, accountId, [query], undefined,
            { contributionQueries: [], sessionQueries: [query] });
    });
    return { ...await deliver(captured, query), chunkReads };
}

async function expectControl(accountId: string, query: UsageAnalyticsQueryRequest) {
    const control = await read(accountId, query, false);
    const actual = await read(accountId, query);
    expectSameWire(actual.serialized, control.serialized);
    return actual;
}

async function readSummaryChunks(accountId: string) {
    return inReadSnapshot(async tx => {
        const rawHead = await readUsageActivitySummaryHead(tx, accountId);
        if (rawHead === null) throw new Error('Expected retained Usage activity manifest');
        const head = JSON.parse(rawHead) as UsageActivityRoutingHead & { format: string };
        expect(head.format).toBe('selective-day-facts');
        const keys = [...head.sourceDays.map(usageActivityRoutingKey), ...head.subjectKeys.map(usageActivitySubjectKey),
            ...head.sessionKeys.map(key => `session:${JSON.stringify(key)}`), ...head.projectionDays.map(usageActivityProjectionDayKey)];
        const chunks = await readUsageActivitySummaryChunks(tx, accountId, keys);
        expect(chunks.size).toBe(keys.length);
        return chunks;
    });
}

function total(result: Awaited<ReturnType<typeof read>>) {
    const first = result.delivery.results[0];
    if (!first || !('value' in first)) throw new Error('Expected successful compact activity result');
    return first.value.totals.tokens.total;
}

async function writeRuntime(accountId: string, sessionId: string, at: number, total: number) {
    const request = UsageEventIngestRequestSchema.parse({ sessionId, externalKey: randomUUID(), observedAt: at,
        agentId: 'codex', source: 'runtime', scope: 'turn_delta', isCumulative: false,
        tokens: { input: total, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total },
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
        metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } } });
    const result = await recordUsageEvent(accountId, request);
    expect(result).toMatchObject({ ok: true });
    return result;
}

async function seed() {
    const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const sessions = await Promise.all([0, 1].map(() => db.session.create({ data: {
        accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
    } })));
    const add = (sessionId: string, at: number, total: number) => db.usageEvent.create({ data: {
        accountId: account.id, sessionId, externalKey: randomUUID(), observedAt: new Date(at),
        agentId: 'codex', source: 'runtime', scope: 'turn_delta', isCumulative: false,
        inputTokens: total, totalTokens: total, reportedCostUsd: 0, estimatedCostUsd: 0,
        metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } },
    } });
    await add(sessions[0]!.id, startMs + day, 3);
    await add(sessions[0]!.id, startMs + 2 * day, 5);
    await add(sessions[1]!.id, startMs + 3 * day, 7);
    return { account, sessions, add };
}

describe('compact Usage activity summary read cache', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-activity-summary-', initAuth: false });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.simpleCache.deleteMany({ where: { key: USAGE_MODEL_PRICE_CACHE_KEY } }),
            () => db.usageEvent.deleteMany(), () => db.usageReport.deleteMany(),
            () => db.session.deleteMany(), () => db.machine.deleteMany(), () => db.account.deleteMany(),
        ]);
    });

    it('delivers identical cold and warm JSON while unchanged subjects read and replay zero events', async () => {
        const { account } = await seed();
        const query = compactQuery();
        const control = await read(account.id, query, false);
        expect(await db.usageAccountingProjection.count({ where: { accountId: account.id } })).toBe(0);
        const cold = await read(account.id, query);
        expectSameWire(cold.serialized, control.serialized);
        expect(cold.capture.activitySummary?.stats).toMatchObject({ eventsRead: 3, discoveryEventsRead: 3,
            historyEventsRead: 0, subjectCount: 2, replayedSubjects: 2 });
        const warm = await read(account.id, query);
        expectSameWire(warm.serialized, control.serialized);
        expect(warm.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, discoveryEventsRead: 0,
            historyEventsRead: 0, subjectCount: 2,
            replayedSubjects: 0, replayedEvents: 0 });
        expect(await db.usageAccountingProjection.count({ where: { accountId: account.id } })).toBeGreaterThan(0);
        const privateCache = await db.usageAccountingProjection.findMany({ where: { accountId: account.id },
            orderBy: { recordKey: 'asc' } });
        const publicQuery = UsageAnalyticsQueryRequestSchema.parse({ ...query, population: 'public_eligible_personal' });
        const publicResult = await expectControl(account.id, publicQuery);
        expect(publicResult.capture.activitySummary).toBeUndefined();
        expect(isDeepStrictEqual(await db.usageAccountingProjection.findMany({ where: { accountId: account.id },
            orderBy: { recordKey: 'asc' } }), privateCache)).toBe(true);
    });

    it('keeps writes raw until the first read and replays only the changed subject for tail and late arrivals', async () => {
        const { account, sessions } = await seed();
        await writeRuntime(account.id, sessions[0]!.id, startMs + 4 * day, 11);
        expect(await db.usageAccountingProjection.count({ where: { accountId: account.id } })).toBe(0);
        const query = compactQuery();
        const captured = await capture(account.id, query);
        expect(await db.usageAccountingProjection.count({ where: { accountId: account.id } })).toBe(0);
        expect(total(await deliver(captured, query))).toBe(26);
        const beforeWrite = await db.usageAccountingProjection.findMany({ where: { accountId: account.id },
            orderBy: { recordKey: 'asc' } });
        await writeRuntime(account.id, sessions[0]!.id, startMs + 5 * day, 13);
        const afterWrite = await db.usageAccountingProjection.findMany({ where: { accountId: account.id },
            orderBy: { recordKey: 'asc' } });
        expect(isDeepStrictEqual(afterWrite, beforeWrite)).toBe(true);
        const tail = await expectControl(account.id, query);
        expect(total(tail)).toBe(39);
        expect(tail.capture.activitySummary?.stats).toMatchObject({ eventsRead: 4, discoveryEventsRead: 1,
            historyEventsRead: 3, replayedSubjects: 1, replayedEvents: 4 });
        await writeRuntime(account.id, sessions[0]!.id, startMs + day / 2, 17);
        const late = await expectControl(account.id, query);
        expect(total(late)).toBe(56);
        expect(late.capture.activitySummary?.stats).toMatchObject({ eventsRead: 5, discoveryEventsRead: 1,
            historyEventsRead: 4, replayedSubjects: 1, replayedEvents: 5 });
        const warm = await expectControl(account.id, query);
        expect(warm.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0 });
    });

    it('keeps changed-summary chunk reads and projection work proportional to six changed subjects as unrelated history grows', async () => {
        const changedSubjects = 6;
        const projectedEvents = changedSubjects * 12;
        const results = [];
        for (const { subjectCount, unrelatedDays } of [
            { subjectCount: 120, unrelatedDays: 10 },
            { subjectCount: 5_233, unrelatedDays: 120 },
        ]) {
            const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
            const sessionIds = Array.from({ length: subjectCount }, () => randomUUID());
            await db.session.createMany({ data: sessionIds.map(id => ({ id, accountId: account.id,
                tag: id, encryptionMode: 'plain', metadata: '{}' })) });
            await db.usageEvent.createMany({ data: sessionIds.flatMap((sessionId, index) =>
                Array.from({ length: index < changedSubjects ? 11 : 1 }, (_, event) => ({
                    accountId: account.id, sessionId, externalKey: randomUUID(),
                    observedAt: new Date(startMs + (index < changedSubjects ? 1 : 3 + index % unrelatedDays) * day + event),
                    agentId: 'codex', source: 'runtime', scope: 'turn_delta', isCumulative: false,
                    inputTokens: 1, totalTokens: 1, reportedCostUsd: 0, estimatedCostUsd: 0,
                    metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } },
                }))) });
            const query = compactQuery({ startMs, endMs: startMs + 125 * day });
            const coldControl = await read(account.id, query, false);
            const cold = await readWithChunkReads(account.id, query);
            expectSameWire(cold.serialized, coldControl.serialized);
            expect(total(cold)).toBe(subjectCount + changedSubjects * 10);
            expect(cold.capture.activitySummary?.stats).toMatchObject({ subjectCount, replayedSubjects: subjectCount });
            const warm = await readWithChunkReads(account.id, query);
            expectSameWire(warm.serialized, coldControl.serialized);
            expect(warm.chunkReads).toEqual({ rows: 0, bytes: 0 });
            expect(warm.capture.activitySummary?.stats).toMatchObject({ replayedSubjects: 0, replayedEvents: 0, projectedRows: 0 });

            const beforeWrite = await db.usageAccountingProjection.findMany({ where: { accountId: account.id },
                orderBy: { recordKey: 'asc' } });
            for (const sessionId of sessionIds.slice(0, changedSubjects)) {
                await writeRuntime(account.id, sessionId, startMs + 2 * day, 1);
            }
            expect(isDeepStrictEqual(await db.usageAccountingProjection.findMany({ where: { accountId: account.id },
                orderBy: { recordKey: 'asc' } }), beforeWrite)).toBe(true);
            const changedControl = await read(account.id, query, false);
            const changed = await readWithChunkReads(account.id, query);
            expectSameWire(changed.serialized, changedControl.serialized);
            expect(total(changed)).toBe(subjectCount + changedSubjects * 11);
            expect(changed.capture.activitySummary?.stats).toMatchObject({ subjectCount,
                eventsRead: projectedEvents, discoveryEventsRead: changedSubjects,
                historyEventsRead: changedSubjects * 11, replayedSubjects: changedSubjects, replayedEvents: projectedEvents });
            const after = await readWithChunkReads(account.id, query);
            expectSameWire(after.serialized, changedControl.serialized);
            expect(after.chunkReads).toEqual({ rows: 0, bytes: 0 });
            expect(after.capture.activitySummary?.stats).toMatchObject({ replayedSubjects: 0, replayedEvents: 0, projectedRows: 0 });
            results.push(changed);
        }
        expect(results[1]!.chunkReads.rows, 'unrelated subjects and days must not add decoded chunks to an active partial read')
            .toBe(results[0]!.chunkReads.rows);
        for (const result of results) {
            expect(result.capture.activitySummary?.stats).toMatchObject({ projectedRows: changedSubjects });
        }
        // Keep the measured cost evidence privacy-safe; never log source rows or delivery bodies.
        console.info('Usage activity changed-read work', JSON.stringify(results.map(result => ({
            subjectCount: result.capture.activitySummary?.stats.subjectCount,
            chunkRowsRead: result.chunkReads.rows, chunkBytesRead: result.chunkReads.bytes,
            projectedRows: result.capture.activitySummary?.stats.projectedRows,
            replayedEvents: result.capture.activitySummary?.stats.replayedEvents,
        }))));
    });

    it('projects only the changed derived day after replaying a subject with unchanged earlier days', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}' } });
        await writeRuntime(account.id, session.id, startMs + day, 3);
        await writeRuntime(account.id, session.id, startMs + 3 * day, 5);
        const query = compactQuery();
        const coldControl = await read(account.id, query, false);
        const cold = await read(account.id, query);
        await db.usageEvent.updateMany({ where: { accountId: account.id,
            observedAt: new Date(startMs + 3 * day) }, data: { inputTokens: 7, totalTokens: 7 } });
        const changedControl = await read(account.id, query, false);
        const changed = await read(account.id, query);
        expect(changed.capture.activitySummary?.stats).toMatchObject({ replayedSubjects: 1,
            replayedEvents: 2, projectedRows: 1 });
        expectSameWire(cold.serialized, coldControl.serialized);
        expectSameWire(changed.serialized, changedControl.serialized);
        const warm = await read(account.id, query);
        expectSameWire(warm.serialized, changedControl.serialized);
        expect(warm.capture.activitySummary?.stats).toMatchObject({ replayedSubjects: 0,
            replayedEvents: 0, projectedRows: 0 });
    });

    it('refreshes a day whose surviving subjects reorder after a source-only peer is removed', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const sessions = await Promise.all([0, 1, 2].map(() => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
        } })));
        const peerId = randomUUID();
        await db.usageEvent.createMany({ data: [
            { sessionId: sessions[0]!.id, observedAt: startMs + day, createdAt: 1, runtime: 'runtime-X', sequence: 2, inferenceId: 'A' },
            { sessionId: sessions[1]!.id, observedAt: startMs + day, createdAt: 2, runtime: 'runtime-Y', sequence: 1, inferenceId: 'B' },
            { id: peerId, sessionId: sessions[2]!.id, observedAt: startMs + day, createdAt: 3, runtime: 'runtime-X', sequence: 1, inferenceId: 'C' },
            { sessionId: sessions[2]!.id, observedAt: startMs + 2 * day, createdAt: 4, runtime: 'runtime-Z', sequence: 1, inferenceId: 'C' },
        ].map(({ createdAt, observedAt, runtime, sequence, inferenceId, ...identity }) => ({
            ...identity, accountId: account.id, externalKey: randomUUID(),
            observedAt: new Date(observedAt), createdAt: new Date(startMs + createdAt),
            agentId: 'codex', source: 'runtime', scope: 'turn_delta', isCumulative: false,
            inputTokens: 1, totalTokens: 1, reportedCostUsd: 0, estimatedCostUsd: 0,
            metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true,
                inferenceId, runtimeEventOrder: { runtimeIncarnationId: runtime, sequence } } },
        })) });
        const query = compactQuery();
        const coldControl = await read(account.id, query, false);
        const cold = await read(account.id, query);
        await db.usageEvent.delete({ where: { id: peerId } });
        const changedControl = await read(account.id, query, false);
        expect(changedControl.serialized === coldControl.serialized,
            'removing the peer must change the canonical delivery order').toBe(false);
        const changed = await read(account.id, query);
        expect(changed.capture.activitySummary?.stats).toMatchObject({ replayedSubjects: 1, replayedEvents: 1 });
        expectSameWire(cold.serialized, coldControl.serialized);
        expectSameWire(changed.serialized, changedControl.serialized);
        const warm = await read(account.id, query);
        expectSameWire(warm.serialized, changedControl.serialized);
        expect(warm.capture.activitySummary?.stats).toMatchObject({ replayedSubjects: 0, replayedEvents: 0, projectedRows: 0 });
    });

    it('retains compact admitted identity facts and preserves metadata semantics after a partial change', async () => {
        const { account, sessions } = await seed();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
        const subject = { kind: 'native', machineId: machine.id,
            agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, sourceRootKey: 'metadata-root',
            nativeSessionKey: 'metadata-native', linkedSessionId: sessions[0]!.id };
        const metadata = {
            usageAccounting: { path: 'runtime', status: 'available', historyComplete: true,
                asOfMs: startMs + 2 * day, nativeSessionId: '  metadata-native  ', counterEpoch: 'epoch-A',
                runtimeEventOrder: { runtimeIncarnationId: 'runtime-A', sequence: 4, diagnostic: true },
                inputIncludesCache: true, outputIncludesReasoning: false, diagnostic: true },
            accountingSubject: { ...subject, diagnostic: true },
            usageAttribution: { v: 1, turnId: 'metadata-turn', source: { kind: 'native', connectedAccount: null,
                accountScope: 'personal' } },
            providerId: 'happier.provider.openrouter/openrouter', providerConnectionId: 'retained-connection', legacyKey: 'retained-key',
            captureOrigin: { retained: true },
        };
        // Historical metadata can be a JSON string; admission owns its normalization.
        await db.usageEvent.updateMany({ where: { accountId: account.id, sessionId: sessions[0]!.id },
            data: { metadata: JSON.stringify(metadata), turnId: metadata.usageAttribution.turnId, modelId: 'metadata-model' } });
        const query = compactQuery();
        const cold = await expectControl(account.id, query);
        expect(total(cold)).toBe(15);
        expect(cold.capture.activitySummary?.stats).toMatchObject({ subjectCount: 2, replayedSubjects: 2, replayedEvents: 3 });
        const warm = await expectControl(account.id, query);
        expect(warm.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0 });

        await db.usageEvent.updateMany({ where: { accountId: account.id, sessionId: sessions[1]!.id },
            data: { metadata: { usageAccounting: { path: 'runtime', status: 'unrecognized' },
                accountingSubject: { kind: 'unrecognized' }, captureOrigin: 'metadata-correction' } } });
        const changed = await expectControl(account.id, query);
        expect(changed.serialized === cold.serialized).toBe(false);
        expect(total(changed)).toBe(15);
        expect(changed.capture.activitySummary?.stats).toMatchObject({ eventsRead: 1, discoveryEventsRead: 1,
            historyEventsRead: 0, subjectCount: 2,
            replayedSubjects: 1, replayedEvents: 1 });
        const after = await expectControl(account.id, query);
        expect(after.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0 });
        await db.usageEvent.updateMany({ where: { accountId: account.id, sessionId: sessions[1]!.id },
            data: { metadata: { usageAccounting: { path: 'runtime', status: 'unrecognized' },
                accountingSubject: { kind: 'unrecognized' }, captureOrigin: 'diagnostic-only-correction' } } });
        const diagnostic = await expectControl(account.id, query);
        expectSameWire(diagnostic.serialized, after.serialized);
        expect(diagnostic.capture.activitySummary?.stats).toMatchObject({ eventsRead: 1, discoveryEventsRead: 1,
            historyEventsRead: 0, replayedSubjects: 1, replayedEvents: 1 });

        const chunks = await readSummaryChunks(account.id);
        const facts = [...chunks].filter(([key]) => key.startsWith('routing:')).flatMap(([, payload]) =>
            JSON.parse(payload) as Array<{ fact: ScopedUsageReplayFact; fingerprint: string }>);
        expect(facts).toHaveLength(3);
        const retained = facts.filter(row => row.fact.sessionId === sessions[0]!.id);
        expect(retained).toHaveLength(2);
        expect(new Set(retained.map(row => row.fact.subjectKey)).size).toBe(1);
        for (const row of retained) {
            expect(row.fact.runtimeEventOrder).toEqual({ runtimeIncarnationId: 'runtime-A', sequence: 4 });
            expect(row.fingerprint.length).toBeGreaterThan(0);
        }
        // Source bodies are hydrated only for changed subjects; retained indices contain no bodies.
        expect(facts.every(({ fact }) => !Object.hasOwn(fact, 'metadata') && !Object.hasOwn(fact, 'accountingEvidence')
            && !Object.hasOwn(fact, 'tokens') && !Object.hasOwn(fact, 'cost'))).toBe(true);
        expect([...chunks.values()].every(payload => !payload.includes('"captureOrigin"')
            && !payload.includes('"usageAccounting"') && !payload.includes('"accountingEvidence"'))).toBe(true);
        const retainedContributions = [...chunks].filter(([key]) => key.startsWith('day:')).flatMap(([, payload]) =>
            (JSON.parse(payload) as Array<{ operand: UsageActivityProjectionOperand }>)
                .map(row => readUsageActivityProjectionOperand(row.operand)))
            .filter(row => row.sessionId === sessions[0]!.id);
        expect(retainedContributions).toHaveLength(2);
        expect(retainedContributions.every(row => row.providerId === null && row.providerConnectionId === null
            && row.providerAttribution === 'known' && row.providerSource === 'native' && row.connectedAccount === null
            && row.turnId === metadata.usageAttribution.turnId && row.modelId === 'metadata-model')).toBe(true);
    });

    it('omits large arbitrary source metadata from retained facts while preserving cold, warm and partial reads', async () => {
        const { account, sessions } = await seed();
        const diagnosticAttachment = 'preserved diagnostic metadata '.repeat(8192);
        const metadata = { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true },
            diagnosticAttachment };
        await db.usageEvent.updateMany({ where: { accountId: account.id, sessionId: sessions[0]!.id },
            data: { metadata } });
        const query = compactQuery();
        const cold = await expectControl(account.id, query);
        expect(total(cold)).toBe(15);
        const warm = await expectControl(account.id, query);
        expect(warm.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0 });
        await db.usageEvent.updateMany({ where: { accountId: account.id, sessionId: sessions[1]!.id },
            data: { metadata: { usageAccounting: { path: 'runtime', status: 'partial', historyComplete: false } } } });
        const changed = await expectControl(account.id, query);
        expect(changed.serialized === cold.serialized).toBe(false);
        expect(changed.capture.activitySummary?.stats).toMatchObject({ eventsRead: 1, replayedSubjects: 1, replayedEvents: 1 });
        const after = await expectControl(account.id, query);
        expect(after.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0 });
        const chunks = await readSummaryChunks(account.id);
        expect([...chunks.values()].every(payload => !payload.includes('"diagnosticAttachment"')
            && !payload.includes(diagnosticAttachment))).toBe(true);
    });

    it('rebases an advancing end within its terminal hour without source reads, replay or cache publication', async () => {
        const { account, sessions, add } = await seed();
        const endMs = startMs + 6 * day + 17 * 60_000;
        await add(sessions[0]!.id, endMs - 10_000, 11);
        const query = compactQuery({ startMs, endMs });
        expect(total(await expectControl(account.id, query))).toBe(26);
        const storedBefore = await db.usageAccountingProjection.findMany({ where: { accountId: account.id },
            orderBy: { recordKey: 'asc' } });
        const advanced = await expectControl(account.id, compactQuery({ startMs, endMs: endMs + 60_000 }));
        expect(advanced.capture.activitySummary?.compact).toBeDefined();
        expect(advanced.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0, replayedEvents: 0 });
        const storedAfter = await db.usageAccountingProjection.findMany({ where: { accountId: account.id },
            orderBy: { recordKey: 'asc' } });
        expect(isDeepStrictEqual(storedAfter, storedBefore)).toBe(true);

        const crossedHour = await expectControl(account.id, compactQuery({ startMs, endMs: endMs + 60 * 60_000 }));
        expect(crossedHour.capture.activitySummary?.compact).toBeUndefined();
        expect(total(crossedHour)).toBe(26);
    });

    it('preserves complete subject history as the exact end shrinks and expands again', async () => {
        const { account, sessions, add } = await seed();
        await add(sessions[0]!.id, startMs + 2 * day + 1, 11);
        const wide = compactQuery();
        const expected = await expectControl(account.id, wide);
        expect(total(expected)).toBe(26);
        const narrow = compactQuery({ startMs, endMs: startMs + 2 * day + 1 });
        const narrowed = await expectControl(account.id, narrow);
        expect(total(narrowed)).toBe(8);
        const expanded = await expectControl(account.id, wide);
        expectSameWire(expanded.serialized, expected.serialized);
        const warm = await expectControl(account.id, wide);
        expect(warm.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0 });
    });

    it('rebuilds deleted and retained subjects and preserves totals after Session SET NULL', async () => {
        const { account, sessions } = await seed();
        const query = compactQuery();
        await expectControl(account.id, query);
        await db.usageEvent.deleteMany({ where: { accountId: account.id, sessionId: sessions[0]!.id,
            observedAt: { gte: new Date(startMs + 2 * day) } } });
        const removed = await expectControl(account.id, query);
        expect(total(removed)).toBe(10);
        expect(removed.capture.activitySummary?.stats).toMatchObject({ replayedSubjects: 1 });
        const policy = readRetentionPolicyFromEnv({});
        const retained = await createUsageEventRetentionRule().run({ policy: { ...policy, enabled: true,
            domains: { ...policy.domains, usageEvents: { mode: 'delete_older_than', days: 1 } } },
            batchSize: 10, maxDeletesPerRulePerRun: 10, dryRun: false, now: new Date(startMs + 4 * day) });
        expect(retained.deleted).toBe(1);
        expect(total(await expectControl(account.id, query))).toBe(7);
        await db.session.delete({ where: { id: sessions[1]!.id } });
        expect(await db.usageEvent.count({ where: { accountId: account.id, sessionId: null } })).toBe(1);
        const detached = await expectControl(account.id, query);
        expect(total(detached)).toBe(7);
        const result = detached.delivery.results[0];
        if (!result || !('value' in result)) throw new Error('Expected detached Usage result');
        expect(result.value.sessionIds).toEqual([]);
        expect(await db.usageAccountingProjection.count({ where: { accountId: account.id } })).toBeGreaterThan(0);
        // These established Account children require explicit deletion; the read cache cascades itself.
        await db.usageEvent.deleteMany({ where: { accountId: account.id } });
        await db.session.deleteMany({ where: { accountId: account.id } });
        await db.account.delete({ where: { id: account.id } });
        expect(await db.usageAccountingProjection.count({ where: { accountId: account.id } })).toBe(0);
    });

    it('reconciles native competition, settlement and scoped native-history deletion through the existing writers', async () => {
        const { account, sessions } = await seed();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
        const subject = { kind: 'native', machineId: machine.id,
            agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, sourceRootKey: 'root', nativeSessionKey: 'native' };
        const observation = { observedAt: startMs + 4 * day, agentId: 'codex', modelId: 'unpriced',
            scope: 'turn_delta', isCumulative: false,
            tokens: { input: 11, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 11 },
            cost: { reportedUsd: 0, estimatedUsd: 0.11, currency: 'USD' } };
        expect(await recordUsageEvent(account.id, UsageEventIngestRequestSchema.parse({ ...observation,
            sessionId: sessions[0]!.id, externalKey: 'runtime-inference', source: 'runtime',
            metadata: { accountingSubject: subject, usageAccounting: { inferenceId: 'shared', path: 'runtime',
                status: 'available', historyComplete: true } } }))).toMatchObject({ ok: true });
        const native = UsageEventIngestRequestSchema.parse({ ...observation, subject, externalKey: 'native-inference',
            source: 'codex-native', accounting: { status: 'partial', historyComplete: false, inferenceKey: 'shared' } });
        const first = await recordUsageEvent(account.id, native);
        expect(first).toMatchObject({ ok: true });
        const query = compactQuery();
        expect(total(await expectControl(account.id, query))).toBe(26);
        expect(await recordUsageEvent(account.id, { ...native, tokens: { ...native.tokens, input: 19, total: 19 },
            cost: { ...native.cost, reportedUsd: 0.5 }, accounting: { ...native.accounting!, status: 'available' } })).toEqual(first);
        const settled = await expectControl(account.id, query);
        expect(settled.capture.activitySummary?.stats).toMatchObject({ eventsRead: 2, discoveryEventsRead: 2,
            historyEventsRead: 0, replayedSubjects: 1, replayedEvents: 2 });
        expect(await deleteNativeUsageHistory(account.id, { machineId: machine.id, sourceRootKey: subject.sourceRootKey }))
            .toEqual({ ok: true, deletedEventCount: 1 });
        expect(total(await expectControl(account.id, query))).toBe(26);
    });

    it('preserves pre-range cumulative baselines and retained-report bridge transitions', async () => {
        const { account } = await seed();
        const baseline = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}' } });
        await db.usageEvent.createMany({ data: [100, 120].map((amount, index) => ({
            accountId: account.id, sessionId: baseline.id, observedAt: new Date(startMs + (index ? 1 : -1) * day),
            agentId: 'codex', modelId: index ? 'new-model' : 'old-model', source: 'runtime',
            scope: 'session_cumulative', isCumulative: true, inputTokens: amount, totalTokens: amount,
            metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } },
        })) });
        const query = compactQuery({ startMs, endMs: Date.now() + day });
        expect(total(await expectControl(account.id, query))).toBe(35);
        const legacy = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}' } });
        await db.usageReport.create({ data: { accountId: account.id, sessionId: legacy.id, key: 'retained-counter',
            data: { tokens: { total: 100, input: 100 }, cost: { total: 1 } },
            createdAt: new Date(startMs + day), updatedAt: new Date(startMs + 2 * day) } });
        expect(total(await expectControl(account.id, query))).toBe(135);
        expect(await recordLegacyUsageReport({ accountId: account.id, sessionId: legacy.id, key: 'retained-counter',
            tokens: { total: 120, input: 120 }, cost: { total: 1.2 } })).toMatchObject({ ok: true, changed: true });
        expect(total(await expectControl(account.id, query))).toBe(155);
        await writeRuntime(account.id, legacy.id, startMs + 3 * day, 23);
        expect(total(await expectControl(account.id, query))).toBe(58);
        const warm = await expectControl(account.id, query);
        expect(warm.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0 });
    });

    it('keeps each captured response coherent when a newer reader persists before an older reader', async () => {
        const { account, sessions } = await seed();
        const query = compactQuery();
        const oldControl = await read(account.id, query, false);
        const older = await capture(account.id, query);
        await writeRuntime(account.id, sessions[0]!.id, startMs + 4 * day, 11);
        const newControl = await read(account.id, query, false);
        const newer = await capture(account.id, query);
        expectSameWire((await deliver(newer, query)).serialized, newControl.serialized);
        expectSameWire((await deliver(older, query)).serialized, oldControl.serialized);
        const warm = await read(account.id, query);
        expectSameWire(warm.serialized, newControl.serialized);
        expect(warm.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0 });
    });

    it('uses canonical capture for a rich sibling demand and preserves provider details after an unrelated change', async () => {
        const { account, sessions } = await seed();
        const turnId = 'mixed-demand-turn';
        const connectedAccount = { service: { pluginId: 'acme.accounts', localId: 'native' }, accountId: 'account-A' };
        await db.usageEvent.updateMany({ where: { accountId: account.id, sessionId: sessions[0]!.id },
            data: { turnId, metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true },
                usageAttribution: { v: 1, turnId, source: { kind: 'native', connectedAccount, accountScope: 'personal' } },
                providerId: 'happier.provider.openrouter/openrouter', providerConnectionId: 'legacy-connection',
                captureOrigin: { retained: true } } } });
        const query = compactQuery();
        await expectControl(account.id, query);
        expect((await expectControl(account.id, query)).capture.activitySummary?.stats)
            .toMatchObject({ eventsRead: 0, replayedSubjects: 0 });
        const sibling = UsageAnalyticsQueryRequestSchema.parse({ ...query, includeInsights: true });
        const queries = [sibling, query];
        const input = UsageAnalyticsQueryBatchRequestSchema.parse({ queries, includeContributions: false,
            contributionQueries: [sibling], sessionQueries: [query] });
        const batchRead = async (summary: boolean) => {
            const captured = await inReadSnapshot(tx => captureUsageAnalyticsBatchInTx(tx, account.id, queries,
                undefined, summary ? input : undefined));
            const projected = await projectUsageAnalyticsBatch(captured, queries, true, true, undefined, input);
            const delivery = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery(projected, input, false));
            return { captured, delivery, serialized: JSON.stringify(delivery) };
        };
        const coldControl = await batchRead(false);
        const cold = await batchRead(true);
        expectSameWire(cold.serialized, coldControl.serialized);
        expect(cold.captured.activitySummary).toBeUndefined();
        const known = cold.delivery.contributionPages?.flatMap(page => page.rows)
            .filter(row => row.sessionId === sessions[0]!.id);
        expect(known?.length).toBeGreaterThan(0);
        expect(known?.every(row => row.providerId === null && row.providerConnectionId === null),
            'captured native attribution replaces fallback Provider dimensions').toBe(true);
        expect(known?.every(row => row.providerAttribution === 'known' && row.providerSource === 'native'),
            'matching captured attribution stays known').toBe(true);
        expect(known?.every(row => row.connectedAccount && sameQualifiedConnectedAccountRef(row.connectedAccount, connectedAccount)),
            'captured Connected Account identity survives delivery').toBe(true);
        await writeRuntime(account.id, sessions[1]!.id, startMs + 4 * day, 11);
        const changedControl = await batchRead(false);
        const changed = await batchRead(true);
        expectSameWire(changed.serialized, changedControl.serialized);
        expect(changed.captured.activitySummary).toBeUndefined();
        expect(isDeepStrictEqual(changed.delivery.contributionPages?.flatMap(page => page.rows)
            .filter(row => row.sessionId === sessions[0]!.id), known)).toBe(true);
    });

    it('moves delayed duplicates to the earliest matching runtime order across a cached day boundary', async () => {
        const { account, sessions } = await seed();
        const externalKey = randomUUID();
        const request = (sequence: number, observedAt: number) => UsageEventIngestRequestSchema.parse({
            sessionId: sessions[0]!.id, externalKey, turnId: 'runtime-order-turn', observedAt,
            agentId: 'codex', source: 'codex-app-server-response-usage', scope: 'turn_delta', isCumulative: false,
            tokens: { input: 3, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
            metadata: { usageAccounting: { path: 'runtime', status: 'partial', asOfMs: observedAt,
                runtimeEventOrder: { runtimeIncarnationId: 'runtime-A', sequence } } },
        });
        const first = await recordUsageEvent(account.id, request(4, startMs + 4 * day + 1));
        expect(first).toMatchObject({ ok: true });
        const query = compactQuery();
        const before = await expectControl(account.id, query);
        expect(total(before)).toBe(18);
        expect(await recordUsageEvent(account.id, request(2, startMs + 4 * day - 1))).toEqual(first);
        const corrected = await expectControl(account.id, query);
        expect(corrected.serialized === before.serialized).toBe(false);
        expect(total(corrected)).toBe(18);
        expect(corrected.capture.activitySummary?.stats).toMatchObject({ eventsRead: 4, discoveryEventsRead: 2,
            historyEventsRead: 2, replayedSubjects: 1, replayedEvents: 3 });
        const warm = await expectControl(account.id, query);
        expect(warm.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0 });
    });

    it('ignores Team-only admission changes and admits a source only when it becomes personal usage', async () => {
        const { account, sessions } = await seed();
        const query = compactQuery();
        const original = await expectControl(account.id, query);
        const excluded = await Promise.all(TEAM_CREDENTIAL_ONLY_USAGE_SOURCES.map((source, index) =>
            db.usageEvent.create({ data: { accountId: account.id, sessionId: sessions[0]!.id,
                observedAt: new Date(startMs + (4 + index) * day), agentId: 'codex', source, scope: 'turn_delta',
                requestCount: 1, inputTokens: 900, totalTokens: 900 } })));
        const ignored = await expectControl(account.id, query);
        expectSameWire(ignored.serialized, original.serialized);
        expect(ignored.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0 });
        await db.usageEvent.updateMany({ where: { accountId: account.id, id: { in: excluded.map(row => row.id) } },
            data: { inputTokens: 1000, totalTokens: 1000, requestCount: 2 } });
        const changedAdmission = await expectControl(account.id, query);
        expectSameWire(changedAdmission.serialized, original.serialized);
        expect(changedAdmission.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0 });
        await db.usageEvent.update({ where: { id: excluded[0]!.id }, data: { source: 'runtime' } });
        const personal = await expectControl(account.id, query);
        expect(total(personal)).toBe(1015);
        expect(personal.capture.activitySummary?.stats).toMatchObject({ eventsRead: 3, discoveryEventsRead: 1,
            historyEventsRead: 2, replayedSubjects: 1, replayedEvents: 3 });
        await db.usageEvent.update({ where: { id: excluded[0]!.id }, data: { source: TEAM_CREDENTIAL_ONLY_USAGE_SOURCES[0] } });
        const excludedAgain = await expectControl(account.id, query);
        expectSameWire(excludedAgain.serialized, original.serialized);
        expect(excludedAgain.capture.activitySummary?.stats).toMatchObject({ eventsRead: 2, discoveryEventsRead: 0,
            historyEventsRead: 2, replayedSubjects: 1, replayedEvents: 2 });
    });

    it('replays a native cumulative subject when settlement corrects only its counter epoch', async () => {
        const { account } = await seed();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
        const subject = { kind: 'native', machineId: machine.id,
            agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, sourceRootKey: 'epoch-root', nativeSessionKey: 'epoch-native' };
        const request = (index: number, amount: number, counterEpoch: string) => UsageEventIngestRequestSchema.parse({
            subject, externalKey: `epoch-${index}`, observedAt: startMs + (4 + index) * day,
            agentId: 'codex', source: 'codex-native', scope: 'session_cumulative', isCumulative: true,
            tokens: { input: amount, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: amount },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
            accounting: { status: 'available', historyComplete: true, counterEpoch },
        });
        expect(await recordUsageEvent(account.id, request(0, 100, 'epoch-A'))).toMatchObject({ ok: true });
        const second = await recordUsageEvent(account.id, request(1, 120, 'epoch-A'));
        expect(second).toMatchObject({ ok: true });
        const query = compactQuery();
        expect(total(await expectControl(account.id, query))).toBe(135);
        expect(await recordUsageEvent(account.id, request(1, 120, 'epoch-B'))).toEqual(second);
        const corrected = await expectControl(account.id, query);
        expect(total(corrected)).toBe(235);
        expect(corrected.capture.activitySummary?.stats).toMatchObject({ eventsRead: 2, discoveryEventsRead: 1,
            historyEventsRead: 1, replayedSubjects: 1, replayedEvents: 2 });
        const warm = await expectControl(account.id, query);
        expect(warm.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0 });
    });

    it('uses the refreshed model price catalog on a warm activity cache without replaying subjects', async () => {
        const { account, sessions } = await seed();
        process.env.HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED = 'true';
        await db.usageEvent.create({ data: { accountId: account.id, sessionId: sessions[0]!.id,
            observedAt: new Date(startMs + 4 * day), agentId: 'codex', modelId: 'summary-priced-model',
            source: 'runtime', scope: 'turn_delta', inputTokens: 1_000_000, totalTokens: 1_000_000,
            reportedCostUsd: 9, estimatedCostUsd: 7, costSource: 'provider_reported' } });
        const catalog = (inputUsdPerMillion: number) => JSON.stringify({ v: 1,
            models: { 'summary-priced-model': { inputUsdPerMillion, outputUsdPerMillion: 4 } },
            provenance: { source: 'litellm', origin: 'fetched', asOfMs: 1000,
                revision: 'summary-catalog', fetchStatus: 'ready' } });
        await db.simpleCache.create({ data: { key: USAGE_MODEL_PRICE_CACHE_KEY, value: catalog(2) } });
        const query = UsageAnalyticsQueryRequestSchema.parse({ ...compactQuery(), costMode: 'api_equivalent' });
        const before = await expectControl(account.id, query);
        await db.simpleCache.update({ where: { key: USAGE_MODEL_PRICE_CACHE_KEY }, data: { value: catalog(3) } });
        const repriced = await expectControl(account.id, query);
        expect(repriced.serialized === before.serialized).toBe(false);
        expect(repriced.capture.activitySummary?.stats).toMatchObject({ eventsRead: 0, replayedSubjects: 0, replayedEvents: 0 });
        const result = repriced.delivery.results[0];
        if (!result || !('value' in result)) throw new Error('Expected repriced compact activity result');
        expect(result.value.totals.cost).toMatchObject({ reportedUsd: 9, estimatedUsd: 7 });
    });

    it.each([{ sessionQueries: undefined }, { sessionQueries: [] }])(
        'keeps the incumbent delivery shape when Session membership is not requested (%j)', async ({ sessionQueries }) => {
        const { account } = await seed();
        const query = compactQuery();
        const input = UsageAnalyticsQueryBatchRequestSchema.parse({ queries: [query], includeContributions: false,
            contributionQueries: [], sessionQueries });
        const batchRead = async (withDemand: boolean) => {
            const captured = await inReadSnapshot(tx => captureUsageAnalyticsBatchInTx(tx, account.id, [query],
                undefined, withDemand ? input : undefined));
            const projected = await projectUsageAnalyticsBatch(captured, [query], true, true, undefined, input);
            return { captured, serialized: JSON.stringify(collectUsageAnalyticsBatchDelivery(
                projectUsageAnalyticsBatchDelivery(projected, input, false))) };
        };
        const control = await batchRead(false);
        for (let index = 0; index < 2; index++) {
            const actual = await batchRead(true);
            expectSameWire(actual.serialized, control.serialized);
            expect(actual.captured.activitySummary).toBeUndefined();
        }
        expect(await db.usageAccountingProjection.count({ where: { accountId: account.id } })).toBe(0);
    });
});
