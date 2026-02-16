import { z } from "zod";

import { type Fastify } from "../../types";
import { db } from "@/storage/db";
import {
    ConnectedServiceIdSchema,
    SealedConnectedServiceQuotaSnapshotV1Schema,
    type ConnectedServiceId,
} from "@happier-dev/protocol";

const MAX_QUOTA_SNAPSHOT_CIPHERTEXT_CHARS = 200_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function encodeQuotaSnapshotBytes(ciphertext: string): Uint8Array {
    return Buffer.from(ciphertext, "utf8");
}

function decodeQuotaSnapshotCiphertext(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("utf8");
}

export function connectConnectedServicesQuotasV2Routes(app: Fastify) {
    app.post("/v2/connect/:serviceId/profiles/:profileId/quotas", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: z.string().min(1),
            }),
            body: z.object({
                sealed: SealedConnectedServiceQuotaSnapshotV1Schema.extend({
                    ciphertext: z.string().min(1).max(MAX_QUOTA_SNAPSHOT_CIPHERTEXT_CHARS),
                }),
                metadata: z.object({
                    fetchedAt: z.number().int().nonnegative(),
                    staleAfterMs: z.number().int().nonnegative(),
                    status: z.enum(["ok", "unavailable", "estimated", "error"]),
                }),
            }),
            response: { 200: z.object({ success: z.literal(true) }) },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;
        const sealed = request.body.sealed;
        const meta = request.body.metadata;

        const metadata: Record<string, unknown> = { v: 1, format: sealed.format };

        await db.serviceAccountQuotaSnapshot.upsert({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            update: {
                updatedAt: new Date(),
                snapshot: encodeQuotaSnapshotBytes(sealed.ciphertext),
                status: meta.status,
                fetchedAt: new Date(meta.fetchedAt),
                staleAfterMs: meta.staleAfterMs,
                metadata,
            },
            create: {
                accountId: userId,
                vendor: serviceId,
                profileId,
                snapshot: encodeQuotaSnapshotBytes(sealed.ciphertext),
                status: meta.status,
                fetchedAt: new Date(meta.fetchedAt),
                staleAfterMs: meta.staleAfterMs,
                metadata,
            },
        });

        return reply.send({ success: true });
    });

    app.get("/v2/connect/:serviceId/profiles/:profileId/quotas", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: z.string().min(1),
            }),
            response: {
                200: z.object({
                    sealed: SealedConnectedServiceQuotaSnapshotV1Schema,
                    metadata: z.object({
                        fetchedAt: z.number().int().nonnegative(),
                        staleAfterMs: z.number().int().nonnegative(),
                        status: z.enum(["ok", "unavailable", "estimated", "error"]),
                        refreshRequestedAt: z.number().int().nonnegative().optional(),
                    }),
                }),
                404: z.object({ error: z.literal("connect_quotas_not_found") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const row = await db.serviceAccountQuotaSnapshot.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            select: { snapshot: true, fetchedAt: true, staleAfterMs: true, status: true, metadata: true },
        });
        if (!row) return reply.code(404).send({ error: "connect_quotas_not_found" });

        const rowMetadata = isRecord(row.metadata) ? row.metadata : null;
        const format = rowMetadata?.format === "account_scoped_v1" ? "account_scoped_v1" : "account_scoped_v1";
        const refreshRequestedAt =
            typeof rowMetadata?.refreshRequestedAt === "number"
                ? Math.max(0, Math.trunc(rowMetadata.refreshRequestedAt))
                : undefined;
        const status =
            row.status === "ok" || row.status === "unavailable" || row.status === "estimated" || row.status === "error"
                ? row.status
                : "ok";

        return reply.send({
            sealed: {
                format,
                ciphertext: decodeQuotaSnapshotCiphertext(row.snapshot),
            },
            metadata: {
                fetchedAt: row.fetchedAt ? row.fetchedAt.getTime() : Date.now(),
                staleAfterMs: typeof row.staleAfterMs === "number" ? row.staleAfterMs : 0,
                status,
                ...(refreshRequestedAt !== undefined ? { refreshRequestedAt } : {}),
            },
        });
    });

    app.post("/v2/connect/:serviceId/profiles/:profileId/quotas/refresh", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: z.string().min(1),
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.object({ error: z.literal("connect_quotas_not_found") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const existing = await db.serviceAccountQuotaSnapshot.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            select: { id: true, metadata: true },
        });
        if (!existing) return reply.code(404).send({ error: "connect_quotas_not_found" });

        const nextMetadata =
            isRecord(existing.metadata)
                ? { ...existing.metadata, refreshRequestedAt: Date.now() }
                : { refreshRequestedAt: Date.now() };

        await db.serviceAccountQuotaSnapshot.update({
            where: { id: existing.id },
            data: {
                updatedAt: new Date(),
                metadata: nextMetadata,
            },
        });

        return reply.send({ success: true });
    });

    app.delete("/v2/connect/:serviceId/profiles/:profileId/quotas", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: z.string().min(1),
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.object({ error: z.literal("connect_quotas_not_found") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const existing = await db.serviceAccountQuotaSnapshot.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            select: { id: true },
        });
        if (!existing) return reply.code(404).send({ error: "connect_quotas_not_found" });

        await db.serviceAccountQuotaSnapshot.delete({ where: { id: existing.id } });
        return reply.send({ success: true });
    });
}
