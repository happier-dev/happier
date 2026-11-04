import { verifyTemplateRequesterExecutionAuthorization, bindTemplateRequesterBirthAuthorization } from '@/app/auth/externalActionExecutionAuthorization';
import { TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1, encodeTemplateBirthExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SessionCreateRequestSchema } from '@/app/session/create/sessionCreateRequest';
import { SessionCreationTagV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { InactiveAccountError } from "@/app/auth/accountStatus";
import { inReadSnapshot, inTx } from "@/storage/inTx";
import { prepareSessionAccountCursorLocks } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { db, isPrismaErrorCode } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { z } from "zod/mini";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { SessionOrganizationPlacementV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionOwnerMetadataEnvelopeV1Schema, SessionDisplayProjectionV1Schema, SESSION_METADATA_LAYOUT_VERSION_V1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionInitialAccessMaterializedV1Schema } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';
import { SessionInitialTriggerAdmissionV1Schema } from '@happier-dev/protocol/sessions/creation/sessionInitialTriggerAdmissionV1';
import { SessionCreateOriginFieldsV1Schema, refineSessionCreateOriginFieldsV1 } from '@happier-dev/protocol/sessions/creation/sessionCreateOriginV1';
import { SessionManagerV1Schema } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SESSION_CREATION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
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
import { mapPendingActivationAuthorization, mapPendingActivationFailureDetails } from "@/app/session/pending/pendingActivationAuthorization";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { isSessionCollaborationEnabled } from "@/app/session/access/sessionAccess";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { projectSessionManagerForRowsInTx } from "@/app/session/awareness/sessionManagerProjection";
import { projectStoredSessionOrigin } from "@/app/session/listing/rows";

import { type Fastify } from "../../types";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { auth, ApiTokenOperationError } from "@/app/auth/auth";
import { verifyCurrentExternalActionPrincipal, verifyExternalActionMachineRpcExecution } from "@/app/auth/externalActionExecutionAuthorization";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { readSessionCreationApiTokenIdInTx, type SessionCreationExecutionAuthorization } from "@/app/session/create/apiTokenSessionCreationAuthorization";
import { DiscussionModelSessionCreationProofV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationAuthorizationV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export function registerSessionCreateOrLoadRoute(app: Fastify) {
    app.post('/v1/sessions', {
        schema: {
            body: SessionCreateRequestSchema,
        },
        preHandler: app.authenticate,
        config: { allowApiToken: true, allowScopedApiToken: true },
    }, async (request, reply) => {
        let sessionCreationAuthorization: SessionCreationExecutionAuthorization | undefined;
        const templateRequester = 'templateRequesterAuthorization' in request.body ? request.body.templateRequesterAuthorization : undefined;
        // The Account bearer has already authenticated. A refused requester
        // carrier must not retire that independent credential in the client.
        const refuseCreationAuthorization = () => templateRequester
            ? reply.code(403).send({ error: 'credential_scope_denied' })
            : reply.code(401).send({ error: 'invalid_token' });
        if (request.authTokenKind === 'api_token' && !templateRequester && request.externalActionExecutionAuthorized !== true) {
            return reply.code(403).send({ error: 'present_user_required' });
        }
        const creationHeader = request.headers[SESSION_CREATION_AUTHORIZATION_HEADER_V1];
        const nativeProof = 'creationAuthorizationProof' in request.body ? request.body.creationAuthorizationProof : undefined;
        if (templateRequester) {
            if (!SessionCreationTagV1Schema.safeParse(request.body.tag).success) {
                return reply.code(400).send({ error: 'invalid-params' });
            }
            if (nativeProof || creationHeader !== undefined || request.externalActionExecutionAuthorized === true) {
                return refuseCreationAuthorization();
            }
            const admitted = await verifyTemplateRequesterExecutionAuthorization({ ...templateRequester, accountId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request) });
            if (!admitted) return refuseCreationAuthorization();
            sessionCreationAuthorization = { binding: admitted.binding, templateRequesterBirth: true };
        } else if (nativeProof && creationHeader === undefined) return reply.code(401).send({ error: 'invalid_token' });
        else if (request.externalActionExecutionAuthorized === true) {
            const binding = request.externalActionExecutionAuthorizationBinding;
            if (nativeProof || !binding || binding.accountId !== request.userId
                || request.externalActionEffectActionId !== 'session.spawn_new'
                || creationHeader !== undefined && creationHeader !== request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]) {
                return reply.code(401).send({ error: 'invalid_token' });
            }
            // Authentication already verifies the installed host's create_bot
            // child, input digest and exact POST bytes under the unchanged root.
            // A bare template token below cannot claim this request-local fact.
            sessionCreationAuthorization = binding.actionId === 'template.instantiate' && request.externalActionReviewedChildAdmission
                ? { binding, reviewedChildAdmission: request.externalActionReviewedChildAdmission, effectActionId: 'session.spawn_new' }
                : binding;
        } else if (creationHeader !== undefined) {
            if (typeof creationHeader !== "string") return reply.code(401).send({ error: "invalid_token" });
            const binding = await auth.verifyExternalActionExecutionAuthorization(creationHeader);
            if (!binding || binding.accountId !== request.userId
                || binding.serverIdentityId !== await getOrCreateServerIdentityId()) return reply.code(401).send({ error: "invalid_token" });
            if (!await verifyCurrentExternalActionPrincipal(binding)) return reply.code(401).send({ error: "invalid_token" });
            if (binding.actionId === 'discussion.second_opinion.start' && nativeProof && 'sharedMetadata' in request.body) {
                const source = nativeProof.sourceExecution;
                if (source.externalActionExecution.authorization.token !== creationHeader
                    || !sameStrictJsonValue(source.externalActionExecution.authorization.binding, binding)
                    || !await verifyExternalActionMachineRpcExecution(source.externalActionExecution, {
                        method: source.method, requestId: source.requestId, params: source.params,
                        originalActionEnvelope: source.originalActionEnvelope,
                        resolveCurrentSessionMachine: app.resolveCurrentSessionMachine,
                    })) return reply.code(401).send({ error: 'invalid_token' });
                const { creationAuthorizationProof: _proof, ...body } = request.body;
                sessionCreationAuthorization = { binding, modelBirth: { body, proof: nativeProof, env: await readRequestHomeEnv(request) } };
            } else if (binding.actionId === 'session.spawn_new' && !nativeProof) {
                sessionCreationAuthorization = binding;
            } else return reply.code(401).send({ error: 'invalid_token' });
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
                case "session-manager-invalid":
                    return reply.code(rejection.result.error === "manager_cycle" ? 400
                        : rejection.result.error === "manager_cas_conflict" ? 409 : 403).send(rejection.result);
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
                displayProjectionV1: layoutOneRequest.displayProjectionV1,
                agentState: agentState ?? null,
                dataEncryptionKey: dataEncryptionKey ?? null,
                requestedEncryptionMode,
                requestedStorageState,
            organizationPlacement: layoutOneRequest.organizationPlacement,
            initialAccess: layoutOneRequest.initialAccess,
            initialTriggers: layoutOneRequest.initialTriggers,
            primaryTeamId: layoutOneRequest.primaryTeamId,
            teamCredentialBindings: layoutOneRequest.teamCredentialBindings,
                manager: layoutOneRequest.manager,
                originKind: layoutOneRequest.originKind,
                originSessionId: layoutOneRequest.originSessionId,
                originRunId: layoutOneRequest.originRunId,
                discussionParticipant: layoutOneRequest.discussionParticipant,
                discussionParticipantLaunch: layoutOneRequest.discussionParticipantLaunch,
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
            if (outcome === null) return refuseCreationAuthorization();
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
                }, {
                    isolationLevel: "ReadCommitted", // The creation owner admits Account authority before reading it.
                    transactionClass: "session.legacy-create",
                });
            } catch (error) {
                if (error instanceof ApiTokenOperationError && error.code === "invalid_token") return refuseCreationAuthorization();
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
                }, {
                    isolationLevel: "ReadCommitted",
                    transactionClass: "session.legacy-rejoin",
                    prepare: () => prepareSessionAccountCursorLocks([existing.id], [userId]),
                }).catch((restoreError: unknown) => {
                    if (restoreError instanceof ApiTokenOperationError && restoreError.code === 'invalid_token') return null;
                    throw restoreError;
                });
                if (restored === null) return refuseCreationAuthorization();
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
        if (templateRequester) {
            const bound = await bindTemplateRequesterBirthAuthorization(templateRequester.authorization,
                { sessionId: resolvedSession.id, creationTag: resolvedSession.tag });
            if (!bound) return refuseCreationAuthorization();
            reply.header(TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1, encodeTemplateBirthExecutionAuthorizationV1(bound));
        }
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
            pendingActivationFailureDetails: mapPendingActivationFailureDetails(resolvedSession),
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
        const [organization] = await inReadSnapshot((tx) => projectSessionManagerForRowsInTx(tx, {
            accountId: userId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
            sessions: [session],
            accessMode: "effective_access_v1",
            nowMs: Date.now(),
        }), {
            transactionClass: "session.creation-projection",
        });
        log({ module: "session-create", sessionId: resolvedSession.id, userId }, `Session resolved: ${resolvedSession.id}`);
        return reply.send({
            created: createdFresh,
            ...(resolvedOrganizationPlacement
                ? { organizationPlacement: resolvedOrganizationPlacement }
                : {}),
            session: {
                ...session,
                ...(organization?.manager ? { manager: organization.manager } : {}),
            },
        });
    });
}
