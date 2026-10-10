import { z } from "zod";
import { log } from "@/utils/logging/log";
import { inTx } from "@/storage/inTx";
import { type Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    ACCOUNT_SETTINGS_V2_UPDATE_REQUEST_MAX_UTF8_BYTES,
    AccountSettingsV2GetResponseSchema,
    AccountSettingsV2UpdateRequestAdmissionSchema,
    AccountSettingsV2UpdateRequestSchema,
    AccountSettingsV2UpdateResponseSchema,
    AccountStoredContentUpgradeRequiredV1Schema,
} from "@happier-dev/protocol";
import {
    enforceProfilePreservingSettingsWriterCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { writeAccountSettingsInTx } from "@/app/accountSettings/writeAccountSettingsInTx";
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import { openPlainAccountSettingsDbValue } from "@/app/encryption/accountSettingsStorage";
import {
    AccountSettingsStorageUnavailableResponseSchema,
    resolveAccountSettingsStorageUnavailableRouteError,
} from "./accountSettingsStorageUnavailableRouteError";
import {
    PresentUserRequiredResponseSchema,
    requirePresentUser,
} from "@/app/api/utils/requirePresentUser";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

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
                503: AccountSettingsStorageUnavailableResponseSchema,
                500: z.object({
                    error: z.literal('Failed to get account settings')
                })
            }
        }
    }, async (request, reply) => {
        try {
            const user = await inTx(tx => tx.account.findUnique({
                where: { id: request.userId },
                select: {
                    settings: true,
                    settingsVersion: true,
                    publicKey: true,
                    encryptionMode: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                }
            }), { readOnly: true });

            if (!user) {
                return reply.code(500).send({ error: 'Failed to get account settings' });
            }

            const currentness =
                deriveAccountEncryptionCurrentnessFromRow(user);
            if (currentness.status === "inconsistent") {
                return reply.code(503).send({
                    error: "account_settings_storage_unavailable",
                });
            }
            const mode = currentness.currentness.encryptionMode;
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
        // The predecessor writer stores the same Account Settings document as
        // V2 does, so it inherits the canonical envelope ceiling instead of the
        // application-wide body limit. The V2 request form is the larger of the
        // two encodings for one ciphertext, so reusing it admits every
        // canonical V1 write and nothing beyond the stored document bound.
        // Reads stay permissive for values a predecessor already stored.
        bodyLimit: ACCOUNT_SETTINGS_V2_UPDATE_REQUEST_MAX_UTF8_BYTES,
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
                403: PresentUserRequiredResponseSchema,
                426: AccountStoredContentUpgradeRequiredV1Schema,
                503: AccountSettingsStorageUnavailableResponseSchema,
                500: z.object({
                    success: z.literal(false),
                    error: z.literal('Failed to update account settings')
                })
            }
        },
        preHandler: [app.authenticate, requirePresentUser]
    }, async (request, reply) => {
        if (!await enforceProfilePreservingSettingsWriterCompatibilityForHttpRequest(
            request,
            reply,
        )) return;

        const userId = request.userId;
        const { settings, expectedVersion } = request.body;

        try {
            const result = await inTx((tx) => writeAccountSettingsInTx({
                tx,
                accountId: userId,
                expectedVersion,
                next: { kind: "v1", settings },
            }));

            if (result.status === "account_not_found") {
                return reply.code(500).send({
                    success: false,
                    error: 'Failed to update account settings'
                });
            }

            if (result.status === "plain_requires_v2") {
                return reply.code(400).send({ error: "plain_account_requires_settings_v2" });
            }
            if (result.status === "storage_unavailable") {
                return reply.code(503).send({
                    error: "account_settings_storage_unavailable",
                });
            }

            if (result.status === "version_mismatch") {
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: result.currentVersion,
                    currentSettings: result.currentSettings
                });
            }

            if (result.status !== "success") {
                return reply.code(500).send({
                    success: false,
                    error: "Failed to update account settings",
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
                503: AccountSettingsStorageUnavailableResponseSchema,
                500: z.object({ error: z.literal("internal") }),
            },
        },
    }, async (request, reply) => {
        try {
            const user = await inTx(tx => tx.account.findUnique({
                where: { id: request.userId },
                select: {
                    settings: true,
                    settingsVersion: true,
                    publicKey: true,
                    encryptionMode: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                },
            }), { readOnly: true });
            if (!user) return reply.code(500).send({ error: "internal" });

            const currentness =
                deriveAccountEncryptionCurrentnessFromRow(user);
            if (currentness.status === "inconsistent") {
                return reply.code(503).send({
                    error: "account_settings_storage_unavailable",
                });
            }
            const mode = currentness.currentness.encryptionMode;
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
        } catch (error) {
            const storageUnavailable = resolveAccountSettingsStorageUnavailableRouteError(error);
            if (storageUnavailable) {
                return reply.code(storageUnavailable.statusCode).send(storageUnavailable.body);
            }
            return reply.code(500).send({ error: "internal" });
        }
    });

    app.post("/v2/account/settings", {
        bodyLimit: ACCOUNT_SETTINGS_V2_UPDATE_REQUEST_MAX_UTF8_BYTES,
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            body: AccountSettingsV2UpdateRequestAdmissionSchema,
            response: {
                200: AccountSettingsV2UpdateResponseSchema,
                400: z.object({ error: z.literal("invalid-params") }),
                403: PresentUserRequiredResponseSchema,
                426: AccountStoredContentUpgradeRequiredV1Schema,
                503: AccountSettingsStorageUnavailableResponseSchema,
                500: z.object({ error: z.literal("internal") }),
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        if (!await enforceProfilePreservingSettingsWriterCompatibilityForHttpRequest(
            request,
            reply,
        )) return;

        const userId = request.userId;
        const parsedRequest = AccountSettingsV2UpdateRequestSchema.safeParse(request.body);
        if (!parsedRequest.success) {
            return reply.send({ success: false, error: "invalid", reason: "tooLarge" });
        }
        const { content, expectedVersion, remoteAlertPolicy, expectedProfileTransferRevision } = parsedRequest.data;
        // Keep the Account document write available while Follow is off, but do
        // not refresh its server-readable remote-alert projection. Existing
        // rows remain compatibility-readable and become stale as the document
        // version advances; the delivery owner is independently feature-gated.
        const admittedRemoteAlertPolicy = isServerFeatureEnabledForRequest("sessions.following", requestHomeEnv)
            ? remoteAlertPolicy
            : undefined;

        try {
            const result = await inTx((tx) => writeAccountSettingsInTx({
                tx,
                accountId: userId,
                expectedVersion,
                ...(expectedProfileTransferRevision === undefined ? {} : { expectedProfileTransferRevision }),
                next: {
                    kind: "v2",
                    content,
                    ...(admittedRemoteAlertPolicy === undefined ? {} : { remoteAlertPolicy: admittedRemoteAlertPolicy }),
                },
            }));

            if (result.status === "account_not_found") return reply.code(500).send({ error: "internal" });
            if (result.status === "storage_unavailable") {
                return reply.code(503).send({
                    error: "account_settings_storage_unavailable",
                });
            }
            if (result.status === "invalid_content") return reply.code(400).send({ error: "invalid-params" });
            if (result.status === 'profile_transfer_mismatch') return reply.send({ success: false,
                error: 'profile-transfer-mismatch', currentProfileTransferRevision: result.currentRevision });
            if (result.status === "version_mismatch") {
                return reply.send({
                    success: false,
                    error: "version-mismatch",
                    currentVersion: result.currentVersion,
                    currentContent: result.currentContent ?? null,
                });
            }
            if (result.status !== "success") return reply.code(500).send({ error: "internal" });
            return reply.send({ success: true, version: result.version });
        } catch (error) {
            const storageUnavailable = resolveAccountSettingsStorageUnavailableRouteError(error);
            if (storageUnavailable) {
                return reply.code(storageUnavailable.statusCode).send(storageUnavailable.body);
            }
            log({ module: "api", level: "error" }, `Failed to update v2 account settings: ${error}`);
            return reply.code(500).send({ error: "internal" });
        }
    });
}
