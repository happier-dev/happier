import { z } from "zod/mini";
import { extend } from "zod/mini";

import { type Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { db } from "@/storage/db";
import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import { SealedConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { NotFoundSchema } from "../../schemas/notFoundSchema";
import { ConnectedServiceProfileIdSchema } from "./connectedServicesV2/profileIdSchema";
import {
    readLegacyConnectedServiceQuotaCompatibilityRecordWithSource,
    requestLegacyConnectedServiceQuotaCompatibilityRefresh,
    unlinkLegacyConnectedServiceQuotaCompatibilitySource,
    writeLegacyConnectedServiceQuotaCompatibilityRecord,
} from "./qualifiedConnectedAccounts/usageRepository";
import {
    deleteReleasedConnectedServiceQuotaSnapshot,
    readReleasedConnectedServiceQuotaSnapshot,
    requestReleasedConnectedServiceQuotaRefresh,
} from "./qualifiedConnectedAccounts/legacyQuotaSnapshotCompatibility";
import { resolveLegacyQualifiedConnectedAccountService } from "./qualifiedConnectedAccounts/identity";
import {
    ConnectedServiceUsageSourceBindingError,
    ConnectedServiceUsageSourceOwnershipError,
    ProviderAccountUsagePayloadInvariantError,
} from "./providerAccountUsage/types";

const MAX_QUOTA_SNAPSHOT_CIPHERTEXT_CHARS = 200_000;

function normalizeResponseStatus(status: string): "ok" | "unavailable" | "estimated" | "error" {
    return status === "unavailable" || status === "estimated" || status === "error" ? status : "ok";
}

async function readE2eeAccount(accountId: string) {
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
        && currentness.currentness.encryptionMode === "e2ee"
        ? account
        : null;
}

export function connectConnectedServicesQuotasV2Routes(app: Fastify) {
    app.post("/v2/connect/:serviceId/profiles/:profileId/quotas", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.write") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            body: z.strictObject({
                sealed: extend(SealedConnectedServiceQuotaSnapshotV1Schema, {
                    ciphertext: z.string().check(z.minLength(1), z.maxLength(MAX_QUOTA_SNAPSHOT_CIPHERTEXT_CHARS)),
                }),
                metadata: z.strictObject({
                    fetchedAt: z.number().check(z.int(), z.nonnegative()),
                    staleAfterMs: z.number().check(z.int(), z.nonnegative()),
                    status: z.enum(["ok", "unavailable", "estimated", "error"]),
                    materialFingerprint: z.optional(z.string().check(z.minLength(1), z.maxLength(256))),
                }),
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                400: z.object({ error: z.literal("invalid-params") }),
            },
        },
    }, async (request, reply) => {
        const account = await readE2eeAccount(request.userId);
        if (!account) return reply.code(400).send({ error: "invalid-params" });
        try {
            await writeLegacyConnectedServiceQuotaCompatibilityRecord({
                accountId: request.userId,
                serviceId: request.params.serviceId satisfies ConnectedServiceId,
                profileId: request.params.profileId,
                payloadMode: "sealed_account_scoped_v1",
                sealed: request.body.sealed,
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

    app.get("/v2/connect/:serviceId/profiles/:profileId/quotas", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.read") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            response: {
                200: z.object({
                    sealed: SealedConnectedServiceQuotaSnapshotV1Schema,
                    metadata: z.object({
                        fetchedAt: z.number().check(z.int(), z.nonnegative()),
                        staleAfterMs: z.number().check(z.int(), z.nonnegative()),
                        status: z.enum(["ok", "unavailable", "estimated", "error"]),
                        refreshRequestedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
                    }),
                }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_quotas_not_found") })]),
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
        const admitted =
            await readLegacyConnectedServiceQuotaCompatibilityRecordWithSource({
            accountId: userId,
            ref,
        });
        if (admitted.status === "storage_mode_mismatch" || admitted.status === "ownership_unproven") {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }
        if (admitted.status === "not_found") {
            const predecessor =
                await readReleasedConnectedServiceQuotaSnapshot({
                    accountId: userId,
                    serviceId,
                    profileId,
                });
            if (!predecessor) {
                return reply.code(404).send({ error: "connect_quotas_not_found" });
            }
            return reply.send({
                sealed: {
                    format: "account_scoped_v1",
                    ciphertext: predecessor.ciphertext,
                },
                metadata: {
                    fetchedAt: predecessor.fetchedAt,
                    staleAfterMs: predecessor.staleAfterMs,
                    status: predecessor.status,
                    ...(predecessor.refreshRequestedAt !== undefined
                        ? { refreshRequestedAt: predecessor.refreshRequestedAt }
                        : {}),
                },
            });
        }
        const record = admitted.record;
        const projection =
            record?.metadata?.legacyQuotaCompatibilityProjections?.find(
                (candidate) =>
                    candidate.source.serviceId === serviceId
                    && candidate.source.profileId === profileId
                    && candidate.providerAccountUsageFetchedAt
                        === record.fetchedAt,
            );
        if (
            !record
            || record.payloadMode !== "sealed_account_scoped_v1"
            || !projection
        ) {
            return reply.code(404).send({
                error: "connect_quotas_not_found",
            });
        }

        return reply.send({
            sealed: projection.sealed,
            metadata: {
                fetchedAt: record.fetchedAt ?? 0,
                staleAfterMs: record.staleAfterMs ?? 0,
                status: normalizeResponseStatus(record.status),
                ...(record.refreshRequestedAt !== undefined ? { refreshRequestedAt: record.refreshRequestedAt } : {}),
            },
        });
    });

    app.post("/v2/connect/:serviceId/profiles/:profileId/quotas/refresh", {
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
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const account = await readE2eeAccount(userId);
        if (!account) return reply.code(404).send({ error: "connect_quotas_not_found" });

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
        if (result === "ownership_unproven") {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }
        if (result === "not_found") {
            const predecessorResult =
                await requestReleasedConnectedServiceQuotaRefresh({
                    accountId: userId,
                    serviceId,
                    profileId,
                });
            if (predecessorResult === "not_found") {
                return reply.code(404).send({ error: "connect_quotas_not_found" });
            }
        }
        return reply.send({ success: true });
    });

    app.delete("/v2/connect/:serviceId/profiles/:profileId/quotas", {
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
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const account = await readE2eeAccount(userId);
        if (!account) return reply.code(404).send({ error: "connect_quotas_not_found" });

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
        const predecessorResult =
            await deleteReleasedConnectedServiceQuotaSnapshot({
                accountId: userId,
                serviceId,
                profileId,
            });
        if (result === "not_found" && predecessorResult === "not_found") {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }
        return reply.send({ success: true });
    });
}
