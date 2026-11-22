import { z } from "zod";
import { type Fastify } from "../../types";
import { eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { redactSentryLogAttributes } from "@/app/monitoring/sentryLogRedaction";

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
                androidActionPresentationV1: z.boolean().optional(),
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
        const { token, clientServerUrl: rawClientServerUrl } = request.body;
        const androidActionPresentationV1 = request.body.androidActionPresentationV1 === true;
        const clientServerUrl =
            rawClientServerUrl === undefined ? undefined : normalizeClientServerUrl(rawClientServerUrl);

        try {
            const update = {
                updatedAt: new Date(),
                androidActionPresentationV1,
                ...(clientServerUrl === undefined ? {} : { clientServerUrl }),
            };

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
                    androidActionPresentationV1,
                }
            });

            return reply.send({ success: true });
        } catch (error) {
            app.log.error({ err: error, userId }, 'Failed to register push token');
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
            app.log.error(redactSentryLogAttributes({ err: error, userId, token }), 'Failed to delete push token');
            return reply.code(500).send({ error: 'Failed to delete push token' });
        }
    });

    // Get Push Tokens API
    app.get('/v1/push-tokens', {
        schema: { querystring: z.object({ suppressIfComputerFocused: z.enum(['0', '1']).optional() }) },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;

        if (request.query.suppressIfComputerFocused === '1' && await eventRouter.hasFocusedComputerUi(userId)) {
            return reply.send({ tokens: [], suppressedByFocusedComputer: true });
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
                    ...(t.androidActionPresentationV1 ? { androidActionPresentationV1: true } : {}),
                }))
            });
        } catch (error) {
            app.log.error({ err: error, userId }, 'Failed to get push tokens');
            return reply.code(500).send({ error: 'Failed to get push tokens' });
        }
    });
}
