import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { backoff } from '@/utils/timing/time';
import { Artifact, ArtifactCreateRequest, ArtifactUpdateRequest, ArtifactUpdateResponse } from '@/sync/domains/artifacts/artifactTypes';
import { HappyError } from '@/utils/errors/errors';
import { serverFetch, type ServerFetch } from '@/sync/http/client';
import { encodeBase64 } from '@/encryption/base64';
import { ARTIFACT_UPLOAD_CONTENT_TYPE_V1, ARTIFACT_UPLOAD_PATH_V1, encodeArtifactUploadFrameV1,
    type ArtifactUploadDestinationV1 } from '@happier-dev/transfers';
import {
    ArtifactAccessErrorCodeV1Schema,
    ArtifactAccessGrantsListResponseV1Schema,
    ArtifactAccessGrantMutationResponseV1Schema,
    ArtifactAccessRecipientCensusResponseV1Schema,
    isPlainArtifactDataKeyMarker,
    ArtifactRecipientKeyEnvelopeCommitResponseV1Schema,
    ArtifactRevisionListResponseV1Schema,
    ArtifactQuotaExceededV1Schema,
    ArtifactRevisionV1Schema,
    ArtifactStorageUsageV1Schema,
    ArtifactBlobReadResponseV1Schema,
    ArtifactHtmlPreviewResponseV1Schema,
    ArtifactBlobAccountEncryptionStageV1Schema,
    type ArtifactBlobStoredContentV1,
    type ArtifactBlobAccountEncryptionStageV1,
    type ArtifactRevisionV1,
    type ArtifactAccessGrantsListInputV1,
    type ArtifactAccessGrantSetInputV1,
    type ArtifactAccessGrantRemoveInputV1,
    type ArtifactRecipientKeyEnvelopeCommitInputV1,
} from '@happier-dev/protocol';

/** The /v1/artifacts transport cursor; shared by complete sync and Action paging. */
export function encodeArtifactListCursor(row: Readonly<{ artifactId: string; updatedAt: number }>): string {
    return encodeBase64(new TextEncoder().encode(JSON.stringify({ updatedAt: row.updatedAt, id: row.artifactId })), 'base64url');
}

async function uploadArtifactContent(credentials: AuthCredentials, destination: ArtifactUploadDestinationV1,
    content: ArtifactBlobStoredContentV1, opts: Pick<ArtifactApiOptions, 'request' | 'signal'>): Promise<Response> {
    opts.signal?.throwIfAborted();
    const frame = encodeArtifactUploadFrameV1(destination, content);
    return (opts.request ?? serverFetch)(ARTIFACT_UPLOAD_PATH_V1, {
        method: 'POST', body: frame.buffer,
        headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': ARTIFACT_UPLOAD_CONTENT_TYPE_V1 },
        ...(opts.signal ? { signal: opts.signal } : {}),
    }, { includeAuth: false, retry: 'none' });
}

export async function stageArtifactBlobAccountEncryptionConversion(credentials: AuthCredentials,
    artifactId: string, blobId: string, content: ArtifactBlobStoredContentV1,
    opts: Pick<ArtifactApiOptions, 'request' | 'signal'> = {}): Promise<ArtifactBlobAccountEncryptionStageV1> {
    const response = await uploadArtifactContent(credentials, { kind: 'encryption-conversion', artifactId, blobId }, content, opts);
    if (!response.ok) throw await readWriteRefusal(response, 'Artifact conversion upload failed');
    const stage = ArtifactBlobAccountEncryptionStageV1Schema.safeParse(await response.json());
    if (!stage.success) throw new HappyError('Artifact conversion upload is unavailable', false, { code: 'artifact_content_unavailable' });
    return stage.data;
}

export async function cancelArtifactBlobAccountEncryptionConversion(credentials: AuthCredentials, uploadId: string,
    opts: Pick<ArtifactApiOptions, 'request'> = {}): Promise<void> {
    const response = await (opts.request ?? serverFetch)(`/v1/artifacts/content/uploads/${encodeURIComponent(uploadId)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${credentials.token}` },
    }, { includeAuth: false, retry: 'none' });
    if (!response.ok) throw await readWriteRefusal(response, 'Artifact conversion cancellation failed');
}

/** A write the server refused for an operator storage budget (`quota_exceeded`), naming the budget and its sizes. */
export class ArtifactQuotaExceededError extends HappyError {
    readonly quota: Readonly<{ budget: 'document' | 'account'; limitBytes: number; usedBytes: number }>;
    constructor(quota: ArtifactQuotaExceededError['quota']) {
        super('quota_exceeded', false, { status: 413, code: 'quota_exceeded' });
        // HappyError installs its own prototype; retain this typed quota boundary.
        Object.setPrototypeOf(this, new.target.prototype);
        this.quota = quota;
    }
}

/** The 4xx refusal of a create or update: a typed budget refusal, else the server's message. */
async function readWriteRefusal(response: Response, fallback: string): Promise<HappyError> {
    const value: unknown = await response.json().catch(() => null);
    const quota = response.status === 413 ? ArtifactQuotaExceededV1Schema.safeParse(value) : null;
    if (quota?.success) return new ArtifactQuotaExceededError({ budget: quota.data.budget, limitBytes: quota.data.limitBytes, usedBytes: quota.data.usedBytes });
    const message = value && typeof value === 'object' && typeof Reflect.get(value, 'error') === 'string' ? String(Reflect.get(value, 'error')) : fallback;
    return new HappyError(message, false, { status: response.status });
}

const artifactAuthorityProjectionSchema = ArtifactAccessRecipientCensusResponseV1Schema.pick({
    ownerAccountId: true, access: true, encryptionMode: true,
});

function readArtifactResponse(value: unknown): Artifact {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new HappyError('Artifact content is unavailable', false, { code: 'artifact_content_unavailable' });
    }
    const projection = artifactAuthorityProjectionSchema.safeParse({
        ownerAccountId: Reflect.get(value, 'ownerAccountId'),
        access: Reflect.get(value, 'access'),
        encryptionMode: Reflect.get(value, 'encryptionMode'),
    });
    if (!projection.success) {
        throw new HappyError('Artifact content is unavailable', false, { code: 'artifact_content_unavailable' });
    }
    if ((projection.data.encryptionMode === 'plain') !== isPlainArtifactDataKeyMarker(Reflect.get(value, 'dataEncryptionKey'))) {
        throw new HappyError('Artifact content does not match its owner Account mode', false, { code: 'artifact_account_mode_mismatch' });
    }
    return { ...value as Artifact, ...projection.data };
}

export type ArtifactApiOptions = Readonly<{
    includeBody?: boolean;
    retry?: 'default' | 'none';
    request?: ServerFetch;
    limit?: number;
    cursor?: string;
    signal?: AbortSignal;
    /** Inventory selection only; the server remains the access authority. */
    ownerAccountId?: string;
}>;

/** The Home supplies only the isolated shell location, never opened HTML or a public grant. */
export async function fetchArtifactHtmlPreviewLocation(credentials: AuthCredentials, artifactId: string,
    opts: Pick<ArtifactApiOptions, 'request' | 'signal'> = {}): Promise<string> {
    opts.signal?.throwIfAborted();
    const response = await (opts.request ?? serverFetch)(`/v1/artifacts/${encodeURIComponent(artifactId)}/html-preview`, {
        headers: { Authorization: `Bearer ${credentials.token}` }, ...(opts.signal ? { signal: opts.signal } : {}),
    }, { includeAuth: false, retry: 'none' });
    opts.signal?.throwIfAborted();
    if (!response.ok) throw new HappyError('HTML preview is unavailable', false,
        { status: response.status, code: 'artifact_html_preview_unavailable' });
    const parsed = ArtifactHtmlPreviewResponseV1Schema.safeParse(await response.json());
    opts.signal?.throwIfAborted();
    if (!parsed.success || new URL(parsed.data.url).pathname !== `/a/${encodeURIComponent(artifactId)}`)
        throw new HappyError('HTML preview is unavailable', false, { code: 'artifact_html_preview_unavailable' });
    return parsed.data.url;
}

/** Authenticated bytes only: verify the requested identity and owner mode before opening. */
export async function fetchArtifactBlob(credentials: AuthCredentials, artifactId: string, blobId: string,
    ownerMode: 'plain' | 'e2ee', opts: Pick<ArtifactApiOptions, 'request' | 'signal'> = {}) {
    opts.signal?.throwIfAborted();
    const response = await (opts.request ?? serverFetch)(`/v1/artifacts/${encodeURIComponent(artifactId)}/blobs/${encodeURIComponent(blobId)}`, {
        headers: { Authorization: `Bearer ${credentials.token}` }, ...(opts.signal ? { signal: opts.signal } : {}),
    }, { includeAuth: false, retry: 'none' });
    opts.signal?.throwIfAborted();
    if (!response.ok) throw new HappyError('Artifact file is unavailable', false,
        { status: response.status, code: 'artifact_content_unavailable' });
    const parsed = ArtifactBlobReadResponseV1Schema.safeParse(await response.json());
    opts.signal?.throwIfAborted();
    if (!parsed.success || parsed.data.blobId !== blobId) throw new HappyError('Artifact file is unavailable', false,
        { code: 'artifact_content_unavailable' });
    if ((ownerMode === 'plain') !== (parsed.data.content.t === 'plain')) throw new HappyError('Artifact file does not match its owner Account mode', false,
        { code: 'artifact_account_mode_mismatch' });
    return parsed.data;
}

/** Read the complete retained-body inventory through the captured Account transport. */
export async function fetchArtifactRevisions(
    credentials: AuthCredentials,
    artifactId: string,
    opts: Pick<ArtifactApiOptions, 'request' | 'signal'> = {},
) {
    opts.signal?.throwIfAborted();
    const response = await (opts.request ?? serverFetch)(`/v1/artifacts/${encodeURIComponent(artifactId)}/revisions`, {
        headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
        ...(opts.signal ? { signal: opts.signal } : {}),
    }, { includeAuth: false, retry: 'none' });
    opts.signal?.throwIfAborted();
    if (!response.ok) {
        throw new HappyError('Artifact revisions are unavailable', false, { status: response.status, code: 'artifact_content_unavailable' });
    }
    const parsed = ArtifactRevisionListResponseV1Schema.safeParse(await response.json());
    opts.signal?.throwIfAborted();
    if (!parsed.success) throw new HappyError('Artifact revision inventory is incomplete', false, { code: 'artifact_content_unavailable' });
    return parsed.data;
}

export async function fetchArtifactStorageUsage(credentials: AuthCredentials,
    opts: Pick<ArtifactApiOptions, 'request' | 'signal'> = {}) {
    opts.signal?.throwIfAborted();
    const response = await (opts.request ?? serverFetch)('/v1/artifacts/storage/usage', {
        headers: { Authorization: `Bearer ${credentials.token}` },
        ...(opts.signal ? { signal: opts.signal } : {}),
    }, { includeAuth: false, retry: 'none' });
    opts.signal?.throwIfAborted();
    if (!response.ok) throw new HappyError('Artifact storage usage is unavailable', false,
        { status: response.status, code: 'content_unavailable' });
    const parsed = ArtifactStorageUsageV1Schema.safeParse(await response.json());
    opts.signal?.throwIfAborted();
    if (!parsed.success) throw new HappyError('Artifact storage usage is unavailable', false, { code: 'content_unavailable' });
    return parsed.data;
}

/** The key holder may reseal the selected body with new restore attribution; its content stays unchanged. */
export async function restoreArtifactRevision(credentials: AuthCredentials, input: Readonly<{
    artifactId: string; bodyVersion: number; header: string; body?: string; expectedRevision: ArtifactRevisionV1;
    provenance?: string | null; provenanceDataEncryptionKey?: string | null;
}>, opts: Pick<ArtifactApiOptions, 'request' | 'signal'> = {}): Promise<ArtifactRevisionV1> {
    opts.signal?.throwIfAborted();
    const response = await (opts.request ?? serverFetch)(`/v1/artifacts/${encodeURIComponent(input.artifactId)}/revisions/${input.bodyVersion}/restore`, {
        method: 'POST', headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ header: input.header, expectedHeaderVersion: input.expectedRevision.headerVersion,
            expectedBodyVersion: input.expectedRevision.bodyVersion, ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
            ...(input.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: input.provenanceDataEncryptionKey }) }),
        ...(opts.signal ? { signal: opts.signal } : {}),
    }, { includeAuth: false, retry: 'none' });
    opts.signal?.throwIfAborted();
    if (!response.ok) throw await readWriteRefusal(response, 'Artifact restore failed');
    const value: unknown = await response.json();
    opts.signal?.throwIfAborted();
    if (value && typeof value === 'object' && Reflect.get(value, 'success') === false
        && Reflect.get(value, 'error') === 'version-mismatch') {
        throw new HappyError('Artifact was modified by another client', false, { code: 'version_mismatch' });
    }
    const revision = ArtifactRevisionV1Schema.safeParse(value && typeof value === 'object' ? {
        headerVersion: Reflect.get(value, 'headerVersion'), bodyVersion: Reflect.get(value, 'bodyVersion'),
    } : null);
    if (!value || typeof value !== 'object' || Reflect.get(value, 'success') !== true || !revision.success)
        throw new HappyError('Artifact restore result is unavailable', false, { code: 'content_unavailable' });
    return revision.data;
}

/** The existing Artifact HTTP owner carries grants and fenced recipient keys. */
export function createArtifactAccessApi(credentials: AuthCredentials, opts: Pick<ArtifactApiOptions, 'request'> = {}) {
    const send = async <T>(artifactId: string, leaf: string, schema: { parse: (value: unknown) => T },
        method?: string, input?: unknown, signal?: AbortSignal): Promise<T> => {
        signal?.throwIfAborted();
        const response = await (opts.request ?? serverFetch)(`/v1/artifacts/${encodeURIComponent(artifactId)}/access/${leaf}`, {
            ...(method ? { method } : {}),
            headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
            ...(signal ? { signal } : {}),
        }, { includeAuth: false, retry: 'none' });
        signal?.throwIfAborted();
        const value: unknown = await response.json().catch(() => null);
        signal?.throwIfAborted();
        if (!response.ok) {
            const known = ArtifactAccessErrorCodeV1Schema.safeParse(value && typeof value === 'object' ? Reflect.get(value, 'error') : undefined);
            const code = known.success ? known.data
                : response.status === 404 || response.status === 405 ? 'artifact_access_unavailable' : 'artifact_access_failed';
            throw Object.assign(new Error(code), { code });
        }
        return schema.parse(value);
    };
    return {
        list: (input: ArtifactAccessGrantsListInputV1, signal?: AbortSignal) =>
            send(input.artifactId, 'grants', ArtifactAccessGrantsListResponseV1Schema, undefined, undefined, signal),
        set: (input: ArtifactAccessGrantSetInputV1, signal?: AbortSignal) =>
            send(input.artifactId, 'grants', ArtifactAccessGrantMutationResponseV1Schema, 'PUT', input, signal),
        remove: (input: ArtifactAccessGrantRemoveInputV1, signal?: AbortSignal) =>
            send(input.artifactId, 'grants', ArtifactAccessGrantMutationResponseV1Schema, 'DELETE', input, signal),
        readRecipients: (artifactId: string, signal?: AbortSignal) =>
            send(artifactId, 'recipients', ArtifactAccessRecipientCensusResponseV1Schema, undefined, undefined, signal),
        commitKeyEnvelopes: (input: ArtifactRecipientKeyEnvelopeCommitInputV1, signal?: AbortSignal) =>
            send(input.artifactId, 'key-envelopes', ArtifactRecipientKeyEnvelopeCommitResponseV1Schema, 'POST', input, signal),
    };
}

/**
 * Fetch all artifacts for the account
 */
export async function fetchArtifacts(
    credentials: AuthCredentials,
    opts: ArtifactApiOptions = {},
): Promise<Artifact[]> {
    const run = async () => {
        const query = new URLSearchParams();
        if (opts.limit !== undefined) query.set('limit', String(opts.limit));
        if (opts.cursor !== undefined) query.set('cursor', opts.cursor);
        if (opts.includeBody) query.set('includeBody', 'true');
        const search = query.toString();
        const response = await (opts.request ?? serverFetch)(`/v1/artifacts${search ? `?${search}` : ''}`, {
            ...(opts.signal ? { signal: opts.signal } : {}),
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            }
        }, { includeAuth: false, retry: opts.retry });

        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to fetch artifacts';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false, { status: response.status, ...(response.status === 400 ? { code: 'invalid_cursor' } : {}) });
            }
            throw new HappyError(`Failed to fetch artifacts: ${response.status}`, true, { status: response.status });
        }

        const value: unknown = await response.json();
        if (!Array.isArray(value)) {
            throw new HappyError('Artifact content is unavailable', false, { code: 'artifact_content_unavailable' });
        }
        const data = value.map(readArtifactResponse);
        return opts.ownerAccountId === undefined ? data : data.filter(artifact => artifact.ownerAccountId === opts.ownerAccountId);
    };

    if (opts.retry === 'none') {
        return await run();
    }

    return await backoff(run);
}

/**
 * Fetch a single artifact with full body
 */
export async function fetchArtifact(
    credentials: AuthCredentials,
    artifactId: string,
    opts: ArtifactApiOptions = {},
): Promise<Artifact> {
    const run = async () => {
        const response = await (opts.request ?? ((path, init, requestOptions) => serverFetch(path, init, {
            includeAuth: false,
            retry: requestOptions?.retry,
        })))(`/v1/artifacts/${artifactId}`, {
            ...(opts.signal ? { signal: opts.signal } : {}),
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            }
        }, { includeAuth: false, retry: opts.retry });

        if (!response.ok) {
            if (response.status === 404) {
                throw new HappyError('Artifact not found', false, { status: 404, code: 'not_found' });
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to fetch artifact';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false, { status: response.status });
            }
            throw new HappyError(`Failed to fetch artifact: ${response.status}`, true, { status: response.status });
        }

        return readArtifactResponse(await response.json());
    };

    if (opts.retry === 'none') {
        return await run();
    }

    return await backoff(run);
}

/**
 * Create a new artifact
 */
export async function createArtifact(
    credentials: AuthCredentials, 
    request: ArtifactCreateRequest,
    opts: ArtifactApiOptions = {},
): Promise<Artifact> {
    const run = async () => {
        const path = request.blob ? '/v1/artifacts/content/binary' : '/v1/artifacts';
        const response = request.blob?.content
            ? await uploadArtifactContent(credentials, { kind: 'create', artifactId: request.id, blobId: request.blob.blobId,
                header: request.header, body: request.body, dataEncryptionKey: request.dataEncryptionKey,
                provenance: request.provenance, provenanceDataEncryptionKey: request.provenanceDataEncryptionKey }, request.blob.content, opts)
            : await (opts.request ?? ((path, init) => serverFetch(path, init, { includeAuth: false })))(path, {
            method: 'POST',
            ...(opts.signal ? { signal: opts.signal } : {}),
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            if (response.status === 409) {
                throw new HappyError('Artifact ID already exists', false, { status: 409, code: 'conflict' });
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                throw await readWriteRefusal(response, 'Failed to create artifact');
            }
            throw new HappyError(`Failed to create artifact: ${response.status}`, true, { status: response.status });
        }

        return readArtifactResponse(await response.json());
    };

    if (opts.retry === 'none') {
        return await run();
    }

    return await backoff(run);
}

/**
 * Update an existing artifact
 */
export async function updateArtifact(
    credentials: AuthCredentials,
    artifactId: string,
    request: ArtifactUpdateRequest,
    opts: ArtifactApiOptions = {},
): Promise<ArtifactUpdateResponse> {
    const run = async () => {
        const path = `/v1/artifacts/${encodeURIComponent(artifactId)}${request.blob !== undefined ? '/content/binary' : ''}`;
        if (request.blob?.content && (request.body === undefined || request.expectedBodyVersion === undefined)) {
            throw new HappyError('Artifact binary update requires its body revision', false, { status: 400 });
        }
        const response = request.blob?.content && request.body !== undefined && request.expectedBodyVersion !== undefined
            ? await uploadArtifactContent(credentials, { kind: 'update', artifactId, blobId: request.blob.blobId,
                header: request.header, expectedHeaderVersion: request.expectedHeaderVersion,
                body: request.body, expectedBodyVersion: request.expectedBodyVersion,
                provenance: request.provenance, provenanceDataEncryptionKey: request.provenanceDataEncryptionKey }, request.blob.content, opts)
            : await (opts.request ?? ((path, init) => serverFetch(path, init, { includeAuth: false })))(path, {
            method: 'POST',
            ...(opts.signal ? { signal: opts.signal } : {}),
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new HappyError('Artifact not found', false, { status: 404, code: 'not_found' });
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                throw await readWriteRefusal(response, 'Failed to update artifact');
            }
            throw new HappyError(`Failed to update artifact: ${response.status}`, true, { status: response.status });
        }

        const data = await response.json() as ArtifactUpdateResponse;
        return data;
    };

    if (opts.retry === 'none') {
        return await run();
    }

    return await backoff(run);
}

/**
 * Delete an artifact
 */
export async function deleteArtifact(
    credentials: AuthCredentials,
    artifactId: string,
    opts: ArtifactApiOptions & Readonly<{ expectedRevision?: Readonly<{ headerVersion: number; bodyVersion: number }> }> = {},
): Promise<void> {
    const run = async () => {
        opts.signal?.throwIfAborted();
        const revision = opts.expectedRevision;
        const path = `/v1/artifacts/${encodeURIComponent(artifactId)}${revision ? `/revision/${revision.headerVersion}/${revision.bodyVersion}` : ''}`;
        const response = await (opts.request ?? serverFetch)(path, {
            method: 'DELETE',
            ...(opts.signal ? { signal: opts.signal } : {}),
            headers: {
                'Authorization': `Bearer ${credentials.token}`
            }
        }, { includeAuth: false, retry: opts.retry });

        if (!response.ok) {
            if (response.status === 409 && revision) {
                throw new HappyError('Artifact revision changed', false, { status: 409, code: 'version_mismatch' });
            }
            if (response.status === 404) {
                throw new HappyError('Artifact not found', false, { status: 404, code: 'not_found' });
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to delete artifact';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false, { status: response.status });
            }
            throw new HappyError(`Failed to delete artifact: ${response.status}`, true, { status: response.status });
        }
    };

    if (opts.retry === 'none') {
        await run();
        return;
    }

    await backoff(run);
}
