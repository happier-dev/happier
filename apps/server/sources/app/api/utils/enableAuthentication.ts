import type { FastifyReply, FastifyRequest } from "fastify";
import { ExternalActionExecutionAuthorizationVerifyRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { z } from "zod/mini";

import type { Fastify } from "../types";
import { log } from "@/utils/logging/log";
import { timeWebLatencyPhase } from '@/utils/webLatencyTrace';
import { readAuthDiagnosticsLogsEnabled } from '@/app/home/settings/authDiagnosticsFlag';
import { captureAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { ACCOUNT_DIRECTORY_ERROR_CODES_V1 } from '@happier-dev/protocol/auth/accountDirectory';
import { parseAccountApiTokenBearerV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { type AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';
import { redactHttpRequestUrlForLog } from "@/utils/logging/redactHttpRequestUrlForLog";
import {
    isRestrictedAuthTokenDeniedForRoute,
    isApiTokenSessionRouteGranted,
    readRestrictedCredentialRouteSessionIds,
    resolveApiTokenSessionActionForRoute,
    isExternalActionSessionRoutePurposeAllowed,
    PRESENT_USER_REQUIRED_ERROR,
} from "./apiTokenRouteAdmission";
import { readBearerCredential, verifyRequestPrincipal, type RequestPrincipalVerification } from "./verifyRequestPrincipal";
import { isApiTokenRequestOriginAllowed } from "./isApiTokenRequestOriginAllowed";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { PresentUserRequiredResponseSchema } from "./requirePresentUser";
import { enableExternalActionHttpBody } from "./externalActionHttpBody";
import {
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_VERIFY_HTTP_PATH_TEMPLATE_V1,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER,
    EXTERNAL_ACTION_REVIEWED_CHILD_HEADER,
} from "@happier-dev/protocol/actions/externalActionApi";
import {
    decodeDeploymentChildExecutionV1,
    decodeReviewedActionChildHttpProofV1,
} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { narrowCredentialAuthority } from "@/app/auth/effectiveCredentialAuthority";
import { ExternalActionAuthorizationRefusalPhaseSchema, type ExternalActionAuthorizationRefusalPhase } from '@happier-dev/protocol/actions/externalActionHttpError';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
    verifyExternalActionDomainExecutionRequest,
    verifyExternalActionExecutionAuthorizationCurrentness,
    refuseExternalActionExecutionRequest,
} from "@/app/auth/externalActionExecutionAuthorization";

/** Account and declared Session-purpose routes without custom restricted-error configuration. */
export const AccountRouteAuthenticationForbiddenResponseSchema = z.union([
    PresentUserRequiredResponseSchema,
    z.strictObject({ error: z.literal("provider-required"), provider: z.string() }),
    z.strictObject({ error: z.literal("not-eligible") }),
    z.strictObject({ error: z.literal("credential_origin_denied") }),
    z.strictObject({ error: z.literal("credential_scope_denied"), authorizationRefusal: z.optional(ExternalActionAuthorizationRefusalPhaseSchema),
        details: ActionExecuteFailureSchema.shape.details, failureCause: ActionExecuteFailureSchema.shape.failureCause }),
]);

function readScalarHeader(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function stampApiTokenPrincipal(request: FastifyRequest, principal: NonNullable<FastifyRequest["apiTokenPrincipal"]>): void {
    request.userId = principal.accountId;
    request.authTokenKind = "api_token";
    request.authAuthority = principal.authority;
    request.authTokenLegacy = false;
    request.authTokenAuthenticationEvidence = principal.authenticationEvidence;
    request.apiTokenPrincipal = principal;
}

async function isApiTokenRequestOriginDenied(request: FastifyRequest): Promise<boolean> {
    const origin = request.headers.origin;
    return origin !== undefined
        && request.apiTokenPrincipal !== undefined
        && !await isApiTokenRequestOriginAllowed(request.apiTokenPrincipal.grant, origin,
            () => readRequestHomeEnv(request));
}

function stampSessionRuntimePrincipal(
    request: FastifyRequest,
    principal: NonNullable<FastifyRequest["sessionRuntimePrincipal"]>,
    authenticationEvidence: readonly AuthTokenAuthenticationEvidenceV1[] | undefined,
): void {
    request.userId = principal.accountId;
    request.authTokenKind = "ephemeral_session_runner";
    // The restricted principal remains Session/Machine-bound by its verified typed projection.
    // For shared authorization owners it is nevertheless an autonomous runtime operation,
    // never an operation by the latest human message author or approving caller.
    request.authAuthority = "account_automation";
    request.authTokenLegacy = false;
    request.authTokenAuthenticationEvidence = authenticationEvidence;
    request.sessionRuntimePrincipal = principal;
}
function sendInvalidConnectionCredentialFailure(request: FastifyRequest, reply: FastifyReply,
    authorizationRefusal?: ExternalActionAuthorizationRefusalPhase, failure?: ActionExecuteFailure) {
    const configuredError = request.routeOptions?.config?.connectionAuthFailureError;
    const error = configuredError === "authentication_failed" || configuredError === "invalid_token"
        ? configuredError
        : "invalid_token";
    return reply.code(401).send({ error, ...(authorizationRefusal ? { authorizationRefusal } : {}),
        ...(failure?.details === undefined ? {} : { details: failure.details }),
        ...(failure?.failureCause === undefined ? {} : { failureCause: failure.failureCause }) });
}

export function enableAuthentication(app: Fastify) {
    const earlyRequestPrincipals = new WeakMap<FastifyRequest, RequestPrincipalVerification>();

    enableExternalActionHttpBody(app);

    app.addHook("onRequest", async (request, reply) => {
        if (request.headers.origin === undefined) return;
        const bearer = readBearerCredential(request.headers.authorization);
        if (bearer === null || parseAccountApiTokenBearerV1(bearer) === null) return;
        const verification = await verifyRequestPrincipal({
            authorizationHeader: request.headers.authorization,
            allowLegacyHomeToken: request.routeOptions.config.allowAccountDirectoryToken !== true,
            readEnv: () => readRequestHomeEnv(request),
        });
        // Routes that authenticate in preHandler reuse the canonical verification;
        // only browser-origin admission runs before the body becomes available.
        earlyRequestPrincipals.set(request, verification);
        if (verification.status !== "verified" || !verification.principal.apiTokenPrincipal) return;
        stampApiTokenPrincipal(request, verification.principal.apiTokenPrincipal);
        if (await isApiTokenRequestOriginDenied(request)) {
            return reply.code(403).send({ error: "credential_origin_denied" });
        }
    });

    app.decorate('authenticate', async function (request: any, reply: any) {
        const authHeader = request.headers.authorization;
        const executionAuthorization = readScalarHeader(
            request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER],
        );
        const machineSignature = readScalarHeader(
            request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER],
        );
        const effectActionId = readScalarHeader(request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]);
        const encodedTarget = readScalarHeader(request.headers[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]);
        const encodedDeploymentChild = readScalarHeader(request.headers[EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]);
        const encodedReviewedChild = readScalarHeader(request.headers[EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]);
        const hasExternalActionHeader = executionAuthorization !== null
            || machineSignature !== null
            || effectActionId !== null
            || encodedTarget !== null || encodedDeploymentChild !== null || encodedReviewedChild !== null;
        // Never log bearer tokens or header contents.
        const logDiagnostics = readAuthDiagnosticsLogsEnabled();
        if (logDiagnostics) {
            log(
                { module: 'auth-decorator' },
                `Auth check - path: ${redactHttpRequestUrlForLog(request.url)}, has header: ${!!authHeader}`,
            );
        }
        if (hasExternalActionHeader) {
            const requesterVerification = authHeader !== undefined
                ? earlyRequestPrincipals.get(request) ?? await verifyRequestPrincipal({ authorizationHeader: authHeader,
                    allowLegacyHomeToken: request.routeOptions?.config?.allowAccountDirectoryToken !== true,
                    readEnv: () => readRequestHomeEnv(request) }) : null;
            // A rejected execution carrier does not invalidate a verified
            // Account bearer. Clients retire Account credentials only on 401.
            let authorizationRefusal: ExternalActionAuthorizationRefusalPhase | undefined;
            let authorizationFailure: ActionExecuteFailure | undefined;
            const refuseExecution = (phase?: ExternalActionAuthorizationRefusalPhase) => {
                if (phase) refuseExternalActionExecutionRequest(phase, { method: request.method, path: request.url,
                    onRefusal: refusal => { authorizationRefusal = refusal; } });
                return requesterVerification?.status === 'verified' || authorizationFailure?.errorCode === 'credential_scope_denied'
                    ? reply.code(403).send({ error: 'credential_scope_denied', ...(authorizationRefusal ? { authorizationRefusal } : {}),
                        ...(authorizationFailure?.details === undefined ? {} : { details: authorizationFailure.details }),
                        ...(authorizationFailure?.failureCause === undefined ? {} : { failureCause: authorizationFailure.failureCause }) })
                    : sendInvalidConnectionCredentialFailure(request, reply, authorizationRefusal, authorizationFailure);
            };
            if (
                authHeader !== undefined
                || !executionAuthorization
                || !machineSignature
                || !effectActionId
                || !encodedTarget
            ) {
                return refuseExecution('proof_shape');
            }
            const deploymentChildExecution = encodedDeploymentChild === null ? undefined
                : decodeDeploymentChildExecutionV1(encodedDeploymentChild, executionAuthorization);
            if (encodedDeploymentChild !== null && !deploymentChildExecution) return refuseExecution('deployment_child_http');
            const reviewedChild = encodedReviewedChild === null ? undefined : decodeReviewedActionChildHttpProofV1(encodedReviewedChild);
            if (encodedReviewedChild !== null && !reviewedChild) return refuseExecution('reviewed_child');
            const sessionBinding = request.routeOptions?.config?.restrictedCredentialBinding;
            const routeActionId = resolveApiTokenSessionActionForRoute(request);
            const routeSessionIds = sessionBinding?.scope === 'session'
                && isExternalActionSessionRoutePurposeAllowed(request, effectActionId)
                ? readRestrictedCredentialRouteSessionIds(request, sessionBinding) : [];
            if (routeSessionIds === null) return refuseExecution('verification_purpose');
            const [routeSessionId, ...additionalSessionIds] = routeSessionIds;
            const proof = {
                onRefusal: (phase: ExternalActionAuthorizationRefusalPhase, failure?: ActionExecuteFailure) => {
                    // The innermost owner refuses first; an enclosing carrier refusal must not mask its cause.
                    authorizationRefusal ??= phase;
                    if (failure) authorizationFailure = failure;
                },
                authorizationToken: executionAuthorization,
                machineSignature,
                effectActionId,
                encodedTarget,
                method: request.method,
                path: request.url,
                body: request.body,
                ...(deploymentChildExecution ? { deploymentChildExecution } : {}),
                ...(reviewedChild ? { reviewedChild } : {}),
                ...(readScalarHeader(request.headers['idempotency-key']) === null ? {}
                    : { idempotencyKey: readScalarHeader(request.headers['idempotency-key'])! }),
                ...(typeof routeSessionId === 'string' && routeSessionId.length > 0
                    ? { sessionRouteTarget: { kind: 'session' as const, sessionId: routeSessionId,
                        ...(routeActionId ? { actionId: routeActionId } : {}),
                        ...(additionalSessionIds.length > 0 ? { additionalSessionIds } : {}) } } : {}),
                routeInput: {
                    ...(request.params && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params : {}),
                    ...(request.query && typeof request.query === 'object' && !Array.isArray(request.query) ? request.query : {}),
                    ...(request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {}),
                },
            };
            const externalActionRouteId = typeof request.params?.actionId === "string"
                ? request.params.actionId
                : null;
            const authorizationCurrentnessActionId = externalActionRouteId !== null
                && request.routeOptions?.url
                    === EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_VERIFY_HTTP_PATH_TEMPLATE_V1
                ? externalActionRouteId
                : null;
            const verified = authorizationCurrentnessActionId !== null
                ? await verifyExternalActionExecutionAuthorizationCurrentness({
                    ...proof,
                    outerActionId: authorizationCurrentnessActionId,
                    resolveCurrentSessionMachine: app.resolveCurrentSessionMachine,
                })
                : await verifyExternalActionDomainExecutionRequest({ ...proof, resolveCurrentSessionMachine: app.resolveCurrentSessionMachine });
            if (!verified) return refuseExecution();
            const verificationPurpose = authorizationCurrentnessActionId !== null
                ? ExternalActionExecutionAuthorizationVerifyRequestV1Schema.safeParse(request.body) : null;
            if (verificationPurpose?.success && verificationPurpose.data.nativePurpose && !verified.machineNpmProfileAdmission) {
                return refuseExecution();
            }
            if (verified.machineNpmProfileAdmission?.kind === 'denied') {
                return reply.code(403).send({ ok: false, nativePurpose: 'machine_npm_profile_acquisition',
                    code: verified.machineNpmProfileAdmission.code, requiredRole: 'manage' });
            }
            if (!isExternalActionSessionRoutePurposeAllowed(request, verified.effectActionId, verified.binding.approvalDecisionAdmission)) {
                return reply.code(403).send({ error: 'credential_scope_denied' });
            }
            if ('authentication' in verified.principal) {
                request.userId = verified.principal.accountId;
                request.authTokenKind = verified.principal.authentication.kind;
                request.authTokenEpoch = verified.principal.authentication.tokenEpoch;
                request.authTokenLegacy = false;
                request.authTokenAuthenticationEvidence = verified.principal.authentication.evidence;
            } else {
                stampApiTokenPrincipal(request, verified.principal);
            }
            request.authAuthority = narrowCredentialAuthority(verified.effectiveAuthority, request.headers[AUTHORITY_CEILING_HEADER_V1]);
            if (await isApiTokenRequestOriginDenied(request)) {
                return reply.code(403).send({ error: "credential_origin_denied" });
            }
            request.externalActionExecutionAuthorized = true;
            if (proof.sessionRouteTarget || verified.sessionSnapshotBatchAdmitted) request.externalActionSessionAccessAdmitted = true;
            request.externalActionExecutionAuthorizationBinding = verified.binding;
            request.externalActionManagedGuestActivity = verified.managedGuestActivity;
            request.externalActionDeploymentChildMachineRead = verified.deploymentChildMachineRead;
            request.externalActionDeploymentChildSigner = verified.deploymentChildSigner;
            request.externalActionDeploymentChildAdmission = verified.deploymentChildAdmission;
            request.externalActionDeploymentTargetRetentionAdmission = verified.deploymentTargetRetentionAdmission;
            request.externalActionDeploymentChildArtifactRead = verified.deploymentChildArtifactRead;
            request.externalActionAcceptedDeploymentRead = verified.acceptedDeploymentReceipt?.read;
            request.externalActionPlatformMaterialAdmission = verified.acceptedDeploymentReceipt?.platformMaterial;
            request.externalActionRegistryAppUpdateRead = verified.registryAppUpdateRead;
            request.externalActionDeploymentSourceRead = verified.deploymentPreparationSourceRead;
            const reviewedEnvironmentId = verified.createPreparationAdmission?.child?.environmentId
                ?? (verified.deploymentDomainPurpose && 'input' in verified.deploymentDomainPurpose
                    ? verified.deploymentDomainPurpose.input.environmentId : undefined);
            request.externalActionReviewedChildAdmission = verified.reviewedChildAdmission
                ? { ...verified.reviewedChildAdmission, ...(reviewedEnvironmentId ? { environmentId: reviewedEnvironmentId } : {}) } : undefined;
            // Ordinary authenticated callers have no PAT input ceiling.
            // Carry that explicit fact through the same signed-effect
            // projection rather than inventing a token grant.
            request.externalActionInputConstraints = 'grant' in verified.binding ? {
                models: verified.binding.grant.models,
                permissionModes: verified.binding.grant.permissionModes,
            } : { models: null, permissionModes: null };
            request.externalActionEffectActionId = verified.effectActionId;
            request.externalActionRootActionId = verified.binding.actionId;
            request.externalActionExecutionTarget = verified.target;
            // A reviewed managed child retains its own operation identity inside the signed parent.
            request.externalActionExecutionRequestId = verified.managedExecWakeRequestId
                ?? (verified.deploymentTargetRetentionAdmission?.kind === 'reviewed-child'
                    ? verified.deploymentTargetRetentionAdmission.requestId : verified.binding.requestId);
            request.externalActionExecutionRequestEnvelopeDigest = verified.binding.requestEnvelopeDigest;
            request.externalActionExecutionMachineId = verified.binding.machineId;
            request.externalActionExecutionCustodianAccountId = verified.binding.custodianAccountId;
            if (isRestrictedAuthTokenDeniedForRoute(request)) {
                return reply.code(403).send({ error: PRESENT_USER_REQUIRED_ERROR });
            }
            captureAccountStoredContentCompatibilityForHttpRequest(request);
            return;
        }
        if (readBearerCredential(authHeader) === null) {
            log({ module: 'auth-decorator' }, `Auth failed - missing or invalid header`);
            if (request.routeOptions?.config?.connectionAuthFailureError === "invalid_token") {
                return sendInvalidConnectionCredentialFailure(request, reply);
            }
            return reply.code(401).send({ error: 'Missing authorization header' });
        }

        // A pre-marker credential is an ordinary-Home compatibility input,
        // never a Directory or Team credential. Directory routes use only the
        // strict current verifier. Route families that opt out of legacy Home
        // authority still verify it, then refuse it below with 403: the
        // credential remains valid at this Home, and a 401 would make the
        // client discard it.
        const verification = earlyRequestPrincipals.get(request) ?? await timeWebLatencyPhase('auth.verify_principal', () => verifyRequestPrincipal({
            authorizationHeader: authHeader,
            allowLegacyHomeToken: request.routeOptions?.config?.allowAccountDirectoryToken !== true,
            readEnv: () => readRequestHomeEnv(request),
        }));
        if (
            verification.status === "absent"
            || verification.status === "invalid"
            || verification.status === "rejected_restricted"
        ) {
            log({ module: 'auth-decorator' }, `Auth failed - invalid token`);
            return sendInvalidConnectionCredentialFailure(request, reply);
        }
        if (verification.status === "ineligible") {
            const eligibility = verification.eligibility;
            if (eligibility.statusCode === 401) {
                return sendInvalidConnectionCredentialFailure(request, reply);
            }
            const fallback = eligibility.statusCode === 503 ? "upstream_error" : "not-eligible";
            if (eligibility.statusCode === 403 && eligibility.error === "provider-required") {
                return reply.code(403).send({ error: "provider-required", provider: eligibility.provider });
            }
            if (eligibility.statusCode === 403 && eligibility.error === "account-disabled") {
                return sendInvalidConnectionCredentialFailure(request, reply);
            }
            return reply.code(eligibility.statusCode).send({ error: eligibility.error ?? fallback });
        }

        const principal = verification.principal;
        const tokenKind = principal.kind;
        request.authTokenEpoch = principal.tokenEpoch;
        request.authTerminalRequestId = principal.terminalAuthRequestId;
        if (logDiagnostics) {
            log({ module: 'auth-decorator' }, `Auth success - user: ${principal.accountId}`);
        }
        const apiTokenPrincipal = principal.apiTokenPrincipal;
        if (tokenKind === "api_token" && !apiTokenPrincipal) {
            return sendInvalidConnectionCredentialFailure(request, reply);
        }
        if (apiTokenPrincipal) {
            stampApiTokenPrincipal(request, apiTokenPrincipal);
            if (await isApiTokenRequestOriginDenied(request)) {
                return reply.code(403).send({ error: "credential_origin_denied" });
            }
        } else if (principal.sessionRuntimePrincipal) {
            stampSessionRuntimePrincipal(
                request,
                principal.sessionRuntimePrincipal,
                principal.authenticationEvidence,
            );
        } else {
            request.userId = principal.accountId;
            request.authTokenKind = tokenKind;
            request.authAuthority = principal.authority;
            request.authTokenLegacy = principal.legacy;
            request.authTokenAuthenticationEvidence = principal.authenticationEvidence;
        }
        request.authAuthority = narrowCredentialAuthority(request.authAuthority, request.headers[AUTHORITY_CEILING_HEADER_V1]);
        if (isRestrictedAuthTokenDeniedForRoute(request)) {
            const error = request.routeOptions?.config?.allowAccountDirectoryToken === true
                ? ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidRequest
                : request.routeOptions?.config?.restrictedAuthFailureError
                    ?? PRESENT_USER_REQUIRED_ERROR;
            return reply.code(403).send({ error });
        }
        const sessionAction = resolveApiTokenSessionActionForRoute(request);
        const binding = request.routeOptions.config.restrictedCredentialBinding;
        if (apiTokenPrincipal && sessionAction && binding?.scope === "session") {
            const sessionIds = readRestrictedCredentialRouteSessionIds(request, binding);
            if (sessionIds === null) {
                return reply.code(403).send({ error: "credential_scope_denied" });
            }
            for (const sessionId of sessionIds) {
                const granted = isApiTokenSessionRouteGranted({
                    principal: apiTokenPrincipal, sessionId, actionId: sessionAction,
                    targetMachineId: await app.resolveCurrentSessionMachine?.({
                        accountId: apiTokenPrincipal.accountId, sessionId,
                    }),
                });
                if (!granted) return reply.code(403).send({ error: "credential_scope_denied" });
            }
        }
        captureAccountStoredContentCompatibilityForHttpRequest(request);
    });
}
