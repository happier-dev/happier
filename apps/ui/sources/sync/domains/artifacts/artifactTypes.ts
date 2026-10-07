import type { ArtifactBodyV1, ArtifactBlobWriteV1, ArtifactBodyEnvelopeV1, ArtifactRevisionProvenanceV1 } from '@happier-dev/protocol';

export type ArtifactBodyInput = ArtifactBodyV1 | null | Readonly<{ bytes: Uint8Array; mime: string }>;

/**
 * Encrypted artifact from API
 */
export interface Artifact {
    id: string;
    /** Authenticated sharing and owner Account-mode projection from HTTP. */
    ownerAccountId: string;
    access: 'owner' | 'view' | 'edit' | 'admin';
    encryptionMode: 'plain' | 'e2ee';
    header: string;  // Base64 encoded encrypted JSON { "title": string | null }
    headerVersion: number;
    body?: string;  // Base64 encoded encrypted JSON { "body": string | null } - only in full fetch
    bodyVersion?: number;  // Current head revision, also projected by header-only HTTP lists
    dataEncryptionKey: string;  // Base64 encoded encryption key (encrypted with user key)
    provenance?: string | null;
    provenanceDataEncryptionKey?: string | null;
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
export type ArtifactBody = ArtifactBodyEnvelopeV1;

export type ArtifactLockedReason =
    | 'encryption_material_unavailable'
    | 'decryption_failed'
    | 'invalid_stored_content';

export interface DecryptedArtifactBase {
    /** HTTP grant projection; content-only socket events do not carry authority. */
    access?: 'owner' | 'view' | 'edit' | 'admin';
    ownerAccountId?: string;
    id: string;
    header?: ArtifactHeader | null;
    /** Exact opened storage metadata; presentation defaults must never be repersisted. */
    rawHeader?: Readonly<Record<string, unknown>> | null;
    title: string | null;
    sessions?: string[];  // Optional array of session IDs linked to this artifact
    draft?: boolean;      // Optional draft flag - hides artifact from visible list when true
    body?: ArtifactBodyV1 | null;  // Only loaded when viewing full artifact
    provenance?: ArtifactRevisionProvenanceV1;
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
    /** Exact HTTP key envelopes used to open this row; never persisted or inferred from a cached key. */
    storageIdentity?: Readonly<{ contentKeyEnvelope: string; provenanceKeyEnvelope: string | null }>;
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
        rawHeader?: null;
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
    provenance?: string | null;
    provenanceDataEncryptionKey?: string | null;
    blob?: ArtifactBlobWriteV1;
}

/**
 * Request to update an existing artifact
 */
export interface ArtifactUpdateRequest {
    provenance?: string | null;
    provenanceDataEncryptionKey?: string | null;
    /** Explicit null deliberately clears an existing binary head; omission is an ordinary write. */
    blob?: ArtifactBlobWriteV1 | null;
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
