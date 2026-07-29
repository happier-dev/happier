import { type Fastify } from "../../types";
import { afterTx, inTx } from "@/storage/inTx";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    AccountEncryptionMigrateRequestSchema,
    AccountEncryptionMigrateSuccessResponseSchema,
    AccountEncryptionMigrateBadRequestResponseSchema,
    AccountEncryptionMigrateForbiddenResponseSchema,
    AccountEncryptionMigrateNotFoundResponseSchema,
    AccountEncryptionMigrateConflictResponseSchema,
    AccountEncryptionMigrateInternalResponseSchema,
    AccountEncryptionMigrateInvalidParamsReasonSchema,
    assertConnectedServiceCredentialRecordBinding,
} from "@happier-dev/protocol";
import { storePlainAccountSettingsDbValue } from "@/app/encryption/accountSettingsStorage";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { encodeCredentialTokenBytes } from "@/app/api/routes/connect/connectedServicesV2/credentialTokenCodec";
import { encryptString } from "@/modules/encrypt";
import { encodeUtf8Bytes } from "@/app/api/routes/connect/connectedServicesV3/bytesCodec";
import { mutateConnectedServiceCredentialInTx } from "@/app/api/routes/connect/credentials/mutation";
import {
    clearQualifiedConnectedAccountsForAccountInTx,
    isQualifiedConnectedAccountMigrationInventoryCompleteInTx,
    mutateQualifiedConnectedAccountConfigurationInTx,
    mutateQualifiedConnectedServiceCredentialInTx,
} from "@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository";
import {
    clearQualifiedConnectedAccountUsageForAccountInTx,
} from "@/app/api/routes/connect/qualifiedConnectedAccounts/usageRepository";
import { recordConnectedServiceAccountProfileChange } from "@/app/api/routes/connect/connectedServicesAccountProfileChange";
import { AutomationValidationError, parseAutomationPatchInput } from "@/app/automations/automationValidation";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { eventRouter } from "@/app/events/eventRouter";
import { buildAccountSettingsChangedUpdate } from "@/app/events/eventPayloadBuilders";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import {
    verifyAccountContentKeyBinding,
    type VerifiedAccountContentKeyBinding,
} from "@/app/encryption/accountContentKeyAdmission";
import {
    acquireAccountEncryptionTransitionFenceInTx,
    applyAccountEncryptionTransitionInTx,
} from "@/app/encryption/accountEncryptionTransition";

class AccountEncryptionMigrationCredentialRejectedError extends Error {
    constructor(status: string) {
        super(`Connected service credential migration rejected: ${status}`);
        this.name = "AccountEncryptionMigrationCredentialRejectedError";
    }
}

class AccountEncryptionMigrationAutomationRejectedError extends Error {
    constructor() {
        super("Automation migration precondition was lost");
        this.name = "AccountEncryptionMigrationAutomationRejectedError";
    }
}

export function registerAccountEncryptionMigrateRoutes(app: Fastify): void {
    app.post("/v1/account/encryption/migrate", {
        preHandler: app.authenticate,
        schema: {
            body: AccountEncryptionMigrateRequestSchema,
            response: {
                200: AccountEncryptionMigrateSuccessResponseSchema,
                400: AccountEncryptionMigrateBadRequestResponseSchema,
                403: AccountEncryptionMigrateForbiddenResponseSchema,
                404: AccountEncryptionMigrateNotFoundResponseSchema,
                409: AccountEncryptionMigrateConflictResponseSchema,
                500: AccountEncryptionMigrateInternalResponseSchema,
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const {
            toMode,
            expectedSettingsVersion,
            settingsContent,
            connectedServices,
            automations,
            keyProof,
        } = request.body;

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
                return reply
                    .code(400)
                    .send({ error: "invalid-params", reason: AccountEncryptionMigrateInvalidParamsReasonSchema.enum.key_proof_required });
            }
        }

        try {
            const result = await inTx(async (tx) => {
                const fence =
                    await acquireAccountEncryptionTransitionFenceInTx(
                        tx,
                        userId,
                    );
                if (fence.status === "account_not_found") {
                    return { type: "internal-error" as const };
                }
                if (
                    fence.status
                    === "metadata_privacy_upgrade_required"
                ) {
                    return {
                        type:
                            "metadata-privacy-upgrade-required" as const,
                    };
                }
                const account = fence.account;
                // Note: treat the migration request as authoritative; it may be used to rewrite settings even
                // when the account is already in the requested mode.

                if (account.settingsVersion !== expectedSettingsVersion) {
                    return { type: "version-mismatch" as const, currentVersion: account.settingsVersion };
                }

                let publicKeyHexUpdate: string | null = null;
                let contentKeyBinding:
                    VerifiedAccountContentKeyBinding | null = null;
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
                        return {
                            type: "invalid-params" as const,
                            reason: AccountEncryptionMigrateInvalidParamsReasonSchema.enum.restore_required,
                        };
                    }
                    publicKeyHexUpdate = publicKeyHex;

                    let contentPublicKey: Uint8Array;
                    let contentPublicKeySignature: Uint8Array;
                    try {
                        contentPublicKey = privacyKit.decodeBase64(
                            keyProof!.contentPublicKey!,
                        );
                        contentPublicKeySignature =
                            privacyKit.decodeBase64(
                                keyProof!.contentPublicKeySig!,
                            );
                    } catch {
                        return { type: "invalid-params" as const };
                    }
                    contentKeyBinding =
                        verifyAccountContentKeyBinding({
                            accountSigningPublicKey: publicKeyBytes,
                            contentPublicKey,
                            contentPublicKeySignature,
                        });
                    if (!contentKeyBinding) {
                        return { type: "invalid-params" as const };
                    }
                }

                // Validate every automation precondition before the first credential write. Returning a
                // typed validation result after a write would commit that partial rewrite in Prisma's
                // interactive transaction instead of rolling it back.
                if (automations.action === "assert_empty") {
                    const count = await tx.automation.count({ where: { accountId: userId } });
                    if (count > 0) return { type: "automations-not-empty" as const };
                } else if (automations.action === "migrate") {
                    const existing = await tx.automation.findMany({ where: { accountId: userId }, select: { id: true } });
                    const existingIds = new Set(existing.map((row) => row.id));
                    const incomingIds = new Set(automations.templates.map((row) => row.automationId));
                    if (incomingIds.size !== automations.templates.length || existingIds.size !== incomingIds.size) {
                        return { type: "automations-migration-incomplete" as const };
                    }
                    for (const id of existingIds) {
                        if (!incomingIds.has(id)) return { type: "automations-migration-incomplete" as const };
                    }
                    for (const item of automations.templates) {
                        try {
                            parseAutomationPatchInput({ templateCiphertext: item.templateCiphertext }, { accountMode: toMode });
                        } catch (error) {
                            if (error instanceof AutomationValidationError) return { type: "invalid-params" as const };
                            throw error;
                        }
                    }
                }

                if (
                    connectedServices.action === "assert_empty"
                    || connectedServices.action === "migrate"
                ) {
                    const inventoryComplete =
                        await isQualifiedConnectedAccountMigrationInventoryCompleteInTx(
                            tx,
                            {
                                accountId: userId,
                                legacyCredentials:
                                    connectedServices.action === "migrate"
                                        ? connectedServices.credentials
                                        : [],
                                qualifiedCredentials:
                                    connectedServices.action === "migrate"
                                        ? connectedServices.qualifiedCredentials
                                        : [],
                            },
                        );
                    if (!inventoryComplete) {
                        return connectedServices.action === "assert_empty"
                            ? {
                                type:
                                    "connected-services-not-empty" as const,
                            }
                            : {
                                type:
                                    "connected-services-migration-incomplete" as const,
                            };
                    }
                }
                if (connectedServices.action === "migrate") {
                    for (const cred of connectedServices.credentials) {
                        if (toMode === "plain") {
                            if (cred.kind !== "plain" || !cred.record) return { type: "invalid-params" as const };
                            try {
                                assertConnectedServiceCredentialRecordBinding({
                                    binding: { serviceId: cred.serviceId, profileId: cred.profileId },
                                    record: cred.record,
                                });
                            } catch {
                                return { type: "invalid-params" as const };
                            }
                        } else if (cred.kind !== "sealed" || !cred.sealed) {
                            return { type: "invalid-params" as const };
                        }
                    }
                }

                const nextSettingsDbValue =
                    toMode === "plain"
                        ? storePlainAccountSettingsDbValue({ accountId: userId, content: settingsContent })
                        : (settingsContent?.t === "encrypted" ? settingsContent.c : null);
                const currentMode = account.currentness.encryptionMode;

                await applyAccountEncryptionTransitionInTx(tx, {
                    accountId: userId,
                    toMode,
                    ...(publicKeyHexUpdate
                        ? { accountPublicKeyHex: publicKeyHexUpdate }
                        : {}),
                    settings: {
                        value: nextSettingsDbValue,
                        version: expectedSettingsVersion + 1,
                    },
                    contentKey:
                        contentKeyBinding
                            ? {
                                kind: "migration_replace",
                                binding: contentKeyBinding,
                            }
                            : { kind: "preserve" },
                });

                if (
                    currentMode !== toMode
                    && connectedServices.action !== "clear"
                ) {
                    await clearQualifiedConnectedAccountUsageForAccountInTx(
                        tx,
                        { accountId: userId },
                    );
                }

                let connectedServicesChanged = false;
                if (connectedServices.action === "clear") {
                    const cleanup =
                        await clearQualifiedConnectedAccountsForAccountInTx(
                            tx,
                            { accountId: userId },
                        );
                    connectedServicesChanged =
                        cleanup.deletedCredentialCount > 0
                        || cleanup.reconciledGroupCount > 0;
                } else if (connectedServices.action === "migrate") {

                    const atRest = encryptionEnv.plainAccountCredentialsAtRest === "none" ? "none" : "server_sealed";

                    for (const cred of connectedServices.credentials) {
                        if (toMode === "plain") {
                            const record = cred.record!;
                            const json = JSON.stringify(record);
                            const keyPath = ["storage", "connect_credential", userId, cred.serviceId, cred.profileId, "v1"];
                            const tokenBytes =
                                atRest === "server_sealed"
                                    ? (encryptString(keyPath, json) as Uint8Array<ArrayBuffer>)
                                    : encodeUtf8Bytes(json);
                            const providerEmail =
                                record.kind === "oauth"
                                    ? record.oauth?.providerEmail ?? null
                                    : record.token?.providerEmail ?? null;
                            const providerAccountId =
                                record.kind === "oauth"
                                    ? record.oauth?.providerAccountId ?? null
                                    : record.token?.providerAccountId ?? null;
                            const metadata = {
                                v: 3,
                                storage: atRest === "server_sealed" ? "server_sealed_json_v1" : "plain_json_v1",
                                kind: record.kind,
                                providerEmail,
                                providerAccountId,
                            };
                            const expiresAt =
                                typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
                                    ? new Date(record.expiresAt)
                                    : null;
                            const mutation = await mutateConnectedServiceCredentialInTx(tx, {
                                accountId: userId,
                                serviceId: cred.serviceId,
                                profileId: cred.profileId,
                                token: tokenBytes,
                                metadata,
                                expiresAt,
                                storageMode: "plain",
                                incomingIdentity: { providerEmail, providerAccountId },
                                allowProviderIdentityChange: false,
                            });
                            if (mutation.status !== "written") {
                                throw new AccountEncryptionMigrationCredentialRejectedError(mutation.status);
                            }
                            connectedServicesChanged = true;
                            continue;
                        }

                        // toMode === "e2ee"
                        const sealed = cred.sealed!;
                        const meta = cred.metadata;
                        const metadata = {
                            v: 2,
                            format: sealed.format,
                            kind: meta?.kind ?? "oauth",
                            providerEmail: meta?.providerEmail ?? null,
                            providerAccountId: meta?.providerAccountId ?? null,
                        };
                        const expiresAt =
                            typeof meta?.expiresAt === "number" && Number.isFinite(meta.expiresAt)
                                ? new Date(meta.expiresAt)
                                : null;
                        const mutation = await mutateConnectedServiceCredentialInTx(tx, {
                            accountId: userId,
                            serviceId: cred.serviceId,
                            profileId: cred.profileId,
                            token: encodeCredentialTokenBytes(sealed.ciphertext),
                            metadata,
                            expiresAt,
                            storageMode: "sealed",
                            incomingIdentity: {
                                providerEmail: meta?.providerEmail ?? null,
                                providerAccountId: meta?.providerAccountId ?? null,
                            },
                            allowProviderIdentityChange: false,
                        });
                        if (mutation.status !== "written") {
                            throw new AccountEncryptionMigrationCredentialRejectedError(mutation.status);
                        }
                        connectedServicesChanged = true;
                    }

                    for (const cred of connectedServices.qualifiedCredentials) {
                        const mutation =
                            await mutateQualifiedConnectedServiceCredentialInTx(
                                tx,
                                {
                                    accountId: userId,
                                    ref: cred.ref,
                                    expectedCredentialRevision:
                                        cred.expectedCredentialRevision,
                                    expectedConfigurationRevision:
                                        cred.expectedConfigurationRevision,
                                    authenticationModeId:
                                        cred.authenticationModeId,
                                    content:
                                        cred.replacementCredentialContentEnvelope,
                                    metadata: cred.metadata,
                                },
                            );
                        if (mutation.status !== "written") {
                            throw new AccountEncryptionMigrationCredentialRejectedError(
                                mutation.status,
                            );
                        }
                        if (
                            cred.replacementConfigurationContentEnvelope
                            && cred.expectedConfigurationRevision !== null
                        ) {
                            const configurationMutation =
                                await mutateQualifiedConnectedAccountConfigurationInTx(
                                    tx,
                                    {
                                        accountId: userId,
                                        target: {
                                            kind: "account",
                                            ref: cred.ref,
                                        },
                                        expectedCredentialRevision:
                                            mutation.credentialRevision,
                                        expectedConfigurationRevision:
                                            cred.expectedConfigurationRevision,
                                        replacementContentEnvelope:
                                            cred.replacementConfigurationContentEnvelope,
                                    },
                                );
                            if (configurationMutation.status !== "written") {
                                throw new AccountEncryptionMigrationCredentialRejectedError(
                                    configurationMutation.status,
                                );
                            }
                        }
                        connectedServicesChanged = true;
                    }
                }

                if (connectedServicesChanged) {
                    await recordConnectedServiceAccountProfileChange({ tx, accountId: userId });
                }

                if (automations.action === "clear") {
                    await tx.automation.deleteMany({ where: { accountId: userId } });
                } else if (automations.action === "migrate") {
                    for (const item of automations.templates) {
                        const updated = await tx.automation.updateMany({
                            where: { id: item.automationId, accountId: userId },
                            data: { templateCiphertext: item.templateCiphertext, updatedAt: new Date() },
                        });
                        if (updated.count !== 1) {
                            throw new AccountEncryptionMigrationAutomationRejectedError();
                        }
                    }
                }

                const cursor = await markAccountChanged(tx, {
                    accountId: userId,
                    kind: "account",
                    entityId: "self",
                    hint: { settingsVersion: expectedSettingsVersion + 1 },
                });

                afterTx(tx, () => {
                    eventRouter.emitUpdate({
                        userId,
                        payload: buildAccountSettingsChangedUpdate(expectedSettingsVersion + 1, cursor, randomKeyNaked(12)),
                        recipientFilter: { type: "user-machine-scoped-only" },
                    });
                });

                return { type: "success" as const, mode: toMode, settingsVersion: expectedSettingsVersion + 1 };
            });

            if (result.type === "internal-error") return reply.code(500).send({ error: "internal" });
            if (result.type === "invalid-params") {
                return reply.code(400).send(
                    result.reason
                        ? { error: "invalid-params", reason: result.reason }
                        : { error: "invalid-params" },
                );
            }
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
            if (result.type === "metadata-privacy-upgrade-required") {
                return reply.code(400).send({
                    error: "metadata_privacy_upgrade_required",
                });
            }
            return reply.send({
                success: true,
                mode: result.mode,
                settingsVersion: result.settingsVersion,
            });
        } catch (error) {
            if (error instanceof AccountEncryptionMigrationCredentialRejectedError) {
                return reply.code(400).send({ error: "invalid-params" });
            }
            if (error instanceof AccountEncryptionMigrationAutomationRejectedError) {
                return reply.code(400).send({ error: "automations_not_empty" });
            }
            return reply.code(500).send({ error: "internal" });
        }
    });
}
