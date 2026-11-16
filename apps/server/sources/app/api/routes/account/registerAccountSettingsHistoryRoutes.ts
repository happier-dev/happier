import { z } from "zod/mini";

import { AccountSettingsV2HistoryDetailResponseSchema, AccountSettingsV2HistoryListResponseSchema, AccountSettingsV2HistoryRestoreClientUpdateRequiredResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import {
    ACCOUNT_SETTINGS_V2_UPDATE_REQUEST_MAX_UTF8_BYTES,
    AccountSettingsV2HistoryMutationRequestSchema,
    AccountSettingsV2HistoryMutationResponseSchema,
    type AccountSettingsV2HistoryMutationRequest,
} from "@happier-dev/protocol/account/settings/accountSettingsApiV2";
import { mutateAccountSettingsHistorySnapshotInTx } from "@/app/accountSettings/accountSettingsHistoryRepository";
import { ACCOUNT_SETTINGS_HISTORY_MAX_AGGREGATE_BYTES } from "@/app/accountSettings/accountSettingsHistoryConfig";
import { inReadSnapshot, inTx } from "@/storage/inTx";
import { PresentUserRequiredResponseSchema, requirePresentUser } from "@/app/api/utils/requirePresentUser";

import {
    accountSettingsSnapshotToContent,
    resolveAccountSettingsSnapshotContentKind,
    readAccountSettingsSnapshotDbValue,
} from "@/app/accountSettings/accountSettingsHistoryContent";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import { log } from "@/utils/logging/log";
import { type Fastify } from "../../types";
import {
    AccountSettingsStorageUnavailableResponseSchema,
    resolveAccountSettingsStorageUnavailableRouteError,
} from "./accountSettingsStorageUnavailableRouteError";

const AccountSettingsHistoryVersionParamsSchema = z.object({
    version: z.coerce.number().check(z.int(), z.minimum(0)),
});

const AccountSettingsHistoryErrorResponseSchema = z.object({
    error: z.union([
        z.literal("invalid-params"),
        z.literal("not_found"),
        z.literal("internal"),
    ]),
});

export function registerAccountSettingsHistoryRoutes(app: Fastify): void {
    app.post("/v2/account/settings/history/:version/mutate", {
        preHandler: [app.authenticate, requirePresentUser],
        // One retained envelope plus one admitted replacement; reuse their owning budgets.
        bodyLimit: ACCOUNT_SETTINGS_HISTORY_MAX_AGGREGATE_BYTES + ACCOUNT_SETTINGS_V2_UPDATE_REQUEST_MAX_UTF8_BYTES,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings") },
        schema: {
            params: AccountSettingsHistoryVersionParamsSchema,
            body: AccountSettingsV2HistoryMutationRequestSchema,
            response: {
                200: AccountSettingsV2HistoryMutationResponseSchema,
                403: PresentUserRequiredResponseSchema,
                503: AccountSettingsStorageUnavailableResponseSchema,
                500: AccountSettingsHistoryErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        try {
            const { version } = request.params as { version: number };
            const result = await inTx(tx => mutateAccountSettingsHistorySnapshotInTx({
                tx, accountId: request.userId, version,
                mutation: request.body as AccountSettingsV2HistoryMutationRequest,
            }));
            return reply.send(result);
        } catch (error) {
            const unavailable = resolveAccountSettingsStorageUnavailableRouteError(error);
            if (unavailable) return reply.code(unavailable.statusCode).send(unavailable.body);
            log({ module: "api", level: "error" }, "Failed to mutate exact account settings history snapshot");
            return reply.code(500).send({ error: "internal" });
        }
    });
    app.get("/v2/account/settings/history", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            response: {
                200: AccountSettingsV2HistoryListResponseSchema,
                503: AccountSettingsStorageUnavailableResponseSchema,
                500: AccountSettingsHistoryErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        try {
            const result = await inReadSnapshot(async tx => {
                const account = await tx.account.findUnique({
                    where: { id: request.userId },
                    select: {
                        publicKey: true,
                        encryptionMode: true,
                        contentPublicKey: true,
                        contentPublicKeySig: true,
                    },
                });
                if (
                    !account
                    || deriveAccountEncryptionCurrentnessFromRow(
                        account,
                    ).status === "inconsistent"
                ) {
                    return { statusCode: 503, body: {
                        error: "account_settings_storage_unavailable",
                    } } as const;
                }
                const snapshots = await tx.accountSettingsSnapshot.findMany({
                    where: { accountId: request.userId },
                    orderBy: [
                        { version: "desc" },
                        { createdAt: "desc" },
                    ],
                    select: {
                        version: true,
                        createdAt: true,
                        encryptionMode: true,
                        settingsDbValue: true,
                        settingsDbValueBytes: true,
                    },
                });

                return { statusCode: 200, body: {
                    snapshots: snapshots.map((snapshot) => ({
                        version: snapshot.version,
                        createdAt: snapshot.createdAt.toISOString(),
                        contentKind: resolveAccountSettingsSnapshotContentKind(snapshot),
                        byteLength: Buffer.byteLength(readAccountSettingsSnapshotDbValue(snapshot) ?? "", "utf8"),
                    })),
                } } as const;
            }, { transactionClass: "account-settings-history-list" });
            // Sending inside the callback commits HTTP before the database settles.
            return reply.code(result.statusCode).send(result.body);
        } catch (error) {
            const storageUnavailable = resolveAccountSettingsStorageUnavailableRouteError(error);
            if (storageUnavailable) {
                return reply.code(storageUnavailable.statusCode).send(storageUnavailable.body);
            }
            log({ module: "api", level: "error" }, `Failed to list account settings history: ${error}`);
            return reply.code(500).send({ error: "internal" });
        }
    });

    app.get("/v2/account/settings/history/:version", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            params: AccountSettingsHistoryVersionParamsSchema,
            response: {
                200: AccountSettingsV2HistoryDetailResponseSchema,
                404: AccountSettingsHistoryErrorResponseSchema,
                503: AccountSettingsStorageUnavailableResponseSchema,
                500: AccountSettingsHistoryErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const { version } = request.params as { version: number };

        try {
            const result = await inReadSnapshot(async tx => {
                const account = await tx.account.findUnique({
                    where: { id: request.userId },
                    select: {
                        publicKey: true,
                        encryptionMode: true,
                        contentPublicKey: true,
                        contentPublicKeySig: true,
                    },
                });
                if (
                    !account
                    || deriveAccountEncryptionCurrentnessFromRow(
                        account,
                    ).status === "inconsistent"
                ) {
                    return { statusCode: 503, body: {
                        error: "account_settings_storage_unavailable",
                    } } as const;
                }
                const snapshot = await tx.accountSettingsSnapshot.findUnique({
                    where: {
                        accountId_version: {
                            accountId: request.userId,
                            version,
                        },
                    },
                    select: {
                        accountId: true,
                        version: true,
                        settingsDbValue: true,
                        settingsDbValueBytes: true,
                        encryptionMode: true,
                        createdAt: true,
                    },
                });
                if (!snapshot) return { statusCode: 404, body: { error: "not_found" } } as const;

                const content = accountSettingsSnapshotToContent(snapshot);
                if (snapshot.settingsDbValue && !content) {
                    return { statusCode: 500, body: { error: "internal" } } as const;
                }

                return { statusCode: 200, body: {
                    content,
                    version: snapshot.version,
                    createdAt: snapshot.createdAt.toISOString(),
                } } as const;
            }, { transactionClass: "account-settings-history-read" });
            return reply.code(result.statusCode).send(result.body);
        } catch (error) {
            const storageUnavailable = resolveAccountSettingsStorageUnavailableRouteError(error);
            if (storageUnavailable) {
                return reply.code(storageUnavailable.statusCode).send(storageUnavailable.body);
            }
            log({ module: "api", level: "error" }, `Failed to get account settings history snapshot: ${error}`);
            return reply.code(500).send({ error: "internal" });
        }
    });

    app.post("/v2/account/settings/history/:version/restore", {
        preHandler: app.authenticate,
        schema: {
            params: AccountSettingsHistoryVersionParamsSchema,
            response: {
                426: AccountSettingsV2HistoryRestoreClientUpdateRequiredResponseSchema,
            },
        },
    }, async (_request, reply) => {
        // Exact snapshot replacement cannot classify E2EE content, so it must
        // not remain a second restore writer beside client-side normalization.
        return reply.code(426).send({
            error: "account_settings_restore_client_update_required",
        });
    });
}
