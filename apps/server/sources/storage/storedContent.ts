import { readCanonicalPaddedBase64DecodedLength } from '@happier-dev/protocol/crypto/base64';
import { WORKFLOW_RUN_CIPHERTEXT_PREFIX } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import * as privacyKit from 'privacy-kit';
import { prismaRuntime } from './prisma';

interface EncryptedContent {
    readonly t: 'encrypted';
    readonly c: string;
    readonly [key: string]: unknown;
}

function isEncryptedContent(content: unknown): content is EncryptedContent {
    return typeof content === 'object' && content !== null && !Array.isArray(content)
        && 't' in content && content.t === 'encrypted' && 'c' in content && typeof content.c === 'string';
}

function readCiphertext(ciphertext: string): { prefix: string; bytes: Uint8Array<ArrayBuffer> } | null {
    const prefix = ciphertext.startsWith(WORKFLOW_RUN_CIPHERTEXT_PREFIX) ? WORKFLOW_RUN_CIPHERTEXT_PREFIX : '';
    const base64 = ciphertext.slice(prefix.length);
    if (readCanonicalPaddedBase64DecodedLength(base64) === null) return null;
    return { prefix, bytes: privacyKit.decodeBase64(base64) };
}

/** Physical encoding only: never decrypts or changes the domain/wire envelope. */
export function encodeStoredContent<T>(content: T): { content: T | null; contentBytes: Uint8Array<ArrayBuffer> | null } {
    if (!isEncryptedContent(content)) return { content, contentBytes: null };
    const ciphertext = readCiphertext(content.c);
    if (!ciphertext) return { content, contentBytes: null };
    // Message's historical byte rows use JSON null. Envelopes with extra fields
    // retain those fields and the domain prefix alongside the ciphertext bytes.
    const shell = ciphertext.prefix === '' && Object.keys(content).length === 2
        ? null : { ...content, c: ciphertext.prefix } as T;
    return { content: shell, contentBytes: ciphertext.bytes };
}

export function decodeStoredContent<T>(row: { content: T | null; contentBytes?: Uint8Array | null }): T | null {
    if (row.contentBytes != null) {
        const base64 = privacyKit.encodeBase64(row.contentBytes);
        if (row.content === null) return { t: 'encrypted', c: base64 } as T;
        if (!isEncryptedContent(row.content)) throw new Error('Stored encrypted content representation is invalid');
        return { ...row.content, c: row.content.c + base64 } as T;
    }
    // Opaque legacy values, including JSON null, belong to the domain parser.
    return row.content;
}

/** Prisma JsonNull is confined to this JSON write boundary. */
export function toPrismaStoredContent<T>(content: T | null): T {
    return (content ?? prismaRuntime.JsonNull) as T;
}

/** Compact canonical text without losing bare-vs-JSON spelling or object fields. */
export function encodeStoredText<T extends string | null>(value: T): { value: T; bytes: Uint8Array<ArrayBuffer> | null } {
    if (value === null) return { value, bytes: null };
    const bare = readCiphertext(value);
    if (bare) return { value: bare.prefix as T, bytes: bare.bytes };
    let content: unknown;
    try { content = JSON.parse(value); } catch { return { value, bytes: null }; }
    if (!isEncryptedContent(content) || JSON.stringify(content) !== value) return { value, bytes: null };
    const ciphertext = readCiphertext(content.c);
    if (!ciphertext) return { value, bytes: null };
    return { value: JSON.stringify({ ...content, c: ciphertext.prefix }) as T, bytes: ciphertext.bytes };
}

export function decodeStoredText<T extends string | null>(value: T, bytes?: Uint8Array | null): T {
    if (bytes == null) return value;
    const base64 = privacyKit.encodeBase64(bytes);
    if (value === '' || value === WORKFLOW_RUN_CIPHERTEXT_PREFIX) return (value + base64) as T;
    if (value === null) throw new Error('Stored text representation is unavailable');
    const content: unknown = JSON.parse(value);
    if (!isEncryptedContent(content)) throw new Error('Stored encrypted text representation is invalid');
    return JSON.stringify({ ...content, c: content.c + base64 }) as T;
}
