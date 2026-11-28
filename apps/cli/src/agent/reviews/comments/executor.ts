import { readActiveMachineId } from '@/daemon/machineIdentity/machineRegistrationStore';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { createHash, randomBytes as nodeRandomBytes, randomUUID } from 'node:crypto';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import axios from '@/api/client/credentialAxios';
import { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import tweetnacl from 'tweetnacl';

import { createReviewCommentPrincipalSigningInputV1, REVIEW_COMMENT_PRINCIPAL_HEADER_V1, ReviewCommentActionIdV1Schema, ReviewCommentActionInputSchemasV1, ReviewCommentActionOutputSchemasV1, ReviewCommentPrincipalHeaderV1Schema, stringifyReviewCommentPrincipalCanonicalJsonV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { buildReviewCommentPlainMutationTransportInputV1, ReviewCommentMutationActionIdV1Schema, REVIEW_COMMENT_RESOURCE_COMMITMENT_DOMAIN_V1 } from '@happier-dev/protocol/reviews/comments/content';
import { executeReviewCommentTransportV1, executeReviewCommentCreateBatchTransportV1, type ReviewCommentCreateBatchTransportResultV1, type ReviewCommentCreateBatchItemV1, type ReviewCommentCreateBatchExecutorV1, type ReviewCommentTransportContextV1, type ReviewCommentTransportRequestV1 } from '@happier-dev/protocol/reviews/comments/transport';
import { buildReviewCommentPublicationTransportRequestV1, openReviewCommentPublicationTransportResponseV1 } from '@happier-dev/protocol/reviews/comments/publicationTransport';
import type { ReviewCommentPublicationCryptoContextV1, ReviewCommentClaimPublicationDispatchRequestV1, ReviewCommentPrincipalHeaderV1, ReviewCommentActionIdV1, ReviewCommentMutationActionIdV1, ReviewCommentPublicationPlanV1, ReviewCommentPrincipalProofV1, AccountScopedCryptoMaterial } from '@happier-dev/protocol';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';

import { createAuthenticationHttpStatusError, createHttpStatusError, isAuthenticationStatus, readServerRefusalCode } from '@/api/client/httpStatusError';
import { createConnectedServiceCredentialApi, type AccountEncryptionModeReadOptions } from '@/api/client/connectedServiceCredentialApi';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { type StoredCredentials } from '@/persistence';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { ReviewCommentResourceCryptoV1 } from '@happier-dev/protocol/reviews/comments/content';

export type ReviewCommentActionExecutionOptions = Readonly<{
    signal?: AbortSignal;
    principal?: ReviewCommentPrincipalHeaderV1;
}>;

type ReviewCommentAccountEncryptionMode = 'plain' | 'e2ee' | 'unknown';

export type ReviewCommentCreateBatchItem = ReviewCommentCreateBatchItemV1;
export type ReviewCommentActionExecutor = ((
    actionId: ReviewCommentActionIdV1,
    input: unknown,
    options?: ReviewCommentActionExecutionOptions,
) => Promise<unknown>) & {
    createBatch?: ReviewCommentCreateBatchExecutorV1;
};

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
    const accountId = readAccountIdFromToken(token);
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
): actionId is ReviewCommentMutationActionIdV1 {
    return ReviewCommentMutationActionIdV1Schema.safeParse(actionId).success;
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
    if (actionId === 'reviews.comments.claimPublicationDispatch') {
        return {
            method: 'post',
            path: '/v1/reviews/comments/publication/claim',
            body: input,
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

function assertReviewCommentLogicalIntent(input: JsonRecord, principal: ReviewCommentPrincipalHeaderV1 | undefined): void {
    if (principal?.currentIntent && principal.currentIntent.effectBodySha256Base64Url
        !== createReviewCommentPrincipalBodyHash(omitKeys(input, ['eventEnvelope']))) {
        throw createActionExecuteFailureError({ ok: false,
            errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' });
    }
}

export async function resolveCliReviewCommentPrincipalSigningContext(admittedMachineId?: string): Promise<ReviewCommentPrincipalSigningContext> {
    const [machineId, identity] = await Promise.all([
        admittedMachineId ?? readActiveMachineId(),
        readOrCreateInstallationIdentity(),
    ]);
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
    assertPrincipalCurrent?: (principal: ReviewCommentPrincipalHeaderV1) => void | Promise<void>;
}>): Promise<ReviewCommentPrincipalHeaderV1> {
    const signingContext = await (params.resolvePrincipalSigningContext ?? resolveCliReviewCommentPrincipalSigningContext)();
    await params.assertPrincipalCurrent?.(params.principal);
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
            ...(params.principal.workflowScope ? { workflowScope: params.principal.workflowScope } : {}),
            proof,
        }),
        privateKey,
    );
    return {
        actor: params.principal.actor,
        ...(params.principal.currentIntent ? { currentIntent: params.principal.currentIntent } : {}),
        ...(params.principal.workflowScope ? { workflowScope: params.principal.workflowScope } : {}),
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
    assertPrincipalCurrent?: (principal: ReviewCommentPrincipalHeaderV1) => void | Promise<void>;
}>): Promise<string> {
    return Buffer
        .from(JSON.stringify(ReviewCommentPrincipalHeaderV1Schema.parse(await signedReviewCommentPrincipalHeader(params))), 'utf8')
        .toString('base64url');
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
    const message = readServerErrorMessage(response.data, status);
    const error = isAuthenticationStatus(status)
        ? createAuthenticationHttpStatusError(status, message, response.data)
        : createHttpStatusError(status, message, readServerRefusalCode(response.data) ?? 'review_comment_request_failed');
    const payload = response.data && typeof response.data === 'object' && !Array.isArray(response.data)
        ? response.data as JsonRecord : {};
    const refusal = readActionFailureEnvelope(response.data) ?? readActionFailureEnvelope({
        ...payload, ok: false, errorCode: error.code!, error: payload.error ?? error.message,
    })!;
    throw Object.assign(error, {
        cause: createActionExecuteFailureError(refusal),
    });
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

export function createCliReviewCommentActionExecutorFromCredentials(
    params: Readonly<{
        credentials: StoredCredentials;
        resolvePrincipalSigningContext?: () => Promise<ReviewCommentPrincipalSigningContext>;
        assertPrincipalCurrent?: (principal: ReviewCommentPrincipalHeaderV1) => void | Promise<void>;
        resolveAccountId?: (token: string) => string;
        resolveAccountEncryptionMode?: (options?: AccountEncryptionModeReadOptions) => Promise<ReviewCommentAccountEncryptionMode>;
        randomBytes?: (length: number) => Uint8Array;
    }>,
): ReviewCommentActionExecutor {
    const accountModeApi = params.resolveAccountEncryptionMode
        ? null
        : createConnectedServiceCredentialApi(params.credentials);
    const readMode = async (options: AccountEncryptionModeReadOptions) => await (params.resolveAccountEncryptionMode
        ? params.resolveAccountEncryptionMode(options) : accountModeApi!.getAccountEncryptionMode(options));
    const assertWriteMode = async (expected: 'plain' | 'e2ee', signal?: AbortSignal) => {
        const mode = await readMode({ usage: 'fresh-authority', ...(signal ? { signal } : {}) });
        const code = mode === 'unknown' ? 'review_comment_encryption_mode_unavailable'
            : mode !== expected ? 'review_comment_encryption_mode_mismatch' : null;
        if (code) throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code });
    };
    const readResource = async (reviewId: string, options?: ReviewCommentActionExecutionOptions): Promise<ReviewCommentResourceCryptoV1> => {
        const held = await createCredentialedAccountArtifactStore(params.credentials).readForUpdate(reviewId,
            { prepareRecipients: false, includeSharedAudience: false,
                ...(options?.signal ? { signal: options.signal } : {}) });
        if (!held) throw createActionExecuteFailureError({ ok: false,
            errorCode: 'review_comment_encryption_material_unavailable', error: 'review_comment_encryption_material_unavailable',
        });
        const binding = { artifactId: reviewId, expectedRevision: held.artifact.revision };
        return { reviewId, mode: held.storageMode,
            open: async content => held.openAssociatedContent({ ...binding, content }),
            seal: async value => held.sealAssociatedContent({ ...binding, value }),
            commitment: (purpose, canonicalInput) => held.associatedContentCommitment(
                REVIEW_COMMENT_RESOURCE_COMMITMENT_DOMAIN_V1, [purpose, canonicalInput]),
        };
    };
    const execute: ReviewCommentActionExecutor = async (actionId, input, options) => {
        const parsedActionId = ReviewCommentActionIdV1Schema.parse(actionId);
        const parsedInput = asRecord(ReviewCommentActionInputSchemasV1[parsedActionId].parse(input));
        if (parsedActionId === 'reviews.comments.get' || parsedActionId === 'reviews.comments.list'
            || isReviewCommentMutationAction(parsedActionId)) {
            const originalPrincipal = options?.principal;
            const assertLogicalIntent = (context: Pick<ReviewCommentTransportContextV1, 'resource' | 'mode'>) => {
                if (context.resource || context.mode === 'e2ee') assertReviewCommentLogicalIntent(parsedInput, originalPrincipal);
            };
            const requestTransport = async (request: ReviewCommentTransportRequestV1, writeMode?: 'plain' | 'e2ee') => {
                const principal = originalPrincipal?.currentIntent && request.contentCommitment
                    ? { ...originalPrincipal, currentIntent: { ...originalPrincipal.currentIntent,
                        effectBodySha256Base64Url: request.contentCommitment } }
                    : originalPrincipal;
                const principalHeader = principal ? await encodeReviewCommentPrincipalHeader({
                    principal, request,
                    ...(params.resolvePrincipalSigningContext ? { resolvePrincipalSigningContext: params.resolvePrincipalSigningContext } : {}),
                    assertPrincipalCurrent: async () => { if (originalPrincipal) await params.assertPrincipalCurrent?.(originalPrincipal); },
                }) : undefined;
                if (writeMode) await assertWriteMode(writeMode, options?.signal);
                return executeReviewCommentHttpRequest({ credentials: params.credentials, request,
                    ...(principalHeader ? { principalHeader } : {}), ...(options?.signal ? { signal: options.signal } : {}) });
            };
            const reviewId = typeof parsedInput.reviewId === 'string' ? parsedInput.reviewId : undefined;
            if ((parsedActionId === 'reviews.comments.get' || parsedActionId === 'reviews.comments.list') && !reviewId) {
                const contexts = new Map<string | undefined, Promise<ReviewCommentTransportContextV1>>();
                return executeReviewCommentTransportV1({ actionId: parsedActionId, input: parsedInput,
                    randomBytes: params.randomBytes ?? ((length) => nodeRandomBytes(length)), request: requestTransport,
                    resolveContext: async boundReviewId => {
                        const existing = contexts.get(boundReviewId);
                        if (existing) return existing;
                        const pending = (async () => {
                            const resource = boundReviewId ? await readResource(boundReviewId, options) : undefined;
                            const mode = resource?.mode ?? await readMode({ usage: 'identity', ...(options?.signal ? { signal: options.signal } : {}) });
                            if (mode === 'unknown') throw createActionExecuteFailureError({ ok: false,
                                errorCode: 'review_comment_encryption_mode_unavailable', error: 'review_comment_encryption_mode_unavailable' });
                            const accountId = (params.resolveAccountId ?? resolveAccountIdFromToken)(params.credentials.token);
                            const context = resource ? { accountId, mode, material: null, resource }
                                : { accountId, mode, material: mode === 'plain' ? null : resolveAccountScopedMaterial(params.credentials) };
                            assertLogicalIntent(context);
                            return context;
                        })();
                        contexts.set(boundReviewId, pending);
                        return pending;
                    },
                });
            }
            const resource = reviewId ? await readResource(reviewId, options) : undefined;
            const mode = resource?.mode ?? await readMode({ usage: 'identity', ...(options?.signal ? { signal: options.signal } : {}) });
            if (mode === 'unknown') throw createActionExecuteFailureError({ ok: false,
                errorCode: 'review_comment_encryption_mode_unavailable', error: 'review_comment_encryption_mode_unavailable' });
            if (resource || mode === 'e2ee' || parsedActionId === 'reviews.comments.get' || parsedActionId === 'reviews.comments.list') {
                const accountId = (params.resolveAccountId ?? resolveAccountIdFromToken)(params.credentials.token);
                assertLogicalIntent({ resource, mode });
                return executeReviewCommentTransportV1({
                    actionId: parsedActionId, input: parsedInput,
                    context: resource ? { accountId, mode, material: null, resource }
                        : { accountId, mode, material: mode === 'plain' ? null : resolveAccountScopedMaterial(params.credentials) },
                    actor: originalPrincipal?.actor ?? { kind: 'user', userId: accountId },
                    randomBytes: params.randomBytes ?? ((length) => nodeRandomBytes(length)),
                    request: request => requestTransport(request,
                        !resource && request.path === '/v1/reviews/comments/mutations/commit' ? mode : undefined),
                });
            }
        }
        let requestInput = parsedInput;
        let publicationContext: ReviewCommentPublicationCryptoContextV1 | null = null;
        if (parsedActionId === 'reviews.comments.claimPublicationDispatch') {
            const mode = await readMode({ usage: 'identity', ...(options?.signal ? { signal: options.signal } : {}) });
            if (mode === 'unknown') throw createActionExecuteFailureError({ ok: false,
                errorCode: 'review_comment_encryption_mode_unavailable', error: 'review_comment_encryption_mode_unavailable' });
            publicationContext = {
                accountId: (params.resolveAccountId ?? resolveAccountIdFromToken)(params.credentials.token),
                mode, material: mode === 'plain' ? null : resolveAccountScopedMaterial(params.credentials),
            };
            requestInput = asRecord(buildReviewCommentPublicationTransportRequestV1({
                input: parsedInput as ReviewCommentClaimPublicationDispatchRequestV1,
                context: publicationContext,
                randomBytes: params.randomBytes ?? ((length) => nodeRandomBytes(length)),
            }));
        }
        if (isReviewCommentMutationAction(parsedActionId)) {
            const accountId = (params.resolveAccountId ?? resolveAccountIdFromToken)(params.credentials.token);
            const actor = options?.principal?.actor ?? { kind: 'user' as const, userId: accountId };
            requestInput = buildReviewCommentPlainMutationTransportInputV1({
                accountId,
                actor,
                actionId: parsedActionId,
                input: parsedInput,
                mode: 'plain',
            });
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
        if (publicationContext || isReviewCommentMutationAction(parsedActionId)) {
            await assertWriteMode(publicationContext?.mode ?? 'plain', options?.signal);
        }
        const output = await executeReviewCommentHttpRequest({
            credentials: params.credentials,
            request,
            ...(principalHeader ? { principalHeader } : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (publicationContext) return openReviewCommentPublicationTransportResponseV1({
            plan: parsedInput as ReviewCommentPublicationPlanV1, context: publicationContext, response: output,
        });
        return ReviewCommentActionOutputSchemasV1[parsedActionId].parse(output);
    };
    execute.createBatch = async (items, options) => {
        if (!items.length) return [];
        let signingContext: Promise<ReviewCommentPrincipalSigningContext> | undefined;
        const resolvePrincipalSigningContext = () => signingContext ??= (
            params.resolvePrincipalSigningContext ?? resolveCliReviewCommentPrincipalSigningContext)();
        const accountId = (params.resolveAccountId ?? resolveAccountIdFromToken)(params.credentials.token);
        const contexts = new Map<string | undefined, Promise<ReviewCommentTransportContextV1>>();
        const results: ReviewCommentCreateBatchTransportResultV1[] = [];
        const resolved: Array<{ index: number; input: JsonRecord; context: ReviewCommentTransportContextV1; actor: ReviewCommentPrincipalHeaderV1['actor'] }> = [];
        for (const [index, item] of items.entries()) {
            try {
                // Verify the logical intent before its keyed commitment replaces the body hash.
                assertReviewCommentLogicalIntent(asRecord(item.input), item.principal);
                const reviewId = item.input.reviewId;
                let context = contexts.get(reviewId);
                if (!context) {
                    context = (async () => {
                        const resource = reviewId ? await readResource(reviewId, options) : undefined;
                        const mode = resource?.mode ?? await readMode({ usage: 'identity', ...(options?.signal ? { signal: options.signal } : {}) });
                        if (mode === 'unknown') throw Object.assign(new Error('review_comment_encryption_mode_unavailable'),
                            { code: 'review_comment_encryption_mode_unavailable' });
                        return { accountId, mode, material: resource || mode === 'plain' ? null : resolveAccountScopedMaterial(params.credentials),
                            ...(resource ? { resource } : {}) };
                    })();
                    contexts.set(reviewId, context);
                }
                resolved.push({ index, input: asRecord(item.input), context: await context,
                    actor: item.principal?.actor ?? { kind: 'user' as const, userId: accountId } });
            } catch (error) { results[index] = { ok: false, ...normalizeActionExecutorThrownError(error) }; }
        }
        const batchResults = await executeReviewCommentCreateBatchTransportV1({ items: resolved,
            randomBytes: params.randomBytes ?? (length => nodeRandomBytes(length)),
            request: async batch => {
                const currentness = new Map<string, Promise<void>>();
                const assertPrincipalCurrent = async (principal: ReviewCommentPrincipalHeaderV1) => {
                    const intent = principal.currentIntent;
                    if (!intent || intent.kind !== 'execution_run_host_action') {
                        await params.assertPrincipalCurrent?.(principal);
                        return;
                    }
                    const key = stringifyReviewCommentPrincipalCanonicalJsonV1([intent.pluginId, intent.sourceCustody]);
                    let pending = currentness.get(key);
                    if (!pending) {
                        pending = Promise.resolve().then(() => params.assertPrincipalCurrent?.(principal));
                        currentness.set(key, pending);
                    }
                    await pending;
                };
                const signed = await Promise.all(batch.items.map(async request => {
                    try {
                        const principal = items[resolved[request.itemIndex]!.index]!.principal;
                        const rebound = principal?.currentIntent && request.contentCommitment
                            ? { ...principal, currentIntent: { ...principal.currentIntent, effectBodySha256Base64Url: request.contentCommitment } } : principal;
                        const principalHeader = rebound ? await encodeReviewCommentPrincipalHeader({ principal: rebound, request,
                            resolvePrincipalSigningContext,
                            assertPrincipalCurrent: async () => { if (principal) await assertPrincipalCurrent(principal); },
                        }) : undefined;
                        return { ok: true as const, value: { input: request.body, ...(principalHeader ? { principalHeader } : {}) } };
                    } catch (error) {
                        return { ok: false as const, ...normalizeActionExecutorThrownError(error) };
                    }
                }));
                const batchItems = signed.flatMap(result => result.ok ? [result.value] : []);
                if (!batchItems.length) return { items: signed };
                if (batch.path.endsWith('/commitBatch') && resolved.some(item => !item.context.resource)) {
                    const mode = resolved.find(item => !item.context.resource)!.context.mode;
                    await assertWriteMode(mode, options?.signal);
                }
                const response = await executeReviewCommentHttpRequest({ credentials: params.credentials,
                    request: { method: 'post', path: batch.path, body: { items: batchItems } },
                    ...(options?.signal ? { signal: options.signal } : {}) });
                if (signed.every(result => result.ok)) return response;
                const responseItems = asRecord(response).items;
                if (!Array.isArray(responseItems) || responseItems.length !== batchItems.length) {
                    throw createActionExecuteFailureError({ ok: false, errorCode: 'review_comment_content_binding_mismatch',
                        error: 'Review comment batch response does not match its signed requests' });
                }
                let responseIndex = 0;
                return { items: signed.map(result => result.ok ? responseItems[responseIndex++] : result) };
            },
        });
        batchResults.forEach((result, index) => { results[resolved[index]!.index] = result; });
        return results;
    };
    return execute;
}

export function createCliReviewCommentRpcActionExecutorFromCredentials(
    params: Readonly<{
        credentials: StoredCredentials;
        resolvePrincipalSigningContext?: () => Promise<ReviewCommentPrincipalSigningContext>;
        assertPrincipalCurrent?: (principal: ReviewCommentPrincipalHeaderV1) => void | Promise<void>;
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
                    ...normalizeActionExecutorThrownError(error),
                };
            }
        },
    };
}
