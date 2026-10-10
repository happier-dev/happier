import type { FastifyReply, FastifyRequest } from "fastify";

import type { Fastify } from "../types";
import { log } from "@/utils/logging/log";
import { readRequestHomeEnv } from '@/app/home/settings/requestHomeEnv';
import { captureAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    AUTHORITY_CEILING_HEADER_V1,
    ACCOUNT_DIRECTORY_ERROR_CODES_V1,
    parseAccountApiTokenBearerV1,
    readServerConfig,
    SERVER_CONFIG,
    type AuthTokenAuthenticationEvidenceV1,
} from "@happier-dev/protocol";
import { redactHttpRequestUrlForLog } from "@/utils/logging/redactHttpRequestUrlForLog";
import {
    isRestrictedAuthTokenDeniedForRoute,
    admitApiTokenSessionOperation,
    readRestrictedCredentialRouteField,
    resolveApiTokenSessionActionForRoute,
    isExternalActionSessionRoutePurposeAllowed,
    PRESENT_USER_REQUIRED_ERROR,
} from "./apiTokenRouteAdmission";
import { readBearerCredential, verifyRequestPrincipal, type RequestPrincipalVerification } from "./verifyRequestPrincipal";
import { isApiTokenRequestOriginAllowed } from "./isApiTokenRequestOriginAllowed";
import {
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_VERIFY_HTTP_PATH_TEMPLATE_V1,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
} from "@happier-dev/protocol/actions";
import { narrowCredentialAuthority } from "@/app/auth/effectiveCredentialAuthority";
import {
    verifyExternalActionDomainExecutionRequest,
    verifyExternalActionExecutionAuthorizationCurrentness,
} from "@/app/auth/externalActionExecutionAuthorization";

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

function isApiTokenRequestOriginDenied(request: FastifyRequest): boolean {
    const origin = request.headers.origin;
    return origin !== undefined
        && request.apiTokenPrincipal !== undefined
        && !isApiTokenRequestOriginAllowed(request.apiTokenPrincipal.grant, origin);
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
function sendInvalidConnectionCredentialFailure(request: FastifyRequest, reply: FastifyReply) {
    const configuredError = request.routeOptions?.config?.connectionAuthFailureError;
    const error = configuredError === "authentication_failed" || configuredError === "invalid_token"
        ? configuredError
        : "invalid_token";
    return reply.code(401).send({ error });
}

export function enableAuthentication(app: Fastify) {
    const earlyRequestPrincipals = new WeakMap<FastifyRequest, RequestPrincipalVerification>();

    app.addHook("onRequest", async (request, reply) => {
        if (request.headers.origin === undefined) return;
        const bearer = readBearerCredential(request.headers.authorization);
        if (bearer === null || parseAccountApiTokenBearerV1(bearer) === null) return;
        const verification = await verifyRequestPrincipal({
            authorizationHeader: request.headers.authorization,
            allowLegacyHomeToken: request.routeOptions.config.allowAccountDirectoryToken !== true
                && request.routeOptions.config.allowLegacyHomeToken !== false,
            env: process.env,
        });
        // Routes that authenticate in preHandler reuse the canonical verification;
        // only browser-origin admission runs before the body becomes available.
        earlyRequestPrincipals.set(request, verification);
        if (verification.status !== "verified" || !verification.principal.apiTokenPrincipal) return;
        stampApiTokenPrincipal(request, verification.principal.apiTokenPrincipal);
        if (isApiTokenRequestOriginDenied(request)) {
            return reply.code(403).send({ error: "credential_origin_denied" });
        }
    });

    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            const executionAuthorization = readScalarHeader(
                request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER],
            );
            const machineSignature = readScalarHeader(
                request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER],
            );
            const effectActionId = readScalarHeader(request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]);
            const encodedTarget = readScalarHeader(request.headers[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]);
            const hasExternalActionHeader = executionAuthorization !== null
                || machineSignature !== null
                || effectActionId !== null
                || encodedTarget !== null;
            // Never log bearer tokens or header contents.
            const logDiagnostics = readServerConfig(await readRequestHomeEnv(request), SERVER_CONFIG.HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS);
            if (logDiagnostics) {
                log(
                    { module: 'auth-decorator' },
                    `Auth check - path: ${redactHttpRequestUrlForLog(request.url)}, has header: ${!!authHeader}`,
                );
            }
            if (hasExternalActionHeader) {
                if (
                    authHeader !== undefined
                    || !executionAuthorization
                    || !machineSignature
                    || !effectActionId
                    || !encodedTarget
                ) {
                    return sendInvalidConnectionCredentialFailure(request, reply);
                }
                const proof = {
                    authorizationToken: executionAuthorization,
                    machineSignature,
                    effectActionId,
                    encodedTarget,
                    method: request.method,
                    path: request.url,
                    body: request.body,
                };
                const routeActionId = typeof request.params?.actionId === "string"
                    ? request.params.actionId
                    : null;
                const authorizationCurrentnessActionId = routeActionId !== null
                    && request.routeOptions?.url
                        === EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_VERIFY_HTTP_PATH_TEMPLATE_V1
                    ? routeActionId
                    : null;
                const verified = authorizationCurrentnessActionId !== null
                    ? await verifyExternalActionExecutionAuthorizationCurrentness({
                        ...proof,
                        outerActionId: authorizationCurrentnessActionId,
                        resolveCurrentSessionMachine: app.resolveCurrentSessionMachine,
                    })
                    : await verifyExternalActionDomainExecutionRequest({ ...proof, resolveCurrentSessionMachine: app.resolveCurrentSessionMachine });
                if (!verified) return sendInvalidConnectionCredentialFailure(request, reply);
                if (!isExternalActionSessionRoutePurposeAllowed(request, verified.effectActionId)) {
                    return reply.code(403).send({ error: 'credential_scope_denied' });
                }
                if ('authentication' in verified.principal) {
                    request.userId = verified.principal.accountId;
                    request.authTokenKind = verified.principal.authentication.kind;
                    request.authAuthority = verified.principal.authority;
                    request.authTokenEpoch = verified.principal.authentication.tokenEpoch;
                    request.authTokenLegacy = false;
                    request.authTokenAuthenticationEvidence = verified.principal.authentication.evidence;
                } else {
                    stampApiTokenPrincipal(request, verified.principal);
                }
                if (isApiTokenRequestOriginDenied(request)) {
                    return reply.code(403).send({ error: "credential_origin_denied" });
                }
                request.externalActionExecutionAuthorized = true;
                request.externalActionExecutionAuthorizationBinding = verified.binding;
                request.externalActionManagedGuestActivity = verified.managedGuestActivity;
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
                request.externalActionExecutionRequestId = verified.binding.requestId;
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
            // never a Directory or Team credential. Directory routes and
            // route families that explicitly reject legacy Home authority use
            // only the strict current verifier; ordinary Home routes retain
            // the explicitly named compatibility reader.
            const verification = earlyRequestPrincipals.get(request) ?? await verifyRequestPrincipal({
                authorizationHeader: authHeader,
                allowLegacyHomeToken: request.routeOptions?.config?.allowAccountDirectoryToken !== true
                    && request.routeOptions?.config?.allowLegacyHomeToken !== false,
                env: process.env,
            });
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
            if (logDiagnostics) {
                log({ module: 'auth-decorator' }, `Auth success - user: ${principal.accountId}`);
            }
            const apiTokenPrincipal = principal.apiTokenPrincipal;
            if (tokenKind === "api_token" && !apiTokenPrincipal) {
                return sendInvalidConnectionCredentialFailure(request, reply);
            }
            if (apiTokenPrincipal) {
                stampApiTokenPrincipal(request, apiTokenPrincipal);
                if (isApiTokenRequestOriginDenied(request)) {
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
                const sessionId = readRestrictedCredentialRouteField(request, binding.session);
                if (typeof sessionId !== "string") {
                    return reply.code(403).send({ error: "credential_scope_denied" });
                }
                const admitted = await admitApiTokenSessionOperation({
                    principal: apiTokenPrincipal, sessionId, actionId: sessionAction,
                    targetMachineId: await app.resolveCurrentSessionMachine?.({
                        accountId: apiTokenPrincipal.accountId, sessionId,
                    }),
                });
                if (!admitted.ok) return reply.code(403).send({ error: admitted.error });
            }
            captureAccountStoredContentCompatibilityForHttpRequest(request);
        } catch {
            return sendInvalidConnectionCredentialFailure(request, reply);
        }
    });
}
