import { z } from "zod";
import { type Fastify } from "../../types";
import { db } from "@/storage/db";
import { eventRouter } from "@/app/events/eventRouter";

function normalizeClientServerUrl(raw: unknown): string | null {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) return null;
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString().replace(/\/+$/, "");
    } catch {
        return null;
    }
}

export function pushRoutes(app: Fastify) {
    
    // Push Token Registration API
    app.post('/v1/push-tokens', {
        schema: {
            body: z.object({
                token: z.string(),
                clientServerUrl: z.string().optional(),
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                500: z.object({
                    error: z.literal('Failed to register push token')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { token } = request.body;
        const rawClientServerUrl = (request.body as any)?.clientServerUrl;
        const clientServerUrl =
            rawClientServerUrl === undefined ? undefined : normalizeClientServerUrl(rawClientServerUrl);

        try {
            const update: Record<string, unknown> = {
                updatedAt: new Date(),
            };
            if (clientServerUrl !== undefined) {
                update.clientServerUrl = clientServerUrl;
            }

            await db.accountPushToken.upsert({
                where: {
                    accountId_token: {
                        accountId: userId,
                        token: token
                    }
                },
                update,
                create: {
                    accountId: userId,
                    token: token,
                    clientServerUrl: clientServerUrl ?? null,
                }
            });

            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to register push token' });
        }
    });

    // Delete Push Token API
    app.delete('/v1/push-tokens/:token', {
        schema: {
            params: z.object({
                token: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                500: z.object({
                    error: z.literal('Failed to delete push token')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { token } = request.params;

        try {
            await db.accountPushToken.deleteMany({
                where: {
                    accountId: userId,
                    token: token
                }
            });

            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to delete push token' });
        }
    });

    // Get Push Tokens API
    app.get('/v1/push-tokens', {
        schema: {
            querystring: z.object({
                suppressIfUIActive: z.enum(['0', '1']).optional(),
            }),
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const query = (request.query ?? {}) as { suppressIfUIActive?: string };

        // When requested, suppress push tokens if the user has an active UI connection (browser/app).
        if (query.suppressIfUIActive === '1' && await eventRouter.hasUserScopedConnections(userId)) {
            return reply.send({ tokens: [], suppressedByActiveUI: true });
        }

        try {
            const tokens = await db.accountPushToken.findMany({
                where: {
                    accountId: userId
                },
                orderBy: {
                    createdAt: 'desc'
                }
            });

            return reply.send({
                tokens: tokens.map(t => ({
                    id: t.id,
                    token: t.token,
                    createdAt: t.createdAt.getTime(),
                    updatedAt: t.updatedAt.getTime(),
                    clientServerUrl: t.clientServerUrl ?? null,
                }))
            });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to get push tokens' });
        }
    });
}
