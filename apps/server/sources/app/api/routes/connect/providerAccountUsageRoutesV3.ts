import { z } from "zod";

import type { Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { encryptString } from "@/modules/encrypt";
import { db } from "@/storage/db";
import {
    ProviderAccountUsageRecordIdSchema,
    ProviderAccountUsageSnapshotV1Schema,
    StoredJsonContentEnvelopeSchema,
} from "@happier-dev/protocol";
import { NotFoundSchema } from "../../schemas/notFoundSchema";
import { persistQuotaSnapshotWithIdempotency } from "./connectedServiceQuotaSnapshotIdempotency";
import { encodeUtf8Bytes, toPrismaBytes } from "./connectedServicesV3/bytesCodec";
import {
    MAX_PROVIDER_ACCOUNT_USAGE_JSON_CHARS,
    PROVIDER_ACCOUNT_USAGE_VENDOR,
    buildPlainAtRestKeyPath,
    buildProviderAccountUsageMetadata,
    buildProviderAccountUsageResponseMetadata,
    isPlainAccountMode,
    isProviderAccountUsageMetadataV1,
    mergeProviderAccountUsageSnapshotWithStoredAliases,
    parsePlainProviderAccountUsageSnapshot,
    readProviderAccountUsageRow,
    resolveAtRestStoragePolicy,
    writeProviderAccountUsageRefreshRequest,
} from "./providerAccountUsageStorage";

export function registerProviderAccountUsageRoutesV3(app: Fastify): void {
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
                }),
            }).strict(),
            response: {
                200: z.object({ success: z.literal(true) }),
                400: z.object({ error: z.literal("invalid-params") }),
            },
        },
    }, async (request, reply) => {
        const account = await db.account.findUnique({
            where: { id: request.userId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (!account || !isPlainAccountMode(account)) return reply.code(400).send({ error: "invalid-params" });
        if (request.body.content.t !== "plain") return reply.code(400).send({ error: "invalid-params" });

        const parsed = ProviderAccountUsageSnapshotV1Schema.safeParse(request.body.content.v);
        if (!parsed.success || parsed.data.recordId !== request.params.recordId) {
            return reply.code(400).send({ error: "invalid-params" });
        }

        const snapshot = await mergeProviderAccountUsageSnapshotWithStoredAliases({
            accountId: request.userId,
            snapshot: parsed.data,
        });
        const json = JSON.stringify(snapshot);
        if (json.length > MAX_PROVIDER_ACCOUNT_USAGE_JSON_CHARS) {
            return reply.code(400).send({ error: "invalid-params" });
        }

        const atRest = resolveAtRestStoragePolicy(process.env);
        const storage = atRest === "server_sealed" ? "server_sealed_json_v1" : "plain_json_v1";
        const bytes = atRest === "server_sealed"
            ? encryptString(buildPlainAtRestKeyPath({ accountId: request.userId, recordId: request.params.recordId }), json)
            : encodeUtf8Bytes(json);
        const metadata = buildProviderAccountUsageMetadata({
            recordId: request.params.recordId,
            storage,
            materialFingerprint: request.body.metadata.materialFingerprint,
        });

        await persistQuotaSnapshotWithIdempotency({
            route: "v3",
            accountId: request.userId,
            vendor: PROVIDER_ACCOUNT_USAGE_VENDOR,
            profileId: request.params.recordId,
            snapshot: toPrismaBytes(bytes),
            status: request.body.metadata.status,
            fetchedAtMs: request.body.metadata.fetchedAt,
            staleAfterMs: request.body.metadata.staleAfterMs,
            metadata,
        });

        return reply.send({ success: true });
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
                }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("provider_account_usage_not_found") })]),
            },
        },
    }, async (request, reply) => {
        const account = await db.account.findUnique({
            where: { id: request.userId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (!account || !isPlainAccountMode(account)) {
            return reply.code(404).send({ error: "provider_account_usage_not_found" });
        }

        const row = await readProviderAccountUsageRow({ accountId: request.userId, recordId: request.params.recordId });
        if (!row || !isProviderAccountUsageMetadataV1(row.metadata)) {
            return reply.code(404).send({ error: "provider_account_usage_not_found" });
        }

        const snapshot = parsePlainProviderAccountUsageSnapshot({
            accountId: request.userId,
            recordId: request.params.recordId,
            row,
            metadata: row.metadata,
        });
        if (!snapshot) return reply.code(404).send({ error: "provider_account_usage_not_found" });

        return reply.send({
            content: { t: "plain", v: snapshot },
            metadata: buildProviderAccountUsageResponseMetadata(row, row.metadata),
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
        const account = await db.account.findUnique({
            where: { id: request.userId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (!account || !isPlainAccountMode(account)) {
            return reply.code(404).send({ error: "provider_account_usage_not_found" });
        }

        const atRest = resolveAtRestStoragePolicy(process.env);
        await writeProviderAccountUsageRefreshRequest({
            accountId: request.userId,
            recordId: request.params.recordId,
            storage: atRest === "server_sealed" ? "server_sealed_json_v1" : "plain_json_v1",
        });
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
        const account = await db.account.findUnique({
            where: { id: request.userId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (!account || !isPlainAccountMode(account)) {
            return reply.code(404).send({ error: "provider_account_usage_not_found" });
        }

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
