import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { createHash, randomBytes as nodeRandomBytes, randomUUID } from 'node:crypto';
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import tweetnacl from 'tweetnacl';

import {
    createReviewCommentPrincipalSigningInputV1,
    buildReviewCommentMutationEventEnvelopeV1,
    decodeBase64,
    REVIEW_COMMENT_PRINCIPAL_HEADER_V1,
    ReviewCommentActionIdV1Schema,
    ReviewCommentActionInputSchemasV1,
    ReviewCommentActionOutputSchemasV1,
    ReviewCommentPrincipalHeaderV1Schema,
    type ReviewCommentPrincipalHeaderV1,
    type ReviewCommentActionIdV1,
    type ReviewCommentPrincipalProofV1,
    type AccountScopedCryptoMaterial,
    stringifyReviewCommentPrincipalCanonicalJsonV1,
} from '@happier-dev/protocol';

import { createHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { readSettings, type StoredCredentials } from '@/persistence';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

export type ReviewCommentActionExecutionOptions = Readonly<{
    signal?: AbortSignal;
    principal?: ReviewCommentPrincipalHeaderV1;
}>;

type ReviewCommentAccountEncryptionMode = 'plain' | 'e2ee' | 'unknown';

export type ReviewCommentActionExecutor = (
    actionId: ReviewCommentActionIdV1,
    input: unknown,
    options?: ReviewCommentActionExecutionOptions,
) => Promise<unknown>;

type JsonRecord = Record<string, unknown>;
type ReviewCommentHttpMethod = 'get' | 'post' | 'patch';

export type ReviewCommentPrincipalSigningContext = Readonly<{
    machineId: string;
    installationId: string;
    privateKeyBase64Url: string;
}>;

type ReviewCommentHttpRequest = Readonly<{
    method: ReviewCommentHttpMethod;
    path: string;
    query?: JsonRecord;
    body?: JsonRecord;
}>;

function asRecord(value: unknown): JsonRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('review_comment_action_input_record_required');
    }
    return value as JsonRecord;
}

function resolveAccountIdFromToken(token: string): string {
    const payload = decodeJwtPayload(token);
    const accountId = typeof payload?.sub === 'string' ? payload.sub.trim() : '';
    if (!accountId) throw new Error('review_comment_account_identity_unavailable');
    return accountId;
}

function resolveAccountScopedMaterial(credentials: StoredCredentials): AccountScopedCryptoMaterial | null {
    if (!credentials.encryption) return null;
    if (credentials.encryption.type === 'legacy') {
        return { type: 'legacy', secret: credentials.encryption.secret };
    }
    return { type: 'dataKey', machineKey: credentials.encryption.machineKey };
}

function isReviewCommentMutationAction(
    actionId: ReviewCommentActionIdV1,
): actionId is Exclude<ReviewCommentActionIdV1, 'reviews.comments.list' | 'reviews.comments.get'> {
    return actionId !== 'reviews.comments.list' && actionId !== 'reviews.comments.get';
}

function readRequiredString(input: JsonRecord, key: string): string {
    const value = input[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`review_comment_action_input_missing:${key}`);
    }
    return value;
}

function omitKeys(input: JsonRecord, keys: readonly string[]): JsonRecord {
    const skipped = new Set(keys);
    return Object.fromEntries(
        Object.entries(input).filter(([key]) => !skipped.has(key)),
    );
}

function encodePathSegment(value: string): string {
    return encodeURIComponent(value);
}

function createReviewCommentHttpRequest(
    actionId: ReviewCommentActionIdV1,
    input: JsonRecord,
): ReviewCommentHttpRequest {
    if (actionId === 'reviews.comments.create') {
        return { method: 'post', path: '/v1/reviews/comments', body: input };
    }
    if (actionId === 'reviews.comments.list') {
        return { method: 'get', path: '/v1/reviews/comments', query: input };
    }
    if (actionId === 'reviews.comments.get') {
        const commentId = readRequiredString(input, 'commentId');
        return {
            method: 'get',
            path: `/v1/reviews/comments/${encodePathSegment(commentId)}`,
            query: omitKeys(input, ['commentId']),
        };
    }
    if (actionId === 'reviews.comments.edit') {
        const commentId = readRequiredString(input, 'commentId');
        return {
            method: 'patch',
            path: `/v1/reviews/comments/${encodePathSegment(commentId)}`,
            body: omitKeys(input, ['commentId']),
        };
    }
    if (actionId === 'reviews.comments.transition') {
        const commentId = readRequiredString(input, 'commentId');
        return {
            method: 'post',
            path: `/v1/reviews/comments/${encodePathSegment(commentId)}/transition`,
            body: omitKeys(input, ['commentId']),
        };
    }
    if (actionId === 'reviews.comments.reply') {
        const parentCommentId = readRequiredString(input, 'parentCommentId');
        return {
            method: 'post',
            path: `/v1/reviews/comments/${encodePathSegment(parentCommentId)}/reply`,
            body: omitKeys(input, ['parentCommentId']),
        };
    }
    if (actionId === 'reviews.comments.redact') {
        const commentId = readRequiredString(input, 'commentId');
        return {
            method: 'post',
            path: `/v1/reviews/comments/${encodePathSegment(commentId)}/redact`,
            body: omitKeys(input, ['commentId']),
        };
    }
    if (actionId === 'reviews.comments.setDisposition') {
        const commentId = readRequiredString(input, 'commentId');
        return {
            method: 'post',
            path: `/v1/reviews/comments/${encodePathSegment(commentId)}/disposition`,
            body: omitKeys(input, ['commentId']),
        };
    }
    if (actionId === 'reviews.comments.attachEvidence') {
        const commentId = readRequiredString(input, 'commentId');
        return {
            method: 'post',
            path: `/v1/reviews/comments/${encodePathSegment(commentId)}/evidence`,
            body: omitKeys(input, ['commentId']),
        };
    }
    return {
        method: 'post',
        path: '/v1/reviews/comments/bulkTransition',
        body: input,
    };
}

function proofMethodForRequest(method: ReviewCommentHttpMethod): ReviewCommentPrincipalProofV1['method'] {
    if (method === 'get') return 'GET';
    if (method === 'patch') return 'PATCH';
    return 'POST';
}

function createReviewCommentPrincipalBodyHash(body: unknown): string {
    return createHash('sha256')
        .update(stringifyReviewCommentPrincipalCanonicalJsonV1(body ?? null))
        .digest('base64url');
}

async function resolveDefaultPrincipalSigningContext(): Promise<ReviewCommentPrincipalSigningContext> {
    const [settings, identity] = await Promise.all([
        readSettings(),
        readOrCreateInstallationIdentity(),
    ]);
    const machineId = typeof settings?.machineId === 'string' ? settings.machineId.trim() : '';
    if (!machineId) {
        throw new Error('review_comment_principal_machine_identity_required');
    }
    return {
        machineId,
        installationId: identity.installationId,
        privateKeyBase64Url: identity.privateKey,
    };
}

async function signedReviewCommentPrincipalHeader(params: Readonly<{
    principal: ReviewCommentPrincipalHeaderV1;
    request: ReviewCommentHttpRequest;
    resolvePrincipalSigningContext?: () => Promise<ReviewCommentPrincipalSigningContext>;
    assertPrincipalCurrent?: (principal: ReviewCommentPrincipalHeaderV1) => void;
}>): Promise<ReviewCommentPrincipalHeaderV1> {
    const signingContext = await (params.resolvePrincipalSigningContext ?? resolveDefaultPrincipalSigningContext)();
    params.assertPrincipalCurrent?.(params.principal);
    const proof = {
        v: 1 as const,
        alg: 'ed25519-machine-installation-v1' as const,
        machineId: signingContext.machineId,
        installationId: signingContext.installationId,
        issuedAt: Date.now(),
        nonce: randomUUID(),
        method: proofMethodForRequest(params.request.method),
        path: params.request.path,
        bodySha256Base64Url: createReviewCommentPrincipalBodyHash(params.request.body),
    };
    const privateKey = decodeBase64(signingContext.privateKeyBase64Url, 'base64url');
    const signature = tweetnacl.sign.detached(
        createReviewCommentPrincipalSigningInputV1({
            actor: params.principal.actor,
            ...(params.principal.currentIntent ? { currentIntent: params.principal.currentIntent } : {}),
            proof,
        }),
        privateKey,
    );
    return {
        actor: params.principal.actor,
        ...(params.principal.currentIntent ? { currentIntent: params.principal.currentIntent } : {}),
        proof: {
            ...proof,
            signatureBase64Url: Buffer.from(signature).toString('base64url'),
        },
    };
}

async function encodeReviewCommentPrincipalHeader(params: Readonly<{
    principal: ReviewCommentPrincipalHeaderV1;
    request: ReviewCommentHttpRequest;
    resolvePrincipalSigningContext?: () => Promise<ReviewCommentPrincipalSigningContext>;
    assertPrincipalCurrent?: (principal: ReviewCommentPrincipalHeaderV1) => void;
}>): Promise<string> {
    return Buffer
        .from(JSON.stringify(ReviewCommentPrincipalHeaderV1Schema.parse(await signedReviewCommentPrincipalHeader(params))), 'utf8')
        .toString('base64url');
}

function readServerErrorCode(data: unknown): string | undefined {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return undefined;
    }
    const record = data as JsonRecord;
    return typeof record.error === 'string'
        ? record.error
        : typeof record.code === 'string'
            ? record.code
            : undefined;
}

function readServerErrorMessage(data: unknown, status: number): string {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const message = (data as JsonRecord).message;
        if (typeof message === 'string' && message.trim().length > 0) {
            return message;
        }
    }
    return `review_comment_request_failed:${status}`;
}

function throwForReviewCommentHttpStatus(response: AxiosResponse<unknown>): never {
    const status = response.status;
    const errorCode = isAuthenticationStatus(status)
        ? 'not_authenticated'
        : readServerErrorCode(response.data) ?? 'review_comment_request_failed';
    throw createHttpStatusError(status, readServerErrorMessage(response.data, status), errorCode);
}

async function executeReviewCommentHttpRequest(params: Readonly<{
    credentials: StoredCredentials;
    request: ReviewCommentHttpRequest;
    principalHeader?: string;
    signal?: AbortSignal;
}>): Promise<unknown> {
    const url = `${resolveServerHttpBaseUrl()}${params.request.path}`;
    const config: AxiosRequestConfig = {
        headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            Authorization: `Bearer ${params.credentials.token}`,
            ...(params.principalHeader ? { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: params.principalHeader } : {}),
        },
        timeout: configuration.sessionControlHttpTimeoutMs,
        validateStatus: () => true,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.request.query ? { params: params.request.query } : {}),
    };
    const response = params.request.method === 'get'
        ? await axios.get(url, config)
        : params.request.method === 'patch'
            ? await axios.patch(url, params.request.body ?? {}, config)
            : await axios.post(url, params.request.body ?? {}, config);
    if (response.status < 200 || response.status >= 300) {
        throwForReviewCommentHttpStatus(response);
    }
    return response.data;
}

function readFailureCode(error: unknown): string {
    if (error && typeof error === 'object' && !Array.isArray(error)) {
        const code = (error as JsonRecord).code;
        if (typeof code === 'string' && code.trim().length > 0) {
            return code;
        }
    }
    return 'review_comment_request_failed';
}

function readFailureMessage(error: unknown): string {
    return error instanceof Error ? error.message : readFailureCode(error);
}

export function createCliReviewCommentActionExecutorFromCredentials(
    params: Readonly<{
        credentials: StoredCredentials;
        resolvePrincipalSigningContext?: () => Promise<ReviewCommentPrincipalSigningContext>;
        assertPrincipalCurrent?: (principal: ReviewCommentPrincipalHeaderV1) => void;
        resolveAccountId?: (token: string) => string;
        resolveAccountEncryptionMode?: () => Promise<ReviewCommentAccountEncryptionMode>;
        randomBytes?: (length: number) => Uint8Array;
    }>,
): ReviewCommentActionExecutor {
    const accountModeApi = params.resolveAccountEncryptionMode
        ? null
        : createConnectedServiceCredentialApi(params.credentials);
    return async (actionId, input, options) => {
        const parsedActionId = ReviewCommentActionIdV1Schema.parse(actionId);
        const parsedInput = asRecord(ReviewCommentActionInputSchemasV1[parsedActionId].parse(input));
        let requestInput = parsedInput;
        if (isReviewCommentMutationAction(parsedActionId)) {
            const accountId = (params.resolveAccountId ?? resolveAccountIdFromToken)(params.credentials.token);
            const mode = await (params.resolveAccountEncryptionMode
                ? params.resolveAccountEncryptionMode()
                : accountModeApi!.getAccountEncryptionMode());
            if (mode === 'unknown') {
                throw new Error('review_comment_encryption_mode_unavailable');
            }
            const actor = options?.principal?.actor ?? { kind: 'user' as const, userId: accountId };
            const material = resolveAccountScopedMaterial(params.credentials);
            if (mode === 'e2ee' && !material) {
                throw new Error('review_comment_encryption_material_unavailable');
            }
            const eventEnvelope = mode === 'plain'
                ? buildReviewCommentMutationEventEnvelopeV1({
                    accountId,
                    actor,
                    actionId: parsedActionId,
                    input: parsedInput,
                    mode: 'plain',
                })
                : buildReviewCommentMutationEventEnvelopeV1({
                    accountId,
                    actor,
                    actionId: parsedActionId,
                    input: parsedInput,
                    mode: 'e2ee',
                    material: material!,
                    randomBytes: params.randomBytes ?? ((length) => nodeRandomBytes(length)),
                });
            requestInput = { ...parsedInput, eventEnvelope };
        }
        const request = createReviewCommentHttpRequest(parsedActionId, requestInput);
        const principalHeader = options?.principal
            ? await encodeReviewCommentPrincipalHeader({
                principal: options.principal,
                request,
                ...(params.resolvePrincipalSigningContext
                    ? { resolvePrincipalSigningContext: params.resolvePrincipalSigningContext }
                    : {}),
                ...(params.assertPrincipalCurrent
                    ? { assertPrincipalCurrent: params.assertPrincipalCurrent }
                    : {}),
            })
            : undefined;
        if (options?.principal) {
            params.assertPrincipalCurrent?.(options.principal);
        }
        const output = await executeReviewCommentHttpRequest({
            credentials: params.credentials,
            request,
            ...(principalHeader ? { principalHeader } : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        return ReviewCommentActionOutputSchemasV1[parsedActionId].parse(output);
    };
}

export function createCliReviewCommentRpcActionExecutorFromCredentials(
    params: Readonly<{
        credentials: StoredCredentials;
        resolvePrincipalSigningContext?: () => Promise<ReviewCommentPrincipalSigningContext>;
        assertPrincipalCurrent?: (principal: ReviewCommentPrincipalHeaderV1) => void;
    }>,
): RpcActionExecutor {
    const executeReviewCommentAction = createCliReviewCommentActionExecutorFromCredentials(params);
    return {
        execute: async (actionId, input) => {
            const parsedActionId = ReviewCommentActionIdV1Schema.safeParse(actionId);
            if (!parsedActionId.success) {
                return {
                    ok: false,
                    errorCode: 'unsupported_action',
                    error: `unsupported_action:${actionId}`,
                };
            }
            try {
                return {
                    ok: true,
                    result: await executeReviewCommentAction(parsedActionId.data, input),
                };
            } catch (error) {
                return {
                    ok: false,
                    errorCode: readFailureCode(error),
                    error: readFailureMessage(error),
                };
            }
        },
    };
}
