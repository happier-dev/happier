import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { log } from '@/log';
import { randomUUID } from '@/platform/randomUUID';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import {
    type ArtifactApiOptions,
    createArtifact as createArtifactApi,
    createArtifactAccessApi,
    fetchArtifact as fetchArtifactApi,
    fetchArtifacts as fetchArtifactsApi,
    updateArtifact as updateArtifactApi,
    fetchArtifactRevisions,
    fetchArtifactBlob,
    fetchArtifactHtmlPreviewLocation,
    restoreArtifactRevision,
} from '@/sync/api/artifacts/apiArtifacts';
import type { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption, projectArtifactHeaderForDisplay } from '@/sync/encryption/artifactEncryption';
import { HappyError } from '@/utils/errors/errors';
import type {
    Artifact,
    ArtifactBodyInput,
    ArtifactCreateRequest,
    ArtifactLockedReason,
    ArtifactUpdateRequest,
    DecryptedArtifact,
} from '@/sync/domains/artifacts/artifactTypes';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    ArtifactBodyV1Schema,
    ArtifactBlobReferenceV1Schema,
    artifactKindRequiresTextBodyV1,
    type ArtifactBlobReferenceV1,
    type ArtifactBodyV1,
    decodePlainArtifactStoredContent,
    encodePlainArtifactStoredContent,
    isPlainArtifactDataKeyMarker,
    runArtifactRecipientKeyPreparationV1,
    withArtifactExcerptV1,
    prepareArtifactHeaderForRevisionV1,
    type ArtifactRevisionV1,
    isArtifactHtmlHeaderV1,
    artifactHtmlBundleFromBodyV1,
    buildArtifactHtmlPreviewUrlV1,
} from '@happier-dev/protocol';
import { hashArtifactBinaryContent, openArtifactBinaryContent, sealArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';

function prepareArtifactBody(input: ArtifactBodyInput): ArtifactBodyV1 | null {
    if (input !== null && typeof input === 'object' && 'bytes' in input) return ArtifactBlobReferenceV1Schema.parse({
        blobId: randomUUID(), mime: input.mime, sizeBytes: input.bytes.length, sha256: hashArtifactBinaryContent(input.bytes),
    });
    return ArtifactBodyV1Schema.nullable().parse(input);
}

function requireArtifactBodyKind(header: Readonly<Record<string, unknown>>, body: ArtifactBodyV1 | null): void {
    if (body !== null && typeof body !== 'string' && artifactKindRequiresTextBodyV1(header.kind)) {
        throw new HappyError('This Artifact kind requires text content', false, { code: 'artifact_invalid_body' });
    }
}

async function requireArtifactHtmlWriteContent(params: Readonly<{
    header: Readonly<Record<string, unknown>>;
    body: ArtifactBodyInput;
    signal?: AbortSignal;
    readReference?: (reference: ArtifactBlobReferenceV1) => Promise<Uint8Array>;
}>): Promise<void> {
    if (!isArtifactHtmlHeaderV1(params.header)) return;
    try {
        if (typeof params.body === 'string') artifactHtmlBundleFromBodyV1(params.body);
        else if (params.body !== null && 'bytes' in params.body) artifactHtmlBundleFromBodyV1(params.body.bytes, params.body.mime);
        else if (params.body !== null && params.readReference) {
            artifactHtmlBundleFromBodyV1(await params.readReference(params.body), params.body.mime);
        } else throw new Error('HTML content is unavailable');
    } catch {
        params.signal?.throwIfAborted();
        throw new HappyError('HTML Artifact content is invalid', false, { code: 'artifact_html_content_invalid' });
    }
}

function artifactAccessProjection(artifact: Artifact) {
    return { access: artifact.access, ownerAccountId: artifact.ownerAccountId };
}

type ArtifactContentProjection = Omit<Artifact, 'ownerAccountId' | 'access' | 'encryptionMode'>
    & Partial<Pick<Artifact, 'ownerAccountId' | 'access'>>;

/**
 * An unwrapped artifact data key together with the exact wrapped envelope it came
 * from. Unwrapping is a pure function of (envelope, account content key) and the
 * account content key is fixed for the lifetime of an `Encryption` instance, so a
 * byte-identical envelope never has to be opened twice. Keeping the envelope beside
 * the key is what makes "unchanged" checkable — a bare key cannot tell a rotated
 * envelope from an unchanged one, which is why the previous cache was written on
 * every refresh and read by no refresh.
 */
export type ArtifactDataKeyCacheEntry = Readonly<{
    envelope: string;
    dataKey: Uint8Array;
}>;

export type ArtifactDataKeyCache = Map<string, ArtifactDataKeyCacheEntry>;

/**
 * Single owner of "which artifact data keys must actually be unwrapped".
 *
 * Reuses every entry whose server-reported envelope is byte-identical, opens the
 * remainder in ONE batch (`decryptEncryptionKeys` owns the native-worker routing
 * decision and can only make it for a batch it is given whole), and drops the
 * cached entry for any artifact whose envelope failed to open so a rotated key is
 * never served from a stale unwrap. Plaintext-mode artifacts carry a marker rather
 * than an envelope and never reach the batch.
 */
async function resolveArtifactDataKeys(params: {
    artifacts: readonly Pick<Artifact, 'id' | 'dataEncryptionKey'>[];
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
}): Promise<Map<string, Uint8Array | null>> {
    const { artifacts, encryption, artifactDataKeys } = params;

    const resolved = new Map<string, Uint8Array | null>();
    const pendingArtifactIds: string[] = [];
    const pendingEnvelopes: string[] = [];

    for (const artifact of artifacts) {
        const envelope = artifact.dataEncryptionKey;
        if (
            typeof envelope !== 'string'
            || envelope.length === 0
            || isPlainArtifactDataKeyMarker(envelope)
        ) {
            artifactDataKeys.delete(artifact.id);
            resolved.set(artifact.id, null);
            continue;
        }
        const cached = artifactDataKeys.get(artifact.id);
        if (cached && cached.envelope === envelope) {
            resolved.set(artifact.id, cached.dataKey);
            continue;
        }
        pendingArtifactIds.push(artifact.id);
        pendingEnvelopes.push(envelope);
    }

    if (pendingEnvelopes.length === 0) {
        return resolved;
    }

    let decryptedKeys: Array<Uint8Array | null>;
    if (!encryption) {
        decryptedKeys = pendingEnvelopes.map(() => null);
    } else {
        try {
            decryptedKeys = await encryption.decryptEncryptionKeys(pendingEnvelopes);
        } catch {
            decryptedKeys = pendingEnvelopes.map(() => null);
        }
    }

    for (let index = 0; index < pendingArtifactIds.length; index += 1) {
        const artifactId = pendingArtifactIds[index]!;
        const dataKey = decryptedKeys[index] ?? null;
        if (!dataKey) {
            // A rotated envelope that fails to open must not leave the previous key
            // cached: the next refresh would reuse a key this artifact no longer uses.
            artifactDataKeys.delete(artifactId);
            resolved.set(artifactId, null);
            continue;
        }
        artifactDataKeys.set(artifactId, { envelope: pendingEnvelopes[index]!, dataKey });
        resolved.set(artifactId, dataKey);
    }

    return resolved;
}

async function resolveArtifactDataKey(params: {
    artifact: Pick<Artifact, 'id' | 'dataEncryptionKey'>;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
}): Promise<Uint8Array | null> {
    const resolved = await resolveArtifactDataKeys({
        artifacts: [params.artifact],
        encryption: params.encryption,
        artifactDataKeys: params.artifactDataKeys,
    });
    return resolved.get(params.artifact.id) ?? null;
}

function requireArtifactEncryption(encryption: Encryption | null): Encryption {
    if (!encryption) {
        throw new Error('Account encryption material is unavailable for an encrypted artifact');
    }
    return encryption;
}

function decodePlainArtifactHeaderRaw(value: string): Readonly<Record<string, unknown>> {
    const decoded = decodePlainArtifactStoredContent(value);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error('Invalid plaintext artifact header');
    }
    return decoded as Readonly<Record<string, unknown>>;
}

function decodePlainArtifactHeader(value: string): ArtifactHeader {
    return normalizeArtifactHeaderForDecryptedArtifact(decodePlainArtifactHeaderRaw(value));
}

function decodePlainArtifactBody(value: string): { body: ArtifactBodyV1 | null } {
    const decoded = decodePlainArtifactStoredContent(value);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error('Invalid plaintext artifact body');
    }
    return { body: ArtifactBodyV1Schema.nullable().parse(Reflect.get(decoded, 'body')) };
}

function normalizeArtifactHeaderForDecryptedArtifact(header: Readonly<Record<string, unknown>>): ArtifactHeader {
    const title = typeof header.title === 'string' ? header.title : null;
    const vRaw = header.v;
    const v = typeof vRaw === 'number' && Number.isFinite(vRaw) ? Math.floor(vRaw) : 1;
    const kindRaw = typeof header.kind === 'string' ? header.kind.trim() : '';
    const kind = kindRaw || 'artifact.legacy';

    const sessionsRaw = header.sessions;
    const sessions = Array.isArray(sessionsRaw)
        ? sessionsRaw.map((v: unknown) => String(v ?? '').trim()).filter(Boolean)
        : undefined;
    const draftRaw = header.draft;
    const draft = typeof draftRaw === 'boolean' ? draftRaw : undefined;

    return {
        ...header,
        v,
        kind,
        title,
        ...(sessions ? { sessions } : {}),
        ...(typeof draft === 'boolean' ? { draft } : {}),
    };
}

function createLockedArtifactView(params: Readonly<{
    artifact: ArtifactContentProjection;
    reason: ArtifactLockedReason;
    storageMode?: 'plain' | 'e2ee';
}>): DecryptedArtifact {
    const { artifact, reason } = params;
    return {
        ...(artifact.ownerAccountId === undefined ? {} : { ownerAccountId: artifact.ownerAccountId }),
        ...(artifact.access === undefined ? {} : { access: artifact.access }),
        id: artifact.id,
        header: null,
        title: null,
        body: undefined,
        headerVersion: artifact.headerVersion,
        bodyVersion: artifact.bodyVersion,
        seq: artifact.seq,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
        isDecrypted: false,
        storageMode: params.storageMode ?? 'e2ee',
        availability: {
            kind: 'locked',
            reason,
        },
    };
}

export async function decryptArtifactListItem(params: {
    artifact: Artifact;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
}): Promise<DecryptedArtifact | null> {
    const opened = await decryptArtifactListItems({ ...params, artifacts: [params.artifact] });
    return opened[0] ?? null;
}

export async function decryptArtifactListItems(params: {
    artifacts: readonly Artifact[];
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    includeBody?: boolean;
}): Promise<Array<DecryptedArtifact | null>> {
    const keys = await resolveArtifactDataKeys(params);
    return await Promise.all(params.artifacts.map(async (artifact) => {
        const dataKey = keys.get(artifact.id) ?? null;
        if (params.includeBody) {
            const opened = await decryptArtifactWithBody({
                artifact, encryption: params.encryption, artifactDataKeys: params.artifactDataKeys, resolvedDataKey: dataKey,
            });
            if (opened?.isDecrypted) return opened;
        }
        // A bad body must not erase its readable identity or the other list rows.
        return await buildDecryptedArtifactListItem({ artifact, encryption: params.encryption, dataKey });
    }));
}

async function buildDecryptedArtifactListItem(params: {
    artifact: Artifact;
    encryption: Encryption | null;
    dataKey: Uint8Array | null;
}): Promise<DecryptedArtifact | null> {
    const { artifact, encryption, dataKey } = params;

    if (isPlainArtifactDataKeyMarker(artifact.dataEncryptionKey)) {
        try {
            const rawHeader = decodePlainArtifactHeaderRaw(artifact.header);
            const header = normalizeArtifactHeaderForDecryptedArtifact(rawHeader);
            return {
                id: artifact.id,
                header,
                rawHeader,
                title: header.title,
                sessions: header.sessions,
                draft: header.draft,
                body: undefined,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: true,
                storageMode: 'plain',
                ...artifactAccessProjection(artifact),
            };
        } catch {
            return createLockedArtifactView({
                artifact,
                reason: 'invalid_stored_content',
                storageMode: 'plain',
            });
        }
    }

    if (!encryption) {
        return createLockedArtifactView({
            artifact,
            reason: 'encryption_material_unavailable',
        });
    }

    try {
        if (!dataKey) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        // Create artifact encryption instance
        const artifactEncryption = new ArtifactEncryption(dataKey);

        // Decrypt header
        const rawHeader = await artifactEncryption.decryptHeaderRaw(artifact.header);
        const header = rawHeader ? projectArtifactHeaderForDisplay(rawHeader) : null;

        if (!header) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        return {
            id: artifact.id,
            header,
            rawHeader,
            title: header.title || null,
            sessions: header.sessions,
            draft: header.draft,
            body: undefined, // Body not loaded in list
            headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            isDecrypted: true,
            storageMode: 'e2ee',
            ...artifactAccessProjection(artifact),
        };
    } catch (err) {
        console.error(`Failed to decrypt artifact ${artifact.id}:`, err);
        return createLockedArtifactView({
            artifact,
            reason: 'decryption_failed',
        });
    }
}

export async function decryptArtifactWithBody(params: {
    artifact: Artifact;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    /** The list's batch result, including a failed unwrap; never retry it per record. */
    resolvedDataKey?: Uint8Array | null;
}): Promise<DecryptedArtifact | null> {
    const { artifact, encryption, artifactDataKeys } = params;

    if (isPlainArtifactDataKeyMarker(artifact.dataEncryptionKey)) {
        try {
            const rawHeader = decodePlainArtifactHeaderRaw(artifact.header);
            const header = normalizeArtifactHeaderForDecryptedArtifact(rawHeader);
            const body = artifact.body ? decodePlainArtifactBody(artifact.body) : null;
            requireArtifactBodyKind(rawHeader, body?.body ?? null);
            return {
                id: artifact.id,
                header,
                rawHeader,
                title: header.title,
                sessions: header.sessions,
                draft: header.draft,
                body: body?.body ?? null,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: true,
                storageMode: 'plain',
                ...artifactAccessProjection(artifact),
            };
        } catch {
            return createLockedArtifactView({
                artifact,
                reason: 'invalid_stored_content',
                storageMode: 'plain',
            });
        }
    }

    if (!encryption) {
        return createLockedArtifactView({
            artifact,
            reason: 'encryption_material_unavailable',
        });
    }

    try {
        const decryptedKey = params.resolvedDataKey !== undefined ? params.resolvedDataKey
            : await resolveArtifactDataKey({ artifact, encryption, artifactDataKeys });
        if (!decryptedKey) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        // Create artifact encryption instance
        const artifactEncryption = new ArtifactEncryption(decryptedKey);

        // Decrypt header and body
        const rawHeader = await artifactEncryption.decryptHeaderRaw(artifact.header);
        const header = rawHeader ? projectArtifactHeaderForDisplay(rawHeader) : null;
        const body = artifact.body ? await artifactEncryption.decryptBody(artifact.body) : null;

        if (!header || (artifact.body && !body)) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        requireArtifactBodyKind(rawHeader!, body?.body ?? null);
        return {
            id: artifact.id,
            header,
            title: header.title || null,
            sessions: header.sessions,
            draft: header.draft,
            body: body?.body ?? null,
            rawHeader,
            headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            isDecrypted: true,
            storageMode: 'e2ee',
            ...artifactAccessProjection(artifact),
        };
    } catch (error) {
        console.error(`Failed to decrypt artifact ${artifact.id}:`, error);
        return createLockedArtifactView({
            artifact,
            reason: 'decryption_failed',
        });
    }
}

export async function fetchAndApplyArtifactsList(params: {
    credentials: AuthCredentials | null | undefined;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
    shouldContinue?: () => boolean;
}): Promise<void> {
    const { credentials, encryption, artifactDataKeys, applyArtifacts } = params;
    const shouldContinue = params.shouldContinue ?? (() => true);

    log.log('📦 fetchArtifactsList: Starting artifact sync');
    if (!credentials) {
        log.log('📦 fetchArtifactsList: No credentials, skipping');
        return;
    }
    if (!shouldContinue()) return;

    try {
        log.log('📦 fetchArtifactsList: Fetching artifacts from server');
        const artifacts = await fetchArtifactsApi(credentials);
        if (!shouldContinue()) return;
        log.log(`📦 fetchArtifactsList: Received ${artifacts.length} artifacts from server`);
        const decryptedArtifacts: DecryptedArtifact[] = [];

        // Unwrap only what this response actually changed, and unwrap it in ONE batch
        // rather than a curve25519 open per artifact per refresh.
        const dataKeysByArtifactId = await resolveArtifactDataKeys({
            artifacts,
            encryption,
            artifactDataKeys,
        });
        if (!shouldContinue()) return;

        for (const artifact of artifacts) {
            if (!shouldContinue()) return;
            let decrypted = await buildDecryptedArtifactListItem({
                artifact,
                encryption,
                dataKey: dataKeysByArtifactId.get(artifact.id) ?? null,
            });
            if (!shouldContinue()) return;
            const header = decrypted?.header;
            const isApprovalIndex = header?.kind === 'approval_request.v1'
                || header?.kind === 'target_action_approval.v1'
                || header?.kind === 'execution_run_host_action_approval.v1';
            const isActionableApprovalStatus = header?.approvalStatus === 'open'
                || header?.approvalStatus === 'approved'
                || header?.approvalStatus === 'executing';
            if (decrypted?.isDecrypted && (header?.kind === 'launch-profile.v1' || (isApprovalIndex && isActionableApprovalStatus))) {
                const hydrated = await fetchArtifactWithBodyFromApi({
                    credentials,
                    artifactId: artifact.id,
                    encryption,
                    artifactDataKeys,
                });
                if (!shouldContinue()) return;
                if (hydrated) decrypted = hydrated;
            }
            if (decrypted) {
                decryptedArtifacts.push(decrypted);
            }
        }

        log.log(`📦 fetchArtifactsList: Prepared ${decryptedArtifacts.length} artifact rows`);
        if (!shouldContinue()) return;
        applyArtifacts(decryptedArtifacts);
        log.log('📦 fetchArtifactsList: Artifacts applied to storage');
    } catch (error) {
        // A background sync failure is recorded here and settled by the sync owner (retry, the one
        // Home-unreachable state). It is never a console error, which dev builds surface as a toast.
        log.log(`📦 fetchArtifactsList: Error fetching artifacts: ${error}`);
        throw error;
    }
}

export async function fetchArtifactWithBodyFromApi(params: {
    credentials: AuthCredentials;
    request?: ArtifactApiOptions['request'];
    artifactId: string;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    signal?: AbortSignal;
}): Promise<DecryptedArtifact | null> {
    const { credentials, artifactId, encryption, artifactDataKeys } = params;

    try {
        params.signal?.throwIfAborted();
        const artifact = await fetchArtifactApi(credentials, artifactId, { request: params.request, signal: params.signal });
        const opened = await decryptArtifactWithBody({
            artifact,
            encryption,
            artifactDataKeys,
        });
        params.signal?.throwIfAborted();
        // Every current HTTP E2EE open performs the named key-holder preparation pass.
        if (opened?.isDecrypted && opened.storageMode === 'e2ee') {
            const key = artifactDataKeys.get(artifactId);
            if (!key || key.envelope !== artifact.dataEncryptionKey) {
                throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
            }
            const accessApi = createArtifactAccessApi(credentials, { request: params.request });
            await runArtifactRecipientKeyPreparationV1({ artifactId, dataKey: key.dataKey,
                openedDataEncryptionKey: key.envelope, randomBytes: getRandomBytes, signal: params.signal,
                readCensus: () => accessApi.readRecipients(artifactId, params.signal),
                commit: (input) => accessApi.commitKeyEnvelopes(input, params.signal),
            });
        }
        return opened;
    } catch (error) {
        if (error instanceof HappyError && error.status === 404) return null;
        throw error;
    }
}

export async function fetchArtifactBinaryFromApi(params: Readonly<{
    credentials: AuthCredentials; request?: ArtifactApiOptions['request']; artifactId: string;
    reference: ArtifactBlobReferenceV1; encryption: Encryption | null; artifactDataKeys: ArtifactDataKeyCache; signal?: AbortSignal;
}>): Promise<Uint8Array> {
    const artifact = await fetchArtifactWithBodyFromApi(params);
    if (!artifact?.isDecrypted || !artifact.storageMode) {
        throw new HappyError('Artifact file changed or is unavailable', false, { code: 'artifact_content_unavailable' });
    }
    return openFetchedArtifactBinary(params, artifact.storageMode);
}

async function openFetchedArtifactBinary(params: Readonly<{
    credentials: AuthCredentials; request?: ArtifactApiOptions['request']; artifactId: string;
    reference: ArtifactBlobReferenceV1; artifactDataKeys: ArtifactDataKeyCache; signal?: AbortSignal;
}>, mode: 'plain' | 'e2ee'): Promise<Uint8Array> {
    const stored = await fetchArtifactBlob(params.credentials, params.artifactId, params.reference.blobId, mode,
        { request: params.request, signal: params.signal });
    const dataKey = params.artifactDataKeys.get(params.artifactId)?.dataKey;
    const bytes = await openArtifactBinaryContent({ reference: params.reference, content: stored.content, mode,
        encryption: dataKey ? new ArtifactEncryption(dataKey) : null });
    params.signal?.throwIfAborted();
    return bytes;
}

export async function fetchArtifactHtmlPreviewFromApi(params: Readonly<{
    credentials: AuthCredentials; request?: ArtifactApiOptions['request']; artifactId: string;
    encryption: Encryption | null; artifactDataKeys: ArtifactDataKeyCache; signal?: AbortSignal;
    forbiddenOrigins?: readonly string[];
    /** A row already opened by the same captured keyholding operation. */
    artifact?: DecryptedArtifact;
}>): Promise<string> {
    const artifact = params.artifact ?? await fetchArtifactWithBodyFromApi(params);
    if (!artifact?.isDecrypted || !artifact.storageMode || !isArtifactHtmlHeaderV1(artifact.rawHeader ?? artifact.header)
        || artifact.body === null || artifact.body === undefined)
        throw new HappyError('HTML preview is unavailable', false, { code: 'artifact_html_preview_unavailable' });
    const body = typeof artifact.body === 'string' ? artifact.body
        : await openFetchedArtifactBinary({ ...params, reference: artifact.body }, artifact.storageMode);
    const bundle = artifactHtmlBundleFromBodyV1(body, typeof artifact.body === 'string' ? undefined : artifact.body.mime);
    const url = await fetchArtifactHtmlPreviewLocation(params.credentials, params.artifactId, params);
    return buildArtifactHtmlPreviewUrlV1({ url, bundle, forbiddenOrigins: params.forbiddenOrigins });
}

type ArtifactRevisionReadParams = Readonly<{
    credentials: AuthCredentials;
    request?: ArtifactApiOptions['request'];
    artifactId: string;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    signal?: AbortSignal;
}>;

async function openRetainedArtifactBodies(params: ArtifactRevisionReadParams, artifact: Artifact) {
    const inventory = await fetchArtifactRevisions(params.credentials, artifact.id, params);
    const key = artifact.encryptionMode === 'e2ee' ? await resolveArtifactDataKey({ ...params, artifact }) : null;
    if (artifact.encryptionMode === 'e2ee' && !key)
        throw Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' });
    const codec = key ? new ArtifactEncryption(key) : null;
    const revisions = await Promise.all(inventory.revisions.map(async (revision) => {
        try {
            const opened = artifact.encryptionMode === 'plain'
                ? decodePlainArtifactBody(revision.body) : await codec!.decryptBody(revision.body);
            if (!opened) throw new Error('Invalid retained body');
            return { ...revision, body: opened.body };
        } catch {
            throw Object.assign(new Error('Artifact revision content is unavailable'), { code: 'content_unavailable' });
        }
    }));
    params.signal?.throwIfAborted();
    return { artifactId: artifact.id, revisions, retentionCount: inventory.retentionCount };
}

export async function fetchArtifactBodyRevisionsFromApi(params: ArtifactRevisionReadParams) {
    const artifact = await fetchArtifactApi(params.credentials, params.artifactId, params);
    return openRetainedArtifactBodies(params, artifact);
}

export async function restoreArtifactBodyRevisionViaApi(params: ArtifactRevisionReadParams & Readonly<{
    bodyVersion: number;
    expectedRevision: ArtifactRevisionV1;
    updateArtifact: (artifact: DecryptedArtifact) => void;
}>) {
    const artifact = await fetchArtifactApi(params.credentials, params.artifactId, params);
    if (artifact.headerVersion !== params.expectedRevision.headerVersion || artifact.bodyVersion !== params.expectedRevision.bodyVersion)
        throw Object.assign(new Error('Artifact was modified by another client'), { code: 'version_mismatch' });
    const current = await decryptArtifactWithBody({ ...params, artifact });
    if (!current?.isDecrypted || !current.rawHeader)
        throw Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' });
    const inventory = await openRetainedArtifactBodies(params, artifact);
    const selected = inventory.revisions.find(row => row.bodyVersion === params.bodyVersion);
    if (!selected) throw new HappyError('Artifact revision not found', false, { status: 404, code: 'not_found' });
    const rawHeader = withArtifactExcerptV1(prepareArtifactHeaderForRevisionV1({
        artifactId: artifact.id, header: current.rawHeader, body: selected.body, expectedRevision: params.expectedRevision,
        nextRevision: { headerVersion: params.expectedRevision.headerVersion + 1, bodyVersion: params.expectedRevision.bodyVersion + 1 },
    }), selected.body);
    const key = params.artifactDataKeys.get(artifact.id)?.dataKey;
    if (artifact.encryptionMode === 'e2ee' && !key)
        throw Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' });
    const header = artifact.encryptionMode === 'plain' ? encodePlainArtifactStoredContent(rawHeader)
        : await new ArtifactEncryption(key!).encryptHeader(rawHeader);
    const revision = await restoreArtifactRevision(params.credentials, { artifactId: artifact.id,
        bodyVersion: params.bodyVersion, expectedRevision: params.expectedRevision, header }, params);
    const restored = await fetchArtifactWithBodyFromApi(params);
    params.signal?.throwIfAborted();
    if (!restored?.isDecrypted) throw Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' });
    params.updateArtifact(restored);
    return { artifactId: artifact.id, revision };
}

export async function createArtifactViaApi(params: {
    credentials: AuthCredentials;
    request?: ArtifactApiOptions['request'];
    serverId?: string;
    title: string | null;
    body: ArtifactBodyInput;
    sessions?: string[];
    draft?: boolean;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    addArtifact: (artifact: DecryptedArtifact) => void;
}): Promise<string> {
    const { credentials, title, body, sessions, draft, encryption, artifactDataKeys, addArtifact } = params;

    return await createArtifactWithHeaderViaApi({
        credentials,
        request: params.request,
        serverId: params.serverId,
        header: {
            title,
            ...(sessions ? { sessions } : {}),
            ...(typeof draft === 'boolean' ? { draft } : {}),
        },
        body,
        encryption,
        artifactDataKeys,
        addArtifact,
    });
}

export async function createArtifactWithHeaderViaApi(params: {
    credentials: AuthCredentials;
    request?: ArtifactApiOptions['request'];
    serverId?: string;
    artifactId?: string;
    signal?: AbortSignal;
    header: Readonly<Record<string, unknown>>;
    body: ArtifactBodyInput;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    addArtifact: (artifact: DecryptedArtifact) => void;
}): Promise<string> {
    const { credentials, header, encryption, artifactDataKeys, addArtifact } = params;
    // A retained reference belongs to an existing Artifact; only update/restore can reuse it.
    if (params.body !== null && typeof params.body === 'object' && !('bytes' in params.body)) {
        throw new HappyError('A new Artifact file requires its bytes', false, { code: 'artifact_invalid_body' });
    }
    const body = prepareArtifactBody(params.body);
    requireArtifactBodyKind(header, body);
    await requireArtifactHtmlWriteContent(params);
    const rawHeader = withArtifactExcerptV1(header, body);

    try {
        // Generate unique artifact ID
        const artifactId = params.artifactId ?? randomUUID();
        const accountMode = (await fetchAccountEncryptionMode(credentials, { request: params.request })).mode;

        let storedDataEncryptionKey: string;
        let storedHeader: string;
        let storedBody: string;
        let artifactEncryption: ArtifactEncryption | null = null;

        if (accountMode === 'plain') {
            storedDataEncryptionKey = ARTIFACT_PLAIN_DATA_KEY_MARKER;
            storedHeader = encodePlainArtifactStoredContent(rawHeader);
            storedBody = encodePlainArtifactStoredContent({ body });
        } else {
            const accountEncryption = requireArtifactEncryption(encryption);
            // Generate data encryption key
            const dataEncryptionKey = ArtifactEncryption.generateDataEncryptionKey();

            // Encrypt the data encryption key with user's key
            const encryptedKey = await accountEncryption.encryptEncryptionKey(dataEncryptionKey);

            // Remember the key against the envelope the server will report back, so the
            // next list refresh recognises it as unchanged instead of re-opening it.
            artifactDataKeys.set(artifactId, {
                envelope: encodeBase64(encryptedKey, 'base64'),
                dataKey: dataEncryptionKey,
            });

            // Create artifact encryption instance
            artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

            // Encrypt header and body
            storedHeader = await artifactEncryption.encryptHeader(rawHeader);
            storedBody = await artifactEncryption.encryptBody({ body });
            storedDataEncryptionKey = encodeBase64(encryptedKey, 'base64');
        }

        // Create the request
        const request: ArtifactCreateRequest = {
            id: artifactId,
            header: storedHeader,
            body: storedBody,
            dataEncryptionKey: storedDataEncryptionKey,
        };
        if (params.body !== null && typeof params.body === 'object' && 'bytes' in params.body && typeof body === 'object' && body !== null) {
            request.blob = { blobId: body.blobId, content: await sealArtifactBinaryContent(params.body.bytes, accountMode, artifactEncryption) };
        }

        // Send to server
        params.signal?.throwIfAborted();
        const artifact = await createArtifactApi(credentials, request, { request: params.request, signal: params.signal });
        params.signal?.throwIfAborted();

        // Exact-id create can return a pre-existing row after a same-id race. Its
        // content and key are authoritative, not the plaintext we attempted to save.
        if (params.artifactId !== undefined) {
            const returnedArtifact = await decryptArtifactWithBody({ artifact, encryption, artifactDataKeys });
            if (!returnedArtifact?.isDecrypted) {
                throw Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' });
            }
            addArtifact(returnedArtifact);
            return artifact.id;
        }

        // Add to local storage
        const normalizedHeader = normalizeArtifactHeaderForDecryptedArtifact(rawHeader);
        const decryptedArtifact: DecryptedArtifact = {
            id: artifact.id,
            header: normalizedHeader,
            rawHeader,
            title: normalizedHeader.title,
            sessions: normalizedHeader.sessions,
            draft: normalizedHeader.draft,
            body,
            headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            isDecrypted: true,
            storageMode: accountMode,
            ...artifactAccessProjection(artifact),
        };

        addArtifact(decryptedArtifact);

        return artifactId;
    } catch (error) {
        console.error('Failed to create artifact:', error);
        throw error;
    }
}

export async function updateArtifactViaApi(params: {
    credentials: AuthCredentials;
    request?: ArtifactApiOptions['request'];
    serverId?: string;
    artifactId: string;
    title: string | null;
    body: ArtifactBodyInput;
    sessions?: string[];
    draft?: boolean;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    getArtifact: (artifactId: string) => DecryptedArtifact | undefined;
    updateArtifact: (artifact: DecryptedArtifact) => void;
}): Promise<void> {
    const { credentials, artifactId, title, body, sessions, draft, encryption, artifactDataKeys, getArtifact, updateArtifact } =
        params;

    try {
        // Get current artifact from storage
        const currentArtifact = getArtifact(artifactId);
        if (!currentArtifact) {
            throw new Error(`Artifact ${artifactId} not found`);
        }
        if (!currentArtifact.isDecrypted || !currentArtifact.rawHeader) {
            throw Object.assign(new Error('Artifact content is unavailable. Please refresh and try again.'), { code: 'content_unavailable' });
        }

        const header: ArtifactHeader = {
            ...currentArtifact.rawHeader,
            title,
            ...(sessions ? { sessions } : {}),
            ...(typeof draft === 'boolean' ? { draft } : {}),
        };

        await updateArtifactWithHeaderViaApi({
            credentials,
            request: params.request,
            serverId: params.serverId,
            artifactId,
            header,
            body,
            encryption,
            artifactDataKeys,
            getArtifact,
            updateArtifact,
        });
    } catch (error) {
        console.error('Failed to update artifact:', error);
        throw error;
    }
}

function stableStringifyJsonValue(value: unknown): string {
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'string') return JSON.stringify(value);
    if (t === 'number') return Number.isFinite(value as number) ? String(value) : '"__non_finite__"';
    if (t === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) return `[${value.map(stableStringifyJsonValue).join(',')}]`;
    if (t !== 'object') return JSON.stringify(null);

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringifyJsonValue(obj[k])}`).join(',')}}`;
}

export async function updateArtifactWithHeaderViaApi(params: {
    credentials: AuthCredentials;
    request?: ArtifactApiOptions['request'];
    serverId?: string;
    artifactId: string;
    expectedRevision?: Readonly<{ headerVersion: number; bodyVersion: number }>;
    signal?: AbortSignal;
    header: Readonly<Record<string, unknown>>;
    body: ArtifactBodyInput;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    getArtifact: (artifactId: string) => DecryptedArtifact | undefined;
    updateArtifact: (artifact: DecryptedArtifact) => void;
}): Promise<void> {
    const { credentials, artifactId, header, encryption, artifactDataKeys, getArtifact, updateArtifact } = params;
    const body = prepareArtifactBody(params.body);
    requireArtifactBodyKind(header, body);
    const rawHeader = withArtifactExcerptV1(header, body);

    // Get current artifact from storage
    const currentArtifact = getArtifact(artifactId);
    if (!currentArtifact) {
        throw new Error(`Artifact ${artifactId} not found`);
    }
    if (currentArtifact.isDecrypted === false) {
        throw new Error(`Artifact ${artifactId} is locked`);
    }

    // Get the data encryption key from memory for encrypted artifacts only.
    let dataEncryptionKey = artifactDataKeys.get(artifactId)?.dataKey;
    let storageMode = currentArtifact.storageMode ?? (dataEncryptionKey ? 'e2ee' : undefined);

    // Determine current versions
    let headerVersion = params.expectedRevision?.headerVersion ?? currentArtifact.headerVersion;
    let bodyVersion = params.expectedRevision?.bodyVersion ?? currentArtifact.bodyVersion;

    if (
        headerVersion === undefined
        || bodyVersion === undefined
        || storageMode === undefined
        || (storageMode === 'e2ee' && !dataEncryptionKey)
    ) {
        const fullArtifact = await fetchArtifactApi(credentials, artifactId, { request: params.request, signal: params.signal });
        // Key recovery must never rebase the full CAS token supplied by the caller.
        if (!params.expectedRevision) {
            headerVersion = fullArtifact.headerVersion;
            bodyVersion = fullArtifact.bodyVersion;
        }
        storageMode = isPlainArtifactDataKeyMarker(fullArtifact.dataEncryptionKey) ? 'plain' : 'e2ee';

        // Decrypt and store the data encryption key if we don't have it
        if (storageMode === 'e2ee' && !dataEncryptionKey) {
            const decryptedKey = await resolveArtifactDataKey({
                artifact: fullArtifact,
                encryption: requireArtifactEncryption(encryption),
                artifactDataKeys,
            });
            if (!decryptedKey) {
                throw new Error('Failed to decrypt encryption key');
            }
            dataEncryptionKey = decryptedKey;
        }
    }

    if (!storageMode) {
        throw new Error('Artifact storage mode is unavailable');
    }
    const currentStorageMode = storageMode;
    await requireArtifactHtmlWriteContent({ ...params,
        readReference: reference => openFetchedArtifactBinary({ ...params, reference }, currentStorageMode),
    });
    const artifactEncryption = storageMode === 'e2ee'
        ? new ArtifactEncryption(dataEncryptionKey!)
        : null;

    // Prepare update request
    const updateRequest: ArtifactUpdateRequest = {};

    const normalizedHeader = normalizeArtifactHeaderForDecryptedArtifact(rawHeader);
    // A complete caller-supplied replacement is authoritative even when an old
    // cache lacks raw metadata. Presentation normalization cannot prove a no-op.
    const shouldUpdateHeader = !currentArtifact.rawHeader
        || stableStringifyJsonValue(rawHeader) !== stableStringifyJsonValue(currentArtifact.rawHeader);

    if (params.expectedRevision || shouldUpdateHeader) {
        updateRequest.header = storageMode === 'plain'
            ? encodePlainArtifactStoredContent(rawHeader)
            : await artifactEncryption!.encryptHeader(rawHeader);
        updateRequest.expectedHeaderVersion = headerVersion;
    }

    // Strict refs are schema-cloned on input; equal file metadata is not a body edit.
    const bodyChanged = body !== null && typeof body === 'object'
        ? stableStringifyJsonValue(body) !== stableStringifyJsonValue(currentArtifact.body)
        : body !== currentArtifact.body;
    if (params.expectedRevision || bodyChanged) {
        updateRequest.body = storageMode === 'plain'
            ? encodePlainArtifactStoredContent({ body })
            : await artifactEncryption!.encryptBody({ body });
        updateRequest.expectedBodyVersion = bodyVersion;
        if (body !== null && typeof body === 'object') {
            updateRequest.blob = { blobId: body.blobId,
                ...(params.body !== null && typeof params.body === 'object' && 'bytes' in params.body
                    ? { content: await sealArtifactBinaryContent(params.body.bytes, storageMode, artifactEncryption) } : {}),
            };
        } else if (currentArtifact.body !== null && typeof currentArtifact.body === 'object') {
            updateRequest.blob = null;
        }
    }

    // Skip if no changes
    if (Object.keys(updateRequest).length === 0) {
        return;
    }

    // Send update to server
    params.signal?.throwIfAborted();
    const response = await updateArtifactApi(credentials, artifactId, updateRequest, { request: params.request, signal: params.signal });
    params.signal?.throwIfAborted();

    if (!response.success) {
        // Handle version mismatch
        if (response.error === 'version-mismatch') {
            throw Object.assign(new Error('Artifact was modified by another client. Please refresh and try again.'), { code: 'version_mismatch' });
        }
        throw new Error('Failed to update artifact');
    }

    // Update local storage
    const updatedArtifact: DecryptedArtifact = {
        ...currentArtifact,
        header: normalizedHeader,
        rawHeader,
        title: normalizedHeader.title,
        sessions: normalizedHeader.sessions,
        draft: normalizedHeader.draft,
        body,
        headerVersion: response.headerVersion !== undefined ? response.headerVersion : headerVersion,
        bodyVersion: response.bodyVersion !== undefined ? response.bodyVersion : bodyVersion,
        updatedAt: Date.now(),
        isDecrypted: true,
        availability: { kind: 'available' },
        storageMode,
    };

    updateArtifact(updatedArtifact);
}

export async function decryptSocketNewArtifactUpdate(params: {
    artifactId: string;
    dataEncryptionKey: string;
    header: string;
    headerVersion: number;
    body?: string | null;
    bodyVersion?: number;
    seq: number;
    createdAt: number;
    updatedAt: number;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
}): Promise<DecryptedArtifact | null> {
    const {
        artifactId,
        dataEncryptionKey,
        header,
        headerVersion,
        body,
        bodyVersion,
        seq,
        createdAt,
        updatedAt,
        encryption,
        artifactDataKeys,
    } = params;

    if (isPlainArtifactDataKeyMarker(dataEncryptionKey)) {
        try {
            const rawHeader = decodePlainArtifactHeaderRaw(header);
            const decryptedHeader = normalizeArtifactHeaderForDecryptedArtifact(rawHeader);
            const decryptedBody = body && bodyVersion !== undefined
                ? decodePlainArtifactBody(body).body
                : undefined;
            requireArtifactBodyKind(rawHeader, decryptedBody ?? null);
            return {
                id: artifactId,
                header: decryptedHeader,
                rawHeader,
                title: decryptedHeader.title,
                sessions: decryptedHeader.sessions,
                draft: decryptedHeader.draft,
                body: decryptedBody,
                headerVersion,
                bodyVersion,
                seq,
                createdAt,
                updatedAt,
                isDecrypted: true,
                storageMode: 'plain',
            };
        } catch {
            return createLockedArtifactView({
                artifact: {
                    id: artifactId,
                    dataEncryptionKey,
                    header,
                    headerVersion,
                    body: body ?? undefined,
                    bodyVersion,
                    seq,
                    createdAt,
                    updatedAt,
                },
                reason: 'invalid_stored_content',
                storageMode: 'plain',
            });
        }
    }

    const artifact: ArtifactContentProjection = {
        id: artifactId,
        dataEncryptionKey,
        header,
        headerVersion,
        body: body ?? undefined,
        bodyVersion,
        seq,
        createdAt,
        updatedAt,
    };
    if (!encryption) {
        return createLockedArtifactView({
            artifact,
            reason: 'encryption_material_unavailable',
        });
    }

    try {
        // Decrypt the data encryption key (and remember it against its envelope)
        const decryptedKey = await resolveArtifactDataKey({
            artifact: { id: artifactId, dataEncryptionKey },
            encryption,
            artifactDataKeys,
        });
        if (!decryptedKey) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        // Create artifact encryption instance
        const artifactEncryption = new ArtifactEncryption(decryptedKey);

        // Decrypt header
        const rawHeader = await artifactEncryption.decryptHeaderRaw(header);
        const decryptedHeader = rawHeader ? projectArtifactHeaderForDisplay(rawHeader) : null;
        if (!decryptedHeader) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        // Decrypt body if provided
        let decryptedBody: ArtifactBodyV1 | null | undefined = undefined;
        if (body && bodyVersion !== undefined) {
            const decrypted = await artifactEncryption.decryptBody(body);
            if (!decrypted) {
                return createLockedArtifactView({
                    artifact,
                    reason: 'decryption_failed',
                });
            }
            decryptedBody = decrypted.body;
            requireArtifactBodyKind(rawHeader!, decryptedBody);
        }

        return {
            id: artifactId,
            header: decryptedHeader,
            title: decryptedHeader.title || null,
            rawHeader,
            sessions: decryptedHeader.sessions,
            draft: decryptedHeader.draft,
            body: decryptedBody,
            headerVersion,
            bodyVersion,
            seq,
            createdAt,
            updatedAt,
            isDecrypted: true,
            storageMode: 'e2ee',
        };
    } catch (error) {
        console.error(`Failed to decrypt new artifact ${artifactId}:`, error);
        return createLockedArtifactView({
            artifact,
            reason: 'decryption_failed',
        });
    }
}

export async function applySocketArtifactUpdate(params: {
    existingArtifact: DecryptedArtifact;
    createdAt: number;
    dataEncryptionKey: Uint8Array | null;
    header?: { version: number; value: string } | null;
    body?: { version: number; value: string } | null;
}): Promise<DecryptedArtifact> {
    const { existingArtifact, createdAt, dataEncryptionKey, header, body } = params;

    const artifactEncryption = existingArtifact.storageMode === 'plain'
        ? null
        : new ArtifactEncryption(dataEncryptionKey ?? (() => {
            throw new Error('Artifact encryption key is unavailable');
        })());

    const existingHeaderVersion = existingArtifact.headerVersion ?? 0;
    const existingBodyVersion = existingArtifact.bodyVersion ?? 0;

    const shouldApplyHeader = !!header && header.version > existingHeaderVersion;
    const shouldApplyBody = !!body && body.version > existingBodyVersion;

    if (!shouldApplyHeader && !shouldApplyBody) {
        return existingArtifact;
    }

    if (existingArtifact.storageMode === 'plain') {
        try {
            if (shouldApplyHeader && header) decodePlainArtifactHeader(header.value);
            if (shouldApplyBody && body) decodePlainArtifactBody(body.value);
        } catch {
            return {
                id: existingArtifact.id,
                header: null,
                title: null,
                body: undefined,
                headerVersion: shouldApplyHeader && header
                    ? header.version
                    : existingArtifact.headerVersion,
                bodyVersion: shouldApplyBody && body
                    ? body.version
                    : existingArtifact.bodyVersion,
                seq: existingArtifact.seq,
                createdAt: existingArtifact.createdAt,
                updatedAt: createdAt,
                isDecrypted: false,
                storageMode: 'plain',
                availability: {
                    kind: 'locked',
                    reason: 'invalid_stored_content',
                },
            };
        }
    }

    // Update artifact with new data
    const updatedArtifact: DecryptedArtifact = {
        ...existingArtifact,
        updatedAt: createdAt,
    };
    const lockedUpdate = (reason: ArtifactLockedReason): DecryptedArtifact => ({
        ...updatedArtifact, isDecrypted: false, storageMode: existingArtifact.storageMode ?? 'e2ee',
        header: null, rawHeader: null, title: null, sessions: undefined, draft: undefined, body: undefined,
        availability: { kind: 'locked', reason },
    });

    // Decrypt and update header if provided
    if (shouldApplyHeader && header) {
        const rawHeader = existingArtifact.storageMode === 'plain'
            ? decodePlainArtifactHeaderRaw(header.value)
            : await artifactEncryption!.decryptHeaderRaw(header.value);
        const decryptedHeader = rawHeader ? (existingArtifact.storageMode === 'plain'
            ? normalizeArtifactHeaderForDecryptedArtifact(rawHeader)
            : projectArtifactHeaderForDisplay(rawHeader)) : null;
        if (!decryptedHeader) return lockedUpdate('decryption_failed');
        updatedArtifact.header = decryptedHeader;
        updatedArtifact.rawHeader = rawHeader;
        updatedArtifact.title = decryptedHeader?.title || null;
        updatedArtifact.sessions = decryptedHeader?.sessions;
        updatedArtifact.draft = decryptedHeader?.draft;
        updatedArtifact.headerVersion = header.version;
    }

    // Decrypt and update body if provided
    if (shouldApplyBody && body) {
        const decryptedBody = existingArtifact.storageMode === 'plain'
            ? decodePlainArtifactBody(body.value)
            : await artifactEncryption!.decryptBody(body.value);
        if (!decryptedBody) return lockedUpdate('decryption_failed');
        updatedArtifact.body = decryptedBody.body;
        updatedArtifact.bodyVersion = body.version;
    }

    try {
        requireArtifactBodyKind(updatedArtifact.rawHeader ?? {}, updatedArtifact.body ?? null);
    } catch {
        return lockedUpdate('invalid_stored_content');
    }

    return updatedArtifact;
}

export async function handleNewArtifactSocketUpdate(params: {
    artifactId: string;
    dataEncryptionKey: string;
    header: string;
    headerVersion: number;
    body?: string | null;
    bodyVersion?: number;
    seq: number;
    createdAt: number;
    updatedAt: number;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    addArtifact: (artifact: DecryptedArtifact) => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const {
        artifactId,
        dataEncryptionKey,
        header,
        headerVersion,
        body,
        bodyVersion,
        seq,
        createdAt,
        updatedAt,
        encryption,
        artifactDataKeys,
        addArtifact,
        log,
    } = params;

    try {
        const decrypted = await decryptSocketNewArtifactUpdate({
            artifactId,
            dataEncryptionKey,
            header,
            headerVersion,
            body,
            bodyVersion,
            seq,
            createdAt,
            updatedAt,
            encryption,
            artifactDataKeys,
        });
        if (!decrypted) {
            return;
        }

        addArtifact(decrypted);
        log.log(`📦 Added new artifact ${artifactId} to storage`);
    } catch (error) {
        console.error(`Failed to process new artifact ${artifactId}:`, error);
    }
}

export async function handleUpdateArtifactSocketUpdate(params: {
    artifactId: string;
    createdAt: number;
    header?: { version: number; value: string } | null;
    body?: { version: number; value: string } | null;
    artifactDataKeys: ArtifactDataKeyCache;
    getExistingArtifact: (artifactId: string) => DecryptedArtifact | undefined;
    updateArtifact: (artifact: DecryptedArtifact) => void;
    invalidateArtifactsSync: () => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const {
        artifactId,
        createdAt,
        header,
        body,
        artifactDataKeys,
        getExistingArtifact,
        updateArtifact,
        invalidateArtifactsSync,
        log,
    } = params;

    const existingArtifact = getExistingArtifact(artifactId);
    if (!existingArtifact) {
        console.error(`Artifact ${artifactId} not found in storage`);
        // Fetch all artifacts to sync
        invalidateArtifactsSync();
        return;
    }

    try {
        // Get the data encryption key from memory
        const dataEncryptionKey = existingArtifact.storageMode === 'plain'
            ? null
            : artifactDataKeys.get(artifactId)?.dataKey ?? null;
        if (existingArtifact.storageMode !== 'plain' && !dataEncryptionKey) {
            console.error(`Encryption key not found for artifact ${artifactId}, fetching artifacts`);
            invalidateArtifactsSync();
            return;
        }

        const updatedArtifact = await applySocketArtifactUpdate({
            existingArtifact,
            createdAt,
            dataEncryptionKey,
            header,
            body,
        });

        updateArtifact(updatedArtifact);
        log.log(`📦 Updated artifact ${artifactId} in storage`);
    } catch (error) {
        console.error(`Failed to process artifact update ${artifactId}:`, error);
    }
}

export function handleDeleteArtifactSocketUpdate(params: {
    artifactId: string;
    deleteArtifact: (artifactId: string) => void;
    artifactDataKeys: ArtifactDataKeyCache;
}): void {
    const { artifactId, deleteArtifact, artifactDataKeys } = params;

    // Remove from storage
    deleteArtifact(artifactId);

    // Remove encryption key from memory
    artifactDataKeys.delete(artifactId);
}
