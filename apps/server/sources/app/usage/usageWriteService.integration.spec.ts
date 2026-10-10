import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eventRouter } from "@/app/events/eventRouter";
import { register } from "@/app/monitoring/metrics/registry";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { recordLegacyUsageReport, recordUsageEvent } from "./usageWriteService";
import { UsageEventIngestRequestSchema, UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol';
import type { UsageAnalyticsQueryRequest } from '@happier-dev/protocol';
import { EphemeralUpdateSchema } from '@happier-dev/protocol/updates';
import { queryUsageAnalytics } from './usageQueryService';

// Only process-external event delivery is stubbed; payload builders remain real.
vi.mock("@/app/events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    vi.spyOn(actual.eventRouter, "emitEphemeral").mockImplementation(() => {});
    return actual;
});
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

type MetricSample = {
    labels: Record<string, string>;
    value: number;
};

async function readMetricSamples(name: string): Promise<MetricSample[]> {
    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((entry) => entry.name === name);
    if (!metric) return [];
    return metric.values.map((value) => ({
        labels: Object.fromEntries(
            Object.entries(value.labels ?? {}).map(([key, labelValue]) => [key, String(labelValue)]),
        ),
        value: Number(value.value),
    }));
}

describe("usageWriteService", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-usage-write-", initAuth: false });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        register.resetMetrics();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.usageEvent.deleteMany(),
            () => db.usageReport.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it('admits owned native subjects and isolates replay keys across native sessions and roots', async () => {
        const account = await db.account.create({ data: { publicKey: 'native-account' } });
        const other = await db.account.create({ data: { publicKey: 'native-other' } });
        await db.machine.create({ data: { id: 'native-machine', accountId: account.id, metadata: 'ciphertext' } });
        const input = {
            subject: { kind: 'native', machineId: 'native-machine', agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, sourceRootKey: 'root-1', nativeSessionKey: 'native-1' },
            observedAt: 10, agentId: 'codex', source: 'codex-native', scope: 'turn_delta', externalKey: 'inference-1', isCumulative: false,
            tokens: { input: 12, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
            accounting: { status: 'partial', historyComplete: false, inferenceKey: 'shared-opaque-inference', inputIncludesCache: true, outputIncludesReasoning: true },
        };
        const request = UsageEventIngestRequestSchema.parse(input);
        const first = await recordUsageEvent(account.id, request);
        expect(first).toMatchObject({ ok: true });
        const wake = vi.mocked(eventRouter.emitEphemeral).mock.calls.at(-1)?.[0];
        expect(wake).toMatchObject({ userId: account.id, recipientFilter: { type: 'user-scoped-only' }, payload: { type: 'usage', id: null } });
        expect(EphemeralUpdateSchema.safeParse(wake?.payload).success).toBe(true);
        expect(await recordUsageEvent(account.id, request)).toEqual(first);
        expect(await recordUsageEvent(other.id, request)).toEqual({ ok: false, error: 'machine-not-found' });
        expect(await recordUsageEvent(account.id, UsageEventIngestRequestSchema.parse({ ...input, subject: { ...input.subject, nativeSessionKey: 'native-2' } }))).toMatchObject({ ok: true });
        expect(await recordUsageEvent(account.id, UsageEventIngestRequestSchema.parse({ ...input, subject: { ...input.subject, sourceRootKey: 'root-2' } }))).toMatchObject({ ok: true });
        const rows = await db.usageEvent.findMany({ where: { accountId: account.id } });
        expect(rows).toHaveLength(3);
        expect(rows.every((row) => row.sessionId === null && row.machineId === 'native-machine')).toBe(true);
        expect(rows[0]?.metadata).toMatchObject({ accountingSubject: input.subject, captureOrigin: 'native', usageAccounting: { path: 'native', status: 'partial', historyComplete: false, inferenceId: 'shared-opaque-inference', inputIncludesCache: true, outputIncludesReasoning: true } });
        const settled = await recordUsageEvent(account.id, UsageEventIngestRequestSchema.parse({
            ...input, tokens: { ...input.tokens, input: 20, total: 20 }, cost: { ...input.cost, reportedUsd: 0.5 },
            accounting: { ...input.accounting, status: 'available' },
        }));
        expect(settled).toEqual(first);
        expect(await db.usageEvent.count({ where: { accountId: account.id } })).toBe(3);
        expect(await db.usageEvent.findUnique({ where: { id: first.ok ? first.event.id : '' } })).toMatchObject({
            totalTokens: 20, reportedCostUsd: 0.5, metadata: { captureOrigin: 'native', usageAccounting: { status: 'available' } },
        });
        expect(await db.session.count()).toBe(0);
    });

    it('keeps native replay identity without inventing an inference witness', async () => {
        const account = await db.account.create({ data: { publicKey: 'native-replay-only-account' } });
        await db.machine.create({ data: { id: 'native-replay-only-machine', accountId: account.id, metadata: 'ciphertext' } });
        const request = UsageEventIngestRequestSchema.parse({
            subject: { kind: 'native', machineId: 'native-replay-only-machine', agent: { pluginId: 'happier.agent.claude', localId: 'claude' },
                sourceRootKey: 'opaque-root', nativeSessionKey: 'opaque-native-session' },
            observedAt: 10, agentId: 'claude', source: 'claude-native', scope: 'turn_delta', externalKey: 'opaque-record-replay', isCumulative: false,
            tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' }, accounting: { status: 'partial', historyComplete: false },
        });
        const first = await recordUsageEvent(account.id, request);
        expect(first).toMatchObject({ ok: true });
        expect(await recordUsageEvent(account.id, request)).toEqual(first);
        const rows = await db.usageEvent.findMany({ where: { accountId: account.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ externalKey: 'opaque-record-replay', sessionId: null, totalTokens: 12,
            metadata: { accountingSubject: request.subject, captureOrigin: 'native', usageAccounting: { status: 'partial', historyComplete: false } } });
        const accounting = Reflect.get(rows[0].metadata ?? {}, 'usageAccounting');
        expect(accounting).not.toHaveProperty('inferenceId');
    });

    it('reconciles Session runtime and null-Session native replay before Account, Session and dimension filtering', async () => {
        const account = await db.account.create({ data: { publicKey: 'runtime-native-query-account' } });
        const otherAccount = await db.account.create({ data: { publicKey: 'runtime-native-other-account' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'runtime-native-query-session', encryptionMode: 'e2ee', metadata: 'ciphertext' } });
        await db.machine.createMany({ data: ['runtime-native-machine', 'runtime-native-other-machine'].map((id) => ({ id, accountId: account.id, metadata: 'ciphertext' })) });
        const subject = { kind: 'native', machineId: 'runtime-native-machine', agent: { pluginId: 'happier.agent.claude', localId: 'claude' }, sourceRootKey: 'opaque-root', nativeSessionKey: 'opaque-native-session' };
        const observation = {
            observedAt: Date.parse('2026-07-01T10:00:00Z'), agentId: 'claude', modelId: 'A', scope: 'turn_delta', isCumulative: false,
            tokens: { input: 30, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
            cost: { reportedUsd: 0, estimatedUsd: 0.3, currency: 'USD', costSource: 'pricing_estimate' },
        };
        const runtime = await recordUsageEvent(account.id, UsageEventIngestRequestSchema.parse({
            ...observation, sessionId: session.id, source: 'runtime', externalKey: 'runtime-one',
            metadata: { accountingSubject: subject, usageAccounting: { inferenceId: 'opaque-inference-one', path: 'runtime', status: 'available' } },
        }));
        const replay = UsageEventIngestRequestSchema.parse({ ...observation, subject, source: 'claude-native', externalKey: 'native-one', accounting: { inferenceKey: 'opaque-inference-one', status: 'available' } });
        const native = await recordUsageEvent(account.id, replay);
        expect(runtime.ok && native.ok).toBe(true);
        const rows = await db.usageEvent.findMany({ where: { accountId: account.id } });
        expect(rows.map((row) => row.sessionId).sort()).toEqual([null, session.id].sort());
        const query = (filters: UsageAnalyticsQueryRequest['filters'] = {}) => queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({ filters, granularity: 'day', includeSeries: true, breakdowns: ['session', 'model', 'machine', 'source'] }));
        for (const filters of [{}, { sessionIds: [session.id] }, { sources: ['runtime'] }, { modelIds: ['A'] }]) {
            const result = await query(filters);
            expect(result.totals.tokens.total).toBe(30);
            expect(result.totals.cost.estimatedUsd).toBeCloseTo(0.3);
            expect(result.series?.map((bucket) => bucket.tokens.total)).toEqual([30]);
            expect(result.breakdowns?.session?.map((entry) => [entry.key, entry.tokens.total])).toEqual([[session.id, 30]]);
        }
        expect((await query({ sources: ['claude-native'] })).totals.tokens.total).toBe(0);
        expect((await queryUsageAnalytics(otherAccount.id, UsageAnalyticsQueryRequestSchema.parse({}))).totals.tokens.total).toBe(0);

        for (const extra of [
            { subject: { ...subject, sourceRootKey: 'other-root' }, modelId: 'A', total: 40, inference: 'opaque-inference-one' },
            { subject: { ...subject, machineId: 'runtime-native-other-machine' }, modelId: 'A', total: 50, inference: 'opaque-inference-one' },
            { subject, modelId: 'B', total: 20, inference: 'opaque-inference-two' },
        ]) {
            expect(await recordUsageEvent(account.id, UsageEventIngestRequestSchema.parse({
                ...observation, subject: extra.subject, source: 'claude-native', externalKey: extra.inference, modelId: extra.modelId,
                tokens: { ...observation.tokens, input: extra.total, total: extra.total }, cost: { ...observation.cost, estimatedUsd: extra.total / 100 },
                accounting: { inferenceKey: extra.inference, status: 'available' },
            }))).toMatchObject({ ok: true });
        }
        expect((await query()).totals.tokens.total).toBe(140);
        expect((await query({ sources: ['claude-native'] })).totals.tokens.total).toBe(110);
        expect((await query({ modelIds: ['A'] })).totals.tokens.total).toBe(120);
        expect((await query({ modelIds: ['B'] })).totals.tokens.total).toBe(20);
        expect((await query({ machineIds: ['runtime-native-machine'] })).totals.tokens.total).toBe(90);
        expect((await query({ machineIds: ['runtime-native-other-machine'] })).totals.tokens.total).toBe(50);
        expect((await query({ sessionIds: [session.id] })).totals.tokens.total).toBe(30);
        expect((await query({ sessionIds: [session.id], sources: ['claude-native'] })).totals.tokens.total).toBe(0);

        // A replay disagreement must remain visible even on Session/model/source
        // reads; filtering the evidence first would silently hide it.
        expect(await recordUsageEvent(account.id, UsageEventIngestRequestSchema.parse({ ...replay, modelId: 'B', tokens: { ...observation.tokens, input: 35, total: 35 } }))).toEqual(native);
        for (const filters of [{}, { sessionIds: [session.id] }, { sessionIds: [session.id], sources: ['runtime'], modelIds: ['A'] }]) {
            const result = await query(filters);
            expect(result.coverage?.reasons).toContain('ambiguous_overlap');
            expect(result.breakdowns?.session?.find((entry) => entry.key === session.id)?.tokens.total).toBe(30);
        }
    });

    it("does not rewrite or re-emit unchanged session legacy usage reports", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-unchanged" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-service-unchanged",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        const first = await recordLegacyUsageReport({
            accountId: account.id,
            key: "legacy-unchanged",
            sessionId: session.id,
            tokens: { total: 12, input: 7, output: 5 },
            cost: { total: 0.12 },
        });
        const duplicate = await recordLegacyUsageReport({
            accountId: account.id,
            key: "legacy-unchanged",
            sessionId: session.id,
            tokens: { total: 12, input: 7, output: 5 },
            cost: { total: 0.12 },
        });

        expect(first).toMatchObject({ ok: true, changed: true, usageEventId: expect.any(String) });
        expect(duplicate).toMatchObject({
            ok: true,
            changed: false,
            usageEventId: null,
            report: first.ok ? first.report : expect.anything(),
        });

        expect(await db.usageReport.count({ where: { accountId: account.id } })).toBe(1);
        expect(await db.usageEvent.count({ where: { accountId: account.id } })).toBe(1);
        expect(eventRouter.emitEphemeral).toHaveBeenCalledTimes(1);
        const wake = vi.mocked(eventRouter.emitEphemeral).mock.calls[0]?.[0];
        expect(EphemeralUpdateSchema.parse(wake?.payload)).toMatchObject({ type: 'usage', id: session.id });

        expect(await readMetricSamples("usage_report_writes_total")).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    labels: { scope: "session", result: "created" },
                    value: 1,
                }),
                expect.objectContaining({
                    labels: { scope: "session", result: "unchanged" },
                    value: 1,
                }),
            ]),
        );
    });

    it("writes sessionless legacy usage reports into the append-only ledger", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-sessionless" },
            select: { id: true },
        });

        const result = await recordLegacyUsageReport({
            accountId: account.id,
            key: "legacy-sessionless",
            sessionId: null,
            tokens: { total: 7, input: 4, output: 3 },
            cost: { total: 0.07 },
        });

        expect(result).toMatchObject({
            ok: true,
            usageEventId: expect.any(String),
        });

        const stored = await db.usageEvent.findMany({
            where: { accountId: account.id },
            select: {
                sessionId: true,
                source: true,
                agentId: true,
                totalTokens: true,
                inputTokens: true,
                outputTokens: true,
                reportedCostUsd: true,
            },
        });
        expect(stored).toEqual([
            {
                sessionId: null,
                source: "legacy_usage_report",
                agentId: "legacy",
                totalTokens: 7,
                inputTokens: 4,
                outputTokens: 3,
                reportedCostUsd: 0.07,
            },
        ]);
    });

    it("preserves legacy evidence while the canonical resolver removes native overlap", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-native-dedup" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-service-native-dedup",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                active: true,
            },
            select: { id: true },
        });
        await db.usageEvent.create({
            data: {
                accountId: account.id,
                sessionId: session.id,
                observedAt: new Date(),
                agentId: "codex",
                source: "codex_app_server",
                scope: "turn_delta",
                isCumulative: false,
                totalTokens: 9,
            },
        });

        const result = await recordLegacyUsageReport({
            accountId: account.id,
            key: "legacy-native-dedup",
            sessionId: session.id,
            tokens: { total: 9 },
            cost: { total: 0.09 },
        });

        expect(result).toMatchObject({ ok: true, changed: true, usageEventId: expect.any(String) });
        expect((await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({
            filters: { sessionIds: [session.id] },
        }))).totals.tokens.total).toBe(9);
        // Removing the native witness must not reveal a hole in retained evidence.
        await db.usageEvent.deleteMany({ where: { accountId: account.id, source: "codex_app_server" } });
        expect((await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({
            filters: { sessionIds: [session.id] },
        }))).totals.tokens.total).toBe(9);
    });

    it("canonicalizes duplicate account-level legacy usage reports before writing the next delta", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-account-dedup" },
            select: { id: true },
        });
        await db.usageReport.create({
            data: {
                accountId: account.id,
                sessionId: null,
                key: "legacy-account-total",
                data: { tokens: { total: 1, input: 1 }, cost: { total: 0.01 } },
            },
        });
        await db.usageReport.create({
            data: {
                accountId: account.id,
                sessionId: null,
                key: "legacy-account-total",
                data: { tokens: { total: 2, input: 2 }, cost: { total: 0.02 } },
            },
        });

        const retained = await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({ granularity: 'day' }));
        expect(retained.totals.tokens.total).toBe(2);
        expect(retained.costFacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'reported', amountUsd: expect.closeTo(0.02) })]));

        const result = await recordLegacyUsageReport({
            accountId: account.id,
            key: "legacy-account-total",
            sessionId: null,
            tokens: { total: 7, input: 7 },
            cost: { total: 0.07 },
        });

        expect(result).toMatchObject({ ok: true, changed: true, usageEventId: expect.any(String) });
        await expect(db.usageReport.findMany({
            where: {
                accountId: account.id,
                sessionId: null,
                key: "legacy-account-total",
            },
            select: { sessionId: true, data: true },
        })).resolves.toEqual([
            {
                sessionId: null,
                data: { tokens: { total: 7, input: 7 }, cost: { total: 0.07 } },
            },
        ]);
        const events = await db.usageEvent.findMany({
            where: { accountId: account.id, source: "legacy_usage_report" },
            select: { sessionId: true, totalTokens: true, inputTokens: true, reportedCostUsd: true },
        });
        expect(events).toHaveLength(2);
        expect(events).toEqual(expect.arrayContaining([
            {
                sessionId: null,
                totalTokens: 2,
                inputTokens: 2,
                reportedCostUsd: 0.02,
            },
            {
                sessionId: null,
                totalTokens: 5,
                inputTokens: 5,
                reportedCostUsd: 0.05,
            },
        ]));
        const query = await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({ granularity: 'day' }));
        expect(query.totals.tokens.total).toBe(7);
        expect(query.costFacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'reported', amountUsd: expect.closeTo(0.07) })]));
    });

    it("deduplicates append-only usage events by session, source, and external key", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-dedupe" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-service-dedupe",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        const first = await recordUsageEvent(account.id, {
            sessionId: session.id,
            observedAt: 1_714_000_000_000,
            agentId: "claude",
            backendMode: "remote",
            modelId: "claude-sonnet",
            projectKey: null,
            workspaceId: null,
            machineId: null,
            source: "claude_sdk",
            scope: "turn_delta",
            externalKey: "vendor-turn-1",
            turnId: "turn-1",
            isCumulative: false,
            tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
            cost: { reportedUsd: 0.11, estimatedUsd: 0, currency: "USD" },
            context: { usedTokens: 12, windowTokens: 200000 },
        });
        const second = await recordUsageEvent(account.id, {
            sessionId: session.id,
            observedAt: 1_714_000_001_000,
            agentId: "claude",
            backendMode: "remote",
            modelId: "claude-sonnet",
            projectKey: null,
            workspaceId: null,
            machineId: null,
            source: "claude_sdk",
            scope: "turn_delta",
            externalKey: "vendor-turn-1",
            turnId: "turn-1",
            isCumulative: false,
            tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
            cost: { reportedUsd: 0.11, estimatedUsd: 0, currency: "USD" },
            context: { usedTokens: 12, windowTokens: 200000 },
        });

        expect(first).toMatchObject({ ok: true });
        expect(second).toMatchObject({ ok: true });
        if (!first.ok || !second.ok) {
            throw new Error("Expected usage events to be accepted");
        }

        expect(second.event.id).toBe(first.event.id);
        expect(await db.usageEvent.count({ where: { accountId: account.id } })).toBe(1);
        expect(await db.usageEvent.findUnique({ where: { id: first.event.id }, select: { observedAt: true } })).toEqual({
            observedAt: new Date(1_714_000_000_000),
        });
    });

    it("persists a bounded stable idempotency key for external-keyed usage events", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-idempotency-key" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-service-idempotency-key",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        const externalKey = `vendor-turn-2-${"x".repeat(512)}`;
        const result = await recordUsageEvent(account.id, {
            sessionId: session.id,
            observedAt: 1_714_000_010_000,
            agentId: "codex",
            backendMode: "appServer",
            modelId: "gpt-5-codex",
            projectKey: null,
            workspaceId: null,
            machineId: null,
            source: "token_count",
            scope: "session_cumulative",
            externalKey,
            turnId: "turn-2",
            isCumulative: true,
            tokens: { input: 10, output: 5, reasoning: 1, cacheRead: 0, cacheWrite: 0, total: 16 },
            cost: { reportedUsd: 0.11, estimatedUsd: 0.09, currency: "USD" },
            context: { usedTokens: 16, windowTokens: 200000 },
        });

        expect(result).toMatchObject({ ok: true });

        const rows = await db.$queryRaw<Array<{ idempotencyKey: string | null }>>`
            SELECT "idempotencyKey"
            FROM "UsageEvent"
            WHERE "accountId" = ${account.id}
              AND "sessionId" = ${session.id}
              AND "source" = ${"token_count"}
              AND "externalKey" = ${externalKey}
        `;

        expect(rows).toHaveLength(1);
        expect(rows[0]?.idempotencyKey).toBeTruthy();
        expect(rows[0]?.idempotencyKey?.length ?? 0).toBeLessThanOrEqual(191);
        expect(rows[0]?.idempotencyKey).not.toContain(externalKey);
    });

    it("treats retries against legacy raw idempotency rows as duplicates during rollout", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-legacy-idempotency" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-service-legacy-idempotency",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        const externalKey = "vendor-turn-legacy";
        const legacyIdempotencyKey = JSON.stringify([account.id, session.id, "claude_sdk", externalKey]);
        const legacyRow = await db.usageEvent.create({
            data: {
                accountId: account.id,
                sessionId: session.id,
                observedAt: new Date(1_714_000_020_000),
                agentId: "claude",
                backendMode: "remote",
                modelId: "claude-sonnet",
                projectKey: null,
                workspaceId: null,
                machineId: null,
                source: "claude_sdk",
                scope: "turn_delta",
                externalKey,
                idempotencyKey: legacyIdempotencyKey,
                turnId: "turn-legacy",
                isCumulative: false,
                inputTokens: 8,
                outputTokens: 4,
                reasoningTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 12,
                reportedCostUsd: 0.11,
                estimatedCostUsd: 0,
                invoiceCostUsd: 0,
                billingContext: null,
                costSource: null,
                currency: "USD",
                contextUsedTokens: 12,
                contextWindowTokens: 200000,
                metadata: null,
            },
            select: { id: true, idempotencyKey: true },
        });

        const retried = await recordUsageEvent(account.id, {
            sessionId: session.id,
            observedAt: 1_714_000_021_000,
            agentId: "claude",
            backendMode: "remote",
            modelId: "claude-sonnet",
            projectKey: null,
            workspaceId: null,
            machineId: null,
            source: "claude_sdk",
            scope: "turn_delta",
            externalKey,
            turnId: "turn-legacy",
            isCumulative: false,
            tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
            cost: { reportedUsd: 0.11, estimatedUsd: 0, currency: "USD" },
            context: { usedTokens: 12, windowTokens: 200000 },
        });

        expect(retried).toMatchObject({ ok: true });
        if (!retried.ok) {
            throw new Error("Expected usage event retry to be accepted");
        }

        expect(retried.event.id).toBe(legacyRow.id);
        expect(await db.usageEvent.count({ where: { accountId: account.id } })).toBe(1);
    });

    it("persists invoice, billing context, and cost source on usage events", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-cost-metadata" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-service-cost-metadata",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        const result = await recordUsageEvent(account.id, {
            sessionId: session.id,
            observedAt: 1_714_000_000_000,
            agentId: "claude",
            backendMode: "remote",
            modelId: "claude-sonnet",
            projectKey: null,
            workspaceId: null,
            machineId: null,
            source: "claude-sdk-result",
            scope: "session_final",
            externalKey: "sdk-result-1",
            turnId: null,
            isCumulative: true,
            tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
            cost: {
                reportedUsd: 0.11,
                estimatedUsd: 0.09,
                invoiceUsd: 0.08,
                billingContext: "api_usage",
                costSource: "provider_reported",
                currency: "USD",
            },
            context: { usedTokens: 12, windowTokens: 200000 },
        });

        expect(result).toMatchObject({ ok: true });

        const stored = await db.usageEvent.findFirst({
            where: {
                accountId: account.id,
                sessionId: session.id,
                source: "claude-sdk-result",
                externalKey: "sdk-result-1",
            },
            select: {
                reportedCostUsd: true,
                estimatedCostUsd: true,
                invoiceCostUsd: true,
                billingContext: true,
                costSource: true,
            },
        });

        expect(stored).toEqual({
            reportedCostUsd: 0.11,
            estimatedCostUsd: 0.09,
            invoiceCostUsd: 0.08,
            billingContext: "api_usage",
            costSource: "provider_reported",
        });
    });
});
