import { z } from "zod";
import { type Fastify } from "@/app/api/types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { requirePresentUser } from "@/app/api/utils/requirePresentUser";
import {
    AccountDirectoryError,
} from "./accountDirectoryErrors";
import {
    AccountDirectoryHomePutRequestSchema,
    AccountDirectoryLinkPutRequestSchema,
    AccountDirectoryMeResponseSchema,
    AccountDirectoryPreferredRequestSchema,
    HomeLoginAssertionRequestSchema,
    HomeLoginAssertionV1Schema,
    HomeLoginRedemptionResponseV1Schema,
} from "./accountDirectorySchemas";
import {
    deleteAccountDirectoryLink,
    deleteAccountHomeDirectoryEntry,
    listAccountHomeDirectory,
    mintAccountHomeLoginAssertion,
    readAccountDirectoryMe,
    redeemHomeLoginAssertion,
    setPreferredAccountHome,
    upsertAccountDirectoryLink,
    upsertAccountHomeDirectoryEntry,
} from "./accountDirectoryService";

const IdentityParamsSchema = z.object({ homeServerIdentityId: z.string().trim().min(1).max(128) }).strict();
const IssuerIdentityParamsSchema = z.object({ issuerServerIdentityId: z.string().trim().min(1).max(128) }).strict();
const ErrorResponseSchema = z.object({ error: z.string() }).strict();

type RequestAuthority = Readonly<{ authAuthority?: unknown; authTokenKind?: unknown }>;

/**
 * Lane 01 stamps both fields only after verification. Account Directory tokens
 * are intentionally limited to these exact handlers; all other routes remain
 * protected by the canonical admission owner.
 */
async function requireAccountDirectoryAuthority(request: RequestAuthority, reply: { code: (code: number) => { send: (value: unknown) => unknown } }): Promise<unknown> {
    if (request.authAuthority === "present_user" || request.authTokenKind === "account_directory") return undefined;
    return reply.code(403).send({ error: "account_directory_authority_required" });
}

function sendAccountDirectoryError(reply: { code: (code: number) => { send: (value: unknown) => unknown } }, error: unknown): unknown {
    if (error instanceof AccountDirectoryError) {
        const codeMap: Record<string, string> = {
            not_found: "directory_unavailable",
            preferred_home_not_found: "directory_unavailable",
            directory_link_conflict: "invalid_request",
            invalid_assertion: "invalid_assertion_signature",
            assertion_wrong_audience: "invalid_audience",
            assertion_client_key_mismatch: "invalid_client_key",
            assertion_issuer_untrusted: "invalid_issuer",
        };
        return reply.code(error.statusCode).send({ error: codeMap[error.code] ?? error.code });
    }
    throw error;
}

export function registerAccountDirectoryRoutes(app: Fastify): void {
    app.get("/v1/account-directory/me", {
        preHandler: [app.authenticate, requireAccountDirectoryAuthority],
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.read") },
        schema: { response: { 200: AccountDirectoryMeResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema } },
    }, async (request, reply) => {
        try {
            return reply.send(await readAccountDirectoryMe(request.userId));
        } catch (error) {
            return sendAccountDirectoryError(reply, error);
        }
    });

    app.get("/v1/account-directory/homes", {
        preHandler: [app.authenticate, requireAccountDirectoryAuthority],
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.read") },
        schema: { response: { 200: z.object({ v: z.literal(1), preferredHomeServerIdentityId: z.string().nullable(), homes: z.array(z.unknown()) }).strict(), 403: ErrorResponseSchema, 404: ErrorResponseSchema } },
    }, async (request, reply) => {
        try {
            return reply.send(await listAccountHomeDirectory(request.userId));
        } catch (error) {
            return sendAccountDirectoryError(reply, error);
        }
    });

    app.put("/v1/account-directory/homes/:homeServerIdentityId", {
        preHandler: [app.authenticate, requireAccountDirectoryAuthority],
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.mutate") },
        schema: { params: IdentityParamsSchema, body: AccountDirectoryHomePutRequestSchema, response: { 200: z.object({ v: z.literal(1), homeServerIdentityId: z.string() }).passthrough(), 400: ErrorResponseSchema, 403: ErrorResponseSchema } },
    }, async (request, reply) => {
        try {
            return reply.send(await upsertAccountHomeDirectoryEntry({
                accountId: request.userId,
                homeServerIdentityId: request.params.homeServerIdentityId,
                label: request.body.label,
                connectionDescriptor: request.body.connectionDescriptor,
            }));
        } catch (error) {
            return sendAccountDirectoryError(reply, error);
        }
    });

    app.delete("/v1/account-directory/homes/:homeServerIdentityId", {
        preHandler: [app.authenticate, requireAccountDirectoryAuthority],
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.mutate") },
        schema: { params: IdentityParamsSchema, response: { 200: z.object({ v: z.literal(1), preferredHomeServerIdentityId: z.string().nullable(), homes: z.array(z.unknown()) }).strict(), 403: ErrorResponseSchema } },
    }, async (request, reply) => {
        try {
            await deleteAccountHomeDirectoryEntry({ accountId: request.userId, homeServerIdentityId: request.params.homeServerIdentityId });
            return reply.send(await listAccountHomeDirectory(request.userId));
        } catch (error) {
            return sendAccountDirectoryError(reply, error);
        }
    });

    app.patch("/v1/account-directory/homes/preferred", {
        preHandler: [app.authenticate, requireAccountDirectoryAuthority],
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.mutate") },
        schema: { body: AccountDirectoryPreferredRequestSchema, response: { 200: z.object({ v: z.literal(1), preferredHomeServerIdentityId: z.string().nullable(), homes: z.array(z.unknown()) }).strict(), 403: ErrorResponseSchema, 404: ErrorResponseSchema } },
    }, async (request, reply) => {
        try {
            return reply.send(await setPreferredAccountHome({ accountId: request.userId, homeServerIdentityId: request.body.homeServerIdentityId }));
        } catch (error) {
            return sendAccountDirectoryError(reply, error);
        }
    });

    app.post("/v1/account-directory/homes/:homeServerIdentityId/login-assertion", {
        preHandler: [app.authenticate, requireAccountDirectoryAuthority],
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.assertionMint") },
        schema: { params: IdentityParamsSchema, body: HomeLoginAssertionRequestSchema, response: { 200: HomeLoginAssertionV1Schema, 400: ErrorResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema } },
    }, async (request, reply) => {
        try {
            return reply.send(await mintAccountHomeLoginAssertion({
                accountId: request.userId,
                homeServerIdentityId: request.params.homeServerIdentityId,
                clientBoxPublicKeyBase64: request.body.clientBoxPublicKeyBase64,
            }));
        } catch (error) {
            return sendAccountDirectoryError(reply, error);
        }
    });
}

export function registerAccountDirectoryLinkRoutes(app: Fastify): void {
    app.put("/v1/account/directory-links/:issuerServerIdentityId", {
        preHandler: [app.authenticate, requirePresentUser],
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.mutate") },
        schema: { params: IssuerIdentityParamsSchema, body: AccountDirectoryLinkPutRequestSchema, response: { 200: z.object({ ok: z.literal(true) }).strict(), 400: ErrorResponseSchema, 403: ErrorResponseSchema, 409: ErrorResponseSchema } },
    }, async (request, reply) => {
        try {
            await upsertAccountDirectoryLink({
                accountId: request.userId,
                issuerServerIdentityId: request.params.issuerServerIdentityId,
                ...request.body,
            });
            return reply.send({ ok: true });
        } catch (error) {
            return sendAccountDirectoryError(reply, error);
        }
    });

    app.delete("/v1/account/directory-links/:issuerServerIdentityId", {
        preHandler: [app.authenticate, requirePresentUser],
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.mutate") },
        schema: { params: IssuerIdentityParamsSchema, response: { 200: z.object({ ok: z.literal(true) }).strict(), 403: ErrorResponseSchema } },
    }, async (request, reply) => {
        try {
            await deleteAccountDirectoryLink({ accountId: request.userId, issuerServerIdentityId: request.params.issuerServerIdentityId });
            return reply.send({ ok: true });
        } catch (error) {
            return sendAccountDirectoryError(reply, error);
        }
    });
}

export function registerHomeLoginRoute(app: Fastify): void {
    app.post("/v1/auth/home-login", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.assertionRedeem") },
        schema: { body: z.union([
            z.object({ v: z.literal(1), assertion: HomeLoginAssertionV1Schema }).strict(),
            HomeLoginAssertionV1Schema,
        ]), response: { 200: HomeLoginRedemptionResponseV1Schema, 401: ErrorResponseSchema, 429: ErrorResponseSchema } },
    }, async (request, reply) => {
        try {
            const body = request.body as { assertion?: unknown };
            return reply.send(await redeemHomeLoginAssertion({ assertion: body.assertion ?? request.body }));
        } catch (error) {
            return sendAccountDirectoryError(reply, error);
        }
    });
}
