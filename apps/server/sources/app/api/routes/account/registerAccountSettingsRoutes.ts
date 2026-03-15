import { z } from "zod";
import { db } from "@/storage/db";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { log } from "@/utils/logging/log";
import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { type Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    AccountSettingsV2GetResponseSchema,
    AccountSettingsV2UpdateRequestSchema,
    AccountSettingsV2UpdateResponseSchema,
    type AccountSettingsStoredContentEnvelope,
} from "@happier-dev/protocol";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { openPlainAccountSettingsDbValue, storePlainAccountSettingsDbValue } from "@/app/encryption/accountSettingsStorage";

export function registerAccountSettingsRoutes(app: Fastify): void {
    // Get Account Settings API
    app.get('/v1/account/settings', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            response: {
                200: z.object({
                    settings: z.string().nullable(),
                    settingsVersion: z.number()
                }),
                400: z.object({ error: z.literal("plain_account_requires_settings_v2") }),
                500: z.object({
                    error: z.literal('Failed to get account settings')
                })
            }
        }
    }, async (request, reply) => {
        try {
            const user = await db.account.findUnique({
                where: { id: request.userId },
                select: { settings: true, settingsVersion: true, publicKey: true, encryptionMode: true }
            });

            if (!user) {
                return reply.code(500).send({ error: 'Failed to get account settings' });
            }

            const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(user);
            if (mode === "plain") {
                return reply.code(400).send({ error: "plain_account_requires_settings_v2" });
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
                400: z.object({ error: z.literal("plain_account_requires_settings_v2") }),
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
                    select: { settings: true, settingsVersion: true, publicKey: true, encryptionMode: true }
                });

                if (!currentUser) {
                    return { type: 'internal-error' as const };
                }

                const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(currentUser);
                if (mode === "plain") {
                    return { type: "plain-requires-v2" as const };
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

            if (result.type === "plain-requires-v2") {
                return reply.code(400).send({ error: "plain_account_requires_settings_v2" });
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

    // V2 envelope-aware settings API for plaintext accounts and keyless flows.
    app.get("/v2/account/settings", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            response: {
                200: AccountSettingsV2GetResponseSchema,
                500: z.object({ error: z.literal("internal") }),
            },
        },
    }, async (request, reply) => {
        try {
            const user = await db.account.findUnique({
                where: { id: request.userId },
                select: { settings: true, settingsVersion: true, publicKey: true, encryptionMode: true },
            });
            if (!user) return reply.code(500).send({ error: "internal" });

            const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(user);
            if (mode === "e2ee") {
                return reply.send({
                    content: user.settings ? { t: "encrypted", c: user.settings } : null,
                    version: user.settingsVersion,
                });
            }

            const opened = openPlainAccountSettingsDbValue({ accountId: request.userId, dbValue: user.settings });
            return reply.send({
                content: opened,
                version: user.settingsVersion,
            });
        } catch {
            return reply.code(500).send({ error: "internal" });
        }
    });

    app.post("/v2/account/settings", {
        preHandler: app.authenticate,
        schema: {
            body: AccountSettingsV2UpdateRequestSchema,
            response: {
                200: AccountSettingsV2UpdateResponseSchema,
                400: z.object({ error: z.literal("invalid-params") }),
                500: z.object({ error: z.literal("internal") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { content, expectedVersion } = request.body;

        try {
            const result = await inTx(async (tx) => {
                const currentUser = await tx.account.findUnique({
                    where: { id: userId },
                    select: { settings: true, settingsVersion: true, publicKey: true, encryptionMode: true },
                });
                if (!currentUser) return { type: "internal-error" as const };

                const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(currentUser);
                if (mode === "plain") {
                    if (content && content.t !== "plain") {
                        return { type: "invalid-params" as const };
                    }
                } else {
                    if (content && content.t !== "encrypted") {
                        return { type: "invalid-params" as const };
                    }
                }

                const currentContent: AccountSettingsStoredContentEnvelope | null =
                    mode === "plain"
                        ? openPlainAccountSettingsDbValue({ accountId: userId, dbValue: currentUser.settings })
                        : currentUser.settings
                            ? { t: "encrypted", c: currentUser.settings }
                            : null;

                if (currentUser.settingsVersion !== expectedVersion) {
                    return {
                        type: "version-mismatch" as const,
                        currentVersion: currentUser.settingsVersion,
                        currentContent,
                    };
                }

                const nextSettingsDbValue =
                    mode === "plain"
                        ? storePlainAccountSettingsDbValue({ accountId: userId, content: content })
                        : (content?.t === "encrypted" ? content.c : null);

                const { count } = await tx.account.updateMany({
                    where: { id: userId, settingsVersion: expectedVersion },
                    data: {
                        settings: nextSettingsDbValue,
                        settingsVersion: expectedVersion + 1,
                        updatedAt: new Date(),
                    },
                });
                if (count === 0) {
                    const account = await tx.account.findUnique({
                        where: { id: userId },
                        select: { settings: true, settingsVersion: true, publicKey: true, encryptionMode: true },
                    });
                    const refreshedMode = account ? resolveEffectiveAccountEncryptionModeFromAccountRow(account) : mode;
                    const refreshedContent: AccountSettingsStoredContentEnvelope | null =
                        refreshedMode === "plain"
                            ? openPlainAccountSettingsDbValue({ accountId: userId, dbValue: account?.settings ?? null })
                            : account?.settings
                                ? { t: "encrypted", c: account.settings }
                                : null;
                    return {
                        type: "version-mismatch" as const,
                        currentVersion: account?.settingsVersion ?? 0,
                        currentContent: refreshedContent,
                    };
                }

                const cursor = await markAccountChanged(tx, {
                    accountId: userId,
                    kind: "account",
                    entityId: "self",
                    hint: { settingsVersion: expectedVersion + 1 },
                });

                afterTx(tx, () => {
                    const updatePayload = buildUpdateAccountUpdate(
                        userId,
                        { settingsV2: { content: content ?? null, version: expectedVersion + 1 } },
                        cursor,
                        randomKeyNaked(12),
                    );
                    eventRouter.emitUpdate({
                        userId,
                        payload: updatePayload,
                        recipientFilter: { type: "user-scoped-only" },
                    });
                });

                return { type: "success" as const, version: expectedVersion + 1 };
            });

            if (result.type === "internal-error") return reply.code(500).send({ error: "internal" });
            if (result.type === "invalid-params") return reply.code(400).send({ error: "invalid-params" });
            if (result.type === "version-mismatch") {
                return reply.send({
                    success: false,
                    error: "version-mismatch",
                    currentVersion: result.currentVersion,
                    currentContent: result.currentContent ?? null,
                });
            }
            return reply.send({ success: true, version: result.version });
        } catch (error) {
            log({ module: "api", level: "error" }, `Failed to update v2 account settings: ${error}`);
            return reply.code(500).send({ error: "internal" });
        }
    });
}
