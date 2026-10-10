import { InactiveAccountError } from "@/app/auth/accountStatus";
import { type Fastify } from "../../types";
import { z } from "zod";
import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    AccountEncryptionMigrateRequestSchema,
    ArtifactQuotaExceededV1Schema,
    AccountEncryptionMigrateSuccessResponseSchema,
    AccountEncryptionMigrateBadRequestResponseSchema,
    AccountEncryptionMigrateForbiddenResponseSchema,
    AccountEncryptionMigrateNotFoundResponseSchema,
    AccountEncryptionMigrateConflictResponseSchema,
    AccountEncryptionMigrateInternalResponseSchema,
    AccountEncryptionMigrateAutomationsInventoryResponseSchema,
    AccountEncryptionMigrateInvalidParamsReasonSchema,
    AccountEncryptionMigrateTransitionPrepareRequestSchema,
    AccountEncryptionMigrateTransitionPrepareResponseSchema,
    AccountEncryptionMigrateTransitionAuthorizeRequestSchema,
    AccountEncryptionMigrateTransitionAuthorizeResponseSchema,
    AccountEncryptionMigrateCollectionInventoryPageRequestSchema,
    AccountEncryptionMigrateCollectionInventoryPageSchema,
    AccountEncryptionMigrateCollectionStageBatchRequestSchema,
    AccountEncryptionMigrateCollectionStageBatchResponseSchema,
    AccountEncryptionMigrateTransitionCancelRequestSchema,
    AccountEncryptionMigrateTransitionCancelResponseSchema,
    AccountEncryptionMigrateTransitionActivateRequestSchema,
    AccountEncryptionMigrateTransitionActivateResponseSchema,
    ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema,
    SessionOrganizationAccountEncryptionMigrationInventorySchema,
    ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_MAX_UTF8_BYTES,
    computeAccountEncryptionMigrateKeyFingerprintV1,
    createAccountEncryptionMigrateProofSigningInputV1,
    createAccountEncryptionMigrateRequestBindingDigestV1,
    createAccountEncryptionMigrateTransitionAuthorizationBindingDigestV1,
    createPasswordCredentialTargetDigestV1,
    parseAccountPasswordCredentialV1,
    createAccountEncryptionMigrateTransitionAuthorizationProofSigningInputV1,
    type AccountEncryptionMigrateKeyProof,
    type AccountEncryptionMigrateRequest,
    type AccountEncryptionMigrateTransitionAuthorizeRequest,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import {
    ConnectedServicesAccountEncryptionMigrationConflictError,
    matchConnectedServicesAccountEncryptionMigrationPostStateInTx,
    migrateConnectedServicesAccountEncryptionInTx,
} from "@/app/api/routes/connect/credentials/accountEncryptionMigration";
import {
    AutomationAccountEncryptionMigrationConflictError,
    matchAutomationAccountEncryptionMigrationPostStateInTx,
    migrateAutomationAccountEncryptionInTx,
    readAutomationAccountEncryptionMigrationInventoryInTx,
} from "@/app/automations/automationCrudService";
import {
    matchAccountSettingsEncryptionMigrationPostStateInTx,
    migrateAccountSettingsEncryptionInTx,
} from "@/app/accountSettings/migrateAccountSettingsEncryptionInTx";
import { eventRouter } from "@/app/events/eventRouter";
import { WorkflowRunAccessError } from "@/app/workflows/workflowRunAccess";
import {
    buildAccountSettingsChangedUpdate,
    buildSessionMetadataRecipientUpdate,
} from "@/app/events/eventPayloadBuilders";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import {
    verifyAccountContentKeyBinding,
    type VerifiedAccountContentKeyBinding,
} from "@/app/encryption/accountContentKeyAdmission";
import {
    acquireAccountEncryptionTransitionCoordinatorFenceInTx,
    activateAccountEncryptionTransitionCoordinatorInTx,
    authorizeAccountEncryptionTransitionCoordinatorInTx,
    cancelAccountEncryptionTransitionCoordinatorInTx,
    finalizeAccountEncryptionTransitionCoordinatorInTx,
    inventoryAccountEncryptionTransitionCoordinatorInTx,
    prepareAccountEncryptionTransitionCoordinatorInTx,
    readAccountEncryptionTransitionAuthorizationPreparationInTx,
    stageAccountEncryptionTransitionCollectionsCoordinatorInTx,
} from "@/app/encryption/accountEncryptionTransitionCoordinator";
import {
    MachineAccountEncryptionMigrationConflictError,
    matchMachineAccountEncryptionMigrationPostStateInTx,
    migrateMachineAccountEncryptionInTx,
} from "@/app/machines/migrateMachineAccountEncryptionInTx";
import {
    ArtifactAccountEncryptionMigrationConflictError,
    ArtifactAccountEncryptionMigrationQuotaExceededError,
    matchArtifactAccountEncryptionMigrationPostStateInTx,
    migrateArtifactAccountEncryptionInTx,
} from "@/app/artifacts/artifactWriteService";
import { prepareArtifactAccountEncryptionConversionBlobs } from '@/app/artifacts/artifactEncryptionConversionBlobService';
import { cleanupRejectedArtifactBlobUploads } from '@/app/artifacts/artifactBlobService';
import {
    matchAccountJsonKvEncryptionMigrationPostStateInTx,
    AccountJsonKvEncryptionMigrationConflictError,
    migrateAccountJsonKvEncryptionInTx,
} from "@/app/kv/migrateAccountJsonKvEncryptionInTx";
import {
    PresentUserRequiredResponseSchema,
    requirePresentUser,
} from "@/app/api/utils/requirePresentUser";
import {
    matchSessionAccountEncryptionMigrationPostStateInTx,
    migrateSessionAccountEncryptionInTx,
    SessionAccountEncryptionMigrationConflictError,
} from "@/app/session/sessionWriteService";
import {
    projectSessionMetadataForRecipient,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import {
    accountEncryptionMigrationReplayBindingsEqualV1,
    createAccountEncryptionMigrationReplayBindingV1,
} from "@/app/encryption/accountEncryptionMigrationReplayBindingV1";
import { consumePasswordMutationKeyChallengeInTx } from "@/app/auth/keyChallengeV2";
import {
    consumeAccountEncryptionFirstKeyExternalAuthProofInTx,
} from "@/app/auth/accountEncryptionFirstKeyExternalAuthProof";
import {
    isTrulyKeylessPlainAccountRow,
} from "@/app/encryption/accountEncryptionMode";
import {
    classifyReviewCommentAccountEncryptionMigrationError,
    migrateReviewCommentAccountEncryptionInTx,
    reviewCommentAccountEncryptionPostStateMatches,
} from "@/app/reviews/comments/accountEncryptionMigration";
import {
    buildReviewCommentAccountEncryptionMigrationInventoryResponse,
    createReviewCommentAccountEncryptionMigrationPersistenceInTx,
} from "@/app/reviews/comments/accountEncryptionMigrationPersistence";
import {
    matchSessionOrganizationAccountEncryptionMigrationPostStateInTx,
    migrateSessionOrganizationAccountEncryptionInTx,
    readSessionOrganizationAccountEncryptionMigrationInventoryInTx,
    SessionOrganizationAccountEncryptionMigrationConflictError,
} from "@/app/session/organization/sessionOrganizationAccountEncryptionMigration";
import {
    assertAccountPetLibraryEmptyForEncryptionTransitionInTx,
} from "@/app/pets/accountPetEncryptionTransition";
import {
    assertPluginWebhookPayloadsEmptyForAccountEncryptionTransitionInTx,
} from "@/app/plugins/webhooks/accountEncryptionTransition";
import {
    inspectPluginAccountDataForEncryptionTransitionInTx,
} from "@/app/plugins/data/accountEncryptionTransitionCensus";
import {
    inspectAccountSettingsForEncryptionTransitionInTx,
} from "@/app/accountSettings/accountEncryptionTransitionCensus";
import {
    matchNewSessionDraftsAccountMigrationPostStateInTx,
    migrateNewSessionDraftsForAccountModeInTx,
    type SessionDraftAccountMigrationResult,
} from "@/app/account/sessionDrafts/sessionDraftService";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { matchConnectedAccountCatalogAccountMigrationPostStateInTx, migrateConnectedAccountCatalogForAccountModeInTx } from '@/app/account/connectedAccounts/configurationRowsEncryptionMigration';
import {
    matchAuthoringMemoryAccountMigrationPostStateInTx,
    migrateAuthoringMemoryForAccountModeInTx,
} from "@/app/kv/authoringMemoryEncryptionMigration";
import { matchWorkspaceExecutionConfigAccountMigrationPostStateInTx, migrateWorkspaceExecutionConfigForAccountModeInTx } from '@/app/projects/execution/workspaceExecutionConfigEncryptionMigration';
import {
    matchProjectAccountRowsAccountMigrationPostStateInTx,
    migrateProjectAccountRowsForAccountModeInTx,
} from '@/app/projects/projectAccountRowsEncryptionMigration';
import { matchProjectTrustAccountMigrationPostStateInTx, migrateProjectTrustForAccountModeInTx } from '@/app/projects/trust/projectTrustEncryptionMigration';
import { matchProfileRowsAccountMigrationPostStateInTx, migrateProfileRowsForAccountModeInTx } from '@/app/account/profiles/profileRowsEncryptionMigration';
import { matchPromptLibraryAccountMigrationPostStateInTx, migratePromptLibraryForAccountModeInTx } from '@/app/account/prompts/promptLibraryEncryptionMigration';
import { matchConfiguredAgentCatalogAccountMigrationPostStateInTx, migrateConfiguredAgentCatalogForAccountModeInTx } from '@/app/account/agents/configuredAgentRowsEncryptionMigration';
import { matchMcpServerCatalogAccountMigrationPostStateInTx, migrateMcpServerCatalogForAccountModeInTx } from '@/app/account/mcp/serverCatalogEncryptionMigration';
import { matchProviderConnectionsAccountMigrationPostStateInTx, migrateProviderConnectionsForAccountModeInTx } from '@/app/account/providers/providerConnectionsEncryptionMigration';
import { matchRemoteHostCatalogAccountMigrationPostStateInTx, migrateRemoteHostCatalogForAccountModeInTx } from '@/app/account/remoteHosts/remoteHostRowsEncryptionMigration';
import { matchNotificationChannelCatalogAccountMigrationPostStateInTx, migrateNotificationChannelCatalogForAccountModeInTx } from '@/app/account/notifications/channelRowsEncryptionMigration';
import { matchConnectedPresentationAccountMigrationPostStateInTx, migrateConnectedPresentationForAccountModeInTx,
    matchConnectedAcknowledgementsAccountMigrationPostStateInTx, migrateConnectedAcknowledgementsForAccountModeInTx } from '@/app/account/connectedAccounts/presentationRowsEncryptionMigration';

const AccountEncryptionMigrationReplayHintSchema = z
    .object({
        settingsVersion: z.number().int().nonnegative(),
        sourceAccountVersion: z.number().int().nonnegative(),
        accountEncryptionMigrationReplayBinding: z.string(),
    })
    .strict();

type VerifiedMigrationKeyProof = Readonly<{
    publicKeyHex: string;
    signingKeyFingerprint: string;
    contentKeyFingerprint: string;
    contentKeyBinding: VerifiedAccountContentKeyBinding;
}>;

function verifyAccountEncryptionMigrationKeyProof(params: Readonly<{
    keyProof: AccountEncryptionMigrateKeyProof;
    signingInput: Uint8Array;
}>): VerifiedMigrationKeyProof | null {
    let publicKeyBytes: Uint8Array;
    let signatureBytes: Uint8Array;
    let contentPublicKey: Uint8Array;
    let contentPublicKeySignature: Uint8Array;
    try {
        publicKeyBytes = privacyKit.decodeBase64(params.keyProof.publicKey);
        signatureBytes = privacyKit.decodeBase64(params.keyProof.signature);
        contentPublicKey = privacyKit.decodeBase64(
            params.keyProof.contentPublicKey!,
        );
        contentPublicKeySignature = privacyKit.decodeBase64(
            params.keyProof.contentPublicKeySig!,
        );
    } catch {
        return null;
    }
    if (
        publicKeyBytes.length !== tweetnacl.sign.publicKeyLength
        || signatureBytes.length !== tweetnacl.sign.signatureLength
        || !tweetnacl.sign.detached.verify(
            params.signingInput,
            signatureBytes,
            publicKeyBytes,
        )
    ) {
        return null;
    }
    const contentKeyBinding = verifyAccountContentKeyBinding({
        accountSigningPublicKey: publicKeyBytes,
        contentPublicKey,
        contentPublicKeySignature,
    });
    if (!contentKeyBinding) return null;
    return {
        publicKeyHex: privacyKit.encodeHex(
            new Uint8Array(publicKeyBytes),
        ),
        signingKeyFingerprint:
            computeAccountEncryptionMigrateKeyFingerprintV1(
                publicKeyBytes,
            ),
        contentKeyFingerprint:
            computeAccountEncryptionMigrateKeyFingerprintV1(
                contentKeyBinding.contentPublicKey,
            ),
        contentKeyBinding,
    };
}

function verifyMigrationKeyProof(params: Readonly<{
    request: AccountEncryptionMigrateRequest;
    accountId: string;
    sourceMode: "plain" | "e2ee";
}>): VerifiedMigrationKeyProof | null {
    const keyProof = params.request.keyProof;
    if (!keyProof) return null;
    let signingInput: Uint8Array;
    try {
        signingInput = createAccountEncryptionMigrateProofSigningInputV1({
            request: params.request,
            accountId: params.accountId,
            sourceMode: params.sourceMode,
        });
    } catch {
        return null;
    }
    return verifyAccountEncryptionMigrationKeyProof({ keyProof, signingInput });
}

class AccountEncryptionMigrationAutomationRejectedError extends Error {
    constructor(
        readonly status:
            | "not_empty"
            | "migration_incomplete"
            | "migration_too_large"
            | "invalid_content",
    ) {
        super(`Automation migration rejected: ${status}`);
        this.name = "AccountEncryptionMigrationAutomationRejectedError";
    }
}

class AccountEncryptionMigrationSettingsRejectedError extends Error {
    constructor(
        readonly status:
            | "account_not_found"
            | "version_mismatch"
            | "inventory_changed",
        readonly currentVersion: number,
    ) {
        super(`Account Settings migration rejected: ${status}`);
        this.name = "AccountEncryptionMigrationSettingsRejectedError";
    }
}

class AccountEncryptionMigrationSessionRejectedError extends Error {
    constructor(
        readonly status:
            | "not_empty"
            | "migration_incomplete"
            | "invalid_content",
    ) {
        super(`Session migration rejected: ${status}`);
        this.name = "AccountEncryptionMigrationSessionRejectedError";
    }
}

class AccountEncryptionMigrationSessionDraftRejectedError extends Error {
    constructor(readonly result: Exclude<SessionDraftAccountMigrationResult, { status: "applied" }>) {
        super(`Session draft migration rejected: ${result.status}`);
        this.name = "AccountEncryptionMigrationSessionDraftRejectedError";
    }
}

class AccountEncryptionMigrationDomainRejectedError extends Error {
    constructor(
        readonly domain:
            | "connected_services"
            | "machines"
            | "todos"
            | "workspace"
            | "artifacts"
            | "review_comments"
            | "session_organization"
            | "pets"
            | "plugin_webhooks"
            | "plugin_data"
            | "plugin_settings"
            | "authoring_memory"
            | "prompt_library"
            | "acp_catalog"
            | "mcp_server_catalog"
            | "provider_connections"
            | "connected_configurations"
            | "connected_purposes"
            | "remote_hosts"
            | "notification_channels"
            | "connected_presentation"
            | "connected_acknowledgements"
            | "profile_rows"
            | "workspace_execution_config"
            | "project_rows"
            | "project_trust",
        readonly status:
            | "not_empty"
            | "migration_incomplete"
            | "invalid_content"
            | "migration_too_large"
            | "unsupported_machine_kind",
    ) {
        super(`Account encryption migration rejected by ${domain}: ${status}`);
        this.name = "AccountEncryptionMigrationDomainRejectedError";
    }
}

function classifyReviewCommentMigrationError(
    error: unknown,
): AccountEncryptionMigrationDomainRejectedError | null {
    const status =
        classifyReviewCommentAccountEncryptionMigrationError(error);
    return status === null
        ? null
        : new AccountEncryptionMigrationDomainRejectedError(
            "review_comments",
            status,
        );
}

function accountEncryptionTransitionFailure(status: string): Readonly<{
    statusCode: 400 | 404 | 500;
    body:
        | Readonly<{ error: "invalid-params"; reason: "migration_inventory_changed" }>
        | Readonly<{ error: "migration_too_large" }>
        | Readonly<{ error: "not_found" }>
        | Readonly<{ error: "internal" }>;
}> {
    if (status === "transition_not_found") {
        return { statusCode: 404, body: { error: "not_found" } };
    }
    if (status === "account_not_found") {
        return { statusCode: 500, body: { error: "internal" } };
    }
    if (status === "migration_too_large") {
        return { statusCode: 400, body: { error: "migration_too_large" } };
    }
    return {
        statusCode: 400,
        body: {
            error: "invalid-params",
            reason: "migration_inventory_changed",
        },
    };
}

/**
 * V5 owns only the Collection participant today, while the established
 * POST/PATCH migration owns every Account stored-content domain. Until those
 * paths are one coordinator and all native provider measurements are
 * recorded, V5 may not create, authorize, disclose, stage, or activate a
 * transition. Cancellation deliberately has no additional V5-capacity
 * refusal so authenticated callers can scrub a persisted source stage.
 */
function accountEncryptionTransitionV5AdmissionFailure(): Readonly<{
    error: "migration_too_large";
}> | null {
    return { error: "migration_too_large" };
}

function accountEncryptionTransitionModePolicyFailure(
    toMode: "plain" | "e2ee",
): Readonly<{
    statusCode: 403 | 404;
    body:
        | Readonly<{ error: "e2ee-required" | "plaintext-only" }>
        | Readonly<{ error: "not_found" }>;
}> | null {
    const encryptionEnv = readEncryptionFeatureEnv(process.env);
    if (toMode === "plain") {
        if (encryptionEnv.storagePolicy === "required_e2ee") {
            return { statusCode: 403, body: { error: "e2ee-required" } };
        }
        if (
            encryptionEnv.storagePolicy === "optional"
            && !encryptionEnv.allowAccountOptOut
        ) {
            return { statusCode: 404, body: { error: "not_found" } };
        }
        return null;
    }
    if (encryptionEnv.storagePolicy === "plaintext_only") {
        return { statusCode: 403, body: { error: "plaintext-only" } };
    }
    return null;
}

async function authorizeAccountEncryptionTransitionFromHttpRequestInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        request: AccountEncryptionMigrateTransitionAuthorizeRequest;
    }>,
) {
    const passwordCredential = params.request.passwordCredential;
    if (params.request.authorization.kind === "present_user_confirmation") {
        // Leaving E2EE replaces the envelope credential with a prepared Plain
        // one. That is a password-material mutation, so it needs the proof this
        // Account's current state can supply — the purpose-bound Key Challenge
        // its own signing key answers — not just the bearer that reached here.
        if (passwordCredential) {
            const emailIdentity = await params.tx.accountIdentity.findUnique({
                where: { accountId_provider: { accountId: params.accountId, provider: "email" } },
                select: { providerUserId: true },
            });
            if (!passwordCredential.proof) return { status: "invalid_authorization" as const };
            const consumed = await consumePasswordMutationKeyChallengeInTx(params.tx, {
                mutation: {
                    v: 1, action: "change", accountId: params.accountId,
                    expectedCredentialRevision: passwordCredential.expectedRevision,
                    normalizedNativeEmail: emailIdentity?.providerUserId ?? null,
                    newCredentialDigest: createPasswordCredentialTargetDigestV1(passwordCredential.credential),
                },
                proof: passwordCredential.proof,
                env: process.env,
            });
            if (!consumed) return { status: "invalid_authorization" as const };
        }
        return await authorizeAccountEncryptionTransitionCoordinatorInTx({
            tx: params.tx,
            accountId: params.accountId,
            transitionId: params.request.transitionId,
            authorization: {
                kind: "present_user_confirmation",
                ...(passwordCredential
                    ? { passwordCredential: {
                        expectedRevision: passwordCredential.expectedRevision,
                        credential: passwordCredential.credential,
                    } }
                    : {}),
            },
        });
    }

    const preparation =
        await readAccountEncryptionTransitionAuthorizationPreparationInTx({
            tx: params.tx,
            accountId: params.accountId,
            transitionId: params.request.transitionId,
        });
    // A prior successful first-key authorization may have lost its HTTP
    // response. Rejoin the canonical durable status before consuming another
    // one-time external proof.
    if (preparation.status === "authorized") return preparation;
    if (preparation.status !== "ready") return preparation;

    let signingInput: Uint8Array;
    let requestDigest: ReturnType<
        typeof createAccountEncryptionMigrateTransitionAuthorizationBindingDigestV1
    >;
    try {
        signingInput =
            createAccountEncryptionMigrateTransitionAuthorizationProofSigningInputV1({
                accountId: params.accountId,
                prepared: preparation.prepared,
                request: params.request,
            });
        requestDigest =
            createAccountEncryptionMigrateTransitionAuthorizationBindingDigestV1({
                accountId: params.accountId,
                prepared: preparation.prepared,
                request: params.request,
            });
    } catch {
        return { status: "invalid_authorization" as const };
    }
    const verifiedKeyProof = verifyAccountEncryptionMigrationKeyProof({
        keyProof: params.request.authorization.keyProof,
        signingInput,
    });
    if (!verifiedKeyProof) return { status: "invalid_authorization" as const };
    const externalAuth =
        await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
            params.tx,
            {
                accountId: params.accountId,
                requestDigest,
                externalAuthProof:
                    params.request.authorization.externalAuthProof,
            },
        );
    if (!externalAuth.ok) return { status: "invalid_authorization" as const };
    return await authorizeAccountEncryptionTransitionCoordinatorInTx({
        tx: params.tx,
        accountId: params.accountId,
        transitionId: params.request.transitionId,
        authorization: {
            kind: "first_key",
            accountPublicKeyHex: verifiedKeyProof.publicKeyHex,
            binding: verifiedKeyProof.contentKeyBinding,
            signingKeyFingerprint: verifiedKeyProof.signingKeyFingerprint,
            // Entering E2EE from a password-only Plain Account: the same
            // `email_password` external-auth proof consumed above verified the
            // current password, and `requestDigest` covers this prepared
            // envelope, so no second proof is needed here.
            ...(passwordCredential
                ? { passwordCredential: {
                    expectedRevision: passwordCredential.expectedRevision,
                    credential: passwordCredential.credential,
                } }
                : {}),
        },
    });
}

export function registerAccountEncryptionMigrateRoutes(app: Fastify): void {
    app.get("/v1/account/encryption/migrate/automations/inventory", {
        preHandler: app.authenticate,
        schema: { response: {
            200: AccountEncryptionMigrateAutomationsInventoryResponseSchema,
            500: AccountEncryptionMigrateInternalResponseSchema,
        } },
    }, async (request, reply) => {
        try {
            return reply.send(await inTx((tx) => readAutomationAccountEncryptionMigrationInventoryInTx({
                tx, accountId: request.userId,
            })));
        } catch (error) {
            if (error instanceof InactiveAccountError) throw error;
            return reply.code(500).send({ error: "internal" });
        }
    });
    app.get(
        "/v1/account/encryption/migrate/review-comments/inventory",
        {
            preHandler: app.authenticate,
            schema: {
                response: {
                    200:
                        ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            try {
                const inventory = await inTx(async (tx) => {
                    return await createReviewCommentAccountEncryptionMigrationPersistenceInTx(
                        tx,
                    ).readInventory(request.userId);
                }, { readOnly: true });
                return reply.send(
                    buildReviewCommentAccountEncryptionMigrationInventoryResponse(
                        inventory,
                    ),
                );
            } catch (error) {
                if (error instanceof InactiveAccountError) throw error;
                return reply.code(500).send({
                    error: "internal",
                });
            }
        },
    );
    app.get(
        "/v1/account/encryption/migrate/session-organization/inventory",
        {
            preHandler: app.authenticate,
            schema: {
                response: {
                    200:
                        SessionOrganizationAccountEncryptionMigrationInventorySchema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            try {
                return reply.send(await inTx(async (tx) => {
                    return await readSessionOrganizationAccountEncryptionMigrationInventoryInTx({
                        tx,
                        accountId: request.userId,
                    });
                }, { readOnly: true }));
            } catch (error) {
                if (error instanceof InactiveAccountError) throw error;
                return reply.code(500).send({
                    error: "internal",
                });
            }
        },
    );

    app.post(
        "/v1/account/encryption/migrate/transition/prepare",
        {
            preHandler: [app.authenticate, requirePresentUser],
            schema: {
                body: AccountEncryptionMigrateTransitionPrepareRequestSchema,
                response: {
                    200: AccountEncryptionMigrateTransitionPrepareResponseSchema,
                    400: AccountEncryptionMigrateBadRequestResponseSchema,
                    403: z.union([
                        AccountEncryptionMigrateForbiddenResponseSchema,
                        PresentUserRequiredResponseSchema,
                    ]),
                    404: AccountEncryptionMigrateNotFoundResponseSchema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            const admissionFailure = accountEncryptionTransitionV5AdmissionFailure();
            if (admissionFailure) return reply.code(400).send(admissionFailure);
            const policyFailure = accountEncryptionTransitionModePolicyFailure(
                request.body.toMode,
            );
            if (policyFailure) {
                return reply.code(policyFailure.statusCode).send(policyFailure.body);
            }
            try {
                const result = await inTx(async (tx) =>
                    await prepareAccountEncryptionTransitionCoordinatorInTx({
                        tx,
                        accountId: request.userId,
                        request: request.body,
                    })
                );
                if (result.status !== "prepared") {
                    const failure = accountEncryptionTransitionFailure(result.status);
                    return reply.code(failure.statusCode).send(failure.body);
                }
                return reply.send(result.transition);
            } catch (error) {
                if (error instanceof InactiveAccountError) throw error;
                return reply.code(500).send({ error: "internal" });
            }
        },
    );

    app.post(
        "/v1/account/encryption/migrate/transition/authorize",
        {
            preHandler: [app.authenticate, requirePresentUser],
            schema: {
                body: AccountEncryptionMigrateTransitionAuthorizeRequestSchema,
                response: {
                    200: AccountEncryptionMigrateTransitionAuthorizeResponseSchema,
                    400: AccountEncryptionMigrateBadRequestResponseSchema,
                    403: PresentUserRequiredResponseSchema,
                    404: AccountEncryptionMigrateNotFoundResponseSchema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            const admissionFailure = accountEncryptionTransitionV5AdmissionFailure();
            if (admissionFailure) return reply.code(400).send(admissionFailure);
            try {
                const result = await inTx(async (tx) =>
                    await authorizeAccountEncryptionTransitionFromHttpRequestInTx({
                        tx,
                        accountId: request.userId,
                        request: request.body,
                    })
                );
                if (result.status !== "authorized") {
                    const failure = accountEncryptionTransitionFailure(result.status);
                    return reply.code(failure.statusCode).send(failure.body);
                }
                return reply.send({ success: true });
            } catch (error) {
                if (error instanceof InactiveAccountError) throw error;
                return reply.code(500).send({ error: "internal" });
            }
        },
    );

    app.post(
        "/v1/account/encryption/migrate/transition/collections/inventory",
        {
            preHandler: app.authenticate,
            schema: {
                body: AccountEncryptionMigrateCollectionInventoryPageRequestSchema,
                response: {
                    200: AccountEncryptionMigrateCollectionInventoryPageSchema,
                    400: AccountEncryptionMigrateBadRequestResponseSchema,
                    404: AccountEncryptionMigrateNotFoundResponseSchema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            const admissionFailure = accountEncryptionTransitionV5AdmissionFailure();
            if (admissionFailure) return reply.code(400).send(admissionFailure);
            try {
                const result = await inTx(async (tx) =>
                    await inventoryAccountEncryptionTransitionCoordinatorInTx({
                        tx,
                        accountId: request.userId,
                        transitionId: request.body.transitionId,
                        ...(request.body.cursor
                            ? { cursor: request.body.cursor }
                            : {}),
                    })
                );
                if (result.status !== "ready") {
                    const failure = accountEncryptionTransitionFailure(result.status);
                    return reply.code(failure.statusCode).send(failure.body);
                }
                return reply.send({
                    items: [...result.items],
                    ...(result.nextCursor
                        ? { nextCursor: result.nextCursor }
                        : {}),
                });
            } catch (error) {
                if (error instanceof InactiveAccountError) throw error;
                return reply.code(500).send({ error: "internal" });
            }
        },
    );

    app.post(
        "/v1/account/encryption/migrate/transition/collections/stage",
        {
            preHandler: [app.authenticate, requirePresentUser],
            schema: {
                body: AccountEncryptionMigrateCollectionStageBatchRequestSchema,
                response: {
                    200: AccountEncryptionMigrateCollectionStageBatchResponseSchema,
                    400: AccountEncryptionMigrateBadRequestResponseSchema,
                    403: PresentUserRequiredResponseSchema,
                    404: AccountEncryptionMigrateNotFoundResponseSchema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            const admissionFailure = accountEncryptionTransitionV5AdmissionFailure();
            if (admissionFailure) return reply.code(400).send(admissionFailure);
            try {
                const result = await inTx(async (tx) =>
                    await stageAccountEncryptionTransitionCollectionsCoordinatorInTx({
                        tx,
                        accountId: request.userId,
                        transitionId: request.body.transitionId,
                        items: request.body.items,
                    })
                );
                if (result.status !== "staged") {
                    const failure = accountEncryptionTransitionFailure(result.status);
                    return reply.code(failure.statusCode).send(failure.body);
                }
                return reply.send({
                    success: true,
                    stagedParticipantCount: result.stagedParticipantCount,
                    stagedSourceBytes: Number(result.stagedSourceBytes),
                    stagedTargetBytes: Number(result.stagedTargetBytes),
                });
            } catch (error) {
                if (error instanceof InactiveAccountError) throw error;
                return reply.code(500).send({ error: "internal" });
            }
        },
    );

    app.post(
        "/v1/account/encryption/migrate/transition/cancel",
        {
            preHandler: [app.authenticate, requirePresentUser],
            schema: {
                body: AccountEncryptionMigrateTransitionCancelRequestSchema,
                response: {
                    200: AccountEncryptionMigrateTransitionCancelResponseSchema,
                    400: AccountEncryptionMigrateBadRequestResponseSchema,
                    403: PresentUserRequiredResponseSchema,
                    404: AccountEncryptionMigrateNotFoundResponseSchema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            try {
                const result = await inTx(async (tx) =>
                    await cancelAccountEncryptionTransitionCoordinatorInTx({
                        tx,
                        accountId: request.userId,
                        transitionId: request.body.transitionId,
                    })
                );
                if (result.status !== "cancelled") {
                    const failure = accountEncryptionTransitionFailure(result.status);
                    return reply.code(failure.statusCode).send(failure.body);
                }
                return reply.send({ success: true });
            } catch (error) {
                if (error instanceof InactiveAccountError) throw error;
                return reply.code(500).send({ error: "internal" });
            }
        },
    );

    app.post(
        "/v1/account/encryption/migrate/transition/activate",
        {
            preHandler: [app.authenticate, requirePresentUser],
            schema: {
                body: AccountEncryptionMigrateTransitionActivateRequestSchema,
                response: {
                    200: AccountEncryptionMigrateTransitionActivateResponseSchema,
                    400: AccountEncryptionMigrateBadRequestResponseSchema,
                    403: PresentUserRequiredResponseSchema,
                    404: AccountEncryptionMigrateNotFoundResponseSchema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            const admissionFailure = accountEncryptionTransitionV5AdmissionFailure();
            if (admissionFailure) return reply.code(400).send(admissionFailure);
            try {
                const result = await inTx(async (tx) =>
                    await activateAccountEncryptionTransitionCoordinatorInTx({
                        tx,
                        accountId: request.userId,
                        transitionId: request.body.transitionId,
                    })
                );
                if (result.status !== "activated") {
                    const failure = accountEncryptionTransitionFailure(result.status);
                    return reply.code(failure.statusCode).send(failure.body);
                }
                return reply.send({
                    success: true,
                    mode: result.mode,
                    accountVersion: result.version,
                    updatedAt: result.updatedAt,
                });
            } catch (error) {
                if (error instanceof InactiveAccountError) throw error;
                return reply.code(500).send({ error: "internal" });
            }
        },
    );

    app.post("/v1/account/encryption/migrate", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            body: AccountEncryptionMigrateRequestSchema,
            response: {
                200: AccountEncryptionMigrateSuccessResponseSchema,
                400: AccountEncryptionMigrateBadRequestResponseSchema,
                403: z.union([
                    AccountEncryptionMigrateForbiddenResponseSchema,
                    PresentUserRequiredResponseSchema,
                ]),
                404: AccountEncryptionMigrateNotFoundResponseSchema,
                409: AccountEncryptionMigrateConflictResponseSchema,
                413: ArtifactQuotaExceededV1Schema,
                500: AccountEncryptionMigrateInternalResponseSchema,
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const userId = request.userId;
        const migrationRequest = request.body;
        if (
            new TextEncoder().encode(JSON.stringify(migrationRequest)).byteLength
            > ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_MAX_UTF8_BYTES
        ) {
            return reply.code(400).send({ error: "migration_too_large" });
        }
        const {
            toMode,
            expectedSettingsVersion,
            settingsContent,
            connectedServices,
            automations,
            keyProof,
            machines,
            todos,
            artifacts,
            sessions,
            reviewComments,
            sessionOrganization,
            sessionDrafts,
            authoringMemory,
            profileRows,
            promptLibrary,
            acpCatalog,
            mcpServerCatalog,
            providerConnections,
            connectedConfigurations,
            connectedPurposes,
            remoteHosts,
            notificationChannels,
            connectedPresentation,
            connectedAcknowledgements,
            workspaceExecutionConfig,
            projectRows,
            projectTrust,
        } = migrationRequest;
        const workspace = migrationRequest.workspace ?? { action: "assert_empty" as const };

        const encryptionEnv = readEncryptionFeatureEnv(requestHomeEnv);

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
            const preparedArtifactBlobs = await prepareArtifactAccountEncryptionConversionBlobs({ accountId: userId, directive: artifacts });
            const result = await inTx(async (tx) => {
                const fence =
                    await acquireAccountEncryptionTransitionCoordinatorFenceInTx(
                        tx,
                        userId,
                    );
                if (fence.status === "account_not_found") {
                    return { type: "internal-error" as const };
                }
                if (fence.status === "account_inconsistent") {
                    return {
                        type: "invalid-params" as const,
                        reason:
                            AccountEncryptionMigrateInvalidParamsReasonSchema
                                .enum.restore_required,
                    };
                }
                const account = fence.account;
                const currentMode =
                    account.currentness.encryptionMode;
                if (currentMode === toMode) {

                    const replayRequest = migrationRequest;
                    const sourceMode =
                        toMode === "plain" ? "e2ee" : "plain";
                    let replayKeyProof:
                        VerifiedMigrationKeyProof | null = null;
                    if (toMode === "e2ee") {
                        replayKeyProof = verifyMigrationKeyProof({
                            request: replayRequest,
                            accountId: userId,
                            sourceMode,
                        });
                        if (
                            !replayKeyProof
                            || account.publicKey
                                !== replayKeyProof.publicKeyHex
                            || account.signingKeyFingerprint
                                !== replayKeyProof
                                    .signingKeyFingerprint
                            || account.contentKeyFingerprint
                                !== replayKeyProof
                                    .contentKeyFingerprint
                            || account.currentness
                                .contentPublicKeyFingerprint
                                !== replayKeyProof
                                    .contentKeyBinding
                                    .contentPublicKeyFingerprint
                        ) {
                            return {
                                type:
                                    "migration-inventory-changed" as const,
                            };
                        }
                        const sourceWasKeyless =
                            replayRequest
                                .expectedSigningKeyFingerprint
                                === null
                            && replayRequest
                                .expectedContentKeyFingerprint
                                === null;
                        // A password-bearing retained-key conversion carried
                        // its current-password proof; its lost-response replay
                        // carries the same request.
                        if (
                            replayRequest.externalAuthProof
                            && !sourceWasKeyless
                            && !replayRequest.passwordCredential
                        ) {
                            return {
                                type:
                                    "migration-inventory-changed" as const,
                            };
                        }
                    } else if (
                        replayRequest.externalAuthProof
                        || account.signingKeyFingerprint
                            !== replayRequest
                                .expectedSigningKeyFingerprint
                        || account.contentKeyFingerprint
                            !== replayRequest
                                .expectedContentKeyFingerprint
                    ) {
                        return {
                            type:
                                "migration-inventory-changed" as const,
                        };
                    }

                    if (
                        account.version
                            <= replayRequest
                                .expectedAccountVersion
                        || account.settingsVersion
                            !== replayRequest
                                .expectedSettingsVersion + 1
                    ) {
                        return {
                            type:
                                "migration-inventory-changed" as const,
                        };
                    }
                    const protocolRequestDigest =
                        createAccountEncryptionMigrateRequestBindingDigestV1({
                            request: replayRequest,
                            accountId: userId,
                            sourceMode,
                        });
                    const expectedReplayBinding =
                        createAccountEncryptionMigrationReplayBindingV1({
                            accountId: userId,
                            protocolRequestDigest,
                        });
                    const finalAccountChange =
                        await tx.accountChange.findUnique({
                            where: {
                                accountId_kind_entityId: {
                                    accountId: userId,
                                    kind: "account",
                                    entityId: "self",
                                },
                            },
                            select: {
                                cursor: true,
                                hint: true,
                            },
                        });
                    const replayHint =
                        AccountEncryptionMigrationReplayHintSchema
                            .safeParse(finalAccountChange?.hint);
                    if (
                        !finalAccountChange
                        || finalAccountChange.cursor
                            !== account.version
                        || !replayHint.success
                        || replayHint.data.sourceAccountVersion
                            !== replayRequest.expectedAccountVersion
                        || replayHint.data.settingsVersion
                            !== account.settingsVersion
                        || !accountEncryptionMigrationReplayBindingsEqualV1(
                            expectedReplayBinding,
                            replayHint.data
                                .accountEncryptionMigrationReplayBinding,
                        )
                    ) {
                        return {
                            type:
                                "migration-inventory-changed" as const,
                        };
                    }

                    const settingsPostState =
                        await matchAccountSettingsEncryptionMigrationPostStateInTx({
                            tx,
                            accountId: userId,
                            toMode,
                            expectedSettingsVersion:
                                replayRequest.expectedSettingsVersion,
                            replacementContent:
                                replayRequest.settingsContent,
                        });
                    const connectedServicesPostState =
                        await matchConnectedServicesAccountEncryptionMigrationPostStateInTx({
                            tx,
                            accountId: userId,
                            toMode,
                            directive:
                                replayRequest.connectedServices,
                        });
                    const automationsPostState =
                        await matchAutomationAccountEncryptionMigrationPostStateInTx({
                            tx,
                            accountId: userId,
                            toMode,
                            directive: replayRequest.automations,
                        });
                    const machinesPostState =
                        await matchMachineAccountEncryptionMigrationPostStateInTx({
                            tx,
                            accountId: userId,
                            toMode,
                            directive: replayRequest.machines,
                        });
                    const todosPostState =
                        await matchAccountJsonKvEncryptionMigrationPostStateInTx({
                            tx,
                            accountId: userId,
                            toMode,
                            directive: replayRequest.todos,
                            namespace: 'todo',
                        });
                    const workspacePostState = await matchAccountJsonKvEncryptionMigrationPostStateInTx({
                        tx, accountId: userId, namespace: 'workspace', toMode,
                        directive: replayRequest.workspace ?? { action: 'assert_empty' },
                    });
                    const artifactsPostState =
                        await matchArtifactAccountEncryptionMigrationPostStateInTx({
                            tx,
                            accountId: userId,
                            toMode,
                            directive: replayRequest.artifacts,
                            preparedBlobs: preparedArtifactBlobs,
                        });
                    const sessionsPostState =
                        await matchSessionAccountEncryptionMigrationPostStateInTx({
                            tx,
                            accountId: userId,
                            toMode,
                            directive: replayRequest.sessions,
                        });
                    const sessionDraftsPostState =
                        await matchNewSessionDraftsAccountMigrationPostStateInTx(
                            tx,
                            {
                                accountId: userId,
                                toMode,
                                directive: replayRequest.sessionDrafts,
                            },
                        );
                    const authoringMemoryPostState = await matchAuthoringMemoryAccountMigrationPostStateInTx(tx, {
                        accountId: userId, toMode, directive: replayRequest.authoringMemory,
                    });
                    const profileRowsPostState = await matchProfileRowsAccountMigrationPostStateInTx(tx, {
                        accountId: userId, toMode, directive: replayRequest.profileRows,
                    });
                    const promptLibraryPostState = await matchPromptLibraryAccountMigrationPostStateInTx(tx, {
                        accountId: userId, toMode, directive: replayRequest.promptLibrary,
                    });
                    const mcpServerCatalogPostState = await matchMcpServerCatalogAccountMigrationPostStateInTx(tx, {
                        accountId: userId, toMode, directive: replayRequest.mcpServerCatalog,
                    });
                    const acpCatalogPostState = await matchConfiguredAgentCatalogAccountMigrationPostStateInTx(tx, {
                        accountId: userId, toMode, directive: replayRequest.acpCatalog,
                    });
                    const providerConnectionsPostState = await matchProviderConnectionsAccountMigrationPostStateInTx(tx, {
                        accountId: userId, toMode, directive: replayRequest.providerConnections,
                    });
                    const connectedConfigurationsPostState = await matchConnectedAccountCatalogAccountMigrationPostStateInTx(tx, {
                        accountId: userId, key: 'configurations', toMode, directive: replayRequest.connectedConfigurations,
                    });
                    const connectedPurposesPostState = await matchConnectedAccountCatalogAccountMigrationPostStateInTx(tx, {
                        accountId: userId, key: 'purposes', toMode, directive: replayRequest.connectedPurposes,
                    });
                    const remoteHostsPostState = await matchRemoteHostCatalogAccountMigrationPostStateInTx(tx, {
                        accountId: userId, toMode, directive: replayRequest.remoteHosts,
                    });
                    const notificationChannelsPostState = await matchNotificationChannelCatalogAccountMigrationPostStateInTx(tx, {
                        accountId: userId, toMode, directive: replayRequest.notificationChannels,
                    });
                    const connectedPresentationPostState = await matchConnectedPresentationAccountMigrationPostStateInTx(tx, {
                        accountId: userId, toMode, directive: replayRequest.connectedPresentation,
                    });
                    const connectedAcknowledgementsPostState = await matchConnectedAcknowledgementsAccountMigrationPostStateInTx(tx, {
                        accountId: userId, toMode, directive: replayRequest.connectedAcknowledgements,
                    });
                    const workspaceExecutionConfigPostState = await matchWorkspaceExecutionConfigAccountMigrationPostStateInTx(tx, {
                        accountId: userId, toMode, directive: replayRequest.workspaceExecutionConfig,
                    });
                    const projectRowsPostState = await matchProjectAccountRowsAccountMigrationPostStateInTx(tx, {
                        accountId: userId, toMode, directive: replayRequest.projectRows,
                    });
                    const projectTrustPostState = await matchProjectTrustAccountMigrationPostStateInTx(tx, {
                        accountId: userId, toMode, directive: replayRequest.projectTrust,
                    });
                    let reviewCommentsPostStateMatches = false;
                    try {
                        reviewCommentsPostStateMatches =
                            await reviewCommentAccountEncryptionPostStateMatches({
                                accountId: userId,
                                targetMode: toMode,
                                directive:
                                    replayRequest.reviewComments,
                                persistence:
                                    createReviewCommentAccountEncryptionMigrationPersistenceInTx(
                                        tx,
                                    ),
                            });
                    } catch {
                        reviewCommentsPostStateMatches = false;
                    }
                    const sessionOrganizationPostState =
                        await matchSessionOrganizationAccountEncryptionMigrationPostStateInTx({
                            tx,
                            accountId: userId,
                            toMode,
                            directive:
                                replayRequest.sessionOrganization,
                        });
                    const petsPostState =
                        await assertAccountPetLibraryEmptyForEncryptionTransitionInTx(
                            tx,
                            userId,
                        );
                    if (
                        settingsPostState.status !== "matched"
                        || connectedServicesPostState.status
                            !== "matched"
                        || automationsPostState.status !== "matched"
                        || machinesPostState.status !== "matched"
                        || todosPostState.status !== "matched"
                        || workspacePostState.status !== 'matched'
                        || artifactsPostState.status !== "matched"
                        || sessionsPostState.status !== "matched"
                        || sessionDraftsPostState.status !== "matched"
                        || authoringMemoryPostState.status !== "matched"
                        || profileRowsPostState.status !== 'matched'
                        || promptLibraryPostState.status !== 'matched'
                        || acpCatalogPostState.status !== 'matched'
                        || mcpServerCatalogPostState.status !== 'matched'
                        || providerConnectionsPostState.status !== 'matched'
                        || connectedConfigurationsPostState.status !== 'matched'
                        || connectedPurposesPostState.status !== 'matched'
                        || remoteHostsPostState.status !== 'matched'
                        || notificationChannelsPostState.status !== 'matched'
                        || connectedPresentationPostState.status !== 'matched'
                        || connectedAcknowledgementsPostState.status !== 'matched'
                        || workspaceExecutionConfigPostState.status !== 'matched'
                        || projectRowsPostState.status !== 'matched'
                        || projectTrustPostState.status !== 'matched'
                        || !reviewCommentsPostStateMatches
                        || sessionOrganizationPostState.status
                            !== "matched"
                        || petsPostState.status !== "empty"
                    ) {
                        return {
                            type:
                                "migration-inventory-changed" as const,
                        };
                    }
                    return {
                        type: "success" as const,
                        mode: toMode,
                        accountVersion: account.version,
                        settingsVersion: account.settingsVersion,
                        sessionDraftRecords: replayRequest.sessionDrafts
                            ? sessionDraftsPostState.records
                            : undefined,
                        authoringMemoryRows: replayRequest.authoringMemory ? authoringMemoryPostState.rows : undefined,
                        profileRowsResult: replayRequest.profileRows ? { rows: profileRowsPostState.rows,
                            referenceGuardRevision: profileRowsPostState.referenceGuardRevision, transferControl: profileRowsPostState.transferControl } : undefined,
                        promptLibraryRows: replayRequest.promptLibrary ? promptLibraryPostState.rows : undefined,
                        acpCatalogResult: replayRequest.acpCatalog ? { row: acpCatalogPostState.row } : undefined,
                        mcpServerCatalogResult: replayRequest.mcpServerCatalog ? mcpServerCatalogPostState.row : undefined,
                        providerConnectionsResult: replayRequest.providerConnections ? { row: providerConnectionsPostState.row } : undefined,
                        connectedConfigurationsResult: replayRequest.connectedConfigurations ? { row: connectedConfigurationsPostState.row } : undefined,
                        connectedPurposesResult: replayRequest.connectedPurposes ? { row: connectedPurposesPostState.row } : undefined,
                        remoteHostsResult: replayRequest.remoteHosts ? remoteHostsPostState.row : undefined,
                        notificationChannelsResult: replayRequest.notificationChannels ? notificationChannelsPostState.row : undefined,
                        connectedPresentationResult: replayRequest.connectedPresentation ? connectedPresentationPostState.row : undefined,
                        connectedAcknowledgementsResult: replayRequest.connectedAcknowledgements ? connectedAcknowledgementsPostState.row : undefined,
                        workspaceExecutionConfigRows: replayRequest.workspaceExecutionConfig ? workspaceExecutionConfigPostState.rows : undefined,
                        projectRows: replayRequest.projectRows ? projectRowsPostState.rows : undefined,
                        projectTrustRows: replayRequest.projectTrust ? projectTrustPostState.rows : undefined,
                    };
                }

                const pluginDataCensus =
                    await inspectPluginAccountDataForEncryptionTransitionInTx(
                        tx,
                        userId,
                    );
                if (pluginDataCensus.status === "account_not_found") {
                    return { type: "internal-error" as const };
                }
                const pluginDataBlocksTransition =
                    pluginDataCensus.status === "nonempty"
                    && (
                        pluginDataCensus.accountStorage
                        || pluginDataCensus.collections === "invalid_tombstone"
                    );

                const pluginSettingsCensus =
                    await inspectAccountSettingsForEncryptionTransitionInTx(
                        tx,
                        userId,
                    );
                if (pluginSettingsCensus.status === "account_not_found") {
                    return { type: "internal-error" as const };
                }
                const pluginSettingsBlockTransition =
                    pluginSettingsCensus.status === "nonempty";
                // A plugin-owned payload that this coordinator cannot rewrite
                // blocks the complete Account transition before domain writers.
                if (pluginDataBlocksTransition) {
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "plugin_data",
                        "migration_too_large",
                    );
                }
                if (pluginSettingsBlockTransition) {
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "plugin_settings",
                        "migration_too_large",
                    );
                }

                if (
                    migrationRequest.expectedAccountVersion
                        !== account.version
                    || migrationRequest.expectedSigningKeyFingerprint
                        !== account.signingKeyFingerprint
                    || migrationRequest.expectedContentKeyFingerprint
                        !== account.contentKeyFingerprint
                ) {
                    return {
                        type: "migration-inventory-changed" as const,
                    };
                }
                const isFirstKeyEnrollment =
                    currentMode === "plain"
                    && toMode === "e2ee"
                    && isTrulyKeylessPlainAccountRow({
                        publicKey: account.publicKey,
                        encryptionMode: currentMode,
                        contentPublicKey:
                            account.currentness.contentPublicKey,
                        contentPublicKeySig:
                            account.currentness
                                .contentPublicKeySignature,
                    });
                if (
                    currentMode === "plain"
                    && toMode === "e2ee"
                    && !isFirstKeyEnrollment
                    && account.publicKey === null
                ) {
                    return {
                        type: "invalid-params" as const,
                        reason:
                            AccountEncryptionMigrateInvalidParamsReasonSchema
                                .enum.restore_required,
                    };
                }
                // Outside first-key enrollment, an external proof is admitted
                // only as the current-password proof of a password-bearing
                // plain -> e2ee conversion, decided once the credential is read.
                if (
                    migrationRequest.externalAuthProof
                    && !isFirstKeyEnrollment
                    && !(currentMode === "plain" && toMode === "e2ee")
                ) {
                    return { type: "invalid-params" as const };
                }
                if (
                    isFirstKeyEnrollment
                    && !migrationRequest.externalAuthProof
                ) {
                    return {
                        type: "invalid-params" as const,
                        reason:
                            AccountEncryptionMigrateInvalidParamsReasonSchema
                                .enum.key_proof_required,
                    };
                }

                if (account.settingsVersion !== expectedSettingsVersion) {
                    return {
                        type: "version-mismatch" as const,
                        currentVersion: account.settingsVersion,
                    };
                }

                let publicKeyHexUpdate: string | null = null;
                let contentKeyBinding:
                    VerifiedAccountContentKeyBinding | null = null;
                if (toMode === "e2ee") {
                    const verifiedKeyProof = verifyMigrationKeyProof({
                        request: migrationRequest,
                        accountId: userId,
                        sourceMode: currentMode,
                    });
                    if (!verifiedKeyProof) {
                        return { type: "invalid-params" as const };
                    }
                    if (
                        account.publicKey
                        && account.publicKey
                            !== verifiedKeyProof.publicKeyHex
                    ) {
                        return {
                            type: "invalid-params" as const,
                            reason: AccountEncryptionMigrateInvalidParamsReasonSchema.enum.restore_required,
                        };
                    }
                    publicKeyHexUpdate =
                        verifiedKeyProof.publicKeyHex;
                    contentKeyBinding =
                        verifiedKeyProof.contentKeyBinding;
                }

                const protocolRequestDigest =
                    createAccountEncryptionMigrateRequestBindingDigestV1({
                        request: migrationRequest,
                        accountId: userId,
                        sourceMode: currentMode,
                    });
                const accountEncryptionMigrationReplayBinding =
                    createAccountEncryptionMigrationReplayBindingV1({
                        accountId: userId,
                        protocolRequestDigest,
                    });

                const currentPasswordCredential = await tx.accountPasswordCredential.findUnique({
                    where: { accountId: userId },
                    select: { revision: true, credential: true },
                });
                const requestedPasswordCredential = migrationRequest.passwordCredential;
                if (Boolean(currentPasswordCredential) !== Boolean(requestedPasswordCredential)) {
                    return { type: "invalid-params" as const };
                }
                if (currentPasswordCredential && requestedPasswordCredential) {
                    if (currentPasswordCredential.revision !== requestedPasswordCredential.expectedRevision
                        || !parseAccountPasswordCredentialV1(currentMode, currentPasswordCredential.credential).ok
                        || !parseAccountPasswordCredentialV1(toMode, requestedPasswordCredential.credential).ok) {
                        return { type: "migration-inventory-changed" as const };
                    }
                    if (currentMode === "e2ee") {
                        if (!requestedPasswordCredential.proof) {
                            return { type: "invalid-params" as const };
                        }
                        const { passwordCredential: _passwordCredential, ...requestWithoutPasswordCredential } = migrationRequest;
                        const transitionRequestDigest = createAccountEncryptionMigrateRequestBindingDigestV1({
                            request: requestWithoutPasswordCredential,
                            accountId: userId,
                            sourceMode: currentMode,
                        });
                        const identity = await tx.accountIdentity.findUnique({
                            where: { accountId_provider: { accountId: userId, provider: "email" } },
                            select: { providerUserId: true },
                        });
                        const accepted = await consumePasswordMutationKeyChallengeInTx(tx, {
                            mutation: {
                                v: 1,
                                action: "change",
                                accountId: userId,
                                expectedCredentialRevision: requestedPasswordCredential.expectedRevision,
                                normalizedNativeEmail: identity?.providerUserId ?? null,
                                newCredentialDigest: createPasswordCredentialTargetDigestV1(
                                    requestedPasswordCredential.credential,
                                    transitionRequestDigest,
                                ),
                            },
                            proof: requestedPasswordCredential.proof,
                            env: requestHomeEnv,
                        });
                        if (!accepted) return { type: "invalid-params" as const };
                    }
                }

                // L02-R22 / 02.04 :179: an existing Plain password credential
                // entering E2EE proves the current password through the
                // transition-bound `email_password` first-key proof, whether the
                // Account is keyless or retains its signing key. The retained key
                // alone is not that proof.
                const requiresCurrentPasswordProof =
                    currentMode === "plain"
                    && toMode === "e2ee"
                    && currentPasswordCredential !== null;
                if (
                    migrationRequest.externalAuthProof
                    && !isFirstKeyEnrollment
                    && !requiresCurrentPasswordProof
                ) {
                    return { type: "invalid-params" as const };
                }
                if (isFirstKeyEnrollment || requiresCurrentPasswordProof) {
                    if (
                        !migrationRequest.externalAuthProof
                    ) {
                        return isFirstKeyEnrollment
                            ? { type: "internal-error" as const }
                            : {
                                type: "invalid-params" as const,
                                reason:
                                    AccountEncryptionMigrateInvalidParamsReasonSchema
                                        .enum.key_proof_required,
                            };
                    }
                    const externalAuth =
                        await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                            tx,
                            {
                                accountId: userId,
                                requestDigest:
                                    protocolRequestDigest,
                                externalAuthProof:
                                    migrationRequest
                                        .externalAuthProof,
                            },
                        );
                    if (!externalAuth.ok) {
                        return {
                            type: "invalid-params" as const,
                            reason:
                                AccountEncryptionMigrateInvalidParamsReasonSchema
                                    .enum.key_proof_required,
                        };
                    }
                    if (currentPasswordCredential && externalAuth.provider !== "email_password") {
                        return {
                            type: "invalid-params" as const,
                            reason: AccountEncryptionMigrateInvalidParamsReasonSchema.enum.key_proof_required,
                        };
                    }
                }

                const authoringMemoryMigration = await migrateAuthoringMemoryForAccountModeInTx(tx, {
                    accountId: userId, toMode, directive: authoringMemory,
                });
                if (authoringMemoryMigration.status !== "applied") {
                    throw new AccountEncryptionMigrationDomainRejectedError("authoring_memory", authoringMemoryMigration.status);
                }
                const profileRowsMigration = await migrateProfileRowsForAccountModeInTx(tx, {
                    accountId: userId, toMode, directive: profileRows,
                });
                if (profileRowsMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('profile_rows', profileRowsMigration.status);
                }
                const promptLibraryMigration = await migratePromptLibraryForAccountModeInTx(tx, {
                    accountId: userId, toMode, directive: promptLibrary,
                });
                if (promptLibraryMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('prompt_library', promptLibraryMigration.status);
                }
                const acpCatalogMigration = await migrateConfiguredAgentCatalogForAccountModeInTx(tx, {
                    accountId: userId, toMode, directive: acpCatalog,
                });
                if (acpCatalogMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('acp_catalog', acpCatalogMigration.status);
                }
                const mcpServerCatalogMigration = await migrateMcpServerCatalogForAccountModeInTx(tx, {
                    accountId: userId, toMode, directive: mcpServerCatalog,
                });
                if (mcpServerCatalogMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('mcp_server_catalog', mcpServerCatalogMigration.status);
                }
                const providerConnectionsMigration = await migrateProviderConnectionsForAccountModeInTx(tx, {
                    accountId: userId, toMode, directive: providerConnections,
                });
                if (providerConnectionsMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('provider_connections', providerConnectionsMigration.status);
                }
                const connectedConfigurationsMigration = await migrateConnectedAccountCatalogForAccountModeInTx(tx, {
                    accountId: userId, key: 'configurations', toMode, directive: connectedConfigurations,
                });
                if (connectedConfigurationsMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('connected_configurations', connectedConfigurationsMigration.status);
                }
                const connectedPurposesMigration = await migrateConnectedAccountCatalogForAccountModeInTx(tx, {
                    accountId: userId, key: 'purposes', toMode, directive: connectedPurposes,
                });
                if (connectedPurposesMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('connected_purposes', connectedPurposesMigration.status);
                }
                const remoteHostsMigration = await migrateRemoteHostCatalogForAccountModeInTx(tx, {
                    accountId: userId, toMode, directive: remoteHosts,
                });
                if (remoteHostsMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('remote_hosts', remoteHostsMigration.status);
                }
                const notificationChannelsMigration = await migrateNotificationChannelCatalogForAccountModeInTx(tx, {
                    accountId: userId, toMode, directive: notificationChannels,
                });
                if (notificationChannelsMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('notification_channels', notificationChannelsMigration.status);
                }
                const connectedPresentationMigration = await migrateConnectedPresentationForAccountModeInTx(tx, {
                    accountId: userId, toMode, directive: connectedPresentation,
                });
                if (connectedPresentationMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('connected_presentation', connectedPresentationMigration.status);
                }
                const connectedAcknowledgementsMigration = await migrateConnectedAcknowledgementsForAccountModeInTx(tx, {
                    accountId: userId, toMode, directive: connectedAcknowledgements,
                });
                if (connectedAcknowledgementsMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('connected_acknowledgements', connectedAcknowledgementsMigration.status);
                }
                const workspaceExecutionConfigMigration = await migrateWorkspaceExecutionConfigForAccountModeInTx(tx, {
                    accountId: userId, toMode, directive: workspaceExecutionConfig,
                });
                if (workspaceExecutionConfigMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('workspace_execution_config', workspaceExecutionConfigMigration.status);
                }
                const projectRowsMigration = await migrateProjectAccountRowsForAccountModeInTx(tx, {
                    accountId: userId, toMode, directive: projectRows,
                });
                if (projectRowsMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('project_rows', projectRowsMigration.status);
                }
                const projectTrustMigration = await migrateProjectTrustForAccountModeInTx(tx, { accountId: userId, toMode, directive: projectTrust });
                if (projectTrustMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('project_trust', projectTrustMigration.status);
                }

                const sessionDraftMigration =
                    await migrateNewSessionDraftsForAccountModeInTx(tx, {
                        accountId: userId,
                        toMode,
                        directive: sessionDrafts,
                    });
                if (sessionDraftMigration.status !== "applied") {
                    throw new AccountEncryptionMigrationSessionDraftRejectedError(
                        sessionDraftMigration,
                    );
                }

                const sessionMigration =
                    await migrateSessionAccountEncryptionInTx({
                        tx,
                accountId: userId,
                fromMode: currentMode,
                        toMode,
                        directive: sessions,
                    });
                if (sessionMigration.status !== "applied") {
                    // The one-time password-mutation proof was consumed and the
                    // new-Session drafts were already rewritten into the target
                    // mode above. A normal return would commit both while the
                    // Account stays in the source mode; throwing is the
                    // transaction-abort contract, exactly as the Settings
                    // rejection below states it.
                    throw new
                        AccountEncryptionMigrationSessionRejectedError(
                            sessionMigration.status,
                        );
                }
                const sessionPublications =
                    sessionMigration.sessions.map((migrated) => {
                        const projection =
                            projectSessionMetadataForRecipient({
                                session: migrated.session,
                                recipient: {
                                    type: "owner",
                                    accountId: userId,
                                    accountMode: toMode,
                                },
                            });
                        if (!("ownerMetadata" in projection)) {
                            throw new
                                SessionAccountEncryptionMigrationConflictError();
                        }
                        return {
                            accountId: userId,
                            cursor: migrated.ownerCursor,
                            sessionId: migrated.session.id,
                            projection,
                        };
                    });
                afterTx(tx, async () => {
                    for (const publication of sessionPublications) {
                        await eventRouter.emitUpdate({
                            userId: publication.accountId,
                            payload:
                                buildSessionMetadataRecipientUpdate(
                                    publication.sessionId,
                                    publication.cursor,
                                    randomKeyNaked(12),
                                    publication.projection,
                                ),
                            recipientFilter: {
                                type:
                                    "all-interested-in-session",
                                sessionId:
                                    publication.sessionId,
                            },
                        });
                    }
                });

                const settingsMigration =
                    await migrateAccountSettingsEncryptionInTx({
                        tx,
                        accountId: userId,
                        fromMode: currentMode,
                        toMode,
                        expectedSettingsVersion,
                        replacementContent: settingsContent,
                    });
                if (settingsMigration.status !== "applied") {
                    // Sessions may already have been rewritten. A normal
                    // return would commit those bytes and their owner cursor;
                    // throwing is the transaction-abort contract.
                    throw new
                        AccountEncryptionMigrationSettingsRejectedError(
                            settingsMigration.status,
                            account.settingsVersion,
                        );
                }
                const nextSettingsVersion =
                    settingsMigration.settingsVersion;

                const machineMigration =
                    await migrateMachineAccountEncryptionInTx({
                        tx,
                        accountId: userId,
                        toMode,
                        directive: machines,
                    });
                if (machineMigration.status !== "applied") {
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "machines",
                        machineMigration.status,
                    );
                }
                const todoMigration =
                    await migrateAccountJsonKvEncryptionInTx({
                        tx,
                        accountId: userId,
                        fromMode: currentMode,
                        toMode,
                        directive: todos,
                        namespace: 'todo',
                    });
                if (todoMigration.status !== "applied") {
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "todos",
                        todoMigration.status,
                    );
                }
                const workspaceMigration = await migrateAccountJsonKvEncryptionInTx({
                    tx, accountId: userId, namespace: 'workspace', fromMode: currentMode, toMode, directive: workspace,
                });
                if (workspaceMigration.status !== 'applied') {
                    throw new AccountEncryptionMigrationDomainRejectedError('workspace', workspaceMigration.status);
                }
                const artifactMigration =
                    await migrateArtifactAccountEncryptionInTx({
                        tx,
                        accountId: userId,
                        fromMode: currentMode,
                        toMode,
                        directive: artifacts,
                        preparedBlobs: preparedArtifactBlobs,
                    });
                if (artifactMigration.status !== "applied") {
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "artifacts",
                        artifactMigration.status,
                    );
                }

                const connectedServicesMigration =
                    await migrateConnectedServicesAccountEncryptionInTx({
                        tx,
                        accountId: userId,
                        currentMode,
                        toMode,
                        directive: connectedServices,
                    });
                if (connectedServicesMigration.status !== "applied") {
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "connected_services",
                        connectedServicesMigration.status,
                    );
                }

                const automationMigration =
                    await migrateAutomationAccountEncryptionInTx({
                        tx,
                        accountId: userId,
                        toMode,
                        ownerContentPublicKeyFingerprint: contentKeyBinding?.contentPublicKeyFingerprint,
                        directive:
                            migrationRequest.automations,
                    });
                if (automationMigration.status !== "applied") {
                    throw new AccountEncryptionMigrationAutomationRejectedError(
                        automationMigration.status,
                    );
                }

                try {
                    await migrateReviewCommentAccountEncryptionInTx({
                        accountId: userId,
                        targetMode: toMode,
                        directive: reviewComments,
                        persistence:
                            createReviewCommentAccountEncryptionMigrationPersistenceInTx(
                                tx,
                            ),
                    });
                } catch (error) {
                    throw classifyReviewCommentMigrationError(error) ?? error;
                }

                const sessionOrganizationMigration =
                    await migrateSessionOrganizationAccountEncryptionInTx({
                        tx,
                        accountId: userId,
                        toMode,
                        directive: sessionOrganization,
                    });
                if (
                    sessionOrganizationMigration.status
                    !== "applied"
                ) {
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "session_organization",
                        sessionOrganizationMigration.status,
                    );
                }

                const petsMigration =
                    await assertAccountPetLibraryEmptyForEncryptionTransitionInTx(
                        tx,
                        userId,
                    );
                if (petsMigration.status !== "empty") {
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "pets",
                        "not_empty",
                    );
                }

                const pluginWebhookInventory =
                    await assertPluginWebhookPayloadsEmptyForAccountEncryptionTransitionInTx(
                        tx,
                        userId,
                    );
                if (pluginWebhookInventory.status !== "empty") {
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "plugin_webhooks",
                        "migration_too_large",
                    );
                }

                const accountChangeHint = {
                    settingsVersion: nextSettingsVersion,
                    sourceAccountVersion: migrationRequest.expectedAccountVersion,
                    accountEncryptionMigrationReplayBinding,
                };

                const finalized =
                    await finalizeAccountEncryptionTransitionCoordinatorInTx({
                        tx,
                        accountId: userId,
                        fromMode: currentMode,
                        toMode,
                        ...(publicKeyHexUpdate
                            ? { accountPublicKeyHex: publicKeyHexUpdate }
                            : {}),
                        contentKey:
                            contentKeyBinding
                                ? {
                                    kind: "migration_replace",
                                    binding: contentKeyBinding,
                                }
                                : { kind: "preserve" },
                        ...(requestedPasswordCredential
                            ? { passwordCredential: {
                                expectedRevision: requestedPasswordCredential.expectedRevision,
                                credential: requestedPasswordCredential.credential,
                            } }
                            : {}),
                        accountChangeHint,
                    });
                if (
                    finalized.status === "collections_migration_incomplete"
                    || finalized.status
                        === "collections_identity_relocation_unsupported"
                ) {
                    // This transition carries the zero-sized assert-empty
                    // Collection directive, so `migration_incomplete` here can
                    // only mean a live row exists — never a capacity or
                    // currentness failure a client could retry past. A
                    // declared mode-derived identity is terminal for the same
                    // live row: the platform holds neither the Account key
                    // material nor the plugin's private components needed to
                    // recompute its address. Both are the same actionable
                    // fact, so they share the named Collection refusal instead
                    // of misreporting a size or an invalid request.
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "plugin_data",
                        "not_empty",
                    );
                }
                if (finalized.status === "collections_invalid_content") {
                    // Distinct from the refusals above: the row's persisted
                    // envelope or projection is inconsistent with its own
                    // contract, which is a content-integrity fact rather than
                    // a "remove your data and retry" one.
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "plugin_data",
                        "invalid_content",
                    );
                }
                if (finalized.status !== "applied") {
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "plugin_data",
                        "migration_incomplete",
                    );
                }

                afterTx(tx, () => {
                    eventRouter.emitUpdate({
                        userId,
                        payload: buildAccountSettingsChangedUpdate(nextSettingsVersion, finalized.cursor, randomKeyNaked(12)),
                        recipientFilter: { type: "user-machine-scoped-only" },
                    });
                });

                return {
                    type: "success" as const,
                    mode: toMode,
                    accountVersion: finalized.version,
                    settingsVersion: nextSettingsVersion,
                    sessionDraftRecords: sessionDrafts
                        ? sessionDraftMigration.records
                        : undefined,
                    authoringMemoryRows: authoringMemory ? authoringMemoryMigration.rows : undefined,
                    profileRowsResult: profileRows ? { rows: profileRowsMigration.rows,
                        referenceGuardRevision: profileRowsMigration.referenceGuardRevision, transferControl: profileRowsMigration.transferControl } : undefined,
                    promptLibraryRows: promptLibrary ? promptLibraryMigration.rows : undefined,
                    acpCatalogResult: acpCatalog ? { row: acpCatalogMigration.row } : undefined,
                    mcpServerCatalogResult: mcpServerCatalog ? mcpServerCatalogMigration.row : undefined,
                    providerConnectionsResult: providerConnections ? { row: providerConnectionsMigration.row } : undefined,
                    connectedConfigurationsResult: connectedConfigurations ? { row: connectedConfigurationsMigration.row } : undefined,
                    connectedPurposesResult: connectedPurposes ? { row: connectedPurposesMigration.row } : undefined,
                    remoteHostsResult: remoteHosts ? remoteHostsMigration.row : undefined,
                    notificationChannelsResult: notificationChannels ? notificationChannelsMigration.row : undefined,
                    connectedPresentationResult: connectedPresentation ? connectedPresentationMigration.row : undefined,
                    connectedAcknowledgementsResult: connectedAcknowledgements ? connectedAcknowledgementsMigration.row : undefined,
                    workspaceExecutionConfigRows: workspaceExecutionConfig ? workspaceExecutionConfigMigration.rows : undefined,
                    projectRows: projectRows ? projectRowsMigration.rows : undefined,
                    projectTrustRows: projectTrust ? projectTrustMigration.rows : undefined,
                };
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
            if (result.type === "migration-inventory-changed") {
                return reply.code(400).send(
                    {
                        error: "invalid-params",
                        reason:
                            AccountEncryptionMigrateInvalidParamsReasonSchema
                                .enum.migration_inventory_changed,
                    },
                );
            }
            // Activation has committed. A failed physical delete retains exact retry custody, not a failed mode change.
            await cleanupRejectedArtifactBlobUploads(userId).catch(error => request.log.error({ err: error }, 'Artifact conversion cleanup retained for retry'));
            return reply.send(AccountEncryptionMigrateSuccessResponseSchema.parse({
                success: true,
                mode: result.mode,
                accountVersion: result.accountVersion,
                settingsVersion: result.settingsVersion,
                ...(result.authoringMemoryRows ? { authoringMemory: { rows: result.authoringMemoryRows } } : {}),
                ...(result.profileRowsResult ? { profileRows: result.profileRowsResult } : {}),
                ...(result.promptLibraryRows ? { promptLibrary: { rows: result.promptLibraryRows } } : {}),
                ...(result.acpCatalogResult ? { acpCatalog: result.acpCatalogResult } : {}),
                ...(result.mcpServerCatalogResult ? { mcpServerCatalog: result.mcpServerCatalogResult } : {}),
                ...(result.providerConnectionsResult ? { providerConnections: result.providerConnectionsResult } : {}),
                ...(result.connectedConfigurationsResult ? { connectedConfigurations: result.connectedConfigurationsResult } : {}),
                ...(result.connectedPurposesResult ? { connectedPurposes: result.connectedPurposesResult } : {}),
                ...(result.remoteHostsResult ? { remoteHosts: result.remoteHostsResult } : {}),
                ...(result.notificationChannelsResult ? { notificationChannels: result.notificationChannelsResult } : {}),
                ...(result.connectedPresentationResult ? { connectedPresentation: result.connectedPresentationResult } : {}),
                ...(result.connectedAcknowledgementsResult ? { connectedAcknowledgements: result.connectedAcknowledgementsResult } : {}),
                ...(result.workspaceExecutionConfigRows ? { workspaceExecutionConfig: { rows: result.workspaceExecutionConfigRows } } : {}),
                ...(result.projectRows ? { projectRows: { rows: result.projectRows } } : {}),
                ...(result.projectTrustRows ? { projectTrust: { rows: result.projectTrustRows } } : {}),
                ...(result.sessionDraftRecords
                    ? { sessionDrafts: {
                        ...(sessionDrafts && "v" in sessionDrafts ? { v: sessionDrafts.v } : {}),
                        records: result.sessionDraftRecords,
                    } }
                    : {}),
            }));
        } catch (error) {
            if (error instanceof InactiveAccountError) throw error;
            if (
                error
                instanceof AccountEncryptionMigrationSessionDraftRejectedError
            ) {
                const rejection = error.result;

                if (rejection.status === "requires_upgrade") {
                    return reply.code(400).send({
                        error: "metadata_privacy_upgrade_required",
                    });
                }
                return reply.code(400).send({
                    error: "invalid-params",
                    reason:
                        AccountEncryptionMigrateInvalidParamsReasonSchema
                            .enum.migration_inventory_changed,
                });
            }
            if (
                error
                instanceof AccountEncryptionMigrationSessionRejectedError
            ) {
                if (error.status === "not_empty") {
                    return reply.code(400).send({
                        error:
                            "metadata_privacy_upgrade_required",
                    });
                }
                if (
                    error.status === "migration_incomplete"
                ) {
                    return reply.code(400).send({
                        error: "invalid-params",
                        reason:
                            AccountEncryptionMigrateInvalidParamsReasonSchema
                                .enum.migration_inventory_changed,
                    });
                }
                return reply.code(400).send({
                    error: "invalid-params",
                });
            }
            if (
                error
                instanceof AccountEncryptionMigrationSettingsRejectedError
            ) {
                if (error.status === "account_not_found") {
                    return reply.code(500).send({
                        error: "internal",
                    });
                }
                if (error.status === "version_mismatch") {
                    return reply.code(409).send({
                        error: "version-mismatch",
                        currentVersion: error.currentVersion,
                    });
                }
                return reply.code(400).send({
                    error: "invalid-params",
                    reason: AccountEncryptionMigrateInvalidParamsReasonSchema.enum.migration_inventory_changed,
                });
            }
            if (
                error
                instanceof AccountEncryptionMigrationDomainRejectedError
            ) {
                if (error.domain === 'workspace') {
                    return reply.code(400).send({ error: 'invalid-params', reason: AccountEncryptionMigrateInvalidParamsReasonSchema.enum.migration_inventory_changed });
                }
                if (error.status === "migration_incomplete") {
                    return reply.code(400).send({
                        error: "invalid-params",
                        reason: AccountEncryptionMigrateInvalidParamsReasonSchema.enum.migration_inventory_changed,
                    });
                }
                if (error.status === "migration_too_large") {
                    return reply.code(400).send({ error: "migration_too_large" });
                }
                if (error.status === "invalid_content") {
                    return reply.code(400).send({
                        error: "invalid-params",
                    });
                }
                if (error.status === "unsupported_machine_kind") {
                    return reply.code(400).send({
                        error: "invalid-params",
                    });
                }

                if (error.domain === "connected_services") {
                    return reply.code(400).send({
                        error: "connected_services_not_empty",
                    });
                }
                if (error.domain === "machines") {
                    return reply.code(400).send({
                        error: "machines_not_empty",
                    });
                }
                if (error.domain === "todos") {
                    return reply.code(400).send({
                        error: "todos_not_empty",
                    });
                }
                if (error.domain === "review_comments") {
                    return reply.code(400).send({ error: "review_comments_not_empty" });
                }
                if (error.domain === "session_organization") {
                    return reply.code(400).send({ error: "session_organization_not_empty" });
                }
                if (error.domain === "pets") {
                    return reply.code(400).send({ error: "pets_not_empty" });
                }
                if (error.domain === "plugin_data") {
                    return reply.code(400).send({
                        error: "plugin_collections_not_empty",
                    });
                }
                return reply.code(400).send({
                    error: "artifacts_not_empty",
                });
            }
            if (
                error
                instanceof MachineAccountEncryptionMigrationConflictError
            ) {
                return reply.code(400).send({
                    error: "invalid-params",
                    reason:
                        AccountEncryptionMigrateInvalidParamsReasonSchema.enum
                            .migration_inventory_changed,
                });
            }
            if (
                error
                instanceof AccountJsonKvEncryptionMigrationConflictError
            ) {
                return reply.code(400).send({
                    error: "invalid-params",
                    reason:
                        AccountEncryptionMigrateInvalidParamsReasonSchema.enum
                            .migration_inventory_changed,
                });
            }
            if (error instanceof ArtifactAccountEncryptionMigrationQuotaExceededError) {
                return reply.code(413).send(error.quota);
            }
            if (
                error
                instanceof ArtifactAccountEncryptionMigrationConflictError
            ) {
                return reply.code(400).send({
                    error: "invalid-params",
                    reason:
                        AccountEncryptionMigrateInvalidParamsReasonSchema.enum
                            .migration_inventory_changed,
                    });
            }
            if (
                error
                instanceof
                SessionAccountEncryptionMigrationConflictError
            ) {
                return reply.code(400).send({
                    error: "invalid-params",
                    reason:
                        AccountEncryptionMigrateInvalidParamsReasonSchema.enum
                            .migration_inventory_changed,
                });
            }
            if (
                error
                instanceof
                SessionOrganizationAccountEncryptionMigrationConflictError
            ) {
                return reply.code(400).send({
                    error: "invalid-params",
                    reason:
                        AccountEncryptionMigrateInvalidParamsReasonSchema.enum
                            .migration_inventory_changed,
                });
            }
            if (
                error
                instanceof
                ConnectedServicesAccountEncryptionMigrationConflictError
            ) {
                return reply.code(400).send({
                    error: "invalid-params",
                    reason:
                        AccountEncryptionMigrateInvalidParamsReasonSchema.enum
                            .migration_inventory_changed,
                });
            }
            if (error instanceof AccountEncryptionMigrationAutomationRejectedError) {
                if (error.status === "invalid_content") {
                    return reply.code(400).send({
                        error: "invalid-params",
                    });
                }
                if (error.status === "migration_too_large") {
                    return reply.code(400).send({
                        error: "migration_too_large",
                    });
                }
                return reply.code(400).send({
                    error: "automations_not_empty",
                });
            }
            if (error instanceof WorkflowRunAccessError) {
                return reply.code(400).send({ error: "invalid-params" });
            }
            if (
                error
                instanceof AutomationAccountEncryptionMigrationConflictError
            ) {
                return reply.code(400).send({
                    error: "invalid-params",
                    reason:
                        AccountEncryptionMigrateInvalidParamsReasonSchema.enum
                            .migration_inventory_changed,
                });
            }
            return reply.code(500).send({ error: "internal" });
        }
    });
}
