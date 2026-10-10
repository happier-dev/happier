import { InactiveAccountError } from "@/app/auth/accountStatus";
import { inTx } from "@/storage/inTx";
import { db, isPrismaErrorCode } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { z } from "zod";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    SessionOrganizationPlacementV1Schema,
    SessionOwnerMetadataEnvelopeV1Schema,
    SessionInitialAccessMaterializedV1Schema,
    SessionInitialTriggerAdmissionV1Schema,
    SESSION_METADATA_LAYOUT_VERSION_V1,
    SessionCreateOriginFieldsV1Schema,
    refineSessionCreateOriginFieldsV1,
    SessionReportsToV1Schema,
    V2SessionRecordSchema,
    SESSION_CREATION_AUTHORIZATION_HEADER_V1,
} from "@happier-dev/protocol";
import { SessionTeamCredentialBindingIntentsV1Schema } from "@happier-dev/protocol/teams";
import { applySessionTranscriptPublicationCeiling } from "@/app/session/sessionTranscriptPublicationPolicy";
import { initializeExternalLinkedSessionStorage } from "@/app/session/externalLinkedSessionStorageInitialization";
import {
    createSessionMetadataPrivacyUpgradeRequiredResponse,
    isSessionMetadataPrivacyUpgradeRequiredError,
    projectSessionMetadataForRecipient,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import {
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { createLegacyLayout0SessionInTx } from "@/app/session/create/createLegacyLayout0Session";
import { isSessionOwnerEnvelopeError } from "@/app/session/create/layout1SessionRowWrite";
import {
    createSessionDataKeyEnvelopeViewerSelect,
    projectViewerSessionDataKey,
} from "@/app/session/encryption/sessionDataKeyEnvelopePersistence";
import { createOrRejoinLayout1SessionByTag } from "@/app/session/create/createOrRejoinLayout1SessionByTag";
import { restoreSessionTagRejoinInTx } from "@/app/session/create/restoreSessionTagRejoinInTx";
import { publishSessionArchiveTransition } from "@/app/session/archive/publishSessionArchiveTransition";
import { readSessionCreatorCurrentness } from "@/app/session/create/layout1SessionCreateInvariants";
import type { SessionOrganizationPlacement } from "@/app/session/create/layout1SessionRowWrite";
import {
    admitRequestedSessionEncryptionMode,
    prepareLayout1SessionCreate,
    resolveEffectiveLayout1SessionEncryptionMode,
    type Layout1SessionCreateRejection,
} from "@/app/session/create/prepareLayout1SessionCreate";
import { mapPendingActivationAuthorization } from "@/app/session/pending/pendingActivationAuthorization";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { isSessionCollaborationEnabled } from "@/app/session/access/sessionAccess";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { projectSessionReportsForRowsInTx } from "@/app/session/awareness/sessionReportsProjection";
import { projectStoredSessionOrigin } from "@/app/session/listing/rows";

import { type Fastify } from "../../types";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { auth, ApiTokenOperationError } from "@/app/auth/auth";
import { verifyCurrentExternalActionPrincipal } from "@/app/auth/externalActionExecutionAuthorization";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, type ExternalActionExecutionAuthorizationBindingV1 } from "@happier-dev/protocol/actions";
import { readSessionCreationApiTokenIdInTx } from "@/app/session/create/apiTokenSessionCreationAuthorization";

export function registerSessionCreateOrLoadRoute(app: Fastify) {
    app.post('/v1/sessions', {
        schema: {
            body: z.union([z.object({
                tag: z.string(),
                metadata: z.string(),
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish(),
                encryptionMode: z.enum(["e2ee", "plain"]).optional(),
                currentStorageState: z.literal("machine_only").optional(),
            }).strict(), z.object({
                tag: z.string(),
                metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
                sharedMetadata: z.object({ ciphertext: z.string().min(1) }).strict(),
                ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish(),
                encryptionMode: z.enum(["e2ee", "plain"]).optional(),
                currentStorageState: z.literal("machine_only").optional(),
                organizationPlacement: SessionOrganizationPlacementV1Schema.optional(),
                initialAccess: SessionInitialAccessMaterializedV1Schema.optional(),
                initialTriggers: z.array(SessionInitialTriggerAdmissionV1Schema).optional(),
                primaryTeamId: z.string().min(1).nullable().optional(),
                teamCredentialBindings: SessionTeamCredentialBindingIntentsV1Schema.optional(),
                reportsTo: SessionReportsToV1Schema.optional(),
                ...SessionCreateOriginFieldsV1Schema.shape,
            }).strict().superRefine(refineSessionCreateOriginFieldsV1)])
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        let sessionCreationAuthorization: ExternalActionExecutionAuthorizationBindingV1 | undefined;
        const creationHeader = request.headers[SESSION_CREATION_AUTHORIZATION_HEADER_V1];
        if (request.externalActionExecutionAuthorized === true) {
            const binding = request.externalActionExecutionAuthorizationBinding;
            if (!binding || binding.accountId !== request.userId || binding.actionId !== 'session.spawn_new'
                || request.externalActionEffectActionId !== 'session.spawn_new'
                || creationHeader !== undefined && creationHeader !== request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]) {
                return reply.code(401).send({ error: 'invalid_token' });
            }
            sessionCreationAuthorization = binding;
        } else if (creationHeader !== undefined) {
            if (typeof creationHeader !== "string") return reply.code(401).send({ error: "invalid_token" });
            const binding = await auth.verifyExternalActionExecutionAuthorization(creationHeader);
            if (!binding || binding.accountId !== request.userId || binding.actionId !== "session.spawn_new"
                || binding.serverIdentityId !== await getOrCreateServerIdentityId()) return reply.code(401).send({ error: "invalid_token" });
            if (!await verifyCurrentExternalActionPrincipal(binding)) return reply.code(401).send({ error: "invalid_token" });
            sessionCreationAuthorization = binding;
        }
        const requestHomeEnv = await readRequestHomeEnv(request);
        const userId = request.userId;
        const layoutOneRequest =
            "sharedMetadata" in request.body
                ? request.body
                : null;
        const isLayoutOneRequest = layoutOneRequest !== null;

        // `initialAccess` and authored Team context are one atomic collaboration
        // operation. A Home whose Session sharing is disabled must refuse before
        // creating the Session; creating a private row and patching access later
        // would expose a visible intermediate and cannot satisfy Team policy.
        // The refusal names this Home's sharing decision; it is not an update requirement.
        if (
            isLayoutOneRequest
            && (layoutOneRequest.initialAccess !== undefined || layoutOneRequest.primaryTeamId !== undefined)
            && !isSessionCollaborationEnabled()
        ) {
            return reply.code(409).send({ error: "session_access_sharing_unavailable" });
        }
        if (
            layoutOneRequest?.teamCredentialBindings !== undefined
            && !isServerFeatureEnabledForRequest("teams.credentialResources", requestHomeEnv)
        ) {
            return reply.code(409).send({
                error: "update_required",
                kind: "update_required",
                operation: "session.spawn_new",
                component: "server",
                reason: "session_team_credential_binding_update_required",
            });
        }
        const {
            tag,
            agentState,
            dataEncryptionKey,
        } = request.body;
        const metadata =
            "sharedMetadata" in request.body
                ? request.body.sharedMetadata.ciphertext
                : request.body.metadata;
        const requestedEncryptionMode = request.body.encryptionMode;
        const requestedStorageState = request.body.currentStorageState;
        const policy = readEncryptionFeatureEnv(requestHomeEnv);

        function sendSessionCreateRejection(rejection: Layout1SessionCreateRejection) {
            switch (rejection.reason) {
                case "session-reports-to-invalid":
                    return reply.code(rejection.result.error === "reports_to_cycle" ? 400
                        : rejection.result.error === "reports_to_cas_conflict" ? 409 : 403).send(rejection.result);
                case "session-origin-forbidden":
                    return reply.code(403).send({ error: "session-origin-forbidden" });
                case "session-initial-trigger-invalid":
                    return reply.code(rejection.code === "invalid_input" ? 400 : 409).send({
                        error: "initial_trigger_admission_failed", code: rejection.code,
                    });
                case "account-disabled":
                    return reply.code(403).send({ error: "account-disabled" });
                case "encryption-mode-not-allowed":
                    return reply.code(400).send({
                        error: "invalid-params",
                        code: rejection.code,
                    });
                case "invalid-organization-placement":
                    return reply.code(400).send({
                        error: "invalid-params",
                        code: "invalid-session-organization-placement",
                    });
                case "privacy-upgrade-required":
                    return reply.code(409).send(
                        createSessionMetadataPrivacyUpgradeRequiredResponse(),
                    );
                case "invalid-params":
                    return reply.code(400).send({ error: "invalid-params" });
                case "session-initial-access-invalid": {
                    const status: 400 | 403 | 404 | 409 | 503 = rejection.code === "session_access_authentication_unavailable"
                        ? 503
                        : rejection.code === "session_access_forbidden"
                        || rejection.code === "session_access_permission_delegation_forbidden"
                        || rejection.code === "session_access_external_sharing_requires_team_admin"
                        || rejection.code === "session_access_external_sharing_disabled"
                        || rejection.code === "session_access_authentication_required"
                        ? 403
                        : rejection.code === "session_access_session_not_found"
                            || rejection.code === "session_access_subject_not_found"
                            ? 404
                            : rejection.code === "session_access_team_policy_required"
                                ? 409
                                : 400;
                    return reply.code(status).send({ error: rejection.code });
                }
                case "team-credential-binding-invalid":
                    return reply.code(
                        rejection.code === "resource_changed"
                            ? 409
                            : rejection.code === "authentication_required"
                                ? 403
                                : rejection.code === "authentication_unavailable"
                                    ? 503
                                    : 400,
                    ).send({
                        error: rejection.code,
                    });
            }
        }

        if (
            isLayoutOneRequest
            && !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            )
        ) {
            if (!reply.sent) {
                return reply.code(409).send(
                    createSessionMetadataPrivacyUpgradeRequiredResponse(),
                );
            }
            return;
        }

        const requestedModeRejection = admitRequestedSessionEncryptionMode({
            storagePolicy: policy.storagePolicy,
            requestedEncryptionMode,
        });
        if (requestedModeRejection) {
            return sendSessionCreateRejection(requestedModeRejection);
        }

        const accountCurrentness = await readSessionCreatorCurrentness(db, userId);
        if (accountCurrentness?.status === "inactive") {
            return sendSessionCreateRejection({ reason: "account-disabled" });
        }
        if (accountCurrentness?.status !== "ready") {
            return reply.code(400).send({
                error: "invalid-params",
            });
        }
        const accountEncryptionMode =
            accountCurrentness.currentness.encryptionMode;

        const effectiveEncryptionMode = resolveEffectiveLayout1SessionEncryptionMode({
            storagePolicy: policy.storagePolicy,
            defaultAccountMode: policy.defaultAccountMode,
            requestedEncryptionMode,
            accountEncryptionMode,
        });

        let createdFresh = false;
        let resolvedSession;
        let resolvedOwnerAccountMode = accountEncryptionMode;
        let resolvedOrganizationPlacement: SessionOrganizationPlacement | undefined;
        if (isLayoutOneRequest) {
            const preparation = prepareLayout1SessionCreate({
                accountId: userId,
                tag,
                metadata,
                ownerMetadata: layoutOneRequest.ownerMetadata,
                agentState: agentState ?? null,
                dataEncryptionKey: dataEncryptionKey ?? null,
                requestedEncryptionMode,
                requestedStorageState,
            organizationPlacement: layoutOneRequest.organizationPlacement,
            initialAccess: layoutOneRequest.initialAccess,
            initialTriggers: layoutOneRequest.initialTriggers,
            primaryTeamId: layoutOneRequest.primaryTeamId,
            teamCredentialBindings: layoutOneRequest.teamCredentialBindings,
                reportsTo: layoutOneRequest.reportsTo,
                originKind: layoutOneRequest.originKind,
                originSessionId: layoutOneRequest.originSessionId,
                originRunId: layoutOneRequest.originRunId,
                workDepth: layoutOneRequest.workDepth,
                accountEncryptionMode,
                storagePolicy: policy.storagePolicy,
                defaultAccountMode: policy.defaultAccountMode,
            });
            if (!preparation.ok) {
                return sendSessionCreateRejection(preparation.rejection);
            }

            const outcome = await createOrRejoinLayout1SessionByTag(
                preparation.prepared,
                readSessionAccessAuthenticationFromRequest(request),
                sessionCreationAuthorization,
            ).catch((error: unknown) => {
                if (error instanceof ApiTokenOperationError && error.code === "invalid_token") return null;
                throw error;
            });
            if (outcome === null) return reply.code(401).send({ error: "invalid_token" });
            if (outcome.kind === "rejected") {
                return sendSessionCreateRejection(outcome.rejection);
            }
            createdFresh = outcome.kind === "created";
            resolvedSession = outcome.session;
            resolvedOwnerAccountMode = outcome.ownerAccountMode;
            resolvedOrganizationPlacement = outcome.organizationPlacement;
        } else {
            if (effectiveEncryptionMode === "plain") {
                if (
                    !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                        request,
                        reply,
                    )
                ) {
                    return;
                }
                return reply.code(409).send(
                    createSessionMetadataPrivacyUpgradeRequiredResponse(),
                );
            }

            try {
                resolvedSession = await inTx(async (tx) => {
                    log({ module: "session-create", userId, tag }, `Creating new session for user ${userId} with tag ${tag}`);

                    const created = await createLegacyLayout0SessionInTx(tx, {
                        accountId: userId,
                        tag,
                        metadata,
                        agentState: agentState ?? null,
                        encryptionMode: effectiveEncryptionMode,
                        requestedStorageState,
                        dataEncryptionKey: dataEncryptionKey
                            ? new Uint8Array(Buffer.from(dataEncryptionKey, "base64"))
                            : null,
                        sessionCreationAuthorization,
                    });
                    createdFresh = true;
                    return created;
                });
            } catch (error) {
                if (error instanceof ApiTokenOperationError && error.code === "invalid_token") return reply.code(401).send({ error: "invalid_token" });
                if (error instanceof InactiveAccountError) {
                    return sendSessionCreateRejection({ reason: "account-disabled" });
                }
                if (isSessionOwnerEnvelopeError(error)) {
                    return sendSessionCreateRejection({ reason: "invalid-params" });
                }
                if (!isPrismaErrorCode(error, "P2002")) {
                    throw error;
                }
                const existing = await db.session.findUnique({
                    where: {
                        accountId_tag: {
                            accountId: userId,
                            tag,
                        },
                    },
                });
                if (!existing) {
                    throw error;
                }
                if (
                    (existing.metadataLayoutVersion ?? 0)
                        >= SESSION_METADATA_LAYOUT_VERSION_V1
                ) {
                    if (
                        !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                            request,
                            reply,
                        )
                    ) {
                        return;
                    }
                    return reply.code(409).send(
                        createSessionMetadataPrivacyUpgradeRequiredResponse(),
                    );
                }
                const restored = await inTx(async (tx) => {
                    await readSessionCreationApiTokenIdInTx(tx, userId, sessionCreationAuthorization);
                    let current = await tx.session.findUniqueOrThrow({ where: { id: existing.id } });
                    if (requestedStorageState === 'machine_only' && current.currentStorageState !== 'machine_only') {
                        const initialized = await initializeExternalLinkedSessionStorage(tx, current, userId);
                        if (!initialized.ok) return { kind: 'storage-conflict' as const };
                        current = { ...current, currentStorageState: initialized.session.currentStorageState };
                    }
                    return await restoreSessionTagRejoinInTx(tx, current);
                }).catch((restoreError: unknown) => {
                    if (restoreError instanceof ApiTokenOperationError && restoreError.code === 'invalid_token') return null;
                    throw restoreError;
                });
                if (restored === null) return reply.code(401).send({ error: 'invalid_token' });
                if ('kind' in restored) return reply.code(409).send({
                    error: 'storage-state-conflict', code: 'session_storage_state_conflict',
                });
                resolvedSession = restored.session;
                if (restored.publication) {
                    await publishSessionArchiveTransition(restored.publication);
                }
                log(
                    { module: "session-create", sessionId: existing.id, userId, tag },
                    `Found existing session after unique-create race: ${existing.id} for tag ${tag}`,
                );
            }
        }

        if (!resolvedSession) {
            return reply.code(500).send({
                error: "failed-to-resolve-session",
            });
        }

        // Always answer with the stored tuple rather than echoing the submitted
        // bytes. A rejoin or a lost unique-insert race must return the winner's
        // actual owner envelope; echoing the request would hand this client a key
        // the Session was never encrypted with.
        const ownerEnvelopeRow = await db.session.findUniqueOrThrow({
            where: { id: resolvedSession.id },
            select: createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: userId }),
        });
        const viewerDataEncryptionKey = projectViewerSessionDataKey(ownerEnvelopeRow);

        let metadataProjection: ReturnType<
            typeof projectSessionMetadataForRecipient
        >;
        try {
            metadataProjection = projectSessionMetadataForRecipient({
                session: {
                    ...resolvedSession,
                    accountId: userId,
                },
                recipient: {
                    type: "owner",
                    accountId: userId,
                    accountMode: resolvedOwnerAccountMode,
                },
            });
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(
                    createSessionMetadataPrivacyUpgradeRequiredResponse(),
                );
            }
            throw error;
        }

        const origin = projectStoredSessionOrigin(resolvedSession);
        const session = V2SessionRecordSchema.parse({
            id: resolvedSession.id,
            seq: applySessionTranscriptPublicationCeiling(resolvedSession.seq, resolvedSession),
            encryptionMode: resolvedSession.encryptionMode,
            ...metadataProjection,
            ...(metadataProjection.metadataLayoutVersion
                === SESSION_METADATA_LAYOUT_VERSION_V1
                ? { share: null }
                : {}),
            dataEncryptionKey: viewerDataEncryptionKey,
            pendingCount: resolvedSession.pendingCount,
            pendingBlockedCount: resolvedSession.pendingBlockedCount,
            pendingVersion: resolvedSession.pendingVersion,
            pendingActivationAuthorization: mapPendingActivationAuthorization(resolvedSession),
            active: resolvedSession.active,
            activeAt: resolvedSession.lastActiveAt.getTime(),
            createdAt: resolvedSession.createdAt.getTime(),
            updatedAt: resolvedSession.updatedAt.getTime(),
            meaningfulActivityAt: (resolvedSession.meaningfulActivityAt ?? resolvedSession.createdAt).getTime(),
            lastMessage: null,
            ...(origin ? { origin } : {}),
        });
        // The relation can change independently of creation metadata. Reuse
        // the authorized current-row projector, including on tag rejoins.
        const [organization] = await inTx((tx) => projectSessionReportsForRowsInTx(tx, {
            accountId: userId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
            sessions: [session],
            accessMode: "effective_access_v1",
            nowMs: Date.now(),
        }));
        log({ module: "session-create", sessionId: resolvedSession.id, userId }, `Session resolved: ${resolvedSession.id}`);
        return reply.send({
            created: createdFresh,
            ...(resolvedOrganizationPlacement
                ? { organizationPlacement: resolvedOrganizationPlacement }
                : {}),
            session: {
                ...session,
                ...(organization?.reportsTo ? { reportsTo: organization.reportsTo } : {}),
            },
        });
    });
}
