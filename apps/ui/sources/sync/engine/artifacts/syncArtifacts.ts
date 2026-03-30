import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { log } from '@/log';
import {
    createArtifact as createArtifactApi,
    fetchArtifact as fetchArtifactApi,
    fetchArtifacts as fetchArtifactsApi,
    updateArtifact as updateArtifactApi,
} from '@/sync/api/artifacts/apiArtifacts';
import type { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import type { Artifact, ArtifactCreateRequest, ArtifactUpdateRequest, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';

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

export async function decryptArtifactListItem(params: {
    artifact: Artifact;
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
}): Promise<DecryptedArtifact | null> {
    const { artifact, encryption, artifactDataKeys } = params;

    try {
        // Decrypt the data encryption key
        const decryptedKey = await encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
        if (!decryptedKey) {
            console.error(`Failed to decrypt key for artifact ${artifact.id}`);
            return null;
        }

        // Store the decrypted key in memory
        artifactDataKeys.set(artifact.id, decryptedKey);

        // Create artifact encryption instance
        const artifactEncryption = new ArtifactEncryption(decryptedKey);

        // Decrypt header
        const header = await artifactEncryption.decryptHeader(artifact.header);

        return {
            id: artifact.id,
            header,
            title: header?.title || null,
            sessions: header?.sessions,
            draft: header?.draft,
            body: undefined, // Body not loaded in list
            headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            isDecrypted: !!header,
        };
    } catch (err) {
        console.error(`Failed to decrypt artifact ${artifact.id}:`, err);
        // Add with decryption failed flag (body is not loaded for list items)
        return {
            id: artifact.id,
            title: null,
            body: undefined,
            headerVersion: artifact.headerVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            isDecrypted: false,
        };
    }
}

export async function decryptArtifactWithBody(params: {
    artifact: Artifact;
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
}): Promise<DecryptedArtifact | null> {
    const { artifact, encryption, artifactDataKeys } = params;

    try {
        // Decrypt the data encryption key
        const decryptedKey = await encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
        if (!decryptedKey) {
            console.error(`Failed to decrypt key for artifact ${artifact.id}`);
            return null;
        }

        // Store the decrypted key in memory
        artifactDataKeys.set(artifact.id, decryptedKey);

        // Create artifact encryption instance
        const artifactEncryption = new ArtifactEncryption(decryptedKey);

        // Decrypt header and body
        const header = await artifactEncryption.decryptHeader(artifact.header);
        const body = artifact.body ? await artifactEncryption.decryptBody(artifact.body) : null;

        return {
            id: artifact.id,
            header,
            title: header?.title || null,
            sessions: header?.sessions,
            draft: header?.draft,
            body: body?.body || null,
            headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            isDecrypted: !!header,
        };
    } catch (error) {
        console.error(`Failed to decrypt artifact ${artifact.id}:`, error);
        return null;
    }
}

export async function fetchAndApplyArtifactsList(params: {
    credentials: AuthCredentials | null | undefined;
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
    applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
}): Promise<void> {
    const { credentials, encryption, artifactDataKeys, applyArtifacts } = params;

    log.log('📦 fetchArtifactsList: Starting artifact sync');
    if (!credentials) {
        log.log('📦 fetchArtifactsList: No credentials, skipping');
        return;
    }

    try {
        log.log('📦 fetchArtifactsList: Fetching artifacts from server');
        const artifacts = await fetchArtifactsApi(credentials);
        log.log(`📦 fetchArtifactsList: Received ${artifacts.length} artifacts from server`);
        const decryptedArtifacts: DecryptedArtifact[] = [];

        for (const artifact of artifacts) {
            const decrypted = await decryptArtifactListItem({
                artifact,
                encryption,
                artifactDataKeys,
            });
            if (decrypted) {
                decryptedArtifacts.push(decrypted);
            }
        }

        log.log(`📦 fetchArtifactsList: Successfully decrypted ${decryptedArtifacts.length} artifacts`);
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
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
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
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
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
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
    addArtifact: (artifact: DecryptedArtifact) => void;
}): Promise<string> {
    const { credentials, header, body, encryption, artifactDataKeys, addArtifact } = params;

    try {
        // Generate unique artifact ID
        const artifactId = encryption.generateId();

        // Generate data encryption key
        const dataEncryptionKey = ArtifactEncryption.generateDataEncryptionKey();

        // Store the decrypted key in memory
        artifactDataKeys.set(artifactId, dataEncryptionKey);

        // Encrypt the data encryption key with user's key
        const encryptedKey = await encryption.encryptEncryptionKey(dataEncryptionKey);

        // Create artifact encryption instance
        const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

        // Encrypt header and body
        const encryptedHeader = await artifactEncryption.encryptHeader(header);
        const encryptedBody = await artifactEncryption.encryptBody({ body });

        // Create the request
        const request: ArtifactCreateRequest = {
            id: artifactId,
            header: encryptedHeader,
            body: encryptedBody,
            dataEncryptionKey: encodeBase64(encryptedKey, 'base64'),
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
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
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
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
    getArtifact: (artifactId: string) => DecryptedArtifact | undefined;
    updateArtifact: (artifact: DecryptedArtifact) => void;
}): Promise<void> {
    const { credentials, artifactId, header, body, encryption, artifactDataKeys, getArtifact, updateArtifact } = params;

    // Get current artifact from storage
    const currentArtifact = getArtifact(artifactId);
    if (!currentArtifact) {
        throw new Error(`Artifact ${artifactId} not found`);
    }

    // Get the data encryption key from memory
    let dataEncryptionKey = artifactDataKeys.get(artifactId);

    // Determine current versions
    let headerVersion = currentArtifact.headerVersion;
    let bodyVersion = currentArtifact.bodyVersion;

    if (headerVersion === undefined || bodyVersion === undefined || !dataEncryptionKey) {
        const fullArtifact = await fetchArtifactApi(credentials, artifactId);
        headerVersion = fullArtifact.headerVersion;
        bodyVersion = fullArtifact.bodyVersion;

        // Decrypt and store the data encryption key if we don't have it
        if (!dataEncryptionKey) {
            const decryptedKey = await encryption.decryptEncryptionKey(fullArtifact.dataEncryptionKey);
            if (!decryptedKey) {
                throw new Error('Failed to decrypt encryption key');
            }
            artifactDataKeys.set(artifactId, decryptedKey);
            dataEncryptionKey = decryptedKey;
        }
    }

    // Create artifact encryption instance
    const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

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
        const encryptedHeader = await artifactEncryption.encryptHeader(header);
        updateRequest.header = encryptedHeader;
        updateRequest.expectedHeaderVersion = headerVersion;
    }

    // Only update body if it changed
    if (body !== currentArtifact.body) {
        const encryptedBody = await artifactEncryption.encryptBody({ body });
        updateRequest.body = encryptedBody;
        updateRequest.expectedBodyVersion = bodyVersion;
    }

    // Skip if no changes
    if (Object.keys(updateRequest).length === 0) {
        return;
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
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
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

    // Decrypt the data encryption key
    const decryptedKey = await encryption.decryptEncryptionKey(dataEncryptionKey);
    if (!decryptedKey) {
        console.error(`Failed to decrypt key for new artifact ${artifactId}`);
        return null;
    }

    // Store the decrypted key in memory
    artifactDataKeys.set(artifactId, decryptedKey);

    // Create artifact encryption instance
    const artifactEncryption = new ArtifactEncryption(decryptedKey);

    // Decrypt header
    const decryptedHeader = await artifactEncryption.decryptHeader(header);

    // Decrypt body if provided
    let decryptedBody: string | null | undefined = undefined;
    if (body && bodyVersion !== undefined) {
        const decrypted = await artifactEncryption.decryptBody(body);
        decryptedBody = decrypted?.body || null;
    }

    return {
        id: artifactId,
        header: decryptedHeader,
        title: decryptedHeader?.title || null,
        body: decryptedBody,
        headerVersion,
        bodyVersion,
        seq,
        createdAt,
        updatedAt,
        isDecrypted: !!decryptedHeader,
    };
}

export async function applySocketArtifactUpdate(params: {
    existingArtifact: DecryptedArtifact;
    createdAt: number;
    dataEncryptionKey: Uint8Array;
    header?: { version: number; value: string } | null;
    body?: { version: number; value: string } | null;
}): Promise<DecryptedArtifact> {
    const { existingArtifact, createdAt, dataEncryptionKey, header, body } = params;

    const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

    const existingHeaderVersion = existingArtifact.headerVersion ?? 0;
    const existingBodyVersion = existingArtifact.bodyVersion ?? 0;

    const shouldApplyHeader = !!header && header.version > existingHeaderVersion;
    const shouldApplyBody = !!body && body.version > existingBodyVersion;

    if (!shouldApplyHeader && !shouldApplyBody) {
        return existingArtifact;
    }

    // Update artifact with new data
    const updatedArtifact: DecryptedArtifact = {
        ...existingArtifact,
        updatedAt: createdAt,
    };

    // Decrypt and update header if provided
    if (shouldApplyHeader && header) {
        const decryptedHeader = await artifactEncryption.decryptHeader(header.value);
        updatedArtifact.header = decryptedHeader;
        updatedArtifact.title = decryptedHeader?.title || null;
        updatedArtifact.sessions = decryptedHeader?.sessions;
        updatedArtifact.draft = decryptedHeader?.draft;
        updatedArtifact.headerVersion = header.version;
    }

    // Decrypt and update body if provided
    if (shouldApplyBody && body) {
        const decryptedBody = await artifactEncryption.decryptBody(body.value);
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
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
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
    artifactDataKeys: Map<string, Uint8Array>;
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
        const dataEncryptionKey = artifactDataKeys.get(artifactId);
        if (!dataEncryptionKey) {
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
    artifactDataKeys: Map<string, Uint8Array>;
}): void {
    const { artifactId, deleteArtifact, artifactDataKeys } = params;

    // Remove from storage
    deleteArtifact(artifactId);

    // Remove encryption key from memory
    artifactDataKeys.delete(artifactId);
}
