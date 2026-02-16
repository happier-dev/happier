import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { type Fastify } from "../../types";
import { db } from "@/storage/db";
import { parseIntEnv } from "@/config/env";
import {
    ConnectedServiceIdSchema,
    SealedConnectedServiceCredentialV1Schema,
    type ConnectedServiceId,
} from "@happier-dev/protocol";
import {
    ConnectedServiceOauthStateMismatchError,
    ConnectedServiceOauthTimeoutError,
    exchangeConnectedServiceOauthTokens,
} from "./connectedServicesV2/exchangeConnectedServiceOauthTokens";
import {
    type ConnectedServiceCredentialMetadataV2,
    isConnectedServiceCredentialMetadataV2,
} from "./connectedServicesV2/credentialMetadataV2";

function resolveCredentialMaxLen(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(env.CONNECTED_SERVICE_CREDENTIAL_MAX_LEN, 64_000, { min: 1, max: 2_000_000 });
}

function resolveRefreshLeaseMaxMs(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(env.CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS, 5 * 60_000, { min: 5_000, max: 60 * 60_000 });
}

const ConnectedServiceProfileIdSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "Invalid profile id");

const CONNECTED_SERVICE_OAUTH_PUBLIC_KEY_MAX_LEN = 512;
const CONNECTED_SERVICE_OAUTH_CODE_MAX_LEN = 4096;
const CONNECTED_SERVICE_OAUTH_VERIFIER_MAX_LEN = 256;
const CONNECTED_SERVICE_OAUTH_REDIRECT_URI_MAX_LEN = 2048;
const CONNECTED_SERVICE_OAUTH_STATE_MAX_LEN = 2048;

const ConnectedServiceOauthExchangeErrorResponseSchema = z.union([
    z.object({
        error: z.enum([
            "connect_oauth_state_mismatch",
            "connect_oauth_timeout",
            "connect_oauth_exchange_failed",
        ]),
    }),
    // Fastify validation errors can occur before the handler (e.g. max-length checks). When using
    // zod serializerCompiler, ensure we accept the default error shape for 400 responses.
    z.object({
        statusCode: z.literal(400),
        error: z.string().min(1),
        message: z.string().min(1),
    }).passthrough(),
]);

const credentialTokenEncoder = new TextEncoder();
const credentialTokenDecoder = new TextDecoder();

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

function resolveCredentialTokenString(tokenBytes: Uint8Array): string {
    return credentialTokenDecoder.decode(tokenBytes);
}

function encodeCredentialTokenBytes(ciphertext: string): Uint8Array<ArrayBuffer> {
    return toPrismaBytes(credentialTokenEncoder.encode(ciphertext));
}

export function connectConnectedServicesV2Routes(app: Fastify) {
    const refreshLeaseMaxMs = resolveRefreshLeaseMaxMs(process.env);
    const credentialMaxLen = resolveCredentialMaxLen(process.env);

    // Back-compat shims (v1), operating on profileId="default".
    app.post("/v1/connect/:vendor/register-sealed", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                vendor: ConnectedServiceIdSchema,
            }),
            body: z.object({
                sealed: SealedConnectedServiceCredentialV1Schema,
                metadata: z.object({
                    kind: z.enum(["oauth", "token"]),
                    providerEmail: z.string().min(1).nullable().optional(),
                    providerAccountId: z.string().min(1).nullable().optional(),
                    expiresAt: z.number().int().nonnegative().nullable().optional(),
                }).optional(),
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                413: z.object({ error: z.literal("connect_credential_invalid") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.vendor satisfies ConnectedServiceId;
        const profileId = "default";
        const sealed = request.body.sealed;
        const meta = request.body.metadata;

        if (sealed.ciphertext.length > credentialMaxLen) {
            return reply.code(413).send({ error: "connect_credential_invalid" });
        }

        const metadata: ConnectedServiceCredentialMetadataV2 = {
            v: 2,
            format: sealed.format,
            kind: meta?.kind ?? "oauth",
            providerEmail: meta?.providerEmail ?? null,
            providerAccountId: meta?.providerAccountId ?? null,
        };
        const prismaMetadata: Prisma.InputJsonValue = metadata;

        await db.serviceAccountToken.upsert({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            update: {
                updatedAt: new Date(),
                token: encodeCredentialTokenBytes(sealed.ciphertext),
                metadata: prismaMetadata,
                expiresAt: meta?.expiresAt ? new Date(meta.expiresAt) : null,
            },
            create: {
                accountId: userId,
                vendor: serviceId,
                profileId,
                token: encodeCredentialTokenBytes(sealed.ciphertext),
                metadata: prismaMetadata,
                expiresAt: meta?.expiresAt ? new Date(meta.expiresAt) : null,
            },
        });

        return reply.send({ success: true });
    });

    app.get("/v1/connect/:vendor/credential", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                vendor: ConnectedServiceIdSchema,
            }),
            response: {
                200: z.object({
                    sealed: SealedConnectedServiceCredentialV1Schema,
                    metadata: z.object({
                        kind: z.enum(["oauth", "token"]),
                        providerEmail: z.string().nullable().optional(),
                        providerAccountId: z.string().nullable().optional(),
                        expiresAt: z.number().int().nonnegative().nullable().optional(),
                    }),
                }),
                404: z.object({ error: z.literal("connect_credential_not_found") }),
                409: z.object({ error: z.literal("connect_credential_unsupported_format") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.vendor satisfies ConnectedServiceId;
        const profileId = "default";

        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            select: { token: true, metadata: true, expiresAt: true },
        });
        if (!row) return reply.code(404).send({ error: "connect_credential_not_found" });

        if (!isConnectedServiceCredentialMetadataV2(row.metadata)) {
            return reply.code(409).send({ error: "connect_credential_unsupported_format" });
        }

        return reply.send({
            sealed: {
                format: row.metadata.format,
                ciphertext: resolveCredentialTokenString(row.token),
            },
            metadata: {
                kind: row.metadata.kind,
                providerEmail: row.metadata.providerEmail ?? null,
                providerAccountId: row.metadata.providerAccountId ?? null,
                expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
            },
        });
    });

    app.post("/v2/connect/:serviceId/oauth/exchange", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
            }),
            body: z.object({
                publicKey: z.string().min(1).max(CONNECTED_SERVICE_OAUTH_PUBLIC_KEY_MAX_LEN),
                code: z.string().min(1).max(CONNECTED_SERVICE_OAUTH_CODE_MAX_LEN),
                verifier: z.string().min(1).max(CONNECTED_SERVICE_OAUTH_VERIFIER_MAX_LEN),
                redirectUri: z.string().url().max(CONNECTED_SERVICE_OAUTH_REDIRECT_URI_MAX_LEN),
                state: z.string().min(1).max(CONNECTED_SERVICE_OAUTH_STATE_MAX_LEN).nullable().optional(),
            }),
            response: {
                200: z.object({ bundle: z.string().min(1) }),
                400: ConnectedServiceOauthExchangeErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        if (serviceId === "anthropic") {
            const state = typeof request.body.state === "string" ? request.body.state.trim() : "";
            if (!state) {
                return reply.code(400).send({ error: "connect_oauth_state_mismatch" });
            }
        }
        try {
            const exchanged = await exchangeConnectedServiceOauthTokens({
                serviceId,
                publicKeyB64Url: request.body.publicKey,
                code: request.body.code,
                verifier: request.body.verifier,
                redirectUri: request.body.redirectUri,
                state: request.body.state ?? null,
                now: Date.now(),
            });
            return reply.send({ bundle: exchanged.bundleB64Url });
        } catch (error) {
            if (error instanceof ConnectedServiceOauthTimeoutError) {
                return reply.code(400).send({ error: "connect_oauth_timeout" });
            }
            if (error instanceof ConnectedServiceOauthStateMismatchError) {
                return reply.code(400).send({ error: "connect_oauth_state_mismatch" });
            }
            return reply.code(400).send({ error: "connect_oauth_exchange_failed" });
        }
    });

    app.post("/v2/connect/:serviceId/profiles/:profileId/credential", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            body: z.object({
                sealed: SealedConnectedServiceCredentialV1Schema,
                metadata: z.object({
                    kind: z.enum(["oauth", "token"]),
                    providerEmail: z.string().min(1).nullable().optional(),
                    providerAccountId: z.string().min(1).nullable().optional(),
                    expiresAt: z.number().int().nonnegative().nullable().optional(),
                }).optional(),
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                413: z.object({ error: z.literal("connect_credential_invalid") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;
        const sealed = request.body.sealed;
        const meta = request.body.metadata;

        if (sealed.ciphertext.length > credentialMaxLen) {
            return reply.code(413).send({ error: "connect_credential_invalid" });
        }

        const metadata: ConnectedServiceCredentialMetadataV2 = {
            v: 2,
            format: sealed.format,
            kind: meta?.kind ?? "oauth",
            providerEmail: meta?.providerEmail ?? null,
            providerAccountId: meta?.providerAccountId ?? null,
        };
        const prismaMetadata: Prisma.InputJsonValue = metadata;

        await db.serviceAccountToken.upsert({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            update: {
                updatedAt: new Date(),
                token: encodeCredentialTokenBytes(sealed.ciphertext),
                metadata: prismaMetadata,
                expiresAt: meta?.expiresAt ? new Date(meta.expiresAt) : null,
            },
            create: {
                accountId: userId,
                vendor: serviceId,
                profileId,
                token: encodeCredentialTokenBytes(sealed.ciphertext),
                metadata: prismaMetadata,
                expiresAt: meta?.expiresAt ? new Date(meta.expiresAt) : null,
            },
        });

        return reply.send({ success: true });
    });

    app.get("/v2/connect/:serviceId/profiles/:profileId/credential", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            response: {
                200: z.object({
                    sealed: SealedConnectedServiceCredentialV1Schema,
                    metadata: z.object({
                        kind: z.enum(["oauth", "token"]),
                        providerEmail: z.string().nullable().optional(),
                        providerAccountId: z.string().nullable().optional(),
                        expiresAt: z.number().int().nonnegative().nullable().optional(),
                    }),
                }),
                404: z.object({ error: z.literal("connect_credential_not_found") }),
                409: z.object({ error: z.literal("connect_credential_unsupported_format") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            select: { token: true, metadata: true, expiresAt: true },
        });
        if (!row) return reply.code(404).send({ error: "connect_credential_not_found" });

        if (!isConnectedServiceCredentialMetadataV2(row.metadata)) {
            return reply.code(409).send({ error: "connect_credential_unsupported_format" });
        }

        return reply.send({
            sealed: {
                format: row.metadata.format,
                ciphertext: resolveCredentialTokenString(row.token),
            },
            metadata: {
                kind: row.metadata.kind,
                providerEmail: row.metadata.providerEmail ?? null,
                providerAccountId: row.metadata.providerAccountId ?? null,
                expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
            },
        });
    });

    app.delete("/v2/connect/:serviceId/profiles/:profileId/credential", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.object({ error: z.literal("connect_credential_not_found") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const existing = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            select: { id: true },
        });
        if (!existing) return reply.code(404).send({ error: "connect_credential_not_found" });

        await db.serviceAccountToken.delete({ where: { id: existing.id } });
        return reply.send({ success: true });
    });

    app.get("/v2/connect/:serviceId/profiles", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ serviceId: ConnectedServiceIdSchema }),
            response: {
                200: z.object({
                    serviceId: ConnectedServiceIdSchema,
                    profiles: z.array(z.object({
                        profileId: z.string().min(1),
                        status: z.enum(["connected", "needs_reauth"]),
                        kind: z.enum(["oauth", "token"]).nullable().optional(),
                        providerEmail: z.string().nullable().optional(),
                        providerAccountId: z.string().nullable().optional(),
                        expiresAt: z.number().int().nonnegative().nullable().optional(),
                        lastUsedAt: z.number().int().nonnegative().nullable().optional(),
                    })),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;

        const rows = await db.serviceAccountToken.findMany({
            where: { accountId: userId, vendor: serviceId },
            orderBy: { updatedAt: "desc" },
            select: { profileId: true, metadata: true, expiresAt: true, lastUsedAt: true },
        });

        const profiles = rows.map((row) => {
            const meta = isConnectedServiceCredentialMetadataV2(row.metadata) ? row.metadata : null;
            return {
                profileId: row.profileId,
                status: meta ? "connected" as const : "needs_reauth" as const,
                kind: meta?.kind ?? null,
                providerEmail: meta?.providerEmail ?? null,
                providerAccountId: meta?.providerAccountId ?? null,
                expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
                lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
            };
        });

        return reply.send({ serviceId, profiles });
    });

    app.post("/v2/connect/:serviceId/profiles/:profileId/refresh-lease", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            body: z.object({
                machineId: z.string().min(1),
                leaseMs: z.number().int().min(1),
            }),
            response: {
                200: z.object({
                    acquired: z.boolean(),
                    leaseUntil: z.number().int().nonnegative(),
                }),
                404: z.object({ error: z.literal("connect_credential_not_found") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;
        const { machineId } = request.body;
        const leaseMs = Math.min(request.body.leaseMs, refreshLeaseMaxMs);

        const now = Date.now();
        const nextExpiry = new Date(now + leaseMs);

        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            select: { id: true, refreshLeaseOwnerMachineId: true, refreshLeaseExpiresAt: true },
        });
        if (!row) return reply.code(404).send({ error: "connect_credential_not_found" });

        const currentExpiryMs = row.refreshLeaseExpiresAt ? row.refreshLeaseExpiresAt.getTime() : null;
        const isExpired = currentExpiryMs !== null && currentExpiryMs <= now;
        const canAcquire = currentExpiryMs === null || isExpired || row.refreshLeaseOwnerMachineId === machineId;

        if (!canAcquire) {
            return reply.send({ acquired: false, leaseUntil: currentExpiryMs ?? now });
        }

        const updated = await db.serviceAccountToken.update({
            where: { id: row.id },
            data: {
                refreshLeaseOwnerMachineId: machineId,
                refreshLeaseExpiresAt: nextExpiry,
            },
            select: { refreshLeaseExpiresAt: true },
        });

        return reply.send({ acquired: true, leaseUntil: updated.refreshLeaseExpiresAt?.getTime() ?? now });
    });
}
