import {
    ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
    AccountApiTokensCreateActionInputV1Schema,
    AccountApiTokensCreateActionOutputV1Schema,
    AccountApiTokensListActionInputV1Schema,
    AccountApiTokensListActionOutputV1Schema,
    AccountApiTokensRevokeActionInputV1Schema,
    AccountApiTokensRevokeActionOutputV1Schema,
    AccountApiTokensRevokeAllActionInputV1Schema,
    AccountApiTokensRevokeAllActionOutputV1Schema,
    AccountApiTokensServerErrorV1Schema,
} from "@happier-dev/protocol";

import {
    auth,
    type ApiTokenSummary,
    type CreatedApiToken,
} from "@/app/auth/auth";
import {
    PresentUserRequiredResponseSchema,
    requirePresentUser,
} from "@/app/api/utils/requirePresentUser";

import { type Fastify } from "../../types";

function serializeApiTokenSummary(token: ApiTokenSummary) {
    return {
        tokenId: token.tokenId,
        label: token.label,
        displayPrefix: token.displayPrefix,
        createdAt: token.createdAt.toISOString(),
        lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
        expiresAt: token.expiresAt?.toISOString() ?? null,
    };
}

function serializeCreatedApiToken(token: CreatedApiToken) {
    return {
        token: token.token,
        apiToken: {
            tokenId: token.tokenId,
            label: token.label,
            displayPrefix: token.displayPrefix,
            createdAt: token.createdAt.toISOString(),
            lastUsedAt: null,
            expiresAt: token.expiresAt?.toISOString() ?? null,
        },
    };
}

/**
 * Direct Settings/session transport for the current Account's API-token
 * Actions. `app.authenticate` is the canonical direct-route authority owner;
 * API-token callers are denied there by the shared default policy. The Action
 * boundary separately governs public/API and trusted-plugin admission.
 */
export function registerAccountApiTokenManagementRoutes(app: Fastify): void {
    app.post(
        ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
        {
            preHandler: [app.authenticate, requirePresentUser],
            attachValidation: true,
            schema: {
                body: AccountApiTokensCreateActionInputV1Schema,
                response: {
                    200: AccountApiTokensCreateActionOutputV1Schema,
                    400: AccountApiTokensServerErrorV1Schema,
                    403: PresentUserRequiredResponseSchema,
                },
            },
        },
        async (request, reply) => {
            if (request.validationError) {
                return await reply.code(400).send({ error: "invalid_request" });
            }

            const expiresAt = request.body.expiresAt == null
                ? null
                : new Date(request.body.expiresAt);
            if (expiresAt !== null && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
                return await reply.code(400).send({ error: "invalid_request" });
            }

            const created = await auth.createApiToken({
                accountId: request.userId,
                label: request.body.label,
                expiresAt,
            });
            return await reply.send(serializeCreatedApiToken(created));
        },
    );

    app.post(
        ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
        {
            preHandler: app.authenticate,
            attachValidation: true,
            schema: {
                body: AccountApiTokensListActionInputV1Schema,
                response: {
                    200: AccountApiTokensListActionOutputV1Schema,
                    400: AccountApiTokensServerErrorV1Schema,
                    403: PresentUserRequiredResponseSchema,
                },
            },
        },
        async (request, reply) => {
            if (request.validationError) {
                return await reply.code(400).send({ error: "invalid_request" });
            }

            const tokens = await auth.listApiTokens(request.userId);
            return await reply.send({ tokens: tokens.map(serializeApiTokenSummary) });
        },
    );

    app.post(
        ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
        {
            preHandler: [app.authenticate, requirePresentUser],
            attachValidation: true,
            schema: {
                body: AccountApiTokensRevokeActionInputV1Schema,
                response: {
                    200: AccountApiTokensRevokeActionOutputV1Schema,
                    400: AccountApiTokensServerErrorV1Schema,
                    403: PresentUserRequiredResponseSchema,
                },
            },
        },
        async (request, reply) => {
            if (request.validationError) {
                return await reply.code(400).send({ error: "invalid_request" });
            }

            const revoked = await auth.revokeApiToken({
                accountId: request.userId,
                tokenId: request.body.tokenId,
            });
            return await reply.send({ revoked });
        },
    );

    app.post(
        ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
        {
            preHandler: [app.authenticate, requirePresentUser],
            attachValidation: true,
            schema: {
                body: AccountApiTokensRevokeAllActionInputV1Schema,
                response: {
                    200: AccountApiTokensRevokeAllActionOutputV1Schema,
                    400: AccountApiTokensServerErrorV1Schema,
                    403: PresentUserRequiredResponseSchema,
                },
            },
        },
        async (request, reply) => {
            if (request.validationError) {
                return await reply.code(400).send({ error: "invalid_request" });
            }

            const revokedCount = await auth.revokeAllApiTokens(request.userId);
            return await reply.send({ revokedCount });
        },
    );
}
