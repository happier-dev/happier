import { z } from "zod";

import type { Fastify } from "../../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { db } from "@/storage/db";
import {
    ConnectedServiceIdSchema,
    StoredJsonContentEnvelopeSchema,
    type ConnectedServiceId,
} from "@happier-dev/protocol";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";
import { ConnectedServiceProfileIdSchema } from "../connectedServicesV2/profileIdSchema";
import {
    readProviderAccountUsageRecord,
} from "../providerAccountUsage";
import {
    readExactQualifiedConnectedServiceUsageSource,
    requestQualifiedConnectedAccountQuotaRefresh,
    unlinkQualifiedConnectedAccountQuota,
} from "../qualifiedConnectedAccounts/usageRepository";
import { resolveLegacyQualifiedConnectedAccountService } from "../qualifiedConnectedAccounts/identity";
import { projectProviderAccountUsageSnapshotToLegacyQuota } from "../qualifiedConnectedAccounts/legacyUsageTranslation";

async function readPlainAccount(accountId: string) {
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: { publicKey: true, encryptionMode: true },
    });
    return account && resolveEffectiveAccountEncryptionModeFromAccountRow(account) === "plain" ? account : null;
}

export function registerConnectedServiceQuotaRoutesV3(app: Fastify): void {
    // SD-1: the quota V3 POST route was retired when quota reads became a projection over
    // provider-account usage — its handler returned 400 unconditionally and no first-party client
    // POSTs here (CLI + UI quota V3 surfaces are GET-only). Removed rather than kept as a dead
    // registered write surface.

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
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const account = await readPlainAccount(userId);
        if (!account) return reply.code(404).send({ error: "connect_quotas_not_found" });

        const ref = {
            service:
                resolveLegacyQualifiedConnectedAccountService(
                    serviceId,
                ),
            accountId: profileId,
        };
        const source =
            await readExactQualifiedConnectedServiceUsageSource({
                accountId: userId,
                source: { ref, bindingKind: "account" },
            });
        if (!source) {
            return reply.code(404).send({
                error: "connect_quotas_not_found",
            });
        }
        const record = await readProviderAccountUsageRecord({
            accountId: userId,
            recordId: source.recordId,
        });
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
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const account = await readPlainAccount(userId);
        if (!account) return reply.code(404).send({ error: "connect_quotas_not_found" });

        const result =
            await requestQualifiedConnectedAccountQuotaRefresh({
                accountId: userId,
                ref: {
                    service:
                        resolveLegacyQualifiedConnectedAccountService(
                            serviceId,
                        ),
                    accountId: profileId,
                },
            });
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
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const account = await readPlainAccount(userId);
        if (!account) return reply.code(404).send({ error: "connect_quotas_not_found" });

        const result =
            await unlinkQualifiedConnectedAccountQuota({
                accountId: userId,
                ref: {
                    service:
                        resolveLegacyQualifiedConnectedAccountService(
                            serviceId,
                        ),
                    accountId: profileId,
                },
            });
        if (result === "not_found") {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }
        return reply.send({ success: true });
    });
}
