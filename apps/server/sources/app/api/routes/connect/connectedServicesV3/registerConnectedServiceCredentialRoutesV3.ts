import { z } from "zod";
import type { Prisma } from "@prisma/client";

import type { Fastify } from "../../../types";
import { db } from "@/storage/db";
import {
    ConnectedServiceCredentialRecordV1Schema,
    ConnectedServiceIdSchema,
    StoredJsonContentEnvelopeSchema,
    type ConnectedServiceId,
} from "@happier-dev/protocol";
import { ConnectedServiceProfileIdSchema } from "../connectedServicesV2/profileIdSchema";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { decryptString, encryptString } from "@/modules/encrypt";
import { decodeUtf8String, encodeUtf8Bytes } from "./bytesCodec";
import { isConnectedServiceCredentialMetadataV3, type ConnectedServiceCredentialMetadataV3 } from "./credentialMetadataV3";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";

const MAX_CREDENTIAL_JSON_CHARS = 220_000;

function resolveAtRestStoragePolicy(env: NodeJS.ProcessEnv): "none" | "server_sealed" {
    const encryption = readEncryptionFeatureEnv(env);
    return encryption.plainAccountCredentialsAtRest === "none" ? "none" : "server_sealed";
}

function buildAtRestKeyPath(params: { accountId: string; serviceId: string; profileId: string }): string[] {
    return ["storage", "connect_credential", params.accountId, params.serviceId, params.profileId, "v1"];
}

function toMetadata(record: z.infer<typeof ConnectedServiceCredentialRecordV1Schema>, storage: ConnectedServiceCredentialMetadataV3["storage"]): ConnectedServiceCredentialMetadataV3 {
    const providerEmail =
        record.kind === "oauth"
            ? record.oauth?.providerEmail ?? null
            : record.token?.providerEmail ?? null;
    const providerAccountId =
        record.kind === "oauth"
            ? record.oauth?.providerAccountId ?? null
            : record.token?.providerAccountId ?? null;
    return {
        v: 3,
        storage,
        kind: record.kind,
        providerEmail,
        providerAccountId,
    };
}

export function registerConnectedServiceCredentialRoutesV3(app: Fastify): void {
    app.post("/v3/connect/:serviceId/profiles/:profileId/credential", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            body: z.object({
                content: StoredJsonContentEnvelopeSchema,
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
        if (mode !== "plain") {
            return reply.code(400).send({ error: "invalid-params" });
        }

        const content = request.body.content;
        if (content.t !== "plain") {
            return reply.code(400).send({ error: "invalid-params" });
        }

        const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(content.v);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid-params" });
        }
        const record = parsed.data;
        const json = JSON.stringify(record);
        if (json.length > MAX_CREDENTIAL_JSON_CHARS) {
            return reply.code(400).send({ error: "invalid-params" });
        }

        const atRest = resolveAtRestStoragePolicy(process.env);
        const keyPath = buildAtRestKeyPath({ accountId: userId, serviceId, profileId });
        const tokenBytes = atRest === "server_sealed"
            ? (encryptString(keyPath, json) as Uint8Array<ArrayBuffer>)
            : encodeUtf8Bytes(json);

        const metadata: Prisma.InputJsonValue = toMetadata(record, atRest === "server_sealed" ? "server_sealed_json_v1" : "plain_json_v1");
        const expiresAt = typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) ? new Date(record.expiresAt) : null;

        await db.serviceAccountToken.upsert({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            update: { updatedAt: new Date(), token: tokenBytes, metadata, expiresAt },
            create: { accountId: userId, vendor: serviceId, profileId, token: tokenBytes, metadata, expiresAt },
        });

        return reply.send({ success: true });
    });

    app.get("/v3/connect/:serviceId/profiles/:profileId/credential", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            response: {
                200: z.object({ content: StoredJsonContentEnvelopeSchema }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
                409: z.object({ error: z.literal("connect_credential_unsupported_format") }),
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
        if (!account) return reply.code(404).send({ error: "connect_credential_not_found" });

        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
        if (mode !== "plain") {
            return reply.code(404).send({ error: "connect_credential_not_found" });
        }

        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            select: { token: true, metadata: true },
        });
        if (!row) return reply.code(404).send({ error: "connect_credential_not_found" });

        if (!isConnectedServiceCredentialMetadataV3(row.metadata)) {
            return reply.code(409).send({ error: "connect_credential_unsupported_format" });
        }

        const keyPath = buildAtRestKeyPath({ accountId: userId, serviceId, profileId });
        const json = row.metadata.storage === "server_sealed_json_v1"
            ? decryptString(keyPath, row.token as any)
            : decodeUtf8String(row.token);

        let parsed: unknown;
        try {
            parsed = JSON.parse(json);
        } catch {
            return reply.code(409).send({ error: "connect_credential_unsupported_format" });
        }

        const record = ConnectedServiceCredentialRecordV1Schema.safeParse(parsed);
        if (!record.success) {
            return reply.code(409).send({ error: "connect_credential_unsupported_format" });
        }

        return reply.send({ content: { t: "plain", v: record.data } });
    });

    app.delete("/v3/connect/:serviceId/profiles/:profileId/credential", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
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
        if (!account) return reply.code(404).send({ error: "connect_credential_not_found" });

        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
        if (mode !== "plain") {
            return reply.code(404).send({ error: "connect_credential_not_found" });
        }

        const existing = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            select: { id: true },
        });
        if (!existing) return reply.code(404).send({ error: "connect_credential_not_found" });

        await db.serviceAccountToken.delete({ where: { id: existing.id } });
        return reply.send({ success: true });
    });
}
