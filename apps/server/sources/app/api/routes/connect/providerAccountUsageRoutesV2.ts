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
    SealedProviderAccountUsageSnapshotV1Schema,
} from "@happier-dev/protocol";
import { NotFoundSchema } from "../../schemas/notFoundSchema";
import {
    ProviderAccountUsageInvalidParamsResponseSchema,
    ProviderAccountUsageWriteSuccessResponseSchema,
    type ProviderAccountUsageInvalidParamsReason,
} from "./providerAccountUsage/schemas";
import type { ProviderAccountUsageSourceLinkOutcome } from "./providerAccountUsage/types";
import {
    ConnectedServiceUsageSourceBindingError,
    ConnectedServiceUsageSourceOwnershipError,
    deleteProviderAccountUsageRecord,
    ProviderAccountUsagePayloadInvariantError,
    listConnectedServiceUsageSourcesForProviderAccountUsageRecord,
    readProviderAccountUsageRecord,
    requestProviderAccountUsageRefresh,
    listProviderAccountUsageRefreshRequests,
    toConnectedServiceUsageSourceV1,
    writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource,
} from "./providerAccountUsage";
import { writeProviderAccountUsageRecordWithPolicy } from "./providerAccountUsage/routeWritePolicy";

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
    // Request IDs are account-scoped metadata; encrypted usage remains on its existing sealed read route.
    app.get("/v2/connect/provider-account-usage/refresh-requests", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.read") },
        preHandler: app.authenticate,
        schema: { response: { 200: z.object({ recordIds: z.array(ProviderAccountUsageRecordIdSchema) }).strict() } },
    }, async (request, reply) => reply.send({ recordIds: await listProviderAccountUsageRefreshRequests(request.userId) }));

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
                metadata: z.object({
                    fetchedAt: z.number().int().nonnegative(),
                    staleAfterMs: z.number().int().nonnegative(),
                    status: z.enum(["ok", "unavailable", "estimated", "error"]),
                    materialFingerprint: z.string().min(1).max(256).optional(),
                    refreshErrorAt: z.number().int().nonnegative().optional(),
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
                refreshErrorAt: request.body.metadata.refreshErrorAt,
                sealedPayload: request.body.sealed,
            };
            let sourceOutcome: ProviderAccountUsageSourceLinkOutcome | undefined;
            if (request.body.source) {
                const result = await writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource({
                    ...writeParams,
                    source: request.body.source,
                });
                sourceOutcome = result.sourceOutcome;
            } else {
                await writeProviderAccountUsageRecordWithPolicy(writeParams);
            }
            return reply.send({
                success: true,
                ...(sourceOutcome ? { source: sourceOutcome } : {}),
            });
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
                        refreshErrorAt: z.number().int().nonnegative().optional(),
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
        const sources = await listConnectedServiceUsageSourcesForProviderAccountUsageRecord({
            accountId: request.userId,
            providerAccountUsageRecordId: record.recordId,
        });

        return reply.send({
            sealed: record.sealedPayload,
            metadata: {
                fetchedAt: record.fetchedAt ?? 0,
                staleAfterMs: record.staleAfterMs ?? 0,
                status: normalizeResponseStatus(record.status),
                ...(record.refreshRequestedAt !== undefined ? { refreshRequestedAt: record.refreshRequestedAt } : {}),
                ...(record.metadata?.refreshErrorAt !== undefined ? { refreshErrorAt: record.metadata.refreshErrorAt } : {}),
            },
            sources: sources.map(toConnectedServiceUsageSourceV1),
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
