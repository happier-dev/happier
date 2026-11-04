import { z } from 'zod/mini';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import {
    RunnerActivationCreateRequestV1Schema,
    type RunnerActivationCreateRequestV1,
    RunnerEndpointFactsRecipientV1Schema,
    type RunnerEndpointFactsRecipientV1,
} from '@happier-dev/protocol/ephemeralRunner/activation';
import {
    RunnerActivationProjectionV1Schema,
    type RunnerActivationProjectionV1,
} from '@happier-dev/protocol/ephemeralRunner/projection';
import {
    RunnerArtifactAvailabilityProjectionV1Schema,
    type RunnerArtifactAvailabilityProjectionV1,
} from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import {
    EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1,
    EPHEMERAL_RUNNER_ACTIVATIONS_PATH_V1,
    EPHEMERAL_RUNNER_CREATOR_RECIPIENT_PATH_V1,
    ephemeralRunnerActivationPathV1,
    ephemeralRunnerActivationReviewPathV1,
    ephemeralRunnerCredentialSelectionPathV1,
    ephemeralRunnerMaterializationPathV1,
} from '@happier-dev/protocol/ephemeralRunner/routes';
import {
    RunnerActivationReviewV1Schema,
    type RunnerActivationReviewV1,
} from '@happier-dev/protocol/ephemeralRunner/review';
import {
    RunnerMaterializationRequestV1Schema,
    RunnerMaterializationResponseV1Schema,
    type RunnerMaterializationRequestV1,
    type RunnerMaterializationResponseV1,
} from '@happier-dev/protocol/ephemeralRunner/materialization';
import {
    RunnerCredentialSelectionResolutionRequestV1Schema,
    RunnerCredentialSelectionResolutionResponseV1Schema,
    type RunnerCredentialSelectionResolutionRequestV1,
    type RunnerCredentialSelectionResolutionResponseV1,
} from '@happier-dev/protocol/teams';

import {
    RunnerServerErrorV1Schema,
    type RunnerServerErrorCodeV1,
    type RunnerArtifactPublicationFailureV1,
} from '@happier-dev/protocol/ephemeralRunner/errors';

import type { ServerFetch } from '@/sync/http/client';

const RunnerActivationCreateResponseV1Schema = z.strictObject({
    status: z.literal('created'),
    activation: RunnerActivationProjectionV1Schema,
});
const RunnerActivationReviewResponseV1Schema = z.strictObject({
    status: z.literal('stored'),
    review: RunnerActivationReviewV1Schema,
});

export type RunnerActivationClientErrorCode =
    | 'malformed_request'
    | 'unauthorized'
    | 'not_found'
    | 'conflict'
    | 'unavailable'
    | 'malformed_response'
    | 'request_failed';

export class RunnerActivationClientError extends Error {
    readonly code: RunnerActivationClientErrorCode;
    readonly status: number;
    readonly retryable: boolean;
    /**
     * The Home's own reason when it sent one from the canonical Runner error
     * vocabulary. Transport classes alone cannot distinguish "this package's
     * platform is no longer published" from "the Home is briefly unreachable".
     */
    readonly serverCode: RunnerServerErrorCodeV1 | null;
    readonly publicationFailure: RunnerArtifactPublicationFailureV1 | null;

    constructor(
        code: RunnerActivationClientErrorCode,
        status: number,
        retryable: boolean,
        serverCode: RunnerServerErrorCodeV1 | null = null,
        publicationFailure: RunnerArtifactPublicationFailureV1 | null = null,
    ) {
        super(serverCode ?? `runner_activation_${code}`);
        this.name = 'RunnerActivationClientError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.serverCode = serverCode;
        this.publicationFailure = publicationFailure;
    }
}

function classifyFailureStatus(status: number): Readonly<{ code: RunnerActivationClientErrorCode; retryable: boolean }> {
    if (status === 401 || status === 403) return { code: 'unauthorized', retryable: false };
    if (status === 404) return { code: 'not_found', retryable: false };
    if (status === 409) return { code: 'conflict', retryable: false };
    if (status === 429 || status >= 500) return { code: 'unavailable', retryable: true };
    return { code: 'request_failed', retryable: false };
}

type ResponseSchema<T> = Readonly<{
    safeParse(value: unknown): { success: true; data: T } | { success: false };
}>;

async function parseResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const { code, retryable } = classifyFailureStatus(response.status);
        const failure = RunnerServerErrorV1Schema.safeParse(payload);
        throw new RunnerActivationClientError(code, response.status, retryable,
            failure.success ? failure.data.error : null,
            failure.success ? failure.data.publicationFailure ?? null : null);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new RunnerActivationClientError('malformed_response', 502, true);
    return parsed.data;
}

async function requestAndParse<T>(
    request: ServerFetch,
    path: string,
    schema: ResponseSchema<T>,
    init?: RequestInit,
): Promise<T> {
    try {
        const response = await request(path, init, { includeAuth: true, retry: 'none' });
        return await parseResponse(response, schema);
    } catch (error) {
        if (error instanceof RunnerActivationClientError) throw error;
        // A caller-canceled safe read is cancellation, not a retryable transport
        // failure. Preserve the exact abort reason so the launch owner keeps its
        // truthful canceling state instead of reporting a failed attempt.
        if (init?.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) throw error;
        throw new RunnerActivationClientError('request_failed', 0, true);
    }
}

/** Safe reads are cancellation-aware; mutations deliberately are not. */
function safeReadInit(signal: AbortSignal | undefined): RequestInit | undefined {
    return signal ? { signal } : undefined;
}

export type RunnerActivationClient = Readonly<{
    listArtifacts: (signal?: AbortSignal, version?: string) => Promise<RunnerArtifactAvailabilityProjectionV1>;
    readCreatorRecipient: (signal?: AbortSignal) => Promise<RunnerEndpointFactsRecipientV1>;
    /**
     * Activation creation is deliberately non-abortable: a canceled request has
     * an unknowable server outcome, while a completed activation can always be
     * closed canonically through {@link RunnerActivationClient.cancel}.
     */
    create: (input: RunnerActivationCreateRequestV1) => Promise<RunnerActivationProjectionV1>;
    read: (activationId: string, signal?: AbortSignal) => Promise<RunnerActivationProjectionV1>;
    readByDraft: (draftId: string, signal?: AbortSignal) => Promise<RunnerActivationProjectionV1>;
    cancel: (activationId: string) => Promise<RunnerActivationProjectionV1>;
    storeReview: (activationId: string, review: RunnerActivationReviewV1) => Promise<RunnerActivationReviewV1>;
    resolveCredentialSelection: (
        activationId: string,
        request: RunnerCredentialSelectionResolutionRequestV1,
        signal?: AbortSignal,
    ) => Promise<RunnerCredentialSelectionResolutionResponseV1>;
    materialize: (request: RunnerMaterializationRequestV1) => Promise<RunnerMaterializationResponseV1>;
}>;

/**
 * Transport-only adapter for one already captured exact Home. Domain decisions,
 * authoring commitment and key custody remain with their canonical owners.
 */
export function createRunnerActivationClient(request: ServerFetch): RunnerActivationClient {
    return {
        listArtifacts: (signal, version) => requestAndParse(
            request,
            version === undefined
                ? EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1
                : `${EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1}?version=${encodeURIComponent(version)}`,
            RunnerArtifactAvailabilityProjectionV1Schema,
            safeReadInit(signal),
        ),
        readCreatorRecipient: (signal) => requestAndParse(
            request,
            EPHEMERAL_RUNNER_CREATOR_RECIPIENT_PATH_V1,
            RunnerEndpointFactsRecipientV1Schema,
            safeReadInit(signal),
        ),
        create: async (rawInput) => {
            const parsed = RunnerActivationCreateRequestV1Schema.safeParse(rawInput);
            if (!parsed.success) throw new RunnerActivationClientError('malformed_request', 400, false);
            const response = await requestAndParse(
                request,
                EPHEMERAL_RUNNER_ACTIVATIONS_PATH_V1,
                RunnerActivationCreateResponseV1Schema,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(parsed.data),
                },
            );
            const {
                v: _version,
                authorizeUnattendedTeamAccess: _authorizeUnattendedTeamAccess,
                ...expected
            } = parsed.data;
            const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, response.activation[key as keyof RunnerActivationProjectionV1]]));
            if (createCanonicalJsonSigningInput(actual) !== createCanonicalJsonSigningInput(expected)
                || response.activation.creatorAccountId !== expected.endpointFactsRecipient.creatorAccountId) {
                throw new RunnerActivationClientError('malformed_response', 502, true);
            }
            return response.activation;
        },
        read: async (activationId, signal) => {
            const activation = await requestAndParse(
                request,
                ephemeralRunnerActivationPathV1(activationId),
                RunnerActivationProjectionV1Schema,
                safeReadInit(signal),
            );
            if (activation.activationId !== activationId) {
                throw new RunnerActivationClientError('malformed_response', 502, true);
            }
            return activation;
        },
        readByDraft: async (draftId, signal) => {
            const activation = await requestAndParse(
                request,
                `${EPHEMERAL_RUNNER_ACTIVATIONS_PATH_V1}?draftId=${encodeURIComponent(draftId)}`,
                RunnerActivationProjectionV1Schema,
                safeReadInit(signal),
            );
            if (activation.draftId !== draftId) {
                throw new RunnerActivationClientError('malformed_response', 502, true);
            }
            return activation;
        },
        cancel: (activationId) => requestAndParse(
            request,
            ephemeralRunnerActivationPathV1(activationId),
            RunnerActivationProjectionV1Schema,
            { method: 'DELETE' },
        ),
        storeReview: async (activationId, rawReview) => {
            const review = RunnerActivationReviewV1Schema.safeParse(rawReview);
            if (!review.success) throw new RunnerActivationClientError('malformed_request', 400, false);
            const response = await requestAndParse(
                request,
                ephemeralRunnerActivationReviewPathV1(activationId),
                RunnerActivationReviewResponseV1Schema,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(review.data),
                },
            );
            return response.review;
        },
        resolveCredentialSelection: async (activationId, rawInput, signal) => {
            const input = RunnerCredentialSelectionResolutionRequestV1Schema.safeParse(rawInput);
            if (!input.success) throw new RunnerActivationClientError('malformed_request', 400, false);
            return requestAndParse(
                request,
                ephemeralRunnerCredentialSelectionPathV1(activationId),
                RunnerCredentialSelectionResolutionResponseV1Schema,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(input.data),
                    ...(signal ? { signal } : {}),
                },
            );
        },
        materialize: async (rawMaterialization) => {
            const materialization = RunnerMaterializationRequestV1Schema.safeParse(rawMaterialization);
            if (!materialization.success) throw new RunnerActivationClientError('malformed_request', 400, false);
            return await requestAndParse(
                request,
                ephemeralRunnerMaterializationPathV1(materialization.data.activationId),
                RunnerMaterializationResponseV1Schema,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(materialization.data),
                },
            );
        },
    };
}
