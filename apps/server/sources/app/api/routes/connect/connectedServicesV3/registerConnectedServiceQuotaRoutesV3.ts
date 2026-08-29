import { z } from "zod";

import type { Fastify } from "../../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { db } from "@/storage/db";
import {
    ConnectedServiceIdSchema,
    parseBuiltInLegacyConnectedServiceQuotaSnapshotV1,
    StoredJsonContentEnvelopeSchema,
    type ConnectedServiceId,
} from "@happier-dev/protocol";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";
import { ConnectedServiceProfileIdSchema } from "../connectedServicesV2/profileIdSchema";
import {
    readQualifiedConnectedAccountUsageRecordWithSource,
    requestLegacyConnectedServiceQuotaCompatibilityRefresh,
    unlinkLegacyConnectedServiceQuotaCompatibilitySource,
    writeLegacyConnectedServiceQuotaCompatibilityRecord,
} from "../qualifiedConnectedAccounts/usageRepository";
import { resolveLegacyQualifiedConnectedAccountService } from "../qualifiedConnectedAccounts/identity";
import { projectProviderAccountUsageSnapshotToLegacyQuota } from "../qualifiedConnectedAccounts/legacyUsageTranslation";
import {
    ConnectedServiceUsageSourceBindingError,
    ConnectedServiceUsageSourceOwnershipError,
    ProviderAccountUsagePayloadInvariantError,
} from "../providerAccountUsage/types";

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

export function registerConnectedServiceQuotaRoutesV3(app: Fastify): void {
    app.post("/v3/connect/:serviceId/profiles/:profileId/quotas", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.write") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            body: z.object({
                content: StoredJsonContentEnvelopeSchema,
                metadata: z.object({
                    fetchedAt: z.number().int().nonnegative(),
                    staleAfterMs: z.number().int().min(1),
                    status: z.enum(["ok", "unavailable", "estimated", "error"]),
                }),
            }).strict(),
            response: {
                200: z.object({ success: z.literal(true) }),
                400: z.object({ error: z.literal("invalid-params") }),
            },
        },
    }, async (request, reply) => {
        const account = await readPlainAccount(request.userId);
        if (!account) return reply.code(400).send({ error: "invalid-params" });
        if (request.body.content.t !== "plain") {
            return reply.code(400).send({ error: "invalid-params" });
        }

        let snapshot;
        try {
            snapshot = parseBuiltInLegacyConnectedServiceQuotaSnapshotV1(
                request.body.content.v,
            );
        } catch {
            return reply.code(400).send({ error: "invalid-params" });
        }
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        if (
            snapshot.serviceId !== serviceId
            || snapshot.profileId !== request.params.profileId
            || snapshot.fetchedAt !== request.body.metadata.fetchedAt
            || snapshot.staleAfterMs !== request.body.metadata.staleAfterMs
        ) {
            return reply.code(400).send({ error: "invalid-params" });
        }

        try {
            await writeLegacyConnectedServiceQuotaCompatibilityRecord({
                accountId: request.userId,
                serviceId,
                profileId: request.params.profileId,
                payloadMode: "plain_json_v1",
                snapshot,
                status: request.body.metadata.status,
                fetchedAt: request.body.metadata.fetchedAt,
                staleAfterMs: request.body.metadata.staleAfterMs,
            });
        } catch (error) {
            if (
                error instanceof ConnectedServiceUsageSourceBindingError
                || error instanceof ConnectedServiceUsageSourceOwnershipError
                || error instanceof ProviderAccountUsagePayloadInvariantError
            ) {
                return reply.code(400).send({ error: "invalid-params" });
            }
            throw error;
        }
        return reply.send({ success: true });
    });

    app.get("/v3/connect/:serviceId/profiles/:profileId/quotas", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.read") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            response: {
                200: z.object({
                    content: StoredJsonContentEnvelopeSchema,
                    metadata: z.object({
                        fetchedAt: z.number().int().nonnegative(),
                        staleAfterMs: z.number().int().nonnegative(),
                        status: z.enum(["ok", "unavailable", "estimated", "error"]),
                        refreshRequestedAt: z.number().int().nonnegative().optional(),
                    }),
                }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_quotas_not_found") })]),
                409: z.object({
                    error: z.literal(
                        "provider_account_usage_storage_mode_mismatch",
                    ),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const ref = {
            service:
                resolveLegacyQualifiedConnectedAccountService(
                    serviceId,
                ),
            accountId: profileId,
        };
        // Admission is owned by the adjacent V4 ProviderAccountUsage read: one
        // transaction admits the persisted Account encryption mode and the
        // record's payload mode together. Source-less PAU history remains
        // absent from this compatibility projection without being deleted.
        const admitted = await readQualifiedConnectedAccountUsageRecordWithSource({
            accountId: userId,
            ref,
        });
        if (admitted.status === "storage_mode_mismatch") {
            return reply.code(409).send({
                error: "provider_account_usage_storage_mode_mismatch",
            });
        }
        const record = admitted.status === "resolved"
            ? admitted.record
            : null;
        if (
            !record?.snapshot
            || record.payloadMode !== "plain_json_v1"
        ) {
            return reply.code(404).send({
                error: "connect_quotas_not_found",
            });
        }

        return reply.send({
            content: {
                t: "plain",
                v:
                    projectProviderAccountUsageSnapshotToLegacyQuota({
                        serviceId,
                        profileId,
                        snapshot: record.snapshot,
                    }),
            },
            metadata: {
                fetchedAt:
                    record.fetchedAt
                    ?? record.snapshot.fetchedAtMs,
                staleAfterMs:
                    record.staleAfterMs
                    ?? record.snapshot.staleAfterMs,
                status:
                    record.status === "unavailable"
                    || record.status === "estimated"
                    || record.status === "error"
                        ? record.status
                        : "ok",
                ...(record.refreshRequestedAt !== undefined
                    ? {
                        refreshRequestedAt:
                            record.refreshRequestedAt,
                    }
                    : {}),
            },
        });
    });

    app.post("/v3/connect/:serviceId/profiles/:profileId/quotas/refresh", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.refresh") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_quotas_not_found") })]),
                409: z.object({ error: z.literal("provider_account_usage_storage_mode_mismatch") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const result =
            await requestLegacyConnectedServiceQuotaCompatibilityRefresh({
                accountId: userId,
                ref: {
                    service:
                        resolveLegacyQualifiedConnectedAccountService(
                            serviceId,
                        ),
                    accountId: profileId,
                },
            });
        if (result === "storage_mode_mismatch") {
            return reply.code(409).send({
                error: "provider_account_usage_storage_mode_mismatch",
            });
        }
        if (result === "not_found") {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }
        return reply.send({ success: true });
    });

    app.delete("/v3/connect/:serviceId/profiles/:profileId/quotas", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.write") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_quotas_not_found") })]),
                409: z.object({ error: z.literal("provider_account_usage_storage_mode_mismatch") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const result =
            await unlinkLegacyConnectedServiceQuotaCompatibilitySource({
                accountId: userId,
                ref: {
                    service:
                        resolveLegacyQualifiedConnectedAccountService(
                            serviceId,
                        ),
                    accountId: profileId,
                },
            });
        if (result === "storage_mode_mismatch") {
            return reply.code(409).send({
                error: "provider_account_usage_storage_mode_mismatch",
            });
        }
        if (result === "not_found") {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }
        return reply.send({ success: true });
    });
}
