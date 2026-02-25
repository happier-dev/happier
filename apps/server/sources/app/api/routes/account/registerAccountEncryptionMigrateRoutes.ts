import { z } from "zod";

import { type Fastify } from "../../types";
import { inTx } from "@/storage/inTx";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    AccountSettingsStoredContentEnvelopeSchema,
    ConnectedServiceCredentialRecordV1Schema,
    ConnectedServiceIdSchema,
    SealedConnectedServiceCredentialV1Schema,
} from "@happier-dev/protocol";
import { storePlainAccountSettingsDbValue } from "@/app/encryption/accountSettingsStorage";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { encodeCredentialTokenBytes } from "@/app/api/routes/connect/connectedServicesV2/credentialTokenCodec";
import { ConnectedServiceProfileIdSchema } from "@/app/api/routes/connect/connectedServicesV2/profileIdSchema";
import { encryptString } from "@/modules/encrypt";
import { encodeUtf8Bytes } from "@/app/api/routes/connect/connectedServicesV3/bytesCodec";
import { AutomationValidationError, parseAutomationPatchInput } from "@/app/automations/automationValidation";

const KeyProofSchema = z.object({
    publicKey: z.string().min(1),
    challenge: z.string().min(1),
    signature: z.string().min(1),
    contentPublicKey: z.string().min(1).optional(),
    contentPublicKeySig: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
    const hasContentKey = typeof value.contentPublicKey === "string";
    const hasContentSig = typeof value.contentPublicKeySig === "string";
    if (hasContentKey !== hasContentSig) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "contentPublicKey and contentPublicKeySig must be provided together",
        });
    }
});

const ConnectedServiceCredentialMigrationItemSchema = z.object({
    serviceId: ConnectedServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema,
    kind: z.enum(["plain", "sealed"]),
    record: ConnectedServiceCredentialRecordV1Schema.optional(),
    sealed: SealedConnectedServiceCredentialV1Schema.optional(),
    metadata: z.object({
        kind: z.enum(["oauth", "token"]),
        providerEmail: z.string().min(1).nullable().optional(),
        providerAccountId: z.string().min(1).nullable().optional(),
        expiresAt: z.number().int().nonnegative().nullable().optional(),
    }).optional(),
}).strict().superRefine((value, ctx) => {
    if (value.kind === "plain") {
        if (!value.record) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "record is required for plain migrations" });
        }
        if (value.sealed) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sealed must not be provided for plain migrations" });
        }
    } else {
        if (!value.sealed) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sealed is required for sealed migrations" });
        }
        if (value.record) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "record must not be provided for sealed migrations" });
        }
    }
});

const ConnectedServicesDirectiveSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("assert_empty") }).strict(),
    z.object({ action: z.literal("clear") }).strict(),
    z.object({
        action: z.literal("migrate"),
        credentials: z.array(ConnectedServiceCredentialMigrationItemSchema).max(500),
    }).strict(),
]);

const AutomationsMigrationItemSchema = z.object({
    automationId: z.string().min(1),
    templateCiphertext: z.string().min(1),
}).strict();

const AutomationsDirectiveSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("assert_empty") }).strict(),
    z.object({ action: z.literal("clear") }).strict(),
    z.object({ action: z.literal("migrate"), templates: z.array(AutomationsMigrationItemSchema).max(500) }).strict(),
]);

const MigrateRequestSchema = z.object({
    toMode: z.enum(["plain", "e2ee"]),
    expectedSettingsVersion: z.number().int().min(0),
    settingsContent: AccountSettingsStoredContentEnvelopeSchema.nullable(),
    connectedServices: ConnectedServicesDirectiveSchema,
    automations: AutomationsDirectiveSchema,
    keyProof: KeyProofSchema.optional(),
}).strict();

export function registerAccountEncryptionMigrateRoutes(app: Fastify): void {
    app.post("/v1/account/encryption/migrate", {
        preHandler: app.authenticate,
        schema: {
            body: MigrateRequestSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    mode: z.enum(["plain", "e2ee"]),
                    settingsVersion: z.number().int().min(0),
                }).strict(),
                400: z.object({ error: z.enum(["invalid-params", "connected_services_not_empty", "automations_not_empty"]) }).strict(),
                403: z.object({ error: z.enum(["e2ee-required", "plaintext-only"]) }).strict(),
                404: z.object({ error: z.literal("not_found") }).strict(),
                409: z.object({ error: z.literal("version-mismatch"), currentVersion: z.number().int().min(0) }).strict(),
                500: z.object({ error: z.literal("internal") }).strict(),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { toMode, expectedSettingsVersion, settingsContent, connectedServices, automations, keyProof } = request.body;

        const encryptionEnv = readEncryptionFeatureEnv(process.env);

        if (toMode === "plain") {
            if (encryptionEnv.storagePolicy === "required_e2ee") {
                return reply.code(403).send({ error: "e2ee-required" });
            }
            if (encryptionEnv.storagePolicy === "optional" && !encryptionEnv.allowAccountOptOut) {
                return reply.code(404).send({ error: "not_found" });
            }
        } else {
            if (encryptionEnv.storagePolicy === "plaintext_only") {
                return reply.code(403).send({ error: "plaintext-only" });
            }
        }

        if (toMode === "plain") {
            if (settingsContent && settingsContent.t !== "plain") {
                return reply.code(400).send({ error: "invalid-params" });
            }
        } else {
            if (settingsContent && settingsContent.t !== "encrypted") {
                return reply.code(400).send({ error: "invalid-params" });
            }
            if (!keyProof) {
                return reply.code(400).send({ error: "invalid-params" });
            }
        }

        try {
            const result = await inTx(async (tx) => {
                const account = await tx.account.findUnique({
                    where: { id: userId },
                    select: {
                        publicKey: true,
                        encryptionMode: true,
                        settingsVersion: true,
                    },
                });
                if (!account) return { type: "internal-error" as const };
                // Note: treat the migration request as authoritative; it may be used to rewrite settings even
                // when the account is already in the requested mode.

                if (account.settingsVersion !== expectedSettingsVersion) {
                    return { type: "version-mismatch" as const, currentVersion: account.settingsVersion };
                }

                let publicKeyHexUpdate: string | null = null;
                let contentPublicKeyUpdate: Uint8Array<ArrayBuffer> | null = null;
                let contentPublicKeySigUpdate: Uint8Array<ArrayBuffer> | null = null;
                if (toMode === "e2ee") {
                    let publicKeyBytes: Uint8Array;
                    let challengeBytes: Uint8Array;
                    let signatureBytes: Uint8Array;
                    try {
                        publicKeyBytes = privacyKit.decodeBase64(keyProof!.publicKey);
                        challengeBytes = privacyKit.decodeBase64(keyProof!.challenge);
                        signatureBytes = privacyKit.decodeBase64(keyProof!.signature);
                    } catch {
                        return { type: "invalid-params" as const };
                    }
                    if (publicKeyBytes.length !== tweetnacl.sign.publicKeyLength) {
                        return { type: "invalid-params" as const };
                    }
                    if (signatureBytes.length !== tweetnacl.sign.signatureLength) {
                        return { type: "invalid-params" as const };
                    }
                    const signatureOk = tweetnacl.sign.detached.verify(challengeBytes, signatureBytes, publicKeyBytes);
                    if (!signatureOk) {
                        return { type: "invalid-params" as const };
                    }
                    const publicKeyHex = privacyKit.encodeHex(new Uint8Array(publicKeyBytes));
                    if (account.publicKey && account.publicKey !== publicKeyHex) {
                        return { type: "invalid-params" as const };
                    }
                    publicKeyHexUpdate = publicKeyHex;

                    if (keyProof!.contentPublicKey && keyProof!.contentPublicKeySig) {
                        let contentPublicKey: Uint8Array;
                        let contentPublicKeySig: Uint8Array;
                        try {
                            contentPublicKey = privacyKit.decodeBase64(keyProof!.contentPublicKey);
                            contentPublicKeySig = privacyKit.decodeBase64(keyProof!.contentPublicKeySig);
                        } catch {
                            return { type: "invalid-params" as const };
                        }
                        if (contentPublicKey.length !== tweetnacl.box.publicKeyLength) {
                            return { type: "invalid-params" as const };
                        }
                        if (contentPublicKeySig.length !== tweetnacl.sign.signatureLength) {
                            return { type: "invalid-params" as const };
                        }
                        const binding = Buffer.concat([
                            Buffer.from("Happy content key v1\u0000", "utf8"),
                            Buffer.from(contentPublicKey),
                        ]);
                        const contentSigOk = tweetnacl.sign.detached.verify(binding, contentPublicKeySig, publicKeyBytes);
                        if (!contentSigOk) {
                            return { type: "invalid-params" as const };
                        }
                        // Prisma's bytes fields are typed as Uint8Array<ArrayBuffer>, but some decoders return
                        // Uint8Array<ArrayBufferLike> (which includes SharedArrayBuffer). Copy into a fresh
                        // ArrayBuffer-backed view for Prisma compatibility.
                        const contentPublicKeyCopy = new Uint8Array(contentPublicKey.byteLength);
                        contentPublicKeyCopy.set(contentPublicKey);
                        contentPublicKeyUpdate = contentPublicKeyCopy;

                        const contentPublicKeySigCopy = new Uint8Array(contentPublicKeySig.byteLength);
                        contentPublicKeySigCopy.set(contentPublicKeySig);
                        contentPublicKeySigUpdate = contentPublicKeySigCopy;
                    }
                }

                if (connectedServices.action === "assert_empty") {
                    const count = await tx.serviceAccountToken.count({ where: { accountId: userId } });
                    if (count > 0) return { type: "connected-services-not-empty" as const };
                } else if (connectedServices.action === "clear") {
                    await tx.serviceAccountToken.deleteMany({ where: { accountId: userId } });
                    await tx.serviceAccountQuotaSnapshot.deleteMany({ where: { accountId: userId } });
                } else if (connectedServices.action === "migrate") {
                    const existing = await tx.serviceAccountToken.findMany({
                        where: { accountId: userId },
                        select: { vendor: true, profileId: true },
                    });
                    const existingKeys = new Set(existing.map((row) => `${row.vendor}:${row.profileId}`));
                    const incomingKeys = new Set(connectedServices.credentials.map((row) => `${row.serviceId}:${row.profileId}`));
                    if (existingKeys.size !== incomingKeys.size) {
                        return { type: "connected-services-migration-incomplete" as const };
                    }
                    for (const key of existingKeys) {
                        if (!incomingKeys.has(key)) return { type: "connected-services-migration-incomplete" as const };
                    }

                    const atRest = encryptionEnv.plainAccountCredentialsAtRest === "none" ? "none" : "server_sealed";

                    for (const cred of connectedServices.credentials) {
                        if (toMode === "plain") {
                            if (cred.kind !== "plain" || !cred.record) return { type: "invalid-params" as const };
                            const json = JSON.stringify(cred.record);
                            const keyPath = ["storage", "connect_credential", userId, cred.serviceId, cred.profileId, "v1"];
                            const tokenBytes =
                                atRest === "server_sealed"
                                    ? (encryptString(keyPath, json) as Uint8Array<ArrayBuffer>)
                                    : encodeUtf8Bytes(json);
                            const providerEmail =
                                cred.record.kind === "oauth"
                                    ? cred.record.oauth?.providerEmail ?? null
                                    : cred.record.token?.providerEmail ?? null;
                            const providerAccountId =
                                cred.record.kind === "oauth"
                                    ? cred.record.oauth?.providerAccountId ?? null
                                    : cred.record.token?.providerAccountId ?? null;
                            const metadata = {
                                v: 3,
                                storage: atRest === "server_sealed" ? "server_sealed_json_v1" : "plain_json_v1",
                                kind: cred.record.kind,
                                providerEmail,
                                providerAccountId,
                            };
                            const expiresAt =
                                typeof cred.record.expiresAt === "number" && Number.isFinite(cred.record.expiresAt)
                                    ? new Date(cred.record.expiresAt)
                                    : null;
                            await tx.serviceAccountToken.upsert({
                                where: {
                                    accountId_vendor_profileId: {
                                        accountId: userId,
                                        vendor: cred.serviceId,
                                        profileId: cred.profileId,
                                    },
                                },
                                update: { updatedAt: new Date(), token: tokenBytes, metadata: metadata as any, expiresAt },
                                create: { accountId: userId, vendor: cred.serviceId, profileId: cred.profileId, token: tokenBytes, metadata: metadata as any, expiresAt },
                            });
                            continue;
                        }

                        // toMode === "e2ee"
                        if (cred.kind !== "sealed" || !cred.sealed) return { type: "invalid-params" as const };
                        const meta = cred.metadata;
                        const metadata = {
                            v: 2,
                            format: cred.sealed.format,
                            kind: meta?.kind ?? "oauth",
                            providerEmail: meta?.providerEmail ?? null,
                            providerAccountId: meta?.providerAccountId ?? null,
                        };
                        await tx.serviceAccountToken.upsert({
                            where: {
                                accountId_vendor_profileId: {
                                    accountId: userId,
                                    vendor: cred.serviceId,
                                    profileId: cred.profileId,
                                },
                            },
                            update: {
                                updatedAt: new Date(),
                                token: encodeCredentialTokenBytes(cred.sealed.ciphertext),
                                metadata: metadata as any,
                                expiresAt: meta?.expiresAt ? new Date(meta.expiresAt) : null,
                            },
                            create: {
                                accountId: userId,
                                vendor: cred.serviceId,
                                profileId: cred.profileId,
                                token: encodeCredentialTokenBytes(cred.sealed.ciphertext),
                                metadata: metadata as any,
                                expiresAt: meta?.expiresAt ? new Date(meta.expiresAt) : null,
                            },
                        });
                    }
                }

                if (automations.action === "assert_empty") {
                    const count = await tx.automation.count({ where: { accountId: userId } });
                    if (count > 0) return { type: "automations-not-empty" as const };
                } else if (automations.action === "clear") {
                    await tx.automation.deleteMany({ where: { accountId: userId } });
                } else if (automations.action === "migrate") {
                    const existing = await tx.automation.findMany({
                        where: { accountId: userId },
                        select: { id: true },
                    });
                    const existingIds = new Set(existing.map((row) => row.id));
                    const incomingIds = new Set(automations.templates.map((row) => row.automationId));
                    if (existingIds.size !== incomingIds.size) {
                        return { type: "automations-migration-incomplete" as const };
                    }
                    for (const id of existingIds) {
                        if (!incomingIds.has(id)) return { type: "automations-migration-incomplete" as const };
                    }

                    for (const item of automations.templates) {
                        try {
                            parseAutomationPatchInput(
                                { templateCiphertext: item.templateCiphertext },
                                { accountMode: toMode },
                            );
                        } catch (error) {
                            if (error instanceof AutomationValidationError) {
                                return { type: "invalid-params" as const };
                            }
                            throw error;
                        }
                        await tx.automation.update({
                            where: { id: item.automationId },
                            data: { templateCiphertext: item.templateCiphertext, updatedAt: new Date() },
                        });
                    }
                }

                const nextSettingsDbValue =
                    toMode === "plain"
                        ? storePlainAccountSettingsDbValue({ accountId: userId, content: settingsContent })
                        : (settingsContent?.t === "encrypted" ? settingsContent.c : null);

                await tx.account.update({
                    where: { id: userId },
                    data: {
                        encryptionMode: toMode,
                        encryptionModeUpdatedAt: new Date(),
                        settings: nextSettingsDbValue,
                        settingsVersion: expectedSettingsVersion + 1,
                        updatedAt: new Date(),
                        ...(toMode === "e2ee" && publicKeyHexUpdate ? {
                            publicKey: publicKeyHexUpdate,
                            ...(contentPublicKeyUpdate ? { contentPublicKey: contentPublicKeyUpdate } : {}),
                            ...(contentPublicKeySigUpdate ? { contentPublicKeySig: contentPublicKeySigUpdate } : {}),
                        } : {}),
                    },
                });

                return { type: "success" as const, mode: toMode, settingsVersion: expectedSettingsVersion + 1 };
            });

            if (result.type === "internal-error") return reply.code(500).send({ error: "internal" });
            if (result.type === "invalid-params") return reply.code(400).send({ error: "invalid-params" });
            if (result.type === "version-mismatch") {
                return reply.code(409).send({ error: "version-mismatch", currentVersion: result.currentVersion });
            }
            if (result.type === "connected-services-not-empty") {
                return reply.code(400).send({ error: "connected_services_not_empty" });
            }
            if (result.type === "connected-services-migration-incomplete") {
                return reply.code(400).send({ error: "connected_services_not_empty" });
            }
            if (result.type === "automations-not-empty") {
                return reply.code(400).send({ error: "automations_not_empty" });
            }
            if (result.type === "automations-migration-incomplete") {
                return reply.code(400).send({ error: "automations_not_empty" });
            }

            return reply.send({
                success: true,
                mode: result.mode,
                settingsVersion: result.settingsVersion,
            });
        } catch {
            return reply.code(500).send({ error: "internal" });
        }
    });
}
