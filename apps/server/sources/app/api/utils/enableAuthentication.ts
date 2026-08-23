import { Fastify } from "../types";
import { log } from "@/utils/logging/log";
import { auth } from "@/app/auth/auth";
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

type VerifiedTokenProvenance = Readonly<{
    extras?: unknown;
    authTokenKind?: unknown;
    authority?: unknown;
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
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = await auth.verifyToken(token);
            if (!verified) {
                log({ module: 'auth-decorator' }, `Auth failed - invalid token`);
                return reply.code(401).send({ error: "invalid_token" });
            }

            const eligibility = await enforceLoginEligibility({ accountId: verified.userId, env: process.env });
            if (!eligibility.ok) {
                if (eligibility.statusCode === 401) {
                    return reply.code(401).send({ error: "invalid_token" });
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
            if (isApiTokenDeniedForRoute(request)) {
                return reply.code(403).send({ error: PRESENT_USER_REQUIRED_ERROR });
            }
            captureAccountStoredContentCompatibilityForHttpRequest(request);
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}
