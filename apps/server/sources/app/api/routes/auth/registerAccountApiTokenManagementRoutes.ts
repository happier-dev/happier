import { ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1, AccountApiTokenEncryptionAccessRequestV1Schema, AccountApiTokenEncryptionAccessResponseV1Schema, AccountApiTokenIntrospectionConnectionFailureV1Schema, AccountApiTokenIntrospectionSubjectFailureV1Schema, ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1, ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1, ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1, AccountApiTokensCreateActionOutputV1Schema, AccountApiTokensListActionInputV1Schema, AccountApiTokensListActionOutputV1Schema, AccountApiTokensRevokeActionInputV1Schema, AccountApiTokensRevokeActionOutputV1Schema, AccountApiTokensRevokeAllActionInputV1Schema, AccountApiTokensRevokeAllActionOutputV1Schema, AccountApiTokensServerErrorV1Schema, ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1, ACCOUNT_API_TOKEN_CHILDREN_CREATE_HTTP_PATH_V1, ACCOUNT_API_TOKEN_CHILDREN_REVOKE_HTTP_PATH_V1, ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1, AccountApiTokensUpdateActionOutputV1Schema, AccountApiTokenChildCreateRequestV1Schema, AccountApiTokenChildRevokeRequestV1Schema, AccountApiTokenSelfV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { z } from "zod/mini";
import { AccountApiTokensCreateHttpInputV1Schema, AccountApiTokensUpdateHttpInputV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { db } from '@/storage/db';

import {
    auth,
    InvalidApiTokenExpiryError,
    ApiTokenOperationError,
    type ApiTokenSummary,
    type CreatedApiToken,
} from "@/app/auth/auth";
import {
    PresentUserRequiredResponseSchema,
    requirePresentUser,
} from "@/app/api/utils/requirePresentUser";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { eventRouter } from '@/app/events/eventRouter';

import { type Fastify } from "../../types";

function serializeApiTokenSummary(token: ApiTokenSummary) {
    return {
        tokenId: token.tokenId,
        label: token.label,
        displayPrefix: token.displayPrefix,
        createdAt: token.createdAt.toISOString(),
        lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
        expiresAt: token.expiresAt?.toISOString() ?? null,
        hasEncryptionAccess: token.hasEncryptionAccess,
        hasUnattendedTeamAccess: token.hasUnattendedTeamAccess,
        grant: token.grant,
        parentTokenId: token.parentTokenId,
        activeChildCount: token.activeChildCount,
        embedConfig: token.embedConfig,
    };
}

function serializeCreatedApiToken(token: CreatedApiToken) {
    return {
        token: token.token,
        apiToken: serializeApiTokenSummary({ ...token, lastUsedAt: null }),
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
            config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.apiTokens.mutate") },
            preHandler: [app.authenticate, requirePresentUser],
            attachValidation: true,
            schema: {
                body: AccountApiTokensCreateHttpInputV1Schema,
                response: {
                    200: AccountApiTokensCreateActionOutputV1Schema,
                    400: AccountApiTokensServerErrorV1Schema,
                    403: AccountApiTokensServerErrorV1Schema,
                    409: AccountApiTokensServerErrorV1Schema,
                },
            },
        },
        async (request, reply) => {
            if (request.validationError) {
                return await reply.code(400).send({ error: "invalid_request" });
            }

            const now = new Date();
            const expiresAt = request.body.expiresAt == null
                ? null
                : new Date(request.body.expiresAt);
            try {
                if (request.body.authorizeUnattendedTeamAccess === true
                    && !request.authTokenAuthenticationEvidence?.length) {
                    return await reply.code(409).send({ error: "credential_authentication_evidence_unavailable" });
                }
                const created = await auth.createApiToken({
                    accountId: request.userId,
                    tokenId: request.body.tokenId,
                    label: request.body.label,
                    expiresAt,
                    grant: request.body.grant,
                    embedConfig: request.body.embedConfig,
                    ...(request.body.deployment !== undefined ? { deployment: request.body.deployment } : {}),
                    ...(request.body.encryption ? { encryption: request.body.encryption } : {}),
                    ...(request.body.authorizeUnattendedTeamAccess === true && request.authTokenAuthenticationEvidence
                        ? { authenticationEvidence: request.authTokenAuthenticationEvidence }
                        : {}),
                }, now);
                return await reply.send(serializeCreatedApiToken(created));
            } catch (error) {
                if (error instanceof InvalidApiTokenExpiryError) {
                    return await reply.code(400).send({ error: "invalid_request" });
                }
                if (error instanceof ApiTokenOperationError && error.code === "account-disabled") {
                    return await reply.code(403).send({ error: "account-disabled" });
                }
                if (error instanceof ApiTokenOperationError && error.code === 'credential_scope_denied') {
                    return await reply.code(403).send({ error: error.code });
                }
                if (error instanceof ApiTokenOperationError && (
                    error.code === "api_token_id_conflict"
                    || error.code === "api_token_encryption_not_ready"
                    || error.code === "credential_authentication_evidence_limit"
                    || error.code === "credential_authentication_evidence_unavailable"
                )) {
                    return await reply.code(409).send({ error: error.code });
                }
                throw error;
            }
        },
    );

    app.post(ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1, {
        config: {
            allowApiToken: true,
            allowScopedApiToken: true,
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.apiTokens.read"),
        },
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: AccountApiTokenEncryptionAccessRequestV1Schema,
            response: {
                200: AccountApiTokenEncryptionAccessResponseV1Schema,
                400: AccountApiTokensServerErrorV1Schema,
                401: z.union([
                    AccountApiTokenIntrospectionSubjectFailureV1Schema,
                    AccountApiTokenIntrospectionConnectionFailureV1Schema,
                ]),
                403: AccountApiTokensServerErrorV1Schema,
                409: AccountApiTokensServerErrorV1Schema,
            },
        },
    }, async (request, reply) => {
        if (request.validationError) return await reply.code(400).send({ error: "invalid_request" });
        if (request.authTokenKind !== "api_token" || !request.apiTokenPrincipal) {
            return await reply.code(403).send({ error: "api_token_required" });
        }
        try {
            return await reply.send(await auth.getApiTokenEncryptionAccess(request.apiTokenPrincipal));
        } catch (error) {
            if (error instanceof ApiTokenOperationError) {
                if (error.code === "invalid_token") return await reply.code(401).send({ error: error.code });
                if (error.code === "api_token_encryption_stale" || error.code === "api_token_encryption_unavailable") {
                    return await reply.code(409).send({ error: error.code });
                }
            }
            throw error;
        }
    });

    app.post(
        ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
        {
            config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.apiTokens.read") },
            preHandler: app.authenticate,
            attachValidation: true,
            schema: {
                body: AccountApiTokensListActionInputV1Schema,
                querystring: z.strictObject({}),
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

            const tokens = await auth.listApiTokens(request.userId, { includeChildren: request.body.includeChildren === true });
            return await reply.send({ tokens: tokens.map(serializeApiTokenSummary) });
        },
    );

    app.post(
        ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
        {
            config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.apiTokens.mutate") },
            preHandler: [app.authenticate, requirePresentUser],
            attachValidation: true,
            schema: {
                body: AccountApiTokensRevokeActionInputV1Schema,
                response: {
                    200: AccountApiTokensRevokeActionOutputV1Schema,
                    400: AccountApiTokensServerErrorV1Schema,
                    403: PresentUserRequiredResponseSchema,
                    503: AccountApiTokensServerErrorV1Schema,
                },
            },
        },
        async (request, reply) => {
            if (request.validationError) {
                return await reply.code(400).send({ error: "invalid_request" });
            }

            const result = await auth.revokeApiToken({
                accountId: request.userId,
                tokenId: request.body.tokenId,
            });
            app.disconnectApiTokenSockets?.(result.revokedTokenIds);
            return await reply.send({ revoked: result.revoked });
        },
    );

    app.post(
        ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
        {
            config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.apiTokens.mutate") },
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

            const result = await auth.revokeAllApiTokens(request.userId);
            app.disconnectApiTokenSockets?.(result.revokedTokenIds);
            return await reply.send({ revokedCount: result.revokedCount });
        },
    );

    app.post(ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1, {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.apiTokens.mutate") },
        preHandler: [app.authenticate, requirePresentUser], attachValidation: true,
        schema: { body: AccountApiTokensUpdateHttpInputV1Schema, response: {
            200: AccountApiTokensUpdateActionOutputV1Schema, 400: AccountApiTokensServerErrorV1Schema,
            401: AccountApiTokenIntrospectionSubjectFailureV1Schema, 403: z.union([PresentUserRequiredResponseSchema, AccountApiTokensServerErrorV1Schema]),
            409: AccountApiTokensServerErrorV1Schema,
        } },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        try {
            if (request.body.authorizeUnattendedTeamAccess === true && !request.authTokenAuthenticationEvidence?.length) {
                return reply.code(409).send({ error: "credential_authentication_evidence_unavailable" });
            }
            const { authorizeUnattendedTeamAccess, ...update } = request.body;
            const result = await auth.updateApiToken({ accountId: request.userId, ...update,
                ...(authorizeUnattendedTeamAccess === true && request.authTokenAuthenticationEvidence
                    ? { authenticationEvidence: request.authTokenAuthenticationEvidence } : {}),
            });
            if (result.grantChanged || result.authenticationEvidenceChanged) app.disconnectApiTokenSockets?.([request.body.tokenId, ...result.revokedTokenIds]);
            if (result.embedConfigChanged && !result.grantChanged) eventRouter.emitApiTokenEmbedConfigChanged({ accountId: request.userId, tokenId: request.body.tokenId });
            return reply.send({ apiToken: serializeApiTokenSummary(result.apiToken) });
        } catch (error) {
            if (error instanceof ApiTokenOperationError && error.code === "invalid_token") return reply.code(401).send({ error: error.code });
            if (error instanceof ApiTokenOperationError && error.code === 'credential_scope_denied') return reply.code(403).send({ error: error.code });
            if (error instanceof ApiTokenOperationError && (error.code === "credential_authentication_evidence_unavailable"
                || error.code === "credential_authentication_evidence_limit")) return reply.code(409).send({ error: error.code });
            throw error;
        }
    });

    app.post(ACCOUNT_API_TOKEN_CHILDREN_CREATE_HTTP_PATH_V1, {
        config: { allowApiToken: true, allowScopedApiToken: true,
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.apiTokens.mutate") },
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: AccountApiTokenChildCreateRequestV1Schema, response: {
            200: AccountApiTokensCreateActionOutputV1Schema, 400: AccountApiTokensServerErrorV1Schema,
            401: AccountApiTokenIntrospectionSubjectFailureV1Schema, 403: AccountApiTokensServerErrorV1Schema,
            409: AccountApiTokensServerErrorV1Schema,
        } },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        if (request.authTokenKind !== "api_token" || !request.apiTokenPrincipal) return reply.code(403).send({ error: "api_token_required" });
        try {
            const created = await auth.createChildApiToken({
                principal: request.apiTokenPrincipal, ...request.body, expiresAt: new Date(request.body.expiresAt),
                resolveSessionMachine: app.resolveCurrentSessionMachine
                    ? (sessionId) => app.resolveCurrentSessionMachine!({ accountId: request.userId, sessionId }) : undefined,
            });
            return reply.send(serializeCreatedApiToken(created));
        } catch (error) {
            if (error instanceof InvalidApiTokenExpiryError) return reply.code(400).send({ error: "api_token_child_invalid" });
            if (error instanceof ApiTokenOperationError && error.code !== 'target_unavailable') {
                const status = error.code === "invalid_token" ? 401 : error.code === "api_token_child_invalid" ? 400
                    : error.code === "api_token_id_conflict" ? 409 : 403;
                return reply.code(status).send({ error: error.code });
            }
            throw error;
        }
    });

    app.post(ACCOUNT_API_TOKEN_CHILDREN_REVOKE_HTTP_PATH_V1, {
        config: { allowApiToken: true, allowScopedApiToken: true,
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.apiTokens.mutate") },
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: AccountApiTokenChildRevokeRequestV1Schema, response: {
            200: AccountApiTokensRevokeActionOutputV1Schema, 400: AccountApiTokensServerErrorV1Schema,
            403: AccountApiTokensServerErrorV1Schema,
        } },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        if (request.authTokenKind !== "api_token" || !request.apiTokenPrincipal) return reply.code(403).send({ error: "api_token_required" });
        try {
            const result = await auth.revokeChildApiToken(request.apiTokenPrincipal, request.body.tokenId);
            app.disconnectApiTokenSockets?.(result.revokedTokenIds);
            return reply.send({ revoked: result.revoked });
        } catch (error) {
            if (error instanceof ApiTokenOperationError && error.code === "api_token_child_forbidden") return reply.code(403).send({ error: error.code });
            throw error;
        }
    });

    app.get(ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1, {
        config: { allowApiToken: true, allowScopedApiToken: true,
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.apiTokens.read") },
        preHandler: app.authenticate,
        schema: { response: { 200: AccountApiTokenSelfV1Schema, 403: AccountApiTokensServerErrorV1Schema,
            401: AccountApiTokenIntrospectionSubjectFailureV1Schema, 409: AccountApiTokensServerErrorV1Schema } },
    }, async (request, reply) => {
        const principal = request.apiTokenPrincipal;
        if (request.authTokenKind !== "api_token" || !principal) return reply.code(403).send({ error: "api_token_required" });
        const account = await db.account.findUniqueOrThrow({ where: { id: principal.accountId }, select: { encryptionMode: true } });
        return reply.header("cache-control", "no-store").send(AccountApiTokenSelfV1Schema.parse({ accountId: principal.accountId, credentialId: principal.credentialId,
            accountEncryptionMode: account.encryptionMode,
            parentTokenId: principal.parentTokenId, grant: principal.grant,
            expiresAt: principal.expiresAt?.toISOString() ?? null, embedConfig: principal.embedConfig,
        }));
    });
}
