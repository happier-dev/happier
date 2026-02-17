import { z } from "zod";

import { type Fastify } from "../../types";
import { db } from "@/storage/db";
import {
    ConnectedServiceIdSchema,
    SealedConnectedServiceQuotaSnapshotV1Schema,
    type ConnectedServiceId,
} from "@happier-dev/protocol";
import { NotFoundSchema } from "../../schemas/notFoundSchema";

const MAX_QUOTA_SNAPSHOT_CIPHERTEXT_CHARS = 200_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

const quotaSnapshotEncoder = new TextEncoder();
const quotaSnapshotDecoder = new TextDecoder();

function toPrismaBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    if (bytes.buffer instanceof ArrayBuffer) {
        const sliced = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        return new Uint8Array(sliced);
    }
    const buffer = new ArrayBuffer(bytes.byteLength);
    const copy = new Uint8Array(buffer);
    copy.set(bytes);
    return copy;
}

function encodeQuotaSnapshotBytes(ciphertext: string): Uint8Array<ArrayBuffer> {
    return toPrismaBytes(quotaSnapshotEncoder.encode(ciphertext));
}

function decodeQuotaSnapshotCiphertext(bytes: Uint8Array): string {
    return quotaSnapshotDecoder.decode(bytes);
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
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_quotas_not_found") })]),
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

        const ciphertext = decodeQuotaSnapshotCiphertext(row.snapshot);
        if (!ciphertext.trim()) {
            // A refresh request may have created a placeholder row before the daemon uploaded a real snapshot.
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }

        return reply.send({
            sealed: {
                format,
                ciphertext,
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
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const where = { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } };
        const existing = await db.serviceAccountQuotaSnapshot.findUnique({ where, select: { metadata: true } });

        const baseMetadata = isRecord(existing?.metadata) ? existing?.metadata : {};
        const nextMetadata: Record<string, unknown> = {
            ...baseMetadata,
            v: 1,
            format: "account_scoped_v1",
            refreshRequestedAt: Date.now(),
        };

        await db.serviceAccountQuotaSnapshot.upsert({
            where,
            update: {
                updatedAt: new Date(),
                metadata: nextMetadata,
            },
            create: {
                accountId: userId,
                vendor: serviceId,
                profileId,
                snapshot: encodeQuotaSnapshotBytes(""),
                status: null,
                fetchedAt: null,
                staleAfterMs: 0,
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
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_quotas_not_found") })]),
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
