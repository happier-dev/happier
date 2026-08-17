import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { log } from '@/log';
import { randomUUID } from '@/platform/randomUUID';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import {
    requireCurrentAccountStoredContentServerCompatibility,
} from '@/sync/api/capabilities/accountStoredContentCompatibility';
import {
    createArtifact as createArtifactApi,
    fetchArtifact as fetchArtifactApi,
    fetchArtifacts as fetchArtifactsApi,
    updateArtifact as updateArtifactApi,
} from '@/sync/api/artifacts/apiArtifacts';
import type { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import type {
    Artifact,
    ArtifactCreateRequest,
    ArtifactLockedReason,
    ArtifactUpdateRequest,
    DecryptedArtifact,
} from '@/sync/domains/artifacts/artifactTypes';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    decodePlainArtifactStoredContent,
    encodePlainArtifactStoredContent,
    isPlainArtifactDataKeyMarker,
} from '@happier-dev/protocol';

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

function decodePlainArtifactHeader(value: string): ArtifactHeader {
    const decoded = decodePlainArtifactStoredContent(value);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error('Invalid plaintext artifact header');
    }
    return normalizeArtifactHeaderForDecryptedArtifact(decoded as ArtifactHeader);
}

function decodePlainArtifactBody(value: string): { body: string | null } {
    const decoded = decodePlainArtifactStoredContent(value);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error('Invalid plaintext artifact body');
    }
    const body = (decoded as { body?: unknown }).body;
    if (body !== null && typeof body !== 'string') {
        throw new Error('Invalid plaintext artifact body');
    }
    return { body };
}

function normalizeArtifactHeaderForDecryptedArtifact(header: ArtifactHeader): ArtifactHeader {
    const title = typeof (header as any).title === 'string' ? (header as any).title : null;
    const vRaw = (header as any).v;
    const v = typeof vRaw === 'number' && Number.isFinite(vRaw) ? Math.floor(vRaw) : 1;
    const kindRaw = typeof (header as any).kind === 'string' ? String((header as any).kind).trim() : '';
    const kind = kindRaw || 'artifact.legacy';

    const sessionsRaw = (header as any).sessions;
    const sessions = Array.isArray(sessionsRaw)
        ? sessionsRaw.map((v: unknown) => String(v ?? '').trim()).filter(Boolean)
        : undefined;
    const draftRaw = (header as any).draft;
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
    artifact: Artifact;
    reason: ArtifactLockedReason;
    storageMode?: 'plain' | 'e2ee';
}>): DecryptedArtifact {
    const { artifact, reason } = params;
    return {
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
    const { artifact, encryption, artifactDataKeys } = params;
    const dataKey = isPlainArtifactDataKeyMarker(artifact.dataEncryptionKey)
        ? null
        : await resolveArtifactDataKey({ artifact, encryption, artifactDataKeys });
    return buildDecryptedArtifactListItem({ artifact, encryption, dataKey });
}

async function buildDecryptedArtifactListItem(params: {
    artifact: Artifact;
    encryption: Encryption | null;
    dataKey: Uint8Array | null;
}): Promise<DecryptedArtifact | null> {
    const { artifact, encryption, dataKey } = params;

    if (isPlainArtifactDataKeyMarker(artifact.dataEncryptionKey)) {
        try {
            const header = decodePlainArtifactHeader(artifact.header);
            return {
                id: artifact.id,
                header,
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
        const header = await artifactEncryption.decryptHeader(artifact.header);

        if (!header) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        return {
            id: artifact.id,
            header,
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
}): Promise<DecryptedArtifact | null> {
    const { artifact, encryption, artifactDataKeys } = params;

    if (isPlainArtifactDataKeyMarker(artifact.dataEncryptionKey)) {
        try {
            const header = decodePlainArtifactHeader(artifact.header);
            const body = artifact.body ? decodePlainArtifactBody(artifact.body) : null;
            return {
                id: artifact.id,
                header,
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
        const decryptedKey = await resolveArtifactDataKey({ artifact, encryption, artifactDataKeys });
        if (!decryptedKey) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        // Create artifact encryption instance
        const artifactEncryption = new ArtifactEncryption(decryptedKey);

        // Decrypt header and body
        const header = await artifactEncryption.decryptHeader(artifact.header);
        const body = artifact.body ? await artifactEncryption.decryptBody(artifact.body) : null;

        if (!header) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        return {
            id: artifact.id,
            header,
            title: header.title || null,
            sessions: header.sessions,
            draft: header.draft,
            body: body?.body || null,
            headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            isDecrypted: true,
            storageMode: 'e2ee',
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
            const decrypted = await buildDecryptedArtifactListItem({
                artifact,
                encryption,
                dataKey: dataKeysByArtifactId.get(artifact.id) ?? null,
            });
            if (!shouldContinue()) return;
            if (decrypted) {
                decryptedArtifacts.push(decrypted);
            }
        }

        log.log(`📦 fetchArtifactsList: Prepared ${decryptedArtifacts.length} artifact rows`);
        if (!shouldContinue()) return;
        applyArtifacts(decryptedArtifacts);
        log.log('📦 fetchArtifactsList: Artifacts applied to storage');
    } catch (error) {
        log.log(`📦 fetchArtifactsList: Error fetching artifacts: ${error}`);
        console.error('Failed to fetch artifacts:', error);
        throw error;
    }
}

export async function fetchArtifactWithBodyFromApi(params: {
    credentials: AuthCredentials;
    artifactId: string;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
}): Promise<DecryptedArtifact | null> {
    const { credentials, artifactId, encryption, artifactDataKeys } = params;

    try {
        const artifact = await fetchArtifactApi(credentials, artifactId);
        return await decryptArtifactWithBody({
            artifact,
            encryption,
            artifactDataKeys,
        });
    } catch (error) {
        console.error(`Failed to fetch artifact ${artifactId}:`, error);
        return null;
    }
}

export async function createArtifactViaApi(params: {
    credentials: AuthCredentials;
    title: string | null;
    body: string | null;
    sessions?: string[];
    draft?: boolean;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    addArtifact: (artifact: DecryptedArtifact) => void;
}): Promise<string> {
    const { credentials, title, body, sessions, draft, encryption, artifactDataKeys, addArtifact } = params;

    return await createArtifactWithHeaderViaApi({
        credentials,
        header: { title, sessions, draft },
        body,
        encryption,
        artifactDataKeys,
        addArtifact,
    });
}

export async function createArtifactWithHeaderViaApi(params: {
    credentials: AuthCredentials;
    header: ArtifactHeader;
    body: string | null;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    addArtifact: (artifact: DecryptedArtifact) => void;
}): Promise<string> {
    const { credentials, header, body, encryption, artifactDataKeys, addArtifact } = params;

    try {
        // Generate unique artifact ID
        const artifactId = randomUUID();
        const accountMode = (await fetchAccountEncryptionMode(credentials)).mode;

        let storedDataEncryptionKey: string;
        let storedHeader: string;
        let storedBody: string;

        if (accountMode === 'plain') {
            await requireCurrentAccountStoredContentServerCompatibility();
            storedDataEncryptionKey = ARTIFACT_PLAIN_DATA_KEY_MARKER;
            storedHeader = encodePlainArtifactStoredContent(header);
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
            const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

            // Encrypt header and body
            storedHeader = await artifactEncryption.encryptHeader(header);
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

        // Send to server
        const artifact = await createArtifactApi(credentials, request);

        // Add to local storage
        const normalizedHeader = normalizeArtifactHeaderForDecryptedArtifact(header);
        const decryptedArtifact: DecryptedArtifact = {
            id: artifact.id,
            header: normalizedHeader,
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
    artifactId: string;
    title: string | null;
    body: string | null;
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

        const header: ArtifactHeader = {
            ...(currentArtifact.header ?? {}),
            title,
            ...(sessions ? { sessions } : {}),
            ...(typeof draft === 'boolean' ? { draft } : {}),
        };

        await updateArtifactWithHeaderViaApi({
            credentials,
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

function resolveHeaderCandidateForEquality(
    artifact: DecryptedArtifact,
    fallback: ArtifactHeader,
): ArtifactHeader {
    if (artifact.header) return normalizeArtifactHeaderForDecryptedArtifact(artifact.header);
    return normalizeArtifactHeaderForDecryptedArtifact(fallback);
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
    artifactId: string;
    header: ArtifactHeader;
    body: string | null;
    encryption: Encryption | null;
    artifactDataKeys: ArtifactDataKeyCache;
    getArtifact: (artifactId: string) => DecryptedArtifact | undefined;
    updateArtifact: (artifact: DecryptedArtifact) => void;
}): Promise<void> {
    const { credentials, artifactId, header, body, encryption, artifactDataKeys, getArtifact, updateArtifact } = params;

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
    let headerVersion = currentArtifact.headerVersion;
    let bodyVersion = currentArtifact.bodyVersion;

    if (
        headerVersion === undefined
        || bodyVersion === undefined
        || storageMode === undefined
        || (storageMode === 'e2ee' && !dataEncryptionKey)
    ) {
        const fullArtifact = await fetchArtifactApi(credentials, artifactId);
        headerVersion = fullArtifact.headerVersion;
        bodyVersion = fullArtifact.bodyVersion;
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
    const artifactEncryption = storageMode === 'e2ee'
        ? new ArtifactEncryption(dataEncryptionKey!)
        : null;

    // Prepare update request
    const updateRequest: ArtifactUpdateRequest = {};

    const normalizedHeader = normalizeArtifactHeaderForDecryptedArtifact(header);
    const currentHeaderCandidate = resolveHeaderCandidateForEquality(currentArtifact, {
        title: currentArtifact.title,
        ...(currentArtifact.sessions ? { sessions: currentArtifact.sessions } : {}),
        ...(typeof currentArtifact.draft === 'boolean' ? { draft: currentArtifact.draft } : {}),
    });

    const shouldUpdateHeader =
        stableStringifyJsonValue(normalizedHeader) !== stableStringifyJsonValue(currentHeaderCandidate);

    if (shouldUpdateHeader) {
        updateRequest.header = storageMode === 'plain'
            ? encodePlainArtifactStoredContent(header)
            : await artifactEncryption!.encryptHeader(header);
        updateRequest.expectedHeaderVersion = headerVersion;
    }

    // Only update body if it changed
    if (body !== currentArtifact.body) {
        updateRequest.body = storageMode === 'plain'
            ? encodePlainArtifactStoredContent({ body })
            : await artifactEncryption!.encryptBody({ body });
        updateRequest.expectedBodyVersion = bodyVersion;
    }

    // Skip if no changes
    if (Object.keys(updateRequest).length === 0) {
        return;
    }

    if (storageMode === 'plain') {
        await requireCurrentAccountStoredContentServerCompatibility();
    }

    // Send update to server
    const response = await updateArtifactApi(credentials, artifactId, updateRequest);

    if (!response.success) {
        // Handle version mismatch
        if (response.error === 'version-mismatch') {
            throw new Error('Artifact was modified by another client. Please refresh and try again.');
        }
        throw new Error('Failed to update artifact');
    }

    // Update local storage
    const updatedArtifact: DecryptedArtifact = {
        ...currentArtifact,
        header: normalizedHeader,
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
            const decryptedHeader = decodePlainArtifactHeader(header);
            const decryptedBody = body && bodyVersion !== undefined
                ? decodePlainArtifactBody(body).body
                : undefined;
            return {
                id: artifactId,
                header: decryptedHeader,
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

    const artifact: Artifact = {
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
        const decryptedHeader = await artifactEncryption.decryptHeader(header);
        if (!decryptedHeader) {
            return createLockedArtifactView({
                artifact,
                reason: 'decryption_failed',
            });
        }

        // Decrypt body if provided
        let decryptedBody: string | null | undefined = undefined;
        if (body && bodyVersion !== undefined) {
            const decrypted = await artifactEncryption.decryptBody(body);
            if (!decrypted) {
                return createLockedArtifactView({
                    artifact,
                    reason: 'decryption_failed',
                });
            }
            decryptedBody = decrypted.body || null;
        }

        return {
            id: artifactId,
            header: decryptedHeader,
            title: decryptedHeader.title || null,
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

    // Decrypt and update header if provided
    if (shouldApplyHeader && header) {
        const decryptedHeader = existingArtifact.storageMode === 'plain'
            ? decodePlainArtifactHeader(header.value)
            : await artifactEncryption!.decryptHeader(header.value);
        updatedArtifact.header = decryptedHeader;
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
        updatedArtifact.body = decryptedBody?.body || null;
        updatedArtifact.bodyVersion = body.version;
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
