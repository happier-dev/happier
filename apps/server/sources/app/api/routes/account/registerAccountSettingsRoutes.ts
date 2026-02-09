import { z } from "zod";
import { db } from "@/storage/db";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { log } from "@/utils/logging/log";
import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { type Fastify } from "../../types";

export function registerAccountSettingsRoutes(app: Fastify): void {
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
}
