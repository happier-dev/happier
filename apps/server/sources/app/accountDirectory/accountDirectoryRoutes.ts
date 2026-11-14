import type { FastifyError, FastifyReply } from "fastify";
import { ACCOUNT_DIRECTORY_HOME_HTTP_PATH_V1, ACCOUNT_DIRECTORY_HOME_LOGIN_ASSERTION_HTTP_PATH_V1, ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1, ACCOUNT_DIRECTORY_LINKS_HTTP_PATH_V1, ACCOUNT_DIRECTORY_ME_HTTP_PATH_V1, ACCOUNT_DIRECTORY_PREFERRED_HOME_HTTP_PATH_V1, HOME_LOGIN_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountDirectory';
import { type Fastify } from "@/app/api/types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { requirePresentUser, PresentUserRequiredResponseSchema } from "@/app/api/utils/requirePresentUser";
import { auth } from "@/app/auth/auth";
import { createHomeApprovalGate } from "@/app/api/routes/auth/homeApprovalGate";
import { registerAccountDirectoryPrivateLabelRecipientCensusRoute } from "@/app/api/routes/account/registerPrivateLabelRecipientCensusRoute";
import {
    accountDirectoryProtocolErrorResponse,
} from "./accountDirectoryErrors";
import {
    AccountDirectoryHomePutRequestSchema,
    AccountDirectoryHomePutResponseV1Schema,
    AccountDirectoryHomeDeleteParamsV1Schema,
    AccountDirectoryHomeDeleteRequestV1Schema,
    AccountDirectoryHomeDeleteResponseV1Schema,
    AccountDirectoryHomesResponseV1Schema,
    AccountDirectoryLinkPutRequestSchema,
    AccountDirectoryLinkPutResponseV1Schema,
    AccountDirectoryLinkDeleteParamsV1Schema,
    AccountDirectoryLinkDeleteRequestV1Schema,
    AccountDirectoryLinkDeleteResponseV1Schema,
    AccountDirectoryMeResponseSchema,
    AccountDirectoryPreferredRequestSchema,
    AccountDirectoryPreferredHomePatchResponseV1Schema,
    HomeLoginAssertionRequestSchema,
    HomeLoginAssertionV1Schema,
    HomeLoginRedemptionRequestV1Schema,
    HomeLoginRedemptionResponseV1Schema,
    HomeLoginRedemptionApprovalRequiredV1Schema,
    AccountDirectoryRouteErrorResponseV1Schema,
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
    type HomeConnectionDescriptorResolver,
} from "./accountDirectoryService";

function sendAccountDirectoryError(reply: FastifyReply, error: unknown): void {
    // One internal→protocol mapping owned by the domain errors owner; the
    // strict response schemas reject anything it does not emit.
    const mapped = accountDirectoryProtocolErrorResponse(error);
    if (!mapped) throw error;
    reply.code(mapped.statusCode).send(mapped.body);
}

function accountDirectoryRouteErrorHandler(
    error: FastifyError,
    _request: unknown,
    reply: FastifyReply,
): void {
    sendAccountDirectoryError(reply, error);
}

const ACCOUNT_DIRECTORY_BOUNDARY_ERROR_RESPONSES = {
    400: AccountDirectoryRouteErrorResponseV1Schema,
    401: AccountDirectoryRouteErrorResponseV1Schema,
    429: AccountDirectoryRouteErrorResponseV1Schema,
} as const;

export function registerAccountDirectoryRoutes(app: Fastify): void {
    registerAccountDirectoryPrivateLabelRecipientCensusRoute(app);
    app.get(ACCOUNT_DIRECTORY_ME_HTTP_PATH_V1, {
        errorHandler: accountDirectoryRouteErrorHandler,
        preHandler: [app.authenticate],
        config: { allowAccountDirectoryToken: true, connectionAuthFailureError: "invalid_token", rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.read") },
        schema: { response: { ...ACCOUNT_DIRECTORY_BOUNDARY_ERROR_RESPONSES, 200: AccountDirectoryMeResponseSchema, 403: AccountDirectoryRouteErrorResponseV1Schema, 404: AccountDirectoryRouteErrorResponseV1Schema } },
    }, async (request, reply) => reply.send(await readAccountDirectoryMe(request.userId)));

    app.get(ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1, {
        errorHandler: accountDirectoryRouteErrorHandler,
        preHandler: [app.authenticate],
        config: { allowAccountDirectoryToken: true, connectionAuthFailureError: "invalid_token", rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.read") },
        schema: { response: { ...ACCOUNT_DIRECTORY_BOUNDARY_ERROR_RESPONSES, 200: AccountDirectoryHomesResponseV1Schema, 403: AccountDirectoryRouteErrorResponseV1Schema, 404: AccountDirectoryRouteErrorResponseV1Schema } },
    }, async (request, reply) => reply.send(await listAccountHomeDirectory(request.userId)));

    app.put(ACCOUNT_DIRECTORY_HOME_HTTP_PATH_V1, {
        errorHandler: accountDirectoryRouteErrorHandler,
        preHandler: [app.authenticate],
        config: { allowAccountDirectoryToken: true, connectionAuthFailureError: "invalid_token", rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.mutate") },
        schema: { params: AccountDirectoryHomeDeleteParamsV1Schema, body: AccountDirectoryHomePutRequestSchema, response: { ...ACCOUNT_DIRECTORY_BOUNDARY_ERROR_RESPONSES, 200: AccountDirectoryHomePutResponseV1Schema, 403: AccountDirectoryRouteErrorResponseV1Schema, 409: AccountDirectoryRouteErrorResponseV1Schema } },
    }, async (request, reply) => reply.send(await upsertAccountHomeDirectoryEntry({
            accountId: request.userId,
            homeServerIdentityId: request.params.homeServerIdentityId,
            label: request.body.label,
            connectionDescriptor: request.body.connectionDescriptor,
        })));

    app.delete(ACCOUNT_DIRECTORY_HOME_HTTP_PATH_V1, {
        errorHandler: accountDirectoryRouteErrorHandler,
        preHandler: [app.authenticate],
        config: { allowAccountDirectoryToken: true, connectionAuthFailureError: "invalid_token", rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.mutate") },
        schema: { params: AccountDirectoryHomeDeleteParamsV1Schema, body: AccountDirectoryHomeDeleteRequestV1Schema, response: { ...ACCOUNT_DIRECTORY_BOUNDARY_ERROR_RESPONSES, 200: AccountDirectoryHomeDeleteResponseV1Schema, 403: AccountDirectoryRouteErrorResponseV1Schema } },
    }, async (request, reply) => {
        await deleteAccountHomeDirectoryEntry({ accountId: request.userId, homeServerIdentityId: request.params.homeServerIdentityId });
        const directory = await listAccountHomeDirectory(request.userId);
        return reply.send({
            v: 1,
            deleted: true,
            homeServerIdentityId: request.params.homeServerIdentityId,
            preferredHomeServerIdentityId: directory.preferredHomeServerIdentityId,
        });
    });

    app.patch(ACCOUNT_DIRECTORY_PREFERRED_HOME_HTTP_PATH_V1, {
        errorHandler: accountDirectoryRouteErrorHandler,
        preHandler: [app.authenticate],
        config: { allowAccountDirectoryToken: true, connectionAuthFailureError: "invalid_token", rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.mutate") },
        schema: { body: AccountDirectoryPreferredRequestSchema, response: { ...ACCOUNT_DIRECTORY_BOUNDARY_ERROR_RESPONSES, 200: AccountDirectoryPreferredHomePatchResponseV1Schema, 403: AccountDirectoryRouteErrorResponseV1Schema, 404: AccountDirectoryRouteErrorResponseV1Schema } },
    }, async (request, reply) => reply.send(await setPreferredAccountHome({ accountId: request.userId, homeServerIdentityId: request.body.homeServerIdentityId })));

    app.post(ACCOUNT_DIRECTORY_HOME_LOGIN_ASSERTION_HTTP_PATH_V1, {
        errorHandler: accountDirectoryRouteErrorHandler,
        preHandler: [app.authenticate],
        config: { allowAccountDirectoryToken: true, connectionAuthFailureError: "invalid_token", rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.assertionMint") },
        schema: { params: AccountDirectoryHomeDeleteParamsV1Schema, body: HomeLoginAssertionRequestSchema, response: { ...ACCOUNT_DIRECTORY_BOUNDARY_ERROR_RESPONSES, 200: HomeLoginAssertionV1Schema, 403: AccountDirectoryRouteErrorResponseV1Schema, 404: AccountDirectoryRouteErrorResponseV1Schema } },
    }, async (request, reply) => {
        if (request.body.homeServerIdentityId !== request.params.homeServerIdentityId) {
            return reply.code(400).send({ error: "invalid_request" });
        }
        return reply.send(await mintAccountHomeLoginAssertion({
            accountId: request.userId,
            homeServerIdentityId: request.params.homeServerIdentityId,
            clientBoxPublicKeyBase64: request.body.clientBoxPublicKeyBase64,
        }));
    });
}

export function registerAccountDirectoryLinkRoutes(app: Fastify): void {
    app.put(ACCOUNT_DIRECTORY_LINKS_HTTP_PATH_V1, {
        errorHandler: accountDirectoryRouteErrorHandler,
        preHandler: [app.authenticate, requirePresentUser],
        config: { connectionAuthFailureError: "invalid_token", rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.mutate") },
        schema: { params: AccountDirectoryLinkDeleteParamsV1Schema, body: AccountDirectoryLinkPutRequestSchema, response: { ...ACCOUNT_DIRECTORY_BOUNDARY_ERROR_RESPONSES, 200: AccountDirectoryLinkPutResponseV1Schema, 403: PresentUserRequiredResponseSchema, 409: AccountDirectoryRouteErrorResponseV1Schema } },
    }, async (request, reply) => {
        if (request.body.issuerServerIdentityId !== request.params.issuerServerIdentityId) {
            return reply.code(400).send({ error: "invalid_request" });
        }
        const { issuerServerIdentityId: _issuerServerIdentityId, ...linkBody } = request.body;
        await upsertAccountDirectoryLink({
            accountId: request.userId,
            issuerServerIdentityId: request.params.issuerServerIdentityId,
            ...linkBody,
        });
        return reply.send({
            v: 1,
            issuerServerIdentityId: request.body.issuerServerIdentityId,
            issuerSubjectId: request.body.issuerSubjectId,
            issuerSigningKeyId: request.body.issuerSigningKeyId,
            issuerSigningPublicKeyBase64Url: request.body.issuerSigningPublicKeyBase64Url,
        });
    });

    app.delete(ACCOUNT_DIRECTORY_LINKS_HTTP_PATH_V1, {
        errorHandler: accountDirectoryRouteErrorHandler,
        preHandler: [app.authenticate, requirePresentUser],
        config: { connectionAuthFailureError: "invalid_token", rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.mutate") },
        schema: { params: AccountDirectoryLinkDeleteParamsV1Schema, body: AccountDirectoryLinkDeleteRequestV1Schema, response: { ...ACCOUNT_DIRECTORY_BOUNDARY_ERROR_RESPONSES, 200: AccountDirectoryLinkDeleteResponseV1Schema, 403: PresentUserRequiredResponseSchema } },
    }, async (request, reply) => {
        await deleteAccountDirectoryLink({ accountId: request.userId, issuerServerIdentityId: request.params.issuerServerIdentityId });
        return reply.send({ v: 1, deleted: true, issuerServerIdentityId: request.params.issuerServerIdentityId });
    });
}

export function registerHomeLoginRoute(app: Fastify, params: Readonly<{
    resolveHomeConnectionDescriptor?: HomeConnectionDescriptorResolver;
}> = {}): void {
    const homeApprovalGate = createHomeApprovalGate(process.env);
    app.post(HOME_LOGIN_HTTP_PATH_V1, {
        errorHandler: accountDirectoryRouteErrorHandler,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "accountDirectory.assertionRedeem") },
        schema: { body: HomeLoginRedemptionRequestV1Schema, response: { ...ACCOUNT_DIRECTORY_BOUNDARY_ERROR_RESPONSES, 200: HomeLoginRedemptionResponseV1Schema, 202: HomeLoginRedemptionApprovalRequiredV1Schema, 401: AccountDirectoryRouteErrorResponseV1Schema, 403: AccountDirectoryRouteErrorResponseV1Schema, 503: AccountDirectoryRouteErrorResponseV1Schema } },
    }, async (request, reply) => {
        await auth.init();
        const body = request.body;
        const result = await redeemHomeLoginAssertion({
            assertion: body.assertion,
            ...(body.approvalId ? { approvalId: body.approvalId } : {}),
            ...(params.resolveHomeConnectionDescriptor
                ? { resolveHomeConnectionDescriptor: params.resolveHomeConnectionDescriptor }
                : {}),
            homeApprovalGate,
            issueHomeToken: async (tx, accountId) => await auth.createTokenInTx(
                tx,
                accountId,
                undefined,
                {
                    kind: "account",
                    authority: "present_user",
                },
            ),
        });
        return "outcome" in result && result.outcome === "approval_required"
            ? reply.code(202).send(result)
            : reply.send(result);
    });
}
