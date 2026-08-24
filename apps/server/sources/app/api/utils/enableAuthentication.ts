import type { FastifyReply, FastifyRequest } from "fastify";

import { Fastify } from "../types";
import { log } from "@/utils/logging/log";
import { auth, type VerifiedApiTokenPrincipal } from "@/app/auth/auth";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { captureAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { redactPublicShareCapabilityUrl } from "@happier-dev/protocol";
import {
    isApiTokenDeniedForRoute,
    PRESENT_USER_REQUIRED_ERROR,
} from "./apiTokenRouteAdmission";

function shouldLogAuthDecoratorDiagnostics(): boolean {
    return process.env.HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS === "1"
        || process.env.HAPPY_AUTH_DECORATOR_DIAGNOSTIC_LOGS === "1";
}

function sendInvalidConnectionCredentialFailure(request: FastifyRequest, reply: FastifyReply) {
    const configuredError = request.routeOptions?.config?.connectionAuthFailureError;
    const error = configuredError === "authentication_failed" || configuredError === "invalid_token"
        ? configuredError
        : "invalid_token";
    return reply.code(401).send({ error });
}

type VerifiedTokenProvenance = Readonly<{
    userId: string;
    extras?: unknown;
    authTokenKind?: unknown;
    authority?: unknown;
    apiTokenPrincipal?: VerifiedApiTokenPrincipal;
}>;

function resolveVerifiedAuthTokenKind(verified: VerifiedTokenProvenance): "account" | "terminal" | "api_token" {
    if (verified.authTokenKind === "api_token") {
        return "api_token";
    }
    // Terminal authorization is minted only with the verified `{ session }` token
    // extra. This is server-verified token provenance, never caller-provided HTTP
    // metadata, so destructive routes can fail closed for daemon credentials.
    if (typeof verified.extras !== "object" || verified.extras === null || Array.isArray(verified.extras)) {
        return "account";
    }
    return typeof (verified.extras as Readonly<Record<string, unknown>>).session === "string"
        ? "terminal"
        : "account";
}

function resolveVerifiedAuthAuthority(
    verified: VerifiedTokenProvenance,
    tokenKind: "account" | "terminal" | "api_token",
): "present_user" | "account_automation" {
    if (verified.authority === "present_user" || verified.authority === "account_automation") {
        return verified.authority;
    }
    return tokenKind === "account" ? "present_user" : "account_automation";
}

function resolveVerifiedApiTokenPrincipal(
    verified: VerifiedTokenProvenance,
    tokenKind: "account" | "terminal" | "api_token",
): VerifiedApiTokenPrincipal | null {
    if (tokenKind !== "api_token") return null;
    const principal = verified.apiTokenPrincipal;
    if (
        !principal
        || principal.authority !== "account_automation"
        || principal.accountId !== verified.userId
        || !principal.accountId.trim()
        || !principal.principalId.trim()
        || !principal.credentialId.trim()
    ) {
        return null;
    }
    return principal;
}

export function enableAuthentication(app: Fastify) {
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            // Never log bearer tokens or header contents.
            const logDiagnostics = shouldLogAuthDecoratorDiagnostics();
            if (logDiagnostics) {
                log(
                    { module: 'auth-decorator' },
                    `Auth check - path: ${redactPublicShareCapabilityUrl(request.url)}, has header: ${!!authHeader}`,
                );
            }
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                log({ module: 'auth-decorator' }, `Auth failed - missing or invalid header`);
                if (request.routeOptions?.config?.connectionAuthFailureError === "invalid_token") {
                    return sendInvalidConnectionCredentialFailure(request, reply);
                }
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = await auth.verifyToken(token);
            if (!verified) {
                log({ module: 'auth-decorator' }, `Auth failed - invalid token`);
                return sendInvalidConnectionCredentialFailure(request, reply);
            }

            const eligibility = await enforceLoginEligibility({ accountId: verified.userId, env: process.env });
            if (!eligibility.ok) {
                if (eligibility.statusCode === 401) {
                    return sendInvalidConnectionCredentialFailure(request, reply);
                }
                const fallback = eligibility.statusCode === 503 ? "upstream_error" : "not-eligible";
                if (eligibility.statusCode === 403 && eligibility.error === "provider-required") {
                    return reply.code(403).send({ error: "provider-required", provider: eligibility.provider });
                }
                if (eligibility.statusCode === 403 && eligibility.error === "account-disabled") {
                    return reply.code(403).send({ error: "account-disabled" });
                }
                return reply.code(eligibility.statusCode).send({ error: eligibility.error ?? fallback });
            }

            if (logDiagnostics) {
                log({ module: 'auth-decorator' }, `Auth success - user: ${verified.userId}`);
            }
            request.userId = verified.userId;
            const tokenKind = resolveVerifiedAuthTokenKind(verified);
            request.authTokenKind = tokenKind;
            request.authAuthority = resolveVerifiedAuthAuthority(verified, tokenKind);
            const apiTokenPrincipal = resolveVerifiedApiTokenPrincipal(verified, tokenKind);
            if (tokenKind === "api_token" && !apiTokenPrincipal) {
                return sendInvalidConnectionCredentialFailure(request, reply);
            }
            if (isApiTokenDeniedForRoute(request)) {
                return reply.code(403).send({ error: PRESENT_USER_REQUIRED_ERROR });
            }
            if (apiTokenPrincipal) {
                request.apiTokenPrincipal = apiTokenPrincipal;
            }
            captureAccountStoredContentCompatibilityForHttpRequest(request);
        } catch {
            return sendInvalidConnectionCredentialFailure(request, reply);
        }
    });
}
