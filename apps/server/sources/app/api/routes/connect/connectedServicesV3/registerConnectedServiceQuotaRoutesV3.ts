import { z } from "zod";

import type { Fastify } from "../../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { db } from "@/storage/db";
import {
    ConnectedServiceIdSchema,
    ConnectedServiceQuotaSnapshotV1Schema,
    StoredJsonContentEnvelopeSchema,
    type ConnectedServiceId,
} from "@happier-dev/protocol";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { decryptString, encryptString } from "@/modules/encrypt";
import { persistQuotaSnapshotWithIdempotency } from "../connectedServiceQuotaSnapshotIdempotency";
import { decodeUtf8String, encodeUtf8Bytes } from "./bytesCodec";
import { isConnectedServiceQuotaMetadataV3 } from "./quotaMetadataV3";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";
import { ConnectedServiceProfileIdSchema } from "../connectedServicesV2/profileIdSchema";
import {
    PROVIDER_ACCOUNT_USAGE_VENDOR,
    buildPlainAtRestKeyPath,
    buildProviderAccountUsageMetadata,
    mergeProviderAccountUsageSnapshotWithStoredAliases,
    readProviderAccountUsageProjectionForConnectedService,
    removeConnectedServiceAliasFromProviderAccountUsageProjection,
    writeProviderAccountUsageRefreshRequest,
} from "../providerAccountUsageStorage";
import {
    buildConnectedServiceFallbackProviderAccountUsageRecordId,
    buildProviderAccountUsageSnapshotFromQuotaSnapshot,
} from "./providerAccountUsageProjectionV3";

const MAX_QUOTA_SNAPSHOT_JSON_CHARS = 200_000;

function resolveAtRestStoragePolicy(env: NodeJS.ProcessEnv): "none" | "server_sealed" {
    const encryption = readEncryptionFeatureEnv(env);
    return encryption.plainAccountCredentialsAtRest === "none" ? "none" : "server_sealed";
}

function buildAtRestKeyPath(params: { accountId: string; serviceId: string; profileId: string }): string[] {
    return ["storage", "connect_quota_snapshot", params.accountId, params.serviceId, params.profileId, "v1"];
}

function normalizeStatus(raw: unknown): "ok" | "unavailable" | "estimated" | "error" {
    return raw === "ok" || raw === "unavailable" || raw === "estimated" || raw === "error" ? raw : "ok";
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
                    materialFingerprint: z.string().min(1).max(256).optional(),
                }),
            }).strict(),
            response: {
                200: z.object({ success: z.literal(true) }),
                400: z.object({ error: z.literal("invalid-params") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const account = await db.account.findUnique({
            where: { id: userId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (!account) return reply.code(400).send({ error: "invalid-params" });

        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
        if (mode !== "plain") return reply.code(400).send({ error: "invalid-params" });

        const content = request.body.content;
        if (content.t !== "plain") return reply.code(400).send({ error: "invalid-params" });

        const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(content.v);
        if (!parsed.success) return reply.code(400).send({ error: "invalid-params" });
        const snapshot = parsed.data;
        if (snapshot.serviceId !== serviceId) return reply.code(400).send({ error: "invalid-params" });
        if (snapshot.profileId !== profileId) return reply.code(400).send({ error: "invalid-params" });

        const providerAccountUsageSnapshot = await mergeProviderAccountUsageSnapshotWithStoredAliases({
            accountId: userId,
            snapshot: buildProviderAccountUsageSnapshotFromQuotaSnapshot(snapshot),
        });
        const json = JSON.stringify(providerAccountUsageSnapshot);
        if (json.length > MAX_QUOTA_SNAPSHOT_JSON_CHARS) {
            return reply.code(400).send({ error: "invalid-params" });
        }

        const atRest = resolveAtRestStoragePolicy(process.env);
        const keyPath = buildPlainAtRestKeyPath({ accountId: userId, recordId: providerAccountUsageSnapshot.recordId });
        const bytes = atRest === "server_sealed"
            ? (encryptString(keyPath, json) as Uint8Array<ArrayBuffer>)
            : encodeUtf8Bytes(json);

        const metadata = buildProviderAccountUsageMetadata({
            recordId: providerAccountUsageSnapshot.recordId,
            storage: atRest === "server_sealed" ? "server_sealed_json_v1" : "plain_json_v1",
            materialFingerprint: request.body.metadata.materialFingerprint,
        });

        const meta = request.body.metadata;
        await persistQuotaSnapshotWithIdempotency({
            route: "v3",
            accountId: userId,
            vendor: PROVIDER_ACCOUNT_USAGE_VENDOR,
            profileId: providerAccountUsageSnapshot.recordId,
            snapshot: bytes,
            status: meta.status,
            fetchedAtMs: meta.fetchedAt,
            staleAfterMs: meta.staleAfterMs,
            metadata,
        });

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
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const account = await db.account.findUnique({
            where: { id: userId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (!account) return reply.code(404).send({ error: "connect_quotas_not_found" });

        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
        if (mode !== "plain") return reply.code(404).send({ error: "connect_quotas_not_found" });

        const canonicalProjection = await readProviderAccountUsageProjectionForConnectedService({
            accountId: userId,
            serviceId,
            profileId,
        });
        if (canonicalProjection) {
            return reply.send({
                content: { t: "plain", v: canonicalProjection.snapshot },
                metadata: canonicalProjection.metadata,
            });
        }

        const row = await db.serviceAccountQuotaSnapshot.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            select: { snapshot: true, fetchedAt: true, staleAfterMs: true, status: true, metadata: true },
        });
        if (!row) return reply.code(404).send({ error: "connect_quotas_not_found" });

        if (!isConnectedServiceQuotaMetadataV3(row.metadata)) {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }

        if ((row.snapshot as Uint8Array).byteLength === 0) {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }

        const keyPath = buildAtRestKeyPath({ accountId: userId, serviceId, profileId });
        const json = row.metadata.storage === "server_sealed_json_v1"
            ? decryptString(keyPath, row.snapshot as any)
            : decodeUtf8String(row.snapshot);
        if (!json.trim()) {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }

        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(json);
        } catch {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }

        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.safeParse(parsedJson);
        if (!snapshot.success) {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }
        if (snapshot.data.serviceId !== serviceId || snapshot.data.profileId !== profileId) {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }

        const refreshRequestedAt =
            typeof row.metadata.refreshRequestedAt === "number"
                ? Math.max(0, Math.trunc(row.metadata.refreshRequestedAt))
                : undefined;

        return reply.send({
            content: { t: "plain", v: snapshot.data },
            metadata: {
                fetchedAt: row.fetchedAt ? row.fetchedAt.getTime() : Date.now(),
                staleAfterMs: typeof row.staleAfterMs === "number" ? row.staleAfterMs : 0,
                status: normalizeStatus(row.status),
                ...(refreshRequestedAt !== undefined ? { refreshRequestedAt } : {}),
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

        const account = await db.account.findUnique({
            where: { id: userId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (!account) return reply.code(404).send({ error: "connect_quotas_not_found" });

        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
        if (mode !== "plain") return reply.code(404).send({ error: "connect_quotas_not_found" });

        const atRest = resolveAtRestStoragePolicy(process.env);
        const canonicalProjection = await readProviderAccountUsageProjectionForConnectedService({
            accountId: userId,
            serviceId,
            profileId,
        });
        await writeProviderAccountUsageRefreshRequest({
            accountId: userId,
            recordId: canonicalProjection?.recordId ?? buildConnectedServiceFallbackProviderAccountUsageRecordId({ serviceId, profileId }),
            storage: atRest === "server_sealed" ? "server_sealed_json_v1" : "plain_json_v1",
        });

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

        const account = await db.account.findUnique({
            where: { id: userId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (!account) return reply.code(404).send({ error: "connect_quotas_not_found" });

        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
        if (mode !== "plain") return reply.code(404).send({ error: "connect_quotas_not_found" });

        const aliasRemoval = await removeConnectedServiceAliasFromProviderAccountUsageProjection({
            accountId: userId,
            serviceId,
            profileId,
        });
        const existingLegacy = await db.serviceAccountQuotaSnapshot.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            select: { id: true },
        });
        if (!existingLegacy && aliasRemoval === "not_found") {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }

        if (existingLegacy) {
            await db.serviceAccountQuotaSnapshot.delete({ where: { id: existingLegacy.id } });
        }
        return reply.send({ success: true });
    });
}
