import { buildUpdateAccountUpdate, buildUsageEphemeral, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { Fastify } from "../types";
import { getPublicUrl } from "@/storage/files";
import { z } from "zod";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { log } from "@/utils/log";
import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { Context } from "@/context";
import { UsernameTakenError, usernameUpdate } from "@/app/social/usernameUpdate";
import { resolveFriendsPolicyFromEnv } from "@/app/social/friendsPolicy";
import { validateUsername } from "@/app/social/usernamePolicy";
import { fetchLinkedProvidersForAccount } from "@/app/auth/providers/linkedProviders";
import { findIdentityProviderById } from "@/app/auth/providers/identityProviders/registry";

export function accountRoutes(app: Fastify) {
    app.get('/v1/account/profile', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const user = await db.account.findUniqueOrThrow({
            where: { id: userId },
            select: {
                firstName: true,
                lastName: true,
                username: true,
                avatar: true,
            }
        });
        const connectedVendors = new Set((await db.serviceAccountToken.findMany({ where: { accountId: userId } })).map(t => t.vendor));
        const linkedProviders = await fetchLinkedProvidersForAccount({ tx: db as any, accountId: userId });
        return reply.send({
            id: userId,
            timestamp: Date.now(),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            avatar: user.avatar ? { ...user.avatar, url: getPublicUrl(user.avatar.path) } : null,
            linkedProviders,
            connectedServices: Array.from(connectedVendors)
        });
    });

    app.patch('/v1/account/identity/:provider', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ provider: z.string() }),
            body: z.object({ showOnProfile: z.boolean() }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.object({ error: z.enum(['unsupported-provider', 'not-connected']) }),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findIdentityProviderById(process.env, providerId);
        if (!provider) return reply.code(404).send({ error: 'unsupported-provider' });

        const result = await inTx(async (tx) => {
            const { count } = await tx.accountIdentity.updateMany({
                where: { accountId: request.userId, provider: providerId },
                data: { showOnProfile: request.body.showOnProfile },
            });

            if (count === 0) {
                return { type: "not-connected" as const };
            }

            const linkedProviders = await fetchLinkedProvidersForAccount({ tx: tx as any, accountId: request.userId });
            const cursor = await markAccountChanged(tx, {
                accountId: request.userId,
                kind: "account",
                entityId: "self",
                hint: { linkedProviders: true },
            });

            afterTx(tx, () => {
                const updatePayload = buildUpdateAccountUpdate(
                    request.userId,
                    { linkedProviders },
                    cursor,
                    randomKeyNaked(12),
                );
                eventRouter.emitUpdate({
                    userId: request.userId,
                    payload: updatePayload,
                    recipientFilter: { type: "user-scoped-only" },
                });
            });

            return { type: "ok" as const };
        });

        if (result.type === "not-connected") {
            return reply.code(404).send({ error: "not-connected" });
        }

        return reply.send({ success: true });
    });

    app.post('/v1/account/username', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                username: z.string(),
            }),
            response: {
                200: z.object({ username: z.string() }),
                400: z.object({ error: z.enum(['invalid-username', 'username-disabled', 'friends-disabled']) }),
                409: z.object({ error: z.literal('username-taken') }),
            },
        },
    }, async (request, reply) => {
        const friendsPolicy = resolveFriendsPolicyFromEnv(process.env);
        if (!friendsPolicy.enabled) {
            return reply.code(400).send({ error: 'friends-disabled' });
        }
        if (!friendsPolicy.allowUsername) {
            if (!friendsPolicy.requiredIdentityProviderId) {
                return reply.code(400).send({ error: 'username-disabled' });
            }
            const current = await db.account.findUnique({
                where: { id: request.userId },
                select: {
                    AccountIdentity: {
                        where: { provider: friendsPolicy.requiredIdentityProviderId },
                        select: { id: true },
                        take: 1,
                    },
                },
            });
            if (!current || current.AccountIdentity.length === 0) {
                return reply.code(400).send({ error: 'username-disabled' });
            }
        }

        const validation = validateUsername(request.body.username, process.env);
        if (!validation.ok) {
            return reply.code(400).send({ error: 'invalid-username' });
        }
        const username = validation.username;

        // Fast pre-check for friendlier errors; rely on unique index as final arbiter.
        const existing = await db.account.findFirst({
            where: {
                username,
                NOT: { id: request.userId },
            },
            select: { id: true },
        });
        if (existing) {
            return reply.code(409).send({ error: 'username-taken' });
        }

        try {
            await usernameUpdate(Context.create(request.userId), username);
        } catch (e) {
            if (e instanceof UsernameTakenError) {
                return reply.code(409).send({ error: 'username-taken' });
            }
            throw e;
        }

        return reply.send({ username });
    });

    // Get Account Settings API
    app.get('/v1/account/settings', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    settings: z.string().nullable(),
                    settingsVersion: z.number()
                }),
                500: z.object({
                    error: z.literal('Failed to get account settings')
                })
            }
        }
    }, async (request, reply) => {
        try {
            const user = await db.account.findUnique({
                where: { id: request.userId },
                select: { settings: true, settingsVersion: true }
            });

            if (!user) {
                return reply.code(500).send({ error: 'Failed to get account settings' });
            }

            return reply.send({
                settings: user.settings,
                settingsVersion: user.settingsVersion
            });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to get account settings' });
        }
    });

    // Update Account Settings API
    app.post('/v1/account/settings', {
        schema: {
            body: z.object({
                settings: z.string().nullable(),
                expectedVersion: z.number().int().min(0)
            }),
            response: {
                200: z.union([z.object({
                    success: z.literal(true),
                    version: z.number()
                }), z.object({
                    success: z.literal(false),
                    error: z.literal('version-mismatch'),
                    currentVersion: z.number(),
                    currentSettings: z.string().nullable()
                })]),
                500: z.object({
                    success: z.literal(false),
                    error: z.literal('Failed to update account settings')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { settings, expectedVersion } = request.body;

        try {
            const result = await inTx(async (tx) => {
                const currentUser = await tx.account.findUnique({
                    where: { id: userId },
                    select: { settings: true, settingsVersion: true }
                });

                if (!currentUser) {
                    return { type: 'internal-error' as const };
                }

                if (currentUser.settingsVersion !== expectedVersion) {
                    return {
                        type: 'version-mismatch' as const,
                        currentVersion: currentUser.settingsVersion,
                        currentSettings: currentUser.settings
                    };
                }

                const { count } = await tx.account.updateMany({
                    where: {
                        id: userId,
                        settingsVersion: expectedVersion
                    },
                    data: {
                        settings: settings,
                        settingsVersion: expectedVersion + 1,
                        updatedAt: new Date()
                    }
                });

                if (count === 0) {
                    const account = await tx.account.findUnique({
                        where: { id: userId },
                        select: { settings: true, settingsVersion: true }
                    });
                    return {
                        type: 'version-mismatch' as const,
                        currentVersion: account?.settingsVersion || 0,
                        currentSettings: account?.settings || null
                    };
                }

                const settingsUpdate = {
                    value: settings,
                    version: expectedVersion + 1
                };

                const cursor = await markAccountChanged(tx, { accountId: userId, kind: 'account', entityId: 'self', hint: { settingsVersion: expectedVersion + 1 } });

                afterTx(tx, () => {
                    const updatePayload = buildUpdateAccountUpdate(userId, { settings: settingsUpdate }, cursor, randomKeyNaked(12));
                    eventRouter.emitUpdate({
                        userId,
                        payload: updatePayload,
                        recipientFilter: { type: 'user-scoped-only' }
                    });
                });

                return { type: 'success' as const, version: expectedVersion + 1 };
            });

            if (result.type === 'internal-error') {
                return reply.code(500).send({
                    success: false,
                    error: 'Failed to update account settings'
                });
            }

            if (result.type === 'version-mismatch') {
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: result.currentVersion,
                    currentSettings: result.currentSettings
                });
            }

            return reply.send({
                success: true,
                version: result.version
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to update account settings: ${error}`);
            return reply.code(500).send({
                success: false,
                error: 'Failed to update account settings'
            });
        }
    });

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
