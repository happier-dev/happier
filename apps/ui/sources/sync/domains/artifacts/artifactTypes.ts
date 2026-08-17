/**
 * Encrypted artifact from API
 */
export interface Artifact {
    id: string;
    header: string;  // Base64 encoded encrypted JSON { "title": string | null }
    headerVersion: number;
    body?: string;  // Base64 encoded encrypted JSON { "body": string | null } - only in full fetch
    bodyVersion?: number;  // Only in full fetch
    dataEncryptionKey: string;  // Base64 encoded encryption key (encrypted with user key)
    seq: number;
    createdAt: number;
    updatedAt: number;
}

/**
 * Decrypted artifact header
 */
export interface ArtifactHeader {
    /**
     * Optional version for header payloads that include structured metadata.
     * Legacy artifacts may omit this value.
     */
    v?: number;

    /**
     * Optional kind discriminator for filtering artifacts without fetching bodies.
     * Legacy artifacts may omit this value.
     */
    kind?: string;

    title: string | null;
    sessions?: string[];  // Optional array of session IDs linked to this artifact
    draft?: boolean;      // Optional draft flag - hides artifact from visible list when true

    /**
     * Passthrough metadata (prompt kinds, approval status, tags, etc).
     * Consumers must treat unknown keys as optional.
     */
    [key: string]: unknown;
}

/**
 * Decrypted artifact body
 */
export interface ArtifactBody {
    body: string | null;
}

export type ArtifactLockedReason =
    | 'encryption_material_unavailable'
    | 'decryption_failed'
    | 'invalid_stored_content';

interface DecryptedArtifactBase {
    id: string;
    header?: ArtifactHeader | null;
    title: string | null;
    sessions?: string[];  // Optional array of session IDs linked to this artifact
    draft?: boolean;      // Optional draft flag - hides artifact from visible list when true
    body?: string | null;  // Only loaded when viewing full artifact
    headerVersion: number;
    bodyVersion?: number;
    seq: number;
    createdAt: number;
    updatedAt: number;
    /**
     * Internal storage discriminator used by the sync owner for socket/update decoding.
     * It is derived from the persisted data-key marker, never from the current account mode.
     */
    storageMode?: 'plain' | 'e2ee';
}

/**
 * Artifact view state for UI consumers.
 *
 * Readable artifacts keep the historical optional `availability` field so existing
 * fixtures remain lightweight. Unreadable retained E2EE rows must use the explicit
 * locked branch; they are data that the current client cannot open, not missing rows.
 */
export type DecryptedArtifact =
    | (DecryptedArtifactBase & Readonly<{
        isDecrypted: true;
        availability?: Readonly<{ kind: 'available' }>;
    }>)
    | (DecryptedArtifactBase & Readonly<{
        isDecrypted: false;
        availability: Readonly<{
            kind: 'locked';
            reason: ArtifactLockedReason;
        }>;
        storageMode: 'plain' | 'e2ee';
        header?: null;
        title: null;
        sessions?: undefined;
        draft?: undefined;
        body?: undefined;
    }>);

/**
 * Request to create a new artifact
 */
export interface ArtifactCreateRequest {
    id: string;  // UUID generated client-side
    header: string;  // Base64 encoded encrypted header
    body: string;  // Base64 encoded encrypted body
    dataEncryptionKey: string;  // Base64 encoded encryption key (encrypted with user key)
}

/**
 * Request to update an existing artifact
 */
export interface ArtifactUpdateRequest {
    header?: string;  // Base64 encoded encrypted header
    expectedHeaderVersion?: number;
    body?: string;  // Base64 encoded encrypted body
    expectedBodyVersion?: number;
}

/**
 * Response from update operation
 */
export type ArtifactUpdateResponse = 
    | {
        success: true;
        headerVersion?: number;
        bodyVersion?: number;
    }
    | {
        success: false;
        error: 'version-mismatch';
        currentHeaderVersion?: number;
        currentBodyVersion?: number;
        currentHeader?: string;
        currentBody?: string;
    };
