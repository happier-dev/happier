import { type Fastify } from "../../types";
import { z } from "zod";
import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    AccountEncryptionMigrateRequestSchema,
    AccountEncryptionMigrateSuccessResponseSchema,
    AccountEncryptionMigratePredecessorSuccessResponseSchema,
    AccountEncryptionMigrateBadRequestResponseSchema,
    AccountEncryptionMigrateForbiddenResponseSchema,
    AccountEncryptionMigrateNotFoundResponseSchema,
    AccountEncryptionMigrateConflictResponseSchema,
    AccountEncryptionMigrateInternalResponseSchema,
    AccountEncryptionMigrateInvalidParamsReasonSchema,
    AccountEncryptionMigratePredecessorRequestSchema,
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
    AccountStoredContentUpgradeRequiredV1Schema,
    ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_MAX_UTF8_BYTES,
    computeAccountEncryptionMigrateKeyFingerprintV1,
    createAccountEncryptionMigrateProofSigningInputV1,
    createAccountEncryptionMigrateRequestBindingDigestV1,
    createAccountEncryptionMigrateTransitionAuthorizationBindingDigestV1,
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
} from "@/app/automations/automationCrudService";
import {
    matchAccountSettingsEncryptionMigrationPostStateInTx,
    migrateAccountSettingsEncryptionInTx,
} from "@/app/accountSettings/migrateAccountSettingsEncryptionInTx";
import { eventRouter } from "@/app/events/eventRouter";
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
    matchArtifactAccountEncryptionMigrationPostStateInTx,
    migrateArtifactAccountEncryptionInTx,
} from "@/app/artifacts/artifactWriteService";
import {
    matchTodoAccountEncryptionMigrationPostStateInTx,
    TodoAccountEncryptionMigrationConflictError,
    migrateTodoAccountEncryptionInTx,
} from "@/app/kv/migrateTodoAccountEncryptionInTx";
import {
    buildAccountStoredContentUpgradeRequired,
    enforceAccountEncryptionTransitionCompatibilityForHttpRequest,
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
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

const AccountEncryptionMigrateIngressRequestSchema = z.union([
    AccountEncryptionMigrateRequestSchema,
    AccountEncryptionMigratePredecessorRequestSchema,
]);

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

class AccountEncryptionMigrationDomainRejectedError extends Error {
    constructor(
        readonly domain:
            | "connected_services"
            | "machines"
            | "todos"
            | "artifacts"
            | "review_comments"
            | "session_organization"
            | "pets"
            | "plugin_webhooks"
            | "plugin_data"
            | "plugin_settings",
        readonly status:
            | "not_empty"
            | "migration_incomplete"
            | "invalid_content"
            | "migration_too_large",
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
 * refusal so a future V5 declaration can scrub a persisted source stage;
 * the current V3 compatibility declaration still rejects every V5 operation
 * before any route handler runs.
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
    if (params.request.authorization.kind === "present_user_confirmation") {
        return await authorizeAccountEncryptionTransitionCoordinatorInTx({
            tx: params.tx,
            accountId: params.accountId,
            transitionId: params.request.transitionId,
            authorization: { kind: "present_user_confirmation" },
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
        },
    });
}

export function registerAccountEncryptionMigrateRoutes(app: Fastify): void {
    app.get(
        "/v1/account/encryption/migrate/review-comments/inventory",
        {
            preHandler: app.authenticate,
            schema: {
                response: {
                    200:
                        ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema,
                    426: AccountStoredContentUpgradeRequiredV1Schema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            if (
                !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                    request,
                    reply,
                )
            ) {
                return;
            }
            try {
                const inventory = await inTx(async (tx) =>
                    await createReviewCommentAccountEncryptionMigrationPersistenceInTx(
                        tx,
                    ).readInventory(request.userId)
                );
                return reply.send(
                    buildReviewCommentAccountEncryptionMigrationInventoryResponse(
                        inventory,
                    ),
                );
            } catch {
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
                    426: AccountStoredContentUpgradeRequiredV1Schema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            if (
                !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                    request,
                    reply,
                )
            ) {
                return;
            }
            try {
                return reply.send(await inTx(async (tx) =>
                    await readSessionOrganizationAccountEncryptionMigrationInventoryInTx({
                        tx,
                        accountId: request.userId,
                    })
                ));
            } catch {
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
                    426: AccountStoredContentUpgradeRequiredV1Schema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            if (!await enforceAccountEncryptionTransitionCompatibilityForHttpRequest(
                request,
                reply,
            )) return;
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
            } catch {
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
                    426: AccountStoredContentUpgradeRequiredV1Schema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            if (!await enforceAccountEncryptionTransitionCompatibilityForHttpRequest(
                request,
                reply,
            )) return;
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
            } catch {
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
                    426: AccountStoredContentUpgradeRequiredV1Schema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            if (!await enforceAccountEncryptionTransitionCompatibilityForHttpRequest(
                request,
                reply,
            )) return;
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
            } catch {
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
                    426: AccountStoredContentUpgradeRequiredV1Schema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            if (!await enforceAccountEncryptionTransitionCompatibilityForHttpRequest(
                request,
                reply,
            )) return;
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
            } catch {
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
                    426: AccountStoredContentUpgradeRequiredV1Schema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            if (!await enforceAccountEncryptionTransitionCompatibilityForHttpRequest(
                request,
                reply,
            )) return;
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
            } catch {
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
                    426: AccountStoredContentUpgradeRequiredV1Schema,
                    500: AccountEncryptionMigrateInternalResponseSchema,
                },
            },
        },
        async (request, reply) => {
            if (!await enforceAccountEncryptionTransitionCompatibilityForHttpRequest(
                request,
                reply,
            )) return;
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
            } catch {
                return reply.code(500).send({ error: "internal" });
            }
        },
    );

    app.post("/v1/account/encryption/migrate", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            body: AccountEncryptionMigrateIngressRequestSchema,
            response: {
                200: z.union([
                    AccountEncryptionMigrateSuccessResponseSchema,
                    AccountEncryptionMigratePredecessorSuccessResponseSchema,
                ]),
                400: AccountEncryptionMigrateBadRequestResponseSchema,
                403: z.union([
                    AccountEncryptionMigrateForbiddenResponseSchema,
                    PresentUserRequiredResponseSchema,
                ]),
                404: AccountEncryptionMigrateNotFoundResponseSchema,
                409: AccountEncryptionMigrateConflictResponseSchema,
                426: AccountStoredContentUpgradeRequiredV1Schema,
                500: AccountEncryptionMigrateInternalResponseSchema,
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const ingressRequest = request.body;
        const isPredecessorRequest =
            !("machines" in ingressRequest)
            && !("todos" in ingressRequest)
            && !("artifacts" in ingressRequest);
        if (
            new TextEncoder().encode(JSON.stringify(ingressRequest)).byteLength
            > ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_MAX_UTF8_BYTES
        ) {
            return reply.code(400).send(
                isPredecessorRequest
                    ? { error: "invalid-params" }
                    : { error: "migration_too_large" },
            );
        }
        const currentRequest =
            AccountEncryptionMigrateRequestSchema.safeParse(
                ingressRequest,
            );
        const isPredecessorPlainMigrationRequest =
            isPredecessorRequest
            && ingressRequest.toMode === "plain";
        if (
            isPredecessorRequest
            && !isPredecessorPlainMigrationRequest
        ) {
            return reply.code(426).send(
                buildAccountStoredContentUpgradeRequired(),
            );
        }
        if (
            currentRequest.success
            && !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            )
        ) {
            return;
        }
        const {
            toMode,
            expectedSettingsVersion,
            settingsContent,
            connectedServices,
            automations,
            keyProof,
        } = ingressRequest;
        const machines =
            "machines" in ingressRequest
                ? ingressRequest.machines
                : { action: "assert_empty" as const };
        const todos =
            "todos" in ingressRequest
                ? ingressRequest.todos
                : { action: "assert_empty" as const };
        const artifacts =
            "artifacts" in ingressRequest
                ? ingressRequest.artifacts
                : { action: "assert_empty" as const };
        const sessions =
            "sessions" in ingressRequest
                ? ingressRequest.sessions
                : { action: "assert_empty" as const };
        const reviewComments =
            "reviewComments" in ingressRequest
                ? ingressRequest.reviewComments
                : { action: "assert_empty" as const };
        const sessionOrganization =
            "sessionOrganization" in ingressRequest
                ? ingressRequest.sessionOrganization
                : { action: "assert_empty" as const };

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
                    if (
                        isPredecessorRequest
                        || !currentRequest.success
                    ) {
                        return {
                            type:
                                "migration-inventory-changed" as const,
                        };
                    }
                    const replayRequest = currentRequest.data;
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
                        if (
                            replayRequest.externalAuthProof
                            && !sourceWasKeyless
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
                        await matchTodoAccountEncryptionMigrationPostStateInTx({
                            tx,
                            accountId: userId,
                            toMode,
                            directive: replayRequest.todos,
                        });
                    const artifactsPostState =
                        await matchArtifactAccountEncryptionMigrationPostStateInTx({
                            tx,
                            accountId: userId,
                            toMode,
                            directive: replayRequest.artifacts,
                        });
                    const sessionsPostState =
                        await matchSessionAccountEncryptionMigrationPostStateInTx({
                            tx,
                            accountId: userId,
                            toMode,
                            directive: replayRequest.sessions,
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
                        || artifactsPostState.status !== "matched"
                        || sessionsPostState.status !== "matched"
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
                const hasLivePluginCollection =
                    pluginDataCensus.status === "nonempty"
                    && pluginDataCensus.hasLiveCollection;

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
                // Keep the current request's pre-existing migration-size
                // failures ahead of later request validation. The retained
                // predecessor body has a different compatibility contract,
                // resolved after its Account/body/currentness checks below.
                if (!isPredecessorRequest && pluginDataBlocksTransition) {
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "plugin_data",
                        "migration_too_large",
                    );
                }
                if (!isPredecessorRequest && pluginSettingsBlockTransition) {
                    throw new AccountEncryptionMigrationDomainRejectedError(
                        "plugin_settings",
                        "migration_too_large",
                    );
                }

                if (
                    currentMode === "plain"
                    && toMode === "e2ee"
                    && !currentRequest.success
                ) {
                    return {
                        type: "invalid-params" as const,
                        reason:
                            AccountEncryptionMigrateInvalidParamsReasonSchema
                                .enum.key_proof_required,
                    };
                }
                if (
                    currentRequest.success
                    && (
                        currentRequest.data.expectedAccountVersion
                            !== account.version
                        || currentRequest.data
                            .expectedSigningKeyFingerprint
                            !== account.signingKeyFingerprint
                        || currentRequest.data
                            .expectedContentKeyFingerprint
                            !== account.contentKeyFingerprint
                    )
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
                if (
                    currentRequest.success
                    && currentRequest.data.externalAuthProof
                    && !isFirstKeyEnrollment
                ) {
                    return { type: "invalid-params" as const };
                }
                if (
                    isFirstKeyEnrollment
                    && (
                        !currentRequest.success
                        || !currentRequest.data.externalAuthProof
                    )
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

                if (isPredecessorRequest) {
                    if (
                        account.settings !== null
                        || connectedServices.action !== "assert_empty"
                        || automations.action !== "assert_empty"
                    ) {
                        return {
                            type: "predecessor-invalid-params" as const,
                        };
                    }
                    // The retained predecessor body has no Collection
                    // directive. A live row is therefore an operation-level
                    // compatibility refusal, not a migration-size response
                    // the predecessor can parse. Preserve the established
                    // Account/settings and legacy-body currentness checks,
                    // then refuse before any domain writer in this
                    // transaction.
                    if (hasLivePluginCollection) {
                        return {
                            type:
                                "metadata-privacy-upgrade-required" as const,
                        };
                    }
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
                    const machineCount = await tx.machine.count({
                        where: { accountId: userId },
                        take: 1,
                    });
                    const todoCount = await tx.userKVStore.count({
                        where: {
                            accountId: userId,
                            key: { startsWith: "todo." },
                            value: { not: null },
                        },
                        take: 1,
                    });
                    const artifactCount = await tx.artifact.count({
                        where: { accountId: userId },
                        take: 1,
                    });
                    let reviewCommentsNotEmpty = false;
                    try {
                        await migrateReviewCommentAccountEncryptionInTx({
                            accountId: userId,
                            targetMode: toMode,
                            directive: { action: "assert_empty" },
                            persistence:
                                createReviewCommentAccountEncryptionMigrationPersistenceInTx(
                                    tx,
                                ),
                        });
                    } catch (error) {
                        const classified =
                            classifyReviewCommentMigrationError(error);
                        if (
                            classified?.status !== "not_empty"
                        ) {
                            throw classified ?? error;
                        }
                        reviewCommentsNotEmpty = true;
                    }
                    const sessionOrganizationPreflight =
                        await migrateSessionOrganizationAccountEncryptionInTx({
                            tx,
                            accountId: userId,
                            toMode,
                            directive: { action: "assert_empty" },
                        });
                    const petsPreflight =
                        await assertAccountPetLibraryEmptyForEncryptionTransitionInTx(
                            tx,
                            userId,
                        );
                    if (
                        machineCount > 0
                        || todoCount > 0
                        || artifactCount > 0
                        || reviewCommentsNotEmpty
                        || sessionOrganizationPreflight.status
                            === "not_empty"
                        || petsPreflight.status === "not_empty"
                    ) {
                        return {
                            type:
                                "metadata-privacy-upgrade-required" as const,
                        };
                    }
                }
                if (!isPredecessorRequest && !currentRequest.success) {
                    return { type: "internal-error" as const };
                }

                let publicKeyHexUpdate: string | null = null;
                let contentKeyBinding:
                    VerifiedAccountContentKeyBinding | null = null;
                if (toMode === "e2ee") {
                    if (!currentRequest.success) {
                        return {
                            type: "invalid-params" as const,
                            reason:
                                AccountEncryptionMigrateInvalidParamsReasonSchema
                                    .enum.key_proof_required,
                        };
                    }
                    const verifiedKeyProof = verifyMigrationKeyProof({
                        request: currentRequest.data,
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

                let protocolRequestDigest:
                    ReturnType<
                        typeof createAccountEncryptionMigrateRequestBindingDigestV1
                    > | null = null;
                let accountEncryptionMigrationReplayBinding:
                    string | null = null;
                if (currentRequest.success) {
                    protocolRequestDigest =
                        createAccountEncryptionMigrateRequestBindingDigestV1({
                            request: currentRequest.data,
                            accountId: userId,
                            sourceMode: currentMode,
                        });
                    accountEncryptionMigrationReplayBinding =
                        createAccountEncryptionMigrationReplayBindingV1({
                            accountId: userId,
                            protocolRequestDigest,
                        });
                }

                if (isFirstKeyEnrollment) {
                    if (
                        !currentRequest.success
                        || !protocolRequestDigest
                        || !currentRequest.data.externalAuthProof
                    ) {
                        return { type: "internal-error" as const };
                    }
                    const externalAuth =
                        await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                            tx,
                            {
                                accountId: userId,
                                requestDigest:
                                    protocolRequestDigest,
                                externalAuthProof:
                                    currentRequest.data
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
                    if (isFirstKeyEnrollment) {
                        throw new
                            AccountEncryptionMigrationSessionRejectedError(
                                sessionMigration.status,
                            );
                    }
                    if (
                        isPredecessorRequest
                        || sessionMigration.status === "not_empty"
                    ) {
                        return {
                            type:
                                "metadata-privacy-upgrade-required" as const,
                        };
                    }
                    if (
                        sessionMigration.status
                        === "migration_incomplete"
                    ) {
                        return {
                            type:
                                "migration-inventory-changed" as const,
                        };
                    }
                    return {
                        type: "invalid-params" as const,
                    };
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
                afterTx(tx, () => {
                    for (const publication of sessionPublications) {
                        eventRouter.emitUpdate({
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

                if (!isPredecessorRequest) {
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
                        await migrateTodoAccountEncryptionInTx({
                            tx,
                            accountId: userId,
                            fromMode: currentMode,
                            toMode,
                            directive: todos,
                        });
                    if (todoMigration.status !== "applied") {
                        throw new AccountEncryptionMigrationDomainRejectedError(
                            "todos",
                            todoMigration.status,
                        );
                    }
                    const artifactMigration =
                        await migrateArtifactAccountEncryptionInTx({
                            tx,
                            accountId: userId,
                            toMode,
                            directive: artifacts,
                        });
                    if (artifactMigration.status !== "applied") {
                        throw new AccountEncryptionMigrationDomainRejectedError(
                            "artifacts",
                            artifactMigration.status,
                        );
                    }
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
                        directive:
                            currentRequest.success
                                ? currentRequest.data.automations
                                : { action: "assert_empty" },
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

                const accountChangeHint =
                        currentRequest.success
                        && accountEncryptionMigrationReplayBinding
                            ? {
                                settingsVersion:
                                    nextSettingsVersion,
                                sourceAccountVersion:
                                    currentRequest.data
                                        .expectedAccountVersion,
                                accountEncryptionMigrationReplayBinding,
                            }
                            : {
                                settingsVersion:
                                    nextSettingsVersion,
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
            if (result.type === "predecessor-invalid-params") {
                return reply.code(400).send({ error: "invalid-params" });
            }
            if (result.type === "migration-inventory-changed") {
                if (isPredecessorRequest) {
                    return reply.code(426).send(
                        buildAccountStoredContentUpgradeRequired(),
                    );
                }
                return reply.code(400).send(
                    {
                        error: "invalid-params",
                        reason:
                            AccountEncryptionMigrateInvalidParamsReasonSchema
                                .enum.migration_inventory_changed,
                    },
                );
            }
            if (result.type === "metadata-privacy-upgrade-required") {
                if (isPredecessorRequest) {
                    return reply.code(426).send(
                        buildAccountStoredContentUpgradeRequired(),
                    );
                }
                return reply.code(400).send(
                    {
                        error:
                            "metadata_privacy_upgrade_required",
                    },
                );
            }
            return reply.send(
                isPredecessorRequest
                    ? {
                        success: true,
                        mode: result.mode,
                        settingsVersion: result.settingsVersion,
                    }
                    : {
                        success: true,
                        mode: result.mode,
                        accountVersion: result.accountVersion,
                        settingsVersion: result.settingsVersion,
                    },
            );
        } catch (error) {
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
                return reply.code(400).send(
                    isPredecessorRequest
                        ? { error: "invalid-params" }
                        : {
                            error: "invalid-params",
                            reason:
                                AccountEncryptionMigrateInvalidParamsReasonSchema
                                    .enum.migration_inventory_changed,
                        },
                );
            }
            if (
                error
                instanceof AccountEncryptionMigrationDomainRejectedError
            ) {
                if (error.status === "migration_incomplete") {
                    return reply.code(400).send(
                        isPredecessorRequest
                            ? { error: "invalid-params" }
                            : {
                                error: "invalid-params",
                                reason:
                                    AccountEncryptionMigrateInvalidParamsReasonSchema
                                        .enum
                                        .migration_inventory_changed,
                            },
                    );
                }
                if (error.status === "migration_too_large") {
                    if (
                        isPredecessorRequest
                        && error.domain === "plugin_data"
                    ) {
                        return reply.code(426).send(
                            buildAccountStoredContentUpgradeRequired(),
                        );
                    }
                    return reply.code(400).send(
                        isPredecessorRequest
                            ? { error: "invalid-params" }
                            : { error: "migration_too_large" },
                    );
                }
                if (error.status === "invalid_content") {
                    return reply.code(400).send({
                        error: "invalid-params",
                    });
                }
                if (
                    isPredecessorRequest
                    && error.status === "not_empty"
                    && (
                        error.domain === "review_comments"
                        || error.domain === "session_organization"
                        || error.domain === "pets"
                    )
                ) {
                    return reply.code(426).send(
                        buildAccountStoredContentUpgradeRequired(),
                    );
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
                    return reply.code(400).send(
                        isPredecessorRequest
                            ? { error: "invalid-params" }
                            : {
                                error:
                                    "review_comments_not_empty",
                            },
                    );
                }
                if (error.domain === "session_organization") {
                    return reply.code(400).send(
                        isPredecessorRequest
                            ? { error: "invalid-params" }
                            : {
                                error:
                                    "session_organization_not_empty",
                            },
                    );
                }
                if (error.domain === "pets") {
                    return reply.code(400).send(
                        isPredecessorRequest
                            ? { error: "invalid-params" }
                            : { error: "pets_not_empty" },
                    );
                }
                if (error.domain === "plugin_data") {
                    // The predecessor body carries no Collection directive, so
                    // a live row is refused as an operation-level upgrade
                    // requirement long before this transition runs. Only a
                    // current request reaches here.
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
                instanceof TodoAccountEncryptionMigrationConflictError
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
