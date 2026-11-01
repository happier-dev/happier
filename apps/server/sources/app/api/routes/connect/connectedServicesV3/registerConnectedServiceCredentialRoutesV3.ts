import { z } from "zod";
import type { Fastify } from "../../../types";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    CONNECTED_SERVICE_ERROR_CODES,
    ConnectedServiceCredentialHealthV1Schema,
    ConnectedServiceCredentialMutationGuardV1Schema,
    ConnectedServiceCredentialRevisionV1Schema,
    ConnectedServiceCredentialMutationSuccessV1Schema,
    ConnectedServiceCredentialMutationSupersededV1Schema,
    ConnectedServiceCredentialRecordV1Schema,
    buildConnectedServiceCredentialMetadata,
    ConnectedServiceIdSchema,
    StoredJsonContentEnvelopeSchema,
    assertConnectedServiceCredentialRecordBinding,
    type ConnectedServiceId,
} from "@happier-dev/protocol";
import { ConnectedServiceProfileIdSchema } from "../connectedServicesV2/profileIdSchema";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { decryptString, encryptString } from "@/modules/encrypt";
import { decodeUtf8String, encodeUtf8Bytes } from "./bytesCodec";
import {
    isConnectedServiceCredentialMetadataV3,
    normalizeConnectedServiceCredentialMetadataV3,
    type ConnectedServiceCredentialMetadataV3,
} from "./credentialMetadataV3";
import {
    isConnectedServiceCredentialMetadataV2,
    normalizeConnectedServiceCredentialMetadataV2,
} from "../connectedServicesV2/credentialMetadataV2";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";
import { deleteConnectedServiceCredentialInTx } from "./authGroupRepository";
import { ConnectedServiceCredentialDeleteQuerySchema } from "./credentialDeleteQuerySchema";
import { recordConnectedServiceAccountProfileChange } from "../connectedServicesAccountProfileChange";
import {
    mutateConnectedServiceCredential,
    mutateConnectedServiceCredentialHealth,
} from "../credentials/mutation";
import { resolveConnectedServiceCredentialRevision } from "../credentials/credentialRevision";

const MAX_CREDENTIAL_JSON_CHARS = 220_000;

function resolveAtRestStoragePolicy(env: NodeJS.ProcessEnv): "none" | "server_sealed" {
    const encryption = readEncryptionFeatureEnv(env);
    return encryption.plainAccountCredentialsAtRest === "none" ? "none" : "server_sealed";
}

function buildAtRestKeyPath(params: { accountId: string; serviceId: string; profileId: string }): string[] {
    return ["storage", "connect_credential", params.accountId, params.serviceId, params.profileId, "v1"];
}

function toMetadata(record: z.infer<typeof ConnectedServiceCredentialRecordV1Schema>, storage: ConnectedServiceCredentialMetadataV3["storage"]): ConnectedServiceCredentialMetadataV3 {
    const { expiresAt: _expiresAt, ...metadata } = buildConnectedServiceCredentialMetadata(record);
    return { v: 3, storage, ...metadata };
}

export function registerConnectedServiceCredentialRoutesV3(app: Fastify): void {
    app.post("/v3/connect/:serviceId/profiles/:profileId/credential", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            body: ConnectedServiceCredentialMutationGuardV1Schema.safeExtend({
                content: StoredJsonContentEnvelopeSchema,
                reconnect: z.object({
                    allowProviderIdentityChange: z.boolean().optional().default(false),
                }).optional(),
            }),
            response: {
                200: ConnectedServiceCredentialMutationSuccessV1Schema,
                400: z.union([
                    z.object({ error: z.literal("invalid-params") }),
                    z.object({ error: z.literal(CONNECTED_SERVICE_ERROR_CODES.credentialInvalid) }),
                ]),
                409: z.union([
                    z.object({ error: z.literal(CONNECTED_SERVICE_ERROR_CODES.reconnectProviderIdentityMismatch) }),
                    ConnectedServiceCredentialMutationSupersededV1Schema,
                ]),
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
        try {
            assertConnectedServiceCredentialRecordBinding({
                binding: { serviceId, profileId },
                record,
            });
        } catch {
            return reply.code(400).send({ error: CONNECTED_SERVICE_ERROR_CODES.credentialInvalid });
        }

        const incomingIdentity = record.kind === "oauth"
            ? {
                providerEmail: record.oauth.providerEmail,
                providerAccountId: record.oauth.providerAccountId,
            }
            : {
                providerEmail: record.token.providerEmail,
                providerAccountId: record.token.providerAccountId,
            };
        const json = JSON.stringify(record);
        if (json.length > MAX_CREDENTIAL_JSON_CHARS) {
            return reply.code(400).send({ error: "invalid-params" });
        }

        const atRest = resolveAtRestStoragePolicy(process.env);
        const keyPath = buildAtRestKeyPath({ accountId: userId, serviceId, profileId });
        const tokenBytes = atRest === "server_sealed"
            ? (encryptString(keyPath, json) as Uint8Array<ArrayBuffer>)
            : encodeUtf8Bytes(json);

        const metadata = toMetadata(record, atRest === "server_sealed" ? "server_sealed_json_v1" : "plain_json_v1");
        const expiresAt = typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) ? new Date(record.expiresAt) : null;

        const result = await mutateConnectedServiceCredential({
            accountId: userId,
            serviceId,
            profileId,
            token: tokenBytes,
            metadata,
            expiresAt,
            storageMode: "plain",
            incomingIdentity,
            allowProviderIdentityChange: request.body.reconnect?.allowProviderIdentityChange === true,
            ...(request.body.expectedCredentialRevision !== undefined
                ? { expectedCredentialRevision: request.body.expectedCredentialRevision }
                : {}),
            ...(request.body.refreshLeaseOwnerId
                ? { refreshLeaseOwnerId: request.body.refreshLeaseOwnerId }
                : {}),
        });
        if (result.status === "provider_identity_mismatch") {
            return reply.code(409).send({ error: CONNECTED_SERVICE_ERROR_CODES.reconnectProviderIdentityMismatch });
        }
        if (result.status === "storage_mode_mismatch") {
            return reply.code(400).send({ error: "invalid-params" });
        }
        if (result.status === "superseded") {
            return reply.code(409).send({
                error: CONNECTED_SERVICE_ERROR_CODES.credentialMutationSuperseded,
                reason: result.reason,
                credentialRevision: result.credentialRevision,
            });
        }

        return reply.send({ success: true, credentialRevision: result.credentialRevision });
    });

    app.patch("/v3/connect/:serviceId/profiles/:profileId/credential/health", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            body: z.object({
                health: ConnectedServiceCredentialHealthV1Schema,
                expectedCredentialRevision: z.string().trim().min(1).max(128).optional(),
            }).strict(),
            response: {
                200: z.object({ success: z.literal(true), credentialRevision: ConnectedServiceCredentialRevisionV1Schema }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
                409: z.union([
                    z.object({ error: z.literal("connect_credential_unsupported_format") }),
                    z.object({
                        error: z.literal(CONNECTED_SERVICE_ERROR_CODES.credentialMutationSuperseded),
                        reason: z.literal("revision_mismatch"),
                        credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
                    }),
                ]),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;
        const result = await mutateConnectedServiceCredentialHealth({
            accountId: userId,
            serviceId,
            profileId,
            health: request.body.health,
            ...(request.body.expectedCredentialRevision
                ? { expectedCredentialRevision: request.body.expectedCredentialRevision }
                : {}),
        });
        if (result.status === "not_found") {
            return reply.code(404).send({ error: "connect_credential_not_found" });
        }
        if (result.status === "unsupported_format") {
            return reply.code(409).send({ error: "connect_credential_unsupported_format" });
        }
        if (result.status === "superseded") {
            return reply.code(409).send({
                error: CONNECTED_SERVICE_ERROR_CODES.credentialMutationSuperseded,
                reason: result.reason,
                credentialRevision: result.credentialRevision,
            });
        }

        return reply.send({ success: true, credentialRevision: result.credentialRevision });
    });

    app.get("/v3/connect/:serviceId/profiles/:profileId/credential", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            response: {
                200: z.object({ credentialRevision: ConnectedServiceCredentialRevisionV1Schema, content: StoredJsonContentEnvelopeSchema }),
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
            select: { id: true, token: true, metadata: true },
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
        try {
            assertConnectedServiceCredentialRecordBinding({
                binding: { serviceId, profileId },
                record: record.data,
            });
        } catch {
            return reply.code(409).send({ error: "connect_credential_unsupported_format" });
        }

        return reply.send({
            credentialRevision: resolveConnectedServiceCredentialRevision({ rowId: row.id, metadata: row.metadata }),
            content: { t: "plain", v: record.data },
        });
    });

    app.delete("/v3/connect/:serviceId/profiles/:profileId/credential", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            querystring: ConnectedServiceCredentialDeleteQuerySchema,
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
                409: z.union([
                    z.object({ error: z.literal("connect_credential_referenced_by_group") }),
                    ConnectedServiceCredentialMutationSupersededV1Schema,
                ]),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const result = await inTx(async (tx) => {
            const deleteResult = await deleteConnectedServiceCredentialInTx(tx, {
                accountId: userId,
                serviceId,
                profileId,
                storageMode: "plain",
                ...(request.query.expectedCredentialRevision
                    ? { expectedCredentialRevision: request.query.expectedCredentialRevision }
                    : {}),
                allowReferencedGroupCleanup: request.query.cleanupGroupReferences === true
                    || !isServerFeatureEnabledForRequest("connectedServices.accountGroups", process.env),
            });
            if (deleteResult === "deleted") {
                await recordConnectedServiceAccountProfileChange(tx, { accountId: userId });
            }
            return deleteResult;
        });
        if (result === "storage_mode_mismatch") {
            return reply.code(404).send({ error: "connect_credential_not_found" });
        }
        if (result === "not_found") {
            return reply.code(404).send({ error: "connect_credential_not_found" });
        }
        if (result === "referenced") {
            return reply.code(409).send({ error: "connect_credential_referenced_by_group" });
        }
        if (typeof result === "object" && result.type === "superseded") {
            return reply.code(409).send({
                error: CONNECTED_SERVICE_ERROR_CODES.credentialMutationSuperseded,
                reason: "revision_mismatch",
                credentialRevision: result.credentialRevision,
            });
        }

        return reply.send({ success: true });
    });
}
