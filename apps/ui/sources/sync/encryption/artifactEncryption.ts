import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { ArtifactHeader, ArtifactBody } from '../domains/artifacts/artifactTypes';
import { AES256Encryption } from './encryptor';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { syncPerformanceTelemetry } from '../runtime/syncPerformanceTelemetry';

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
    
    /**
     * Encrypt artifact header
     */
    async encryptHeader(header: ArtifactHeader): Promise<string> {
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
     * Decrypt artifact header
     */
    async decryptHeader(encryptedHeader: string): Promise<ArtifactHeader | null> {
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
            const header = decrypted[0] as Record<string, unknown>;
            if (typeof header !== 'object' || header === null || Array.isArray(header)) {
                return null;
            }
            const title = typeof header.title === 'string' ? header.title : null;
            const v = sanitizeArtifactHeaderVersion(header.v);
            const kindRaw = typeof header.kind === 'string' ? String(header.kind).trim() : '';
            const kind = kindRaw || 'artifact.legacy';

            const sessionsRaw = header.sessions;
            const sessions = Array.isArray(sessionsRaw)
                ? sessionsRaw.map((v: unknown) => String(v ?? '').trim()).filter(Boolean)
                : undefined;
            const draftRaw = header.draft;
            const draft = typeof draftRaw === 'boolean' ? draftRaw : undefined;

            return {
                ...sanitizeArtifactHeaderPassthrough(header),
                v,
                kind,
                title,
                ...(sessions ? { sessions } : {}),
                ...(draft !== undefined ? { draft } : {}),
            };
        } catch (error) {
            console.error('Failed to decrypt artifact header:', error);
            return null;
        }
    }
    
    /**
     * Encrypt artifact body
     */
    async encryptBody(body: ArtifactBody): Promise<string> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.artifact.encryptBody',
            { items: 1 },
            async () => {
                const encrypted = await this.encryptor.encrypt([body]);
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
            const body = decrypted[0] as any;
            if (typeof body !== 'object' || body === null) {
                return null;
            }
            return {
                body: typeof body.body === 'string' ? body.body : null
            };
        } catch (error) {
            console.error('Failed to decrypt artifact body:', error);
            return null;
        }
    }
}
