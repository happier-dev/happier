import { z } from "zod";
import type { FastifyReply } from "fastify";

import type { Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { db } from "@/storage/db";
import {
    ConnectedServiceIdSchema,
    getProviderAccountUsageRefreshErrorAt,
    ConnectedServiceProfileIdSchema,
    ConnectedServiceUsageSourceV1Schema,
    ProviderAccountUsageRecordIdSchema,
    ProviderAccountUsageSnapshotV1Schema,
    ProviderAccountSubscriptionV1Schema,
    ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema,
    splitProviderAccountUsageSupplementalFacets,
    PROVIDER_ACCOUNT_SUBSCRIPTION_ACCEPT,
    StoredJsonContentEnvelopeSchema,
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
    listConnectedServiceUsageSourcesForProviderAccountUsageRecord,
    readExactConnectedServiceUsageSource,
    readProviderAccountUsageRecord,
    requestProviderAccountUsageRefresh,
    toConnectedServiceUsageSourceV1,
    writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource,
} from "./providerAccountUsage";
import { ProviderAccountUsagePayloadInvariantError } from "./providerAccountUsage";
import { writeProviderAccountUsageRecordWithPolicy } from "./providerAccountUsage/routeWritePolicy";

function providerAccountUsageWriteMetadataMatchesSnapshotClock(
    metadata: Readonly<{ fetchedAt: number; staleAfterMs: number }>,
    snapshot: Readonly<{ fetchedAtMs: number; staleAfterMs: number }>,
): boolean {
    return metadata.fetchedAt === snapshot.fetchedAtMs
        && metadata.staleAfterMs === snapshot.staleAfterMs;
}

function normalizeResponseStatus(status: string): "ok" | "unavailable" | "estimated" | "error" {
    return status === "unavailable" || status === "estimated" || status === "error" ? status : "ok";
}

function sendProviderAccountUsageInvalidParams(
    reply: FastifyReply,
    reason: ProviderAccountUsageInvalidParamsReason,
) {
    return reply.code(400).send({ error: "invalid-params" as const, reason });
}

const ConnectedServiceUsageSourceQueryBindingV1Schema = z.discriminatedUnion("bindingKind", [
    z.object({
        serviceId: ConnectedServiceIdSchema,
        profileId: ConnectedServiceProfileIdSchema,
        bindingKind: z.literal("profile"),
    }).strict(),
    z.object({
        serviceId: ConnectedServiceIdSchema,
        profileId: ConnectedServiceProfileIdSchema,
        bindingKind: z.literal("group_member"),
        groupId: z.string().trim().min(1),
        groupGeneration: z.number().int().nonnegative(),
    }).strict(),
]);

const ConnectedServiceUsageSourceQueryV1Schema = z.preprocess((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const groupGeneration = (value as { groupGeneration?: unknown }).groupGeneration;
    if (typeof groupGeneration !== "string") return value;
    if (!/^(0|[1-9]\d*)$/.test(groupGeneration)) return value;
    const parsed = Number(groupGeneration);
    if (!Number.isSafeInteger(parsed)) return value;
    return { ...value, groupGeneration: parsed };
}, ConnectedServiceUsageSourceQueryBindingV1Schema);

async function readPlainAccount(accountId: string) {
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: { publicKey: true, encryptionMode: true },
    });
    return account && resolveEffectiveAccountEncryptionModeFromAccountRow(account) === "plain" ? account : null;
}

export function registerProviderAccountUsageRoutesV3(app: Fastify): void {
    app.get("/v3/connect/provider-account-usage/sources/resolve", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.read") },
        preHandler: app.authenticate,
        schema: {
            querystring: ConnectedServiceUsageSourceQueryV1Schema,
            response: {
                200: z.object({
                    source: ConnectedServiceUsageSourceV1Schema,
                    recordId: ProviderAccountUsageRecordIdSchema,
                    providerAccountId: z.string().trim().min(1).max(512),
                    fetchedAt: z.number().int().nonnegative().nullable(),
                    staleAfterMs: z.number().int().nonnegative().nullable(),
                }).strict(),
                404: z.object({ error: z.literal("provider_account_usage_source_not_found") }),
            },
        },
    }, async (request, reply) => {
        const resolved = await readExactConnectedServiceUsageSource({
            accountId: request.userId,
            source: request.query,
        });
        if (!resolved) {
            return reply.code(404).send({ error: "provider_account_usage_source_not_found" });
        }
        return reply.send(resolved);
    });

    app.post("/v3/connect/provider-account-usage/:recordId", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.write") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({ recordId: ProviderAccountUsageRecordIdSchema }),
            body: z.object({
                content: StoredJsonContentEnvelopeSchema,
                metadata: z.object({
                    fetchedAt: z.number().int().nonnegative(),
                    staleAfterMs: z.number().int().min(1),
                    status: z.enum(["ok", "unavailable", "estimated", "error"]),
                    materialFingerprint: z.string().min(1).max(256).optional(),
                    subscription: ProviderAccountSubscriptionV1Schema.optional(),
                    recoveryCreditDetails: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema.optional(),
                }).strict(),
                source: ConnectedServiceUsageSourceV1Schema.optional(),
            }).strict(),
            response: {
                200: ProviderAccountUsageWriteSuccessResponseSchema,
                400: ProviderAccountUsageInvalidParamsResponseSchema,
            },
        },
    }, async (request, reply) => {
        const account = await readPlainAccount(request.userId);
        if (!account || request.body.content.t !== "plain") {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_plaintext_required");
        }
        const parsed = ProviderAccountUsageSnapshotV1Schema.safeParse(request.body.content.v);
        if (!parsed.success) {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_payload_invalid");
        }
        if ((request.body.metadata.recoveryCreditDetails !== undefined || parsed.data.recoveryCreditDetails !== undefined)
            && !isServerFeatureEnabledForRequest("connectedServices.quotaRecoveryCreditDetails", process.env)) {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_payload_invalid");
        }
        if (parsed.data.recordId !== request.params.recordId) {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_record_id_mismatch");
        }
        if (!providerAccountUsageWriteMetadataMatchesSnapshotClock(request.body.metadata, parsed.data)) {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_payload_invalid");
        }

        try {
            const writeParams = {
                accountId: request.userId,
                recordId: parsed.data.recordId,
                recordKey: parsed.data.recordKey,
                payloadMode: "plain_json_v1" as const,
                status: request.body.metadata.status,
                fetchedAt: request.body.metadata.fetchedAt,
                staleAfterMs: request.body.metadata.staleAfterMs,
                materialFingerprint: request.body.metadata.materialFingerprint,
                refreshErrorAt: getProviderAccountUsageRefreshErrorAt(parsed.data),
                snapshot: {
                    ...parsed.data,
                    ...(request.body.metadata.subscription ? { subscription: request.body.metadata.subscription } : {}),
                    ...(request.body.metadata.recoveryCreditDetails ? { recoveryCreditDetails: request.body.metadata.recoveryCreditDetails } : {}),
                },
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

    app.get("/v3/connect/provider-account-usage/:recordId", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.read") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({ recordId: ProviderAccountUsageRecordIdSchema }),
            response: {
                200: z.object({
                    content: StoredJsonContentEnvelopeSchema,
                    subscription: ProviderAccountSubscriptionV1Schema.optional(),
                    recoveryCreditDetails: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema.optional(),
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
        const account = await readPlainAccount(request.userId);
        if (!account) return reply.code(404).send({ error: "provider_account_usage_not_found" });

        const record = await readProviderAccountUsageRecord({
            accountId: request.userId,
            recordId: request.params.recordId,
        });
        if (!record?.snapshot || record.payloadMode !== "plain_json_v1") {
            return reply.code(404).send({ error: "provider_account_usage_not_found" });
        }
        const sources = await listConnectedServiceUsageSourcesForProviderAccountUsageRecord({
            accountId: request.userId,
            providerAccountUsageRecordId: record.recordId,
        });

        const projected = splitProviderAccountUsageSupplementalFacets(record.snapshot);
        return reply.send({
            content: { t: "plain", v: projected.snapshot },
            ...(request.headers.accept === PROVIDER_ACCOUNT_SUBSCRIPTION_ACCEPT && projected.subscription
                ? { subscription: projected.subscription } : {}),
            ...(projected.recoveryCreditDetails ? { recoveryCreditDetails: projected.recoveryCreditDetails } : {}),
            metadata: {
                fetchedAt: record.fetchedAt ?? record.snapshot.fetchedAtMs,
                staleAfterMs: record.staleAfterMs ?? record.snapshot.staleAfterMs,
                status: normalizeResponseStatus(record.status),
                ...(record.refreshRequestedAt !== undefined ? { refreshRequestedAt: record.refreshRequestedAt } : {}),
                ...(record.metadata?.refreshErrorAt !== undefined ? { refreshErrorAt: record.metadata.refreshErrorAt } : {}),
            },
            sources: sources.map(toConnectedServiceUsageSourceV1),
        });
    });

    app.post("/v3/connect/provider-account-usage/:recordId/refresh", {
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
        const account = await readPlainAccount(request.userId);
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

    app.delete("/v3/connect/provider-account-usage/:recordId", {
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
        const account = await readPlainAccount(request.userId);
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
