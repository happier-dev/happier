import { Fastify } from "../types";
import { log } from "@/utils/logging/log";
import { auth } from "@/app/auth/auth";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { enforceSessionSyncCompatibilityForHttpRequest } from "@/app/clientCompatibility/httpEnforcement";
import { isSessionSyncHttpRoute } from "@/app/clientCompatibility/routeInventory";
import { redactPublicShareCapabilityUrl } from "@happier-dev/protocol";

function shouldLogAuthDecoratorDiagnostics(): boolean {
    return process.env.HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS === "1"
        || process.env.HAPPY_AUTH_DECORATOR_DIAGNOSTIC_LOGS === "1";
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
            const routePath = request.routeOptions?.url ?? request.url.split('?', 1)[0];
            if (typeof routePath === 'string' && isSessionSyncHttpRoute(routePath)) {
                const accepted = await enforceSessionSyncCompatibilityForHttpRequest(request, reply, process.env);
                if (!accepted) return;
            }
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}
