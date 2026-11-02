import { z } from "zod";

import { type Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { db } from "@/storage/db";
import {
    ConnectedServiceIdSchema,
    SealedConnectedServiceQuotaSnapshotV1Schema,
    type ConnectedServiceId,
} from "@happier-dev/protocol";
import { NotFoundSchema } from "../../schemas/notFoundSchema";
import { ConnectedServiceProfileIdSchema } from "./connectedServicesV2/profileIdSchema";
import { registerProviderAccountUsageRoutesV2 } from "./providerAccountUsageRoutesV2";
import {
    readConnectedServiceUsageSource,
    readProviderAccountUsageRecord,
    requestConnectedServiceQuotaRefresh,
    unlinkConnectedServiceUsageSource,
} from "./providerAccountUsage";

const MAX_QUOTA_SNAPSHOT_CIPHERTEXT_CHARS = 200_000;

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

export function connectConnectedServicesQuotasV2Routes(app: Fastify) {
    registerProviderAccountUsageRoutesV2(app);

    app.post("/v2/connect/:serviceId/profiles/:profileId/quotas", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.write") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            body: z.object({
                sealed: SealedConnectedServiceQuotaSnapshotV1Schema.extend({
                    ciphertext: z.string().min(1).max(MAX_QUOTA_SNAPSHOT_CIPHERTEXT_CHARS),
                }),
                metadata: z.object({
                    fetchedAt: z.number().int().nonnegative(),
                    staleAfterMs: z.number().int().nonnegative(),
                    status: z.enum(["ok", "unavailable", "estimated", "error"]),
                    materialFingerprint: z.string().min(1).max(256).optional(),
                }).strict(),
            }).strict(),
            response: {
                200: z.object({ success: z.literal(true) }),
                400: z.object({ error: z.literal("invalid-params") }),
            },
        },
    }, async (request, reply) => {
        const account = await readE2eeAccount(request.userId);
        if (!account) return reply.code(400).send({ error: "invalid-params" });
        return reply.code(400).send({ error: "invalid-params" });
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
                        fetchedAt: z.number().int().nonnegative(),
                        staleAfterMs: z.number().int().nonnegative(),
                        status: z.enum(["ok", "unavailable", "estimated", "error"]),
                        refreshRequestedAt: z.number().int().nonnegative().optional(),
                        refreshErrorAt: z.number().int().nonnegative().optional(),
                    }),
                }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_quotas_not_found") })]),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const account = await readE2eeAccount(userId);
        if (!account) return reply.code(404).send({ error: "connect_quotas_not_found" });

        const source = await readConnectedServiceUsageSource({ accountId: userId, serviceId, profileId });
        if (!source) return reply.code(404).send({ error: "connect_quotas_not_found" });

        const record = await readProviderAccountUsageRecord({
            accountId: userId,
            recordId: source.providerAccountUsageRecordId,
        });
        if (!record?.sealedPayload || record.payloadMode !== "sealed_account_scoped_v1") {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }

        return reply.send({
            sealed: record.sealedPayload,
            metadata: {
                fetchedAt: record.fetchedAt ?? 0,
                staleAfterMs: record.staleAfterMs ?? 0,
                status: normalizeResponseStatus(record.status),
                ...(record.refreshRequestedAt !== undefined ? { refreshRequestedAt: record.refreshRequestedAt } : {}),
                ...(record.metadata?.refreshErrorAt !== undefined ? { refreshErrorAt: record.metadata.refreshErrorAt } : {}),
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

        const result = await requestConnectedServiceQuotaRefresh({ accountId: userId, serviceId, profileId });
        if (result === "not_found") {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
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

        const result = await unlinkConnectedServiceUsageSource({ accountId: userId, serviceId, profileId });
        if (result === "not_found") {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }
        return reply.send({ success: true });
    });
}
