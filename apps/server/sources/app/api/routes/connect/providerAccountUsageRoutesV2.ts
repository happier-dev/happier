import { z } from "zod";

import type { Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { db } from "@/storage/db";
import {
    ProviderAccountUsageRecordIdSchema,
    SealedProviderAccountUsageSnapshotV1Schema,
} from "@happier-dev/protocol";
import { NotFoundSchema } from "../../schemas/notFoundSchema";
import { persistQuotaSnapshotWithIdempotency } from "./connectedServiceQuotaSnapshotIdempotency";
import { decodeUtf8String, encodeUtf8Bytes } from "./connectedServicesV3/bytesCodec";
import {
    MAX_PROVIDER_ACCOUNT_USAGE_CIPHERTEXT_CHARS,
    PROVIDER_ACCOUNT_USAGE_VENDOR,
    buildProviderAccountUsageMetadata,
    buildProviderAccountUsageResponseMetadata,
    isPlainAccountMode,
    isProviderAccountUsageMetadataV1,
    readProviderAccountUsageRow,
    writeProviderAccountUsageRefreshRequest,
} from "./providerAccountUsageStorage";

async function readE2eeProviderAccountUsageAccount(accountId: string): Promise<Readonly<{
    publicKey: string | null;
    encryptionMode: string | null;
}> | null> {
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: { publicKey: true, encryptionMode: true },
    });
    return account && !isPlainAccountMode(account) ? account : null;
}

export function registerProviderAccountUsageRoutesV2(app: Fastify): void {
    app.post("/v2/connect/provider-account-usage/:recordId", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.write") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({ recordId: ProviderAccountUsageRecordIdSchema }),
            body: z.object({
                sealed: SealedProviderAccountUsageSnapshotV1Schema.extend({
                    ciphertext: z.string().min(1).max(MAX_PROVIDER_ACCOUNT_USAGE_CIPHERTEXT_CHARS),
                }),
                metadata: z.object({
                    fetchedAt: z.number().int().nonnegative(),
                    staleAfterMs: z.number().int().nonnegative(),
                    status: z.enum(["ok", "unavailable", "estimated", "error"]),
                    materialFingerprint: z.string().min(1).max(256).optional(),
                }),
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                400: z.object({ error: z.literal("invalid-params") }),
            },
        },
    }, async (request, reply) => {
        const account = await readE2eeProviderAccountUsageAccount(request.userId);
        if (!account) return reply.code(400).send({ error: "invalid-params" });

        const metadata = buildProviderAccountUsageMetadata({
            recordId: request.params.recordId,
            storage: "sealed_account_scoped_v1",
            format: request.body.sealed.format,
            materialFingerprint: request.body.metadata.materialFingerprint,
        });

        await persistQuotaSnapshotWithIdempotency({
            route: "v2",
            accountId: request.userId,
            vendor: PROVIDER_ACCOUNT_USAGE_VENDOR,
            profileId: request.params.recordId,
            snapshot: encodeUtf8Bytes(request.body.sealed.ciphertext),
            status: request.body.metadata.status,
            fetchedAtMs: request.body.metadata.fetchedAt,
            staleAfterMs: request.body.metadata.staleAfterMs,
            metadata,
        });

        return reply.send({ success: true });
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
                    }),
                }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("provider_account_usage_not_found") })]),
            },
        },
    }, async (request, reply) => {
        const account = await readE2eeProviderAccountUsageAccount(request.userId);
        if (!account) return reply.code(404).send({ error: "provider_account_usage_not_found" });

        const row = await readProviderAccountUsageRow({ accountId: request.userId, recordId: request.params.recordId });
        if (!row || !isProviderAccountUsageMetadataV1(row.metadata) || row.metadata.storage !== "sealed_account_scoped_v1") {
            return reply.code(404).send({ error: "provider_account_usage_not_found" });
        }
        const ciphertext = decodeUtf8String(row.snapshot);
        if (!ciphertext.trim()) return reply.code(404).send({ error: "provider_account_usage_not_found" });

        return reply.send({
            sealed: {
                format: row.metadata.format ?? "account_scoped_v1",
                ciphertext,
            },
            metadata: buildProviderAccountUsageResponseMetadata(row, row.metadata),
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
        const account = await readE2eeProviderAccountUsageAccount(request.userId);
        if (!account) return reply.code(404).send({ error: "provider_account_usage_not_found" });

        await writeProviderAccountUsageRefreshRequest({
            accountId: request.userId,
            recordId: request.params.recordId,
            storage: "sealed_account_scoped_v1",
            format: "account_scoped_v1",
        });
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
        const account = await readE2eeProviderAccountUsageAccount(request.userId);
        if (!account) return reply.code(404).send({ error: "provider_account_usage_not_found" });

        const existing = await db.serviceAccountQuotaSnapshot.findUnique({
            where: {
                accountId_vendor_profileId: {
                    accountId: request.userId,
                    vendor: PROVIDER_ACCOUNT_USAGE_VENDOR,
                    profileId: request.params.recordId,
                },
            },
            select: { id: true },
        });
        if (!existing) return reply.code(404).send({ error: "provider_account_usage_not_found" });
        await db.serviceAccountQuotaSnapshot.delete({ where: { id: existing.id } });
        return reply.send({ success: true });
    });
}
