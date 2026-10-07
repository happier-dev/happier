import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { ArtifactHeader, ArtifactBody } from '../domains/artifacts/artifactTypes';
import { AES256Encryption } from './encryptor';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { syncPerformanceTelemetry } from '../runtime/syncPerformanceTelemetry';
import { ArtifactBodyEnvelopeV1Schema, ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { WorkflowDefinitionArtifactHeaderV1ReadSchema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';

const ARTIFACT_HEADER_DEFAULT_VERSION = 1;
const ARTIFACT_HEADER_MAX_VERSION = 1;
const UNSAFE_HEADER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RESERVED_HEADER_KEYS = new Set(['v', 'kind', 'title', 'sessions', 'draft']);

function sanitizeArtifactHeaderPassthrough(header: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(header)) {
        if (UNSAFE_HEADER_KEYS.has(key) || RESERVED_HEADER_KEYS.has(key)) {
            continue;
        }
        sanitized[key] = header[key];
    }
    return sanitized;
}

function sanitizeArtifactHeaderVersion(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return ARTIFACT_HEADER_DEFAULT_VERSION;
    }
    const normalized = Math.floor(value);
    if (normalized < ARTIFACT_HEADER_DEFAULT_VERSION || normalized > ARTIFACT_HEADER_MAX_VERSION) {
        return ARTIFACT_HEADER_DEFAULT_VERSION;
    }
    return normalized;
}

/** Presentation projection only. Strict readers and storage writers consume the raw header. */
export function projectArtifactHeaderForDisplay(header: Readonly<Record<string, unknown>>): ArtifactHeader {
    // Workflow titles are public authored content, under the kind owner's metadata.
    // Project them without changing the raw header that strict readers and writes consume.
    const workflow = header.kind === 'workflow-definition.v1'
        ? WorkflowDefinitionArtifactHeaderV1ReadSchema.safeParse(header)
        : null;
    const title = workflow?.success ? workflow.data.metadata.title
        : typeof header.title === 'string' ? header.title : null;
    const v = sanitizeArtifactHeaderVersion(header.v);
    const kindRaw = typeof header.kind === 'string' ? header.kind.trim() : '';
    const sessions = Array.isArray(header.sessions)
        ? header.sessions.map((value: unknown) => String(value ?? '').trim()).filter(Boolean)
        : undefined;
    return {
        ...sanitizeArtifactHeaderPassthrough(header), v, kind: kindRaw || 'artifact.legacy', title,
        ...(sessions ? { sessions } : {}),
        ...(typeof header.draft === 'boolean' ? { draft: header.draft } : {}),
    };
}

export class ArtifactEncryption {
    private encryptor: AES256Encryption;
    
    constructor(dataEncryptionKey: Uint8Array) {
        this.encryptor = new AES256Encryption(dataEncryptionKey);
    }
    
    /**
     * Generate a new data encryption key for an artifact
     */
    static generateDataEncryptionKey(): Uint8Array {
        return getRandomBytes(32);  // 256 bits for AES-256
    }

    async encryptBytes(bytes: Uint8Array): Promise<string> {
        return encodeBase64(await this.encryptor.encryptBytes(bytes), 'base64');
    }

    async decryptBytes(ciphertext: string): Promise<Uint8Array> {
        return this.encryptor.decryptBytes(decodeBase64(ciphertext, 'base64'));
    }
    
    /**
     * Encrypt artifact header
     */
    async encryptHeader(header: Readonly<Record<string, unknown>>): Promise<string> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.artifact.encryptHeader',
            { items: 1 },
            async () => {
                const encrypted = await this.encryptor.encrypt([header]);
                return encodeBase64(encrypted[0], 'base64');
            },
        );
    }
    
    /**
     * Open stored metadata without adding presentation defaults. Storage
     * transformations and strict document readers must preserve the raw header.
     */
    async decryptHeaderRaw(encryptedHeader: string): Promise<Readonly<Record<string, unknown>> | null> {
        try {
            const encryptedData = decodeBase64(encryptedHeader, 'base64');
            const decrypted = await syncPerformanceTelemetry.measureAsync(
                'sync.encryption.artifact.decryptHeader',
                { items: 1 },
                async () => this.encryptor.decrypt([encryptedData]),
            );
            if (!decrypted[0]) {
                return null;
            }
            // Validate structure
            const header: unknown = decrypted[0];
            if (typeof header !== 'object' || header === null || Array.isArray(header)) {
                return null;
            }
            return header as Readonly<Record<string, unknown>>;
        } catch (error) {
            console.error('Failed to decrypt artifact header:', error);
            return null;
        }
    }

    /** Decrypt and project generic Artifact display fields. */
    async decryptHeader(encryptedHeader: string): Promise<ArtifactHeader | null> {
        const header = await this.decryptHeaderRaw(encryptedHeader);
        if (!header) return null;
        return projectArtifactHeaderForDisplay(header);
    }
    
    /**
     * Encrypt artifact body
     */
    async encryptBody(body: ArtifactBody): Promise<string> {
        const content = ArtifactBodyEnvelopeV1Schema.parse(body);
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.artifact.encryptBody',
            { items: 1 },
            async () => {
                const encrypted = await this.encryptor.encrypt([content]);
                return encodeBase64(encrypted[0], 'base64');
            },
        );
    }
    
    /**
     * Decrypt artifact body
     */
    async decryptBody(encryptedBody: string): Promise<ArtifactBody | null> {
        try {
            const encryptedData = decodeBase64(encryptedBody, 'base64');
            const decrypted = await syncPerformanceTelemetry.measureAsync(
                'sync.encryption.artifact.decryptBody',
                { items: 1 },
                async () => this.encryptor.decrypt([encryptedData]),
            );
            if (!decrypted[0]) {
                return null;
            }
            // Validate structure
            const body: unknown = decrypted[0];
            if (typeof body !== 'object' || body === null || Array.isArray(body)) {
                return null;
            }
            const parsed = ArtifactBodyEnvelopeV1StoredSchema.safeParse(body);
            return parsed.success ? parsed.data : null;
        } catch (error) {
            console.error('Failed to decrypt artifact body:', error);
            return null;
        }
    }
}
