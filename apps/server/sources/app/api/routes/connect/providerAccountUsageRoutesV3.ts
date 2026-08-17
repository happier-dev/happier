import { z } from "zod";
import type { FastifyReply } from "fastify";

import type { Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { db } from "@/storage/db";
import {
    ConnectedServiceIdSchema,
    ConnectedServiceProfileIdSchema,
    ConnectedServiceUsageSourceV1Schema,
    ProviderAccountUsageRecordIdSchema,
    parseBuiltInLegacyProviderAccountUsageSnapshotV1,
    projectBuiltInLegacyProviderAccountUsageSnapshotV1,
    StoredJsonContentEnvelopeSchema,
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
    deleteQualifiedProviderAccountUsageRecord,
    listQualifiedUsageSourcesForRecord,
    readExactQualifiedConnectedServiceUsageSource,
    requestQualifiedProviderAccountUsageRefresh,
    writeQualifiedProviderAccountUsageRecordFromLegacyBoundary,
} from "./qualifiedConnectedAccounts/usageRepository";
import {
    projectQualifiedConnectedServiceUsageSourceToLegacy,
    translateLegacyConnectedServiceUsageSource,
} from "./qualifiedConnectedAccounts/legacyUsageTranslation";

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
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    const currentness = account
        ? deriveAccountEncryptionCurrentnessFromRow(account)
        : null;
    return currentness?.status === "ready"
        && currentness.currentness.encryptionMode === "plain"
        ? account
        : null;
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
        const resolved =
            await readExactQualifiedConnectedServiceUsageSource({
            accountId: request.userId,
            source:
                translateLegacyConnectedServiceUsageSource(
                    request.query,
                ),
        });
        return resolved
            ? reply.send({
                ...resolved,
                source: request.query,
            })
            : reply.code(404).send({ error: "provider_account_usage_source_not_found" });
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

        let snapshot;
        try {
            snapshot =
                parseBuiltInLegacyProviderAccountUsageSnapshotV1(
                    request.body.content.v,
                );
        } catch {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_payload_invalid");
        }
        if (snapshot.recordId !== request.params.recordId) {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_record_id_mismatch");
        }
        if (!providerAccountUsageWriteMetadataMatchesSnapshotClock(request.body.metadata, snapshot)) {
            return sendProviderAccountUsageInvalidParams(reply, "provider_account_usage_payload_invalid");
        }

        let sourceOutcome: ProviderAccountUsageSourceLinkOutcome | undefined;
        try {
            const writeParams = {
                accountId: request.userId,
                recordId: snapshot.recordId,
                recordKey: snapshot.recordKey,
                payloadMode: "plain_json_v1" as const,
                status: request.body.metadata.status,
                fetchedAt: request.body.metadata.fetchedAt,
                staleAfterMs: request.body.metadata.staleAfterMs,
                materialFingerprint: request.body.metadata.materialFingerprint,
                snapshot,
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

    app.get("/v3/connect/provider-account-usage/:recordId", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.read") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({ recordId: ProviderAccountUsageRecordIdSchema }),
            response: {
                200: z.object({
                    content: StoredJsonContentEnvelopeSchema,
                    metadata: z.object({
                        fetchedAt: z.number().int().nonnegative(),
                        staleAfterMs: z.number().int().nonnegative(),
                        status: z.enum(["ok", "unavailable", "estimated", "error"]),
                        refreshRequestedAt: z.number().int().nonnegative().optional(),
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
            content: {
                t: "plain",
                v:
                    projectBuiltInLegacyProviderAccountUsageSnapshotV1(
                        record.snapshot,
                    ),
            },
            metadata: {
                fetchedAt: record.fetchedAt ?? record.snapshot.fetchedAtMs,
                staleAfterMs: record.staleAfterMs ?? record.snapshot.staleAfterMs,
                status: normalizeResponseStatus(record.status),
                ...(record.refreshRequestedAt !== undefined ? { refreshRequestedAt: record.refreshRequestedAt } : {}),
            },
            sources: legacySources,
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

        const qualifiedSources = await listQualifiedUsageSourcesForRecord({
            accountId: request.userId,
            recordId: request.params.recordId,
        });
        const refreshResult = qualifiedSources.length > 0
            ? await requestQualifiedProviderAccountUsageRefresh({
                accountId: request.userId,
                recordId: request.params.recordId,
            })
            : await requestProviderAccountUsageRefresh({
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

        const qualifiedSources = await listQualifiedUsageSourcesForRecord({
            accountId: request.userId,
            recordId: request.params.recordId,
        });
        const deleted = qualifiedSources.length > 0
            ? await deleteQualifiedProviderAccountUsageRecord({
                accountId: request.userId,
                recordId: request.params.recordId,
            })
            : await deleteProviderAccountUsageRecord({
                accountId: request.userId,
                recordId: request.params.recordId,
            });
        if (deleted === "not_found") {
            return reply.code(404).send({ error: "provider_account_usage_not_found" });
        }
        return reply.send({ success: true });
    });
}
