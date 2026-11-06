import { getUsageAnalyticsQueryRequestKey, UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryBatchResponseSchema, UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema, UsageEventIngestRequestSchema, UsageNativeHistoryDeleteRequestSchema, type UsageAnalyticsQueryBatchRequest, type UsageAnalyticsQueryBatchResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { FastifyReply } from 'fastify';
import { UsageModelPriceCatalogSchema } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { z } from "zod/mini";
import { inReadSnapshot, type Tx } from "@/storage/inTx";
import { readDatabaseErrorCode } from "@/storage/transactionErrors";
import { log } from "@/utils/logging/log";
import { captureUsageAnalyticsInTx, projectUsageAnalytics } from "@/app/usage/usageQueryService";
import { recordLegacyUsageReport, recordUsageEvent, deleteNativeUsageHistory } from "@/app/usage/usageWriteService";
import { LegacyUsageReportRouteBodySchema } from "@/app/usage/legacyUsageReportSchema";
import { type Fastify } from "../../types";
import { accountUsageRoutePaths } from "./accountUsageRoutePaths";
import { readUsageModelPriceCatalog, refreshUsageModelPriceCatalog } from '@/app/usage/usageModelPriceCatalog';
import { readCurrentSessionIdsInTx } from '@/app/session/access/sessionReadAdmission';
import { readSessionAccessAuthenticationFromRequest, type SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { isServerFeatureEnabledForHome } from '@/app/features/catalog/serverFeatureGate';
import { captureUsageAnalyticsBatchInTx, projectUsageAnalyticsBatch } from '@/app/usage/query/readUsageAnalyticsBatch';
import { Readable } from 'node:stream';
import { collectUsageAnalyticsBatchDelivery, encodeUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery,
    readUsageContributionEncoding, readUsageContributionProjection } from '@happier-dev/protocol/usage/usageCost';
import { UsageQueryTiming } from '@/app/usage/query/usageQueryTiming';

const batchTimings = new WeakMap<object, UsageQueryTiming>();

const LegacyUsageReportRouteResponseSchema = z.object({
    success: z.literal(true),
    reportId: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

const UsageEventIngestRouteResponseSchema = z.object({
    success: z.literal(true),
    eventId: z.string(),
    createdAt: z.number(),
});

async function ensureReadableSessionIds(tx: Tx, accountId: string, sessionIds: readonly string[],
    authentication: SessionAccessAuthentication): Promise<boolean> {
    const requested = [...new Set(sessionIds)];
    const readable = await readCurrentSessionIdsInTx(tx, { accountId, sessionIds: requested, authentication });
    return readable.size === requested.length;
}

export function registerAccountUsageRoutes(app: Fastify): void {
    app.get(accountUsageRoutePaths.prices, {
        schema: { response: { 200: UsageModelPriceCatalogSchema } },
        preHandler: app.authenticate,
    }, async (_request, reply) => reply.send(await readUsageModelPriceCatalog()));

    app.post(accountUsageRoutePaths.pricesRefresh, {
        schema: { body: z.strictObject({}), response: { 200: UsageModelPriceCatalogSchema } },
        preHandler: app.authenticate,
    }, async (_request, reply) => reply.send(await refreshUsageModelPriceCatalog()));

    app.post(accountUsageRoutePaths.legacyQuery, {
        schema: {
            body: z.object({
                sessionId: z.nullish(z.string()),
                startTime: z.nullish(z.number().check(z.int(), z.positive())),
                endTime: z.nullish(z.number().check(z.int(), z.positive())),
                groupBy: z.nullish(z.enum(['hour', 'day'])),
            }),
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, startTime, endTime, groupBy } = request.body;
        const actualGroupBy = groupBy || 'day';

        try {
            const query = UsageAnalyticsQueryRequestSchema.parse({
                granularity: actualGroupBy, includeSeries: true,
                filters: sessionId ? { sessionIds: [sessionId] } : undefined,
                dateRange: startTime || endTime ? {
                    ...(startTime ? { startMs: startTime * 1000 } : {}),
                    // v1's retained millisecond instant is inclusive; v2 ranges are half-open.
                    ...(endTime ? { endMs: endTime * 1000 + 1 } : {}),
                } : undefined,
            });
            const snapshot = await inReadSnapshot(async tx => {
                if (sessionId) {
                    if (!await ensureReadableSessionIds(tx, userId, [sessionId], readSessionAccessAuthenticationFromRequest(request))) {
                        return null;
                    }
                }
                return captureUsageAnalyticsInTx(tx, userId, query, () => reply.raw.destroyed);
            });
            if (reply.raw.destroyed) { reply.hijack(); return; }
            if (!snapshot) return reply.code(404).send({ error: 'Session not found' });
            const result = projectUsageAnalytics(snapshot, query);
            return reply.send({
                usage: (result.series ?? []).map((bucket) => ({
                    timestamp: Math.floor(bucket.bucketStartMs / 1000), tokens: bucket.tokens,
                    cost: bucket.cost.effectiveUsd === undefined ? {} : { total: bucket.cost.effectiveUsd },
                    reportCount: bucket.eventCount,
                })),
                groupBy: actualGroupBy,
                totalReports: result.totals.eventCount,
            });
        } catch (error) {
            if (reply.raw.destroyed) { reply.hijack(); return; }
            if (readDatabaseErrorCode(error)) throw error;
            log({ module: 'api', level: 'error' }, `Failed to query usage reports: ${error}`);
            return reply.code(500).send({ error: 'Failed to query usage reports' });
        }
    });

    app.post(accountUsageRoutePaths.analyticsQuery, {
        schema: {
            body: UsageAnalyticsQueryRequestSchema,
            response: {
                200: UsageAnalyticsQueryResponseSchema,
                404: z.object({ error: z.enum(['Session not found', 'not_found']) }),
                500: z.object({ error: z.literal('Failed to query usage analytics') }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            if (request.body.population === 'public_eligible_personal'
                && !await isServerFeatureEnabledForHome('account.publicProfiles', { request })) {
                return reply.code(404).send({ error: 'not_found' });
            }
            const snapshot = await inReadSnapshot(async tx => {
                if (request.body.filters?.sessionIds?.length) {
                    const isReadable = await ensureReadableSessionIds(tx, request.userId, request.body.filters.sessionIds,
                        readSessionAccessAuthenticationFromRequest(request));
                    if (!isReadable) {
                        return null;
                    }
                }

                return captureUsageAnalyticsInTx(tx, request.userId, request.body, () => reply.raw.destroyed);
            });
            if (reply.raw.destroyed) { reply.hijack(); return; }
            if (!snapshot) return reply.code(404).send({ error: 'Session not found' });
            return reply.send(projectUsageAnalytics(snapshot, request.body));
        } catch (error) {
            if (reply.raw.destroyed) { reply.hijack(); return; }
            if (readDatabaseErrorCode(error)) throw error;
            log({ module: 'api', level: 'error' }, `Failed to query usage analytics: ${error}`);
            return reply.code(500).send({ error: 'Failed to query usage analytics' });
        }
    });

    app.post<{
        Body: UsageAnalyticsQueryBatchRequest;
        Reply: UsageAnalyticsQueryBatchResponse | ReturnType<FastifyReply['serialize']> | Readable;
    }>(accountUsageRoutePaths.analyticsQueryBatch, {
        schema: { body: UsageAnalyticsQueryBatchRequestSchema, response: { 200: UsageAnalyticsQueryBatchResponseSchema } },
        onRequest: async request => { batchTimings.set(request, new UsageQueryTiming()); },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const timing = batchTimings.get(request)!;
        const queries = [...new Map(request.body.queries.map(query => [getUsageAnalyticsQueryRequestKey(query), query])).values()];
        const publicEnabled = queries.some(query => query.population === 'public_eligible_personal')
            ? await isServerFeatureEnabledForHome('account.publicProfiles', { request }) : false;
        const captured = await inReadSnapshot(async tx => {
            const sessionIds = [...new Set(queries.flatMap(query => query.filters?.sessionIds ?? []))];
            const readable = sessionIds.length ? await readCurrentSessionIdsInTx(tx, { accountId: request.userId,
                sessionIds, authentication: readSessionAccessAuthenticationFromRequest(request) }) : new Set<string>();
            const admitted = queries.filter(query => (query.population !== 'public_eligible_personal' || publicEnabled)
                && (query.filters?.sessionIds ?? []).every(id => readable.has(id)));
            const readStart = performance.now();
            try {
                return { admitted, snapshot: admitted.length ? await captureUsageAnalyticsBatchInTx(tx, request.userId, admitted,
                    () => reply.raw.destroyed) : undefined };
            } finally { timing.durations.read += performance.now() - readStart; }
        }).catch(error => {
            if (reply.raw.destroyed) { reply.hijack(); return null; }
            throw error;
        });
        if (!captured) return;
        // Authentication, validation, feature/session admission and transaction acquisition/commit.
        timing.durations.auth = performance.now() - timing.startedAt - timing.durations.read;
        if (reply.raw.destroyed) { reply.hijack(); return; }
        const projected = captured.snapshot ? await projectUsageAnalyticsBatch(captured.snapshot, captured.admitted,
            request.body.includeContributions || request.body.contributionQueries !== undefined,
            request.body.contributionQueries !== undefined, timing) : undefined;
        if (reply.raw.destroyed) { reply.hijack(); return; }
        const results = new Map(projected?.results.map(result => [getUsageAnalyticsQueryRequestKey(result.query), result]));
        const batch = { v: 1 as const, ...(projected?.priceCatalog ? { priceCatalog: projected.priceCatalog } : {}),
            results: queries.map(query => results.get(getUsageAnalyticsQueryRequestKey(query)) ?? { query, error: 'not_found' as const }) };
        const sendJson = (value: typeof batch) => {
            const serialized = timing.measure('serialize', () => reply.serialize(value));
            return reply.header('Server-Timing', timing.header()).type('application/json').send(serialized);
        };
        const sendLines = (chunks: Iterable<typeof batch>) => {
            // All facts are already projected. Encode each line once before sending
            // headers so Server-Timing includes serialization rather than a zero placeholder.
            const dictionary = readUsageContributionEncoding(request.headers.accept);
            const lines = timing.measure('serialize', () => Array.from(chunks, chunk =>
                JSON.stringify(dictionary ? encodeUsageAnalyticsBatchDelivery(chunk) : chunk) + '\n'));
            return reply.header('Server-Timing', timing.header()).type('application/x-ndjson').send(Readable.from(lines));
        };
        if (request.body.contributionQueries !== undefined) {
            const streaming = request.headers.accept?.includes('application/x-ndjson') === true;
            const chunks = projectUsageAnalyticsBatchDelivery(batch, request.body, streaming,
                readUsageContributionProjection(request.headers.accept));
            return streaming ? sendLines(chunks) : sendJson(timing.measure('project', () => collectUsageAnalyticsBatchDelivery(chunks)));
        }
        if (request.headers.accept?.includes('application/x-ndjson')) {
            // Each line is the same closed response schema. The shared catalog
            // is delivered once before per-query facts, not copied per slice.
            return sendLines((function* () {
                yield { v: 1 as const, ...(batch.priceCatalog ? { priceCatalog: batch.priceCatalog } : {}), results: [] };
                for (const result of batch.results) yield { v: 1 as const, results: [result] };
            })());
        }
        return sendJson(batch);
    });

    app.post(accountUsageRoutePaths.analyticsEventsIngest, {
        config: {
            restrictedCredentialBinding: {
                scope: "session",
                session: "body.sessionId",
                machine: "body.machineId",
                machineOptional: true,
            },
        },
        schema: {
            body: UsageEventIngestRequestSchema,
            response: {
                200: UsageEventIngestRouteResponseSchema,
                400: z.object({ error: z.enum(['Invalid parameters', 'Native Session link not found']) }),
                404: z.object({ error: z.enum(['Session not found', 'Machine not found']) }),
                500: z.object({ error: z.literal('Failed to save usage event') }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const result = await recordUsageEvent(request.userId, request.body);
            if (!result.ok) {
                if (result.error === 'invalid-params' || result.error === 'native-link-not-found') return reply.code(400).send({ error: result.error === 'native-link-not-found' ? 'Native Session link not found' : 'Invalid parameters' });
                return reply.code(404).send({ error: result.error === 'machine-not-found' ? 'Machine not found' : 'Session not found' });
            }
            return reply.send({
                success: true,
                eventId: result.event.id,
                createdAt: result.event.createdAt.getTime(),
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to save usage event: ${error}`);
            return reply.code(500).send({ error: 'Failed to save usage event' });
        }
    });

    app.post(accountUsageRoutePaths.nativeHistoryDelete, {
        schema: {
            body: UsageNativeHistoryDeleteRequestSchema,
            response: {
                200: z.object({ success: z.literal(true), deletedEventCount: z.number().check(z.int(), z.minimum(0)) }),
                404: z.object({ error: z.literal('Machine not found') }),
                500: z.object({ error: z.literal('Failed to delete native usage history') }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const result = await deleteNativeUsageHistory(request.userId, request.body);
            if (!result.ok) return reply.code(404).send({ error: 'Machine not found' });
            return reply.send({ success: true, deletedEventCount: result.deletedEventCount });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to delete native usage history: ${error}`);
            return reply.code(500).send({ error: 'Failed to delete native usage history' });
        }
    });

    app.post(accountUsageRoutePaths.legacyReportsIngest, {
        schema: {
            body: LegacyUsageReportRouteBodySchema,
            response: {
                200: LegacyUsageReportRouteResponseSchema,
                400: z.object({ error: z.literal('Invalid parameters') }),
                404: z.object({ error: z.literal('Session not found') }),
                500: z.object({ error: z.literal('Failed to save usage report') }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const result = await recordLegacyUsageReport({
                accountId: request.userId,
                key: request.body.key,
                sessionId: request.body.sessionId,
                tokens: request.body.tokens,
                cost: request.body.cost,
            });

            if (!result.ok) {
                return reply.code(result.error === 'invalid-params' ? 400 : 404).send({
                    error: result.error === 'invalid-params' ? 'Invalid parameters' : 'Session not found',
                });
            }

            return reply.send({
                success: true,
                reportId: result.report.id,
                createdAt: result.report.createdAt.getTime(),
                updatedAt: result.report.updatedAt.getTime(),
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to save usage report: ${error}`);
            return reply.code(500).send({ error: 'Failed to save usage report' });
        }
    });
}
