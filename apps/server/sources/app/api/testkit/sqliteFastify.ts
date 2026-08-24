import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { captureAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    isApiTokenDeniedForRoute,
    PRESENT_USER_REQUIRED_ERROR,
} from "../utils/apiTokenRouteAdmission";

export function createAuthenticatedTestApp(
    options: Readonly<{ bodyLimit?: number }> = {},
) {
    // Fastify's own 1 MiB default would answer 413 for a route that declares no
    // ceiling at all, so a body-limit test must be able to reproduce the
    // production application limit and let the route ceiling be the only bound.
    const app = Fastify(options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
        request.authTokenKind = request.headers["x-test-auth-token-kind"] === "terminal"
            ? "terminal"
            : request.headers["x-test-auth-token-kind"] === "api_token"
                ? "api_token"
                : "account";
        request.authAuthority = request.authTokenKind === "account"
            ? "present_user"
            : "account_automation";
        if (request.authTokenKind === "api_token") {
            const accountId = request.headers["x-test-api-token-account-id"];
            const principalId = request.headers["x-test-api-token-principal-id"];
            const credentialId = request.headers["x-test-api-token-credential-id"];
            if (
                typeof accountId === "string"
                && typeof principalId === "string"
                && typeof credentialId === "string"
                && accountId.length > 0
                && principalId.length > 0
                && credentialId.length > 0
            ) {
                request.apiTokenPrincipal = {
                    accountId,
                    principalId,
                    credentialId,
                    authority: "account_automation",
                    expiresAt: null,
                };
            }
        }
        if (isApiTokenDeniedForRoute(request)) {
            return reply.code(403).send({ error: PRESENT_USER_REQUIRED_ERROR });
        }
        captureAccountStoredContentCompatibilityForHttpRequest(request);
    });

    return typed;
}

export async function withAuthenticatedTestApp(
    registerRoutes: (app: any) => void,
    run: (app: any) => Promise<void>,
): Promise<void> {
    const app = createAuthenticatedTestApp();
    registerRoutes(app);
    await app.ready();
    try {
        await run(app);
    } finally {
        await app.close();
    }
}
