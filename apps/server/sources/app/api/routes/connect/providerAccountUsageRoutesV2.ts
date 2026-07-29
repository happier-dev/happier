import { z } from "zod";
import type { FastifyReply } from "fastify";

import type { Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { db } from "@/storage/db";
import {
    buildProviderAccountUsageRecordId,
    ConnectedServiceUsageSourceV1Schema,
    ProviderAccountUsageRecordIdSchema,
    ProviderAccountUsageRecordKeyV1Schema,
    readAccountScopedCiphertextKindByte,
    SealedConnectedServiceQuotaSnapshotV1Schema,
    SealedProviderAccountUsageSnapshotV1Schema,
} from "@happier-dev/protocol";
import { NotFoundSchema } from "../../schemas/notFoundSchema";
import {
    ConnectedServiceUsageSourceBindingError,
    ConnectedServiceUsageSourceOwnershipError,
    deleteProviderAccountUsageRecord,
    ProviderAccountUsagePayloadInvariantError,
    readProviderAccountUsageRecord,
    requestProviderAccountUsageRefresh,
} from "./providerAccountUsage";
import {
    ProviderAccountUsageInvalidParamsResponseSchema,
    ProviderAccountUsageWriteSuccessResponseSchema,
    type ProviderAccountUsageInvalidParamsReason,
} from "./providerAccountUsage/schemas";
import { writeProviderAccountUsageRecordWithPolicy } from "./providerAccountUsage/routeWritePolicy";
import type { ProviderAccountUsageSourceLinkOutcome } from "./providerAccountUsage/types";
import {
    listQualifiedUsageSourcesForRecord,
    writeQualifiedProviderAccountUsageRecordFromLegacyBoundary,
} from "./qualifiedConnectedAccounts/usageRepository";
import {
    projectQualifiedConnectedServiceUsageSourceToLegacy,
    translateLegacyConnectedServiceUsageSource,
} from "./qualifiedConnectedAccounts/legacyUsageTranslation";

const MAX_PROVIDER_ACCOUNT_USAGE_CIPHERTEXT_CHARS = 200_000;

function normalizeResponseStatus(status: string): "ok" | "unavailable" | "estimated" | "error" {
    return status === "unavailable" || status === "estimated" || status === "error" ? status : "ok";
}

async function readE2eeAccount(accountId: string) {
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: { publicKey: true, encryptionMode: true },
    });
    return account && resolveEffectiveAccountEncryptionModeFromAccountRow(account) === "e2ee" ? account : null;
}

function sendProviderAccountUsageInvalidParams(
    reply: FastifyReply,
    reason: ProviderAccountUsageInvalidParamsReason,
) {
    return reply.code(400).send({ error: "invalid-params" as const, reason });
}

export function registerProviderAccountUsageRoutesV2(app: Fastify): void {
    app.post("/v2/connect/provider-account-usage/:recordId", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.write") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({ recordId: ProviderAccountUsageRecordIdSchema }),
            body: z.object({
                recordKey: ProviderAccountUsageRecordKeyV1Schema.optional(),
                sealed: SealedProviderAccountUsageSnapshotV1Schema.extend({
                    ciphertext: z.string().min(1).max(MAX_PROVIDER_ACCOUNT_USAGE_CIPHERTEXT_CHARS),
                }),
                legacyQuotaCompatibility:
                    SealedConnectedServiceQuotaSnapshotV1Schema.extend({
                        ciphertext:
                            z.string().min(1).max(
                                MAX_PROVIDER_ACCOUNT_USAGE_CIPHERTEXT_CHARS,
                            ),
                    }).optional(),
                metadata: z.object({
                    fetchedAt: z.number().int().nonnegative(),
                    staleAfterMs: z.number().int().nonnegative(),
                    status: z.enum(["ok", "unavailable", "estimated", "error"]),
                    materialFingerprint: z.string().min(1).max(256).optional(),
                }).passthrough(),
                source: ConnectedServiceUsageSourceV1Schema.optional(),
            }).strict(),
            response: {
                200: ProviderAccountUsageWriteSuccessResponseSchema,
                400: ProviderAccountUsageInvalidParamsResponseSchema,
                409: z.object({ error: z.literal("provider_account_usage_record_key_required") }),
            },
        },
    }, async (request, reply) => {
        const account = await readE2eeAccount(request.userId);
        if (!account) {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_e2ee_required");
        }
        if (Object.prototype.hasOwnProperty.call(request.body.metadata, "aliases")) {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_legacy_aliases_rejected");
        }
        if (
            request.body.legacyQuotaCompatibility
            && (
                request.body.source?.bindingKind !== "profile"
                || readAccountScopedCiphertextKindByte(
                    request.body.legacyQuotaCompatibility.ciphertext,
                ) !== 4
            )
        ) {
            return sendProviderAccountUsageInvalidParams(
                reply,
                "provider_account_usage_payload_invalid",
            );
        }

        const existing = await readProviderAccountUsageRecord({
            accountId: request.userId,
            recordId: request.params.recordId,
        });
        const recordKey = request.body.recordKey ?? existing?.recordKey;
        if (!recordKey) {
            return reply.code(409).send({ error: "provider_account_usage_record_key_required" });
        }
        if (buildProviderAccountUsageRecordId(recordKey) !== request.params.recordId) {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_record_id_mismatch");
        }

        let sourceOutcome: ProviderAccountUsageSourceLinkOutcome | undefined;
        try {
            const writeParams = {
                accountId: request.userId,
                recordId: request.params.recordId,
                recordKey,
                payloadMode: "sealed_account_scoped_v1" as const,
                status: request.body.metadata.status,
                fetchedAt: request.body.metadata.fetchedAt,
                staleAfterMs: request.body.metadata.staleAfterMs,
                materialFingerprint: request.body.metadata.materialFingerprint,
                sealedPayload: request.body.sealed,
                ...(request.body.legacyQuotaCompatibility
                    && request.body.source?.bindingKind === "profile"
                    ? {
                        legacyQuotaCompatibility: {
                            source: request.body.source,
                            sealed:
                                request.body.legacyQuotaCompatibility,
                        },
                    }
                    : {}),
            };
            if (request.body.source) {
                const writeResult =
                    await writeQualifiedProviderAccountUsageRecordFromLegacyBoundary({
                    ...writeParams,
                    source:
                        translateLegacyConnectedServiceUsageSource(
                            request.body.source,
                        ),
                });
                sourceOutcome = writeResult.sourceOutcome;
            } else {
                await writeProviderAccountUsageRecordWithPolicy(writeParams);
            }
        } catch (error) {
            if (error instanceof ConnectedServiceUsageSourceOwnershipError) {
                return sendProviderAccountUsageInvalidParams(reply, "connected_service_usage_source_incompatible");
            }
            if (error instanceof ConnectedServiceUsageSourceBindingError) {
                return sendProviderAccountUsageInvalidParams(reply, "connected_service_usage_source_invalid");
            }
            if (error instanceof ProviderAccountUsagePayloadInvariantError) {
                return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_payload_invalid");
            }
            throw error;
        }

        return reply.send({
            success: true,
            ...(sourceOutcome ? { source: sourceOutcome } : {}),
        });
    });

    app.get("/v2/connect/provider-account-usage/:recordId", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.read") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({ recordId: ProviderAccountUsageRecordIdSchema }),
            response: {
                200: z.object({
                    sealed: SealedProviderAccountUsageSnapshotV1Schema,
                    metadata: z.object({
                        fetchedAt: z.number().int().nonnegative(),
                        staleAfterMs: z.number().int().nonnegative(),
                        status: z.enum(["ok", "unavailable", "estimated", "error"]),
                        refreshRequestedAt: z.number().int().nonnegative().optional(),
                        materialFingerprint:
                            z.string().min(1).max(256).optional(),
                    }),
                    sources: z.array(ConnectedServiceUsageSourceV1Schema),
                }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("provider_account_usage_not_found") })]),
            },
        },
    }, async (request, reply) => {
        const account = await readE2eeAccount(request.userId);
        if (!account) return reply.code(404).send({ error: "provider_account_usage_not_found" });

        const record = await readProviderAccountUsageRecord({
            accountId: request.userId,
            recordId: request.params.recordId,
        });
        if (!record?.sealedPayload || record.payloadMode !== "sealed_account_scoped_v1") {
            return reply.code(404).send({ error: "provider_account_usage_not_found" });
        }
        const sources = await listQualifiedUsageSourcesForRecord({
            accountId: request.userId,
            recordId: request.params.recordId,
        });
        const legacySources = sources.flatMap((source) => {
            const projected =
                projectQualifiedConnectedServiceUsageSourceToLegacy(
                    source,
                );
            return projected ? [projected] : [];
        });

        return reply.send({
            sealed: record.sealedPayload,
            metadata: {
                fetchedAt: record.fetchedAt ?? 0,
                staleAfterMs: record.staleAfterMs ?? 0,
                status: normalizeResponseStatus(record.status),
                ...(record.refreshRequestedAt !== undefined ? { refreshRequestedAt: record.refreshRequestedAt } : {}),
                ...(record.metadata?.materialFingerprint
                    ? {
                        materialFingerprint:
                            record.metadata.materialFingerprint,
                    }
                    : {}),
            },
            sources: legacySources,
        });
    });

    app.post("/v2/connect/provider-account-usage/:recordId/refresh", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.refresh") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({ recordId: ProviderAccountUsageRecordIdSchema }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("provider_account_usage_not_found") })]),
            },
        },
    }, async (request, reply) => {
        const account = await readE2eeAccount(request.userId);
        if (!account) return reply.code(404).send({ error: "provider_account_usage_not_found" });

        const refreshResult = await requestProviderAccountUsageRefresh({
            accountId: request.userId,
            recordId: request.params.recordId,
        });
        if (refreshResult === "not_found") {
            return reply.code(404).send({ error: "provider_account_usage_not_found" });
        }
        return reply.send({ success: true });
    });

    app.delete("/v2/connect/provider-account-usage/:recordId", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.write") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({ recordId: ProviderAccountUsageRecordIdSchema }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("provider_account_usage_not_found") })]),
            },
        },
    }, async (request, reply) => {
        const account = await readE2eeAccount(request.userId);
        if (!account) return reply.code(404).send({ error: "provider_account_usage_not_found" });

        const deleted = await deleteProviderAccountUsageRecord({
            accountId: request.userId,
            recordId: request.params.recordId,
        });
        if (deleted === "not_found") {
            return reply.code(404).send({ error: "provider_account_usage_not_found" });
        }
        return reply.send({ success: true });
    });
}
