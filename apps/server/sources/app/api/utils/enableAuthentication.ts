import { Fastify } from "../types";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";

export function enableAuthentication(app: Fastify) {
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            // Never log bearer tokens or header contents.
            log({ module: 'auth-decorator' }, `Auth check - path: ${request.url}, has header: ${!!authHeader}`);
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

            log({ module: 'auth-decorator' }, `Auth success - user: ${verified.userId}`);
            request.userId = verified.userId;
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}
