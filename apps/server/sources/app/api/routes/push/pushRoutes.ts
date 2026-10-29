import { z } from "zod/mini";
import { PushNotificationTestResultSchema } from '@happier-dev/protocol/push/pushNotificationTest';
import { sendAccountExpoPushMessages } from '@/app/activity/accountPushTransport';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { type Fastify } from "../../types";
import { db, getActivePrismaRuntime } from "@/storage/db";
import { eventRouter } from '@/app/events/eventRouter';
import { shouldMuteMobileAlertsForComputerFocus } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';
import { PushTokenRegisterRequestSchema } from '@happier-dev/protocol/push/pushTokenRegistration';
import { DeviceRemoteAlertPolicyV1Schema, resolveAccountRemoteAlertPolicyCurrentness } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';
import { redactSentryLogAttributes } from "@/app/monitoring/sentryLogRedaction";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

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
    // Deliberate plumbing check: exact Account registration, fixed payload, ordinary
    // Home push transport. It changes no alert policy or enrollment state.
    app.post('/v1/push-tokens/:tokenId/test', {
        schema: { params: z.strictObject({ tokenId: z.string().check(z.minLength(1)) }),
            body: z.strictObject({}), response: { 200: PushNotificationTestResultSchema } },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const registration = await db.accountPushToken.findFirst({
            where: { id: request.params.tokenId, accountId: request.userId },
            select: { token: true, clientServerUrl: true },
        });
        if (!registration) return reply.send({ status: 'not_registered' as const });
        const serverId = await getOrCreateServerIdentityId();
        const result = await sendAccountExpoPushMessages([{
            accountId: request.userId, token: registration.token,
            message: { to: registration.token, title: 'Happier notification test',
                body: 'This is a remote push test requested from notification settings.',
                sound: 'default', priority: 'high', data: {
                    url: '/settings/notifications', serverId, accountId: request.userId,
                    ...(registration.clientServerUrl ? { serverUrl: registration.clientServerUrl } : {}),
                } },
        }], 'push-diagnostics');
        return reply.send({ status: result.acceptedCount === 1 && result.failedCount === 0 ? 'accepted' as const
            : result.invalidCredentials ? 'invalid_credentials' as const : 'rejected' as const });
    });
    
    // Push Token Registration API
    app.post('/v1/push-tokens', {
        schema: {
            body: PushTokenRegisterRequestSchema,
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({ error: z.literal('push_token_not_found') }),
                500: z.object({
                    error: z.literal('Failed to register push token')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const userId = request.userId;
        const { token } = request.body;
        const rawClientServerUrl = request.body.clientServerUrl;
        const clientServerUrl =
            rawClientServerUrl === undefined ? undefined : normalizeClientServerUrl(rawClientServerUrl);

        try {
            const update: Record<string, unknown> = {
                updatedAt: new Date(),
            };
            if (clientServerUrl !== undefined) {
                update.clientServerUrl = clientServerUrl;
            }

            if (request.body.remoteAlerts !== undefined) {
                if (!isServerFeatureEnabledForRequest("sessions.following", requestHomeEnv)) {
                    return reply.code(404).send({ error: 'push_token_not_found' });
                }
                const result = await db.accountPushToken.updateMany({
                    where: { accountId: userId, token, id: request.body.remoteAlerts.registrationId },
                    data: {
                        ...update,
                        remoteAlerts: request.body.remoteAlerts.policy === null
                            ? getActivePrismaRuntime().DbNull
                            : request.body.remoteAlerts.policy,
                    },
                });
                if (result.count === 0) return reply.code(404).send({ error: 'push_token_not_found' });
                return reply.send({ success: true });
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
        schema: { querystring: z.object({ projectionVersion: z.optional(z.coerce.number().check(z.int())), suppressIfComputerFocused: z.optional(z.enum(['0', '1'])) }) },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const userId = request.userId;

        if (request.query.suppressIfComputerFocused === '1' && shouldMuteMobileAlertsForComputerFocus({
            mutePhoneWhenComputerFocused: true,
            computerFocused: await eventRouter.hasFocusedComputerUi(userId),
        })) return reply.send({ tokens: [], suppressedByFocusedComputer: true });

        try {
            const tokens = await db.accountPushToken.findMany({
                where: {
                    accountId: userId
                },
                orderBy: {
                    createdAt: 'desc'
                }
            });

            const projection = request.query.projectionVersion === 2
                && isServerFeatureEnabledForRequest("sessions.following", requestHomeEnv);
            const account = projection ? await db.account.findUniqueOrThrow({
                where: { id: userId }, select: { settingsVersion: true, remoteAlertPolicy: true },
            }) : null;
            return reply.send({
                ...(account ? { v: 2, accountRemoteAlerts: {
                    settingsVersion: account.settingsVersion,
                    status: resolveAccountRemoteAlertPolicyCurrentness(account.remoteAlertPolicy, account.settingsVersion).status,
                } } : {}),
                tokens: tokens.map(t => ({
                    id: t.id,
                    token: t.token,
                    createdAt: t.createdAt.getTime(),
                    updatedAt: t.updatedAt.getTime(),
                    clientServerUrl: t.clientServerUrl ?? null,
                    ...(projection ? { remoteAlerts: DeviceRemoteAlertPolicyV1Schema.safeParse(t.remoteAlerts).data ?? null } : {}),
                }))
            });
        } catch (error) {
            app.log.error({ err: error, userId }, 'Failed to get push tokens');
            return reply.code(500).send({ error: 'Failed to get push tokens' });
        }
    });
}
