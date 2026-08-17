import { Fastify } from "../types";
import { log } from "@/utils/logging/log";
import { auth } from "@/app/auth/auth";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { captureAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { redactPublicShareCapabilityUrl } from "@happier-dev/protocol";

function shouldLogAuthDecoratorDiagnostics(): boolean {
    return process.env.HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS === "1"
        || process.env.HAPPY_AUTH_DECORATOR_DIAGNOSTIC_LOGS === "1";
}

function resolveVerifiedAuthTokenKind(extras: unknown): "account" | "terminal" {
    // Terminal authorization is minted only with the verified `{ session }` token
    // extra. This is server-verified token provenance, never caller-provided HTTP
    // metadata, so destructive routes can fail closed for daemon credentials.
    if (typeof extras !== "object" || extras === null || Array.isArray(extras)) {
        return "account";
    }
    return typeof (extras as Readonly<Record<string, unknown>>).session === "string"
        ? "terminal"
        : "account";
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
                return reply.code(401).send({ error: 'Invalid token', code: 'invalid-token' });
            }

            const eligibility = await enforceLoginEligibility({ accountId: verified.userId, env: process.env });
            if (!eligibility.ok) {
                if (eligibility.statusCode === 401) {
                    return reply.code(401).send({ error: "Invalid token", code: "account-not-found" });
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
            request.authTokenKind = resolveVerifiedAuthTokenKind(verified.extras);
            captureAccountStoredContentCompatibilityForHttpRequest(request);
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}
