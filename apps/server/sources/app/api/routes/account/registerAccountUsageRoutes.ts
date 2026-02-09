import { z } from "zod";
import { db } from "@/storage/db";
import { buildUsageEphemeral, eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/logging/log";
import { type Fastify } from "../../types";

export function registerAccountUsageRoutes(app: Fastify): void {
    app.post('/v1/usage/query', {
        schema: {
            body: z.object({
                sessionId: z.string().nullish(),
                startTime: z.number().int().positive().nullish(),
                endTime: z.number().int().positive().nullish(),
                groupBy: z.enum(['hour', 'day']).nullish()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, startTime, endTime, groupBy } = request.body;
        const actualGroupBy = groupBy || 'day';

        try {
            // Build query conditions
            const where: {
                accountId: string;
                sessionId?: string | null;
                createdAt?: {
                    gte?: Date;
                    lte?: Date;
                };
            } = {
                accountId: userId
            };

            if (sessionId) {
                // Verify session belongs to user
                const session = await db.session.findFirst({
                    where: {
                        id: sessionId,
                        accountId: userId
                    }
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

            // Fetch usage reports
            const reports = await db.usageReport.findMany({
                where,
                orderBy: {
                    createdAt: 'desc'
                }
            });

            // Aggregate data by time period
            const aggregated = new Map<string, {
                tokens: Record<string, number>;
                cost: Record<string, number>;
                count: number;
                timestamp: number;
            }>();

            for (const report of reports) {
                const data = report.data as PrismaJson.UsageReportData;
                const date = new Date(report.createdAt);

                // Calculate timestamp based on groupBy
                let timestamp: number;
                if (actualGroupBy === 'hour') {
                    // Round down to hour
                    const hourDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0);
                    timestamp = Math.floor(hourDate.getTime() / 1000);
                } else {
                    // Round down to day
                    const dayDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
                    timestamp = Math.floor(dayDate.getTime() / 1000);
                }

                const key = timestamp.toString();

                if (!aggregated.has(key)) {
                    aggregated.set(key, {
                        tokens: {},
                        cost: {},
                        count: 0,
                        timestamp
                    });
                }

                const agg = aggregated.get(key)!;
                agg.count++;

                // Aggregate tokens
                for (const [tokenKey, tokenValue] of Object.entries(data.tokens)) {
                    if (typeof tokenValue === 'number') {
                        agg.tokens[tokenKey] = (agg.tokens[tokenKey] || 0) + tokenValue;
                    }
                }

                // Aggregate costs
                for (const [costKey, costValue] of Object.entries(data.cost)) {
                    if (typeof costValue === 'number') {
                        agg.cost[costKey] = (agg.cost[costKey] || 0) + costValue;
                    }
                }
            }

            // Convert to array and sort by timestamp
            const result = Array.from(aggregated.values())
                .map(data => ({
                    timestamp: data.timestamp,
                    tokens: data.tokens,
                    cost: data.cost,
                    reportCount: data.count
                }))
                .sort((a, b) => a.timestamp - b.timestamp);

            return reply.send({
                usage: result,
                groupBy: actualGroupBy,
                totalReports: reports.length
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to query usage reports: ${error}`);
            return reply.code(500).send({ error: 'Failed to query usage reports' });
        }
    });

    // V2 - Record usage reports (durable store + optional ephemeral hint)
    app.post('/v2/usage-reports', {
        schema: {
            body: z.object({
                key: z.string(),
                sessionId: z.string(),
                tokens: z.object({ total: z.number() }).catchall(z.number()),
                cost: z.object({ total: z.number() }).catchall(z.number()),
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    reportId: z.string(),
                    createdAt: z.number(),
                    updatedAt: z.number(),
                }),
                400: z.object({ error: z.literal('Invalid parameters') }),
                404: z.object({ error: z.literal('Session not found') }),
                500: z.object({ error: z.literal('Failed to save usage report') }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { key, sessionId, tokens, cost } = request.body;

        if (!key || typeof key !== 'string' || typeof tokens?.total !== 'number' || typeof cost?.total !== 'number') {
            return reply.code(400).send({ error: 'Invalid parameters' });
        }

        try {
            const session = await db.session.findFirst({
                where: { id: sessionId, accountId: userId },
                select: { id: true },
            });
            if (!session) {
                return reply.code(404).send({ error: 'Session not found' });
            }

            const usageData: PrismaJson.UsageReportData = { tokens, cost };
            const report = await db.usageReport.upsert({
                where: {
                    accountId_sessionId_key: {
                        accountId: userId,
                        sessionId,
                        key,
                    },
                },
                update: {
                    data: usageData,
                    updatedAt: new Date(),
                },
                create: {
                    accountId: userId,
                    sessionId,
                    key,
                    data: usageData,
                },
            });

            const usageEvent = buildUsageEphemeral(sessionId, key, usageData.tokens, usageData.cost);
            eventRouter.emitEphemeral({
                userId,
                payload: usageEvent,
                recipientFilter: { type: 'user-scoped-only' },
            });

            return reply.send({
                success: true,
                reportId: report.id,
                createdAt: report.createdAt.getTime(),
                updatedAt: report.updatedAt.getTime(),
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to save usage report: ${error}`);
            return reply.code(500).send({ error: 'Failed to save usage report' });
        }
    });
}
