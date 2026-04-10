import {
    UsageAnalyticsQueryRequestSchema,
    UsageAnalyticsQueryResponseSchema,
    UsageEventIngestRequestSchema,
} from "@happier-dev/protocol";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { queryUsageAnalytics } from "@/app/usage/usageQueryService";
import { recordLegacyUsageReport, recordUsageEvent } from "@/app/usage/usageWriteService";
import { type Fastify } from "../../types";

const LegacyUsageReportRouteBodySchema = z.object({
    key: z.string(),
    sessionId: z.string(),
    tokens: z.object({ total: z.number() }).catchall(z.number()),
    cost: z.object({ total: z.number() }).catchall(z.number()),
});

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

async function ensureOwnedSessionIds(accountId: string, sessionIds: readonly string[]): Promise<boolean> {
    if (sessionIds.length === 0) {
        return true;
    }

    const count = await db.session.count({
        where: {
            accountId,
            id: { in: [...sessionIds] },
        },
    });
    return count === sessionIds.length;
}

export function registerAccountUsageRoutes(app: Fastify): void {
    app.post('/v1/usage/query', {
        schema: {
            body: z.object({
                sessionId: z.string().nullish(),
                startTime: z.number().int().positive().nullish(),
                endTime: z.number().int().positive().nullish(),
                groupBy: z.enum(['hour', 'day']).nullish(),
            }),
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, startTime, endTime, groupBy } = request.body;
        const actualGroupBy = groupBy || 'day';

        try {
            const where: {
                accountId: string;
                sessionId?: string | null;
                createdAt?: {
                    gte?: Date;
                    lte?: Date;
                };
            } = {
                accountId: userId,
            };

            if (sessionId) {
                const session = await db.session.findFirst({
                    where: {
                        id: sessionId,
                        accountId: userId,
                    },
                    select: { id: true },
                });
                if (!session) {
                    return reply.code(404).send({ error: 'Session not found' });
                }
                where.sessionId = sessionId;
            }

            if (startTime || endTime) {
                where.createdAt = {};
                if (startTime) {
                    where.createdAt.gte = new Date(startTime * 1000);
                }
                if (endTime) {
                    where.createdAt.lte = new Date(endTime * 1000);
                }
            }

            const reports = await db.usageReport.findMany({
                where,
                orderBy: {
                    createdAt: 'desc',
                },
            });

            const aggregated = new Map<string, {
                tokens: Record<string, number>;
                cost: Record<string, number>;
                count: number;
                timestamp: number;
            }>();

            for (const report of reports) {
                const data = report.data as PrismaJson.UsageReportData;
                const date = new Date(report.createdAt);
                const timestamp = actualGroupBy === 'hour'
                    ? Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0).getTime() / 1000)
                    : Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).getTime() / 1000);

                const current = aggregated.get(String(timestamp)) ?? {
                    tokens: {},
                    cost: {},
                    count: 0,
                    timestamp,
                };
                current.count += 1;

                for (const [tokenKey, tokenValue] of Object.entries(data.tokens)) {
                    if (typeof tokenValue === 'number') {
                        current.tokens[tokenKey] = (current.tokens[tokenKey] || 0) + tokenValue;
                    }
                }

                for (const [costKey, costValue] of Object.entries(data.cost)) {
                    if (typeof costValue === 'number') {
                        current.cost[costKey] = (current.cost[costKey] || 0) + costValue;
                    }
                }

                aggregated.set(String(timestamp), current);
            }

            return reply.send({
                usage: Array.from(aggregated.values())
                    .map((entry) => ({
                        timestamp: entry.timestamp,
                        tokens: entry.tokens,
                        cost: entry.cost,
                        reportCount: entry.count,
                    }))
                    .sort((left, right) => left.timestamp - right.timestamp),
                groupBy: actualGroupBy,
                totalReports: reports.length,
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to query usage reports: ${error}`);
            return reply.code(500).send({ error: 'Failed to query usage reports' });
        }
    });

    app.post('/v2/usage/query', {
        schema: {
            body: UsageAnalyticsQueryRequestSchema,
            response: {
                200: UsageAnalyticsQueryResponseSchema,
                404: z.object({ error: z.literal('Session not found') }),
                500: z.object({ error: z.literal('Failed to query usage analytics') }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            if (request.body.filters?.sessionIds?.length) {
                const isOwned = await ensureOwnedSessionIds(request.userId, request.body.filters.sessionIds);
                if (!isOwned) {
                    return reply.code(404).send({ error: 'Session not found' });
                }
            }

            const response = await queryUsageAnalytics(request.userId, request.body);
            return reply.send(response);
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to query usage analytics: ${error}`);
            return reply.code(500).send({ error: 'Failed to query usage analytics' });
        }
    });

    app.post('/v2/usage-events', {
        schema: {
            body: UsageEventIngestRequestSchema,
            response: {
                200: UsageEventIngestRouteResponseSchema,
                404: z.object({ error: z.literal('Session not found') }),
                500: z.object({ error: z.literal('Failed to save usage event') }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const result = await recordUsageEvent(request.userId, request.body);
            if (!result.ok) {
                return reply.code(404).send({ error: 'Session not found' });
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

    app.post('/v2/usage-reports', {
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
