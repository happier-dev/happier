import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { z } from 'zod/mini';
import * as privacyKit from 'privacy-kit';
import type { BinaryBlobStoredContentV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { encryptBytes, decryptBytes, encryptBytesChunks, symmetricEnvelopeOverheadBytes } from '@/modules/encrypt';
import type { PrivateFileWrite } from './privateFiles';
import { readEncryptionFeatureEnv } from '@/app/features/catalog/readFeatureEnv';
import { readPrivateFile } from '@/storage/blob/files';

const PlainBinaryFileSchema = createStoredReadSchema(z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('plain'), v: z.string() }),
    z.strictObject({ t: z.literal('sealed_v1'), c: z.string() }),
]));

/** Only a successfully staged transfer supplies the temp file and its measured facts. */
export type PrivateBinaryContentInput = BinaryBlobStoredContentV1 | Readonly<{
    t: BinaryBlobStoredContentV1['t'];
    staged: Readonly<{ tempPath: string; sizeBytes: number; sha256: string }>;
}>;

async function* stagedFileChunks(path: string): AsyncGenerator<Uint8Array> {
    for await (const chunk of createReadStream(path)) yield chunk;
}

async function* base64JsonChunks(prefix: string, chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    yield Buffer.from(prefix);
    // Base64 groups three input bytes. Only the final quantum can add padding.
    let carry = Buffer.alloc(0);
    for await (const chunk of chunks) {
        const bytes = carry.byteLength ? Buffer.concat([carry, chunk]) : chunk;
        const end = bytes.byteLength - bytes.byteLength % 3;
        if (end) yield Buffer.from(privacyKit.encodeBase64(Uint8Array.from(bytes.subarray(0, end))));
        carry = Buffer.from(bytes.subarray(end));
    }
    if (carry.byteLength) yield Buffer.from(privacyKit.encodeBase64(carry));
    yield Buffer.from('"}');
}

/** Resource adapters supply their established at-rest namespace, never authorization. */
export function preparePrivateBinaryContent(path: string[], content: PrivateBinaryContentInput): Readonly<{
    stored: PrivateFileWrite; sizeBytes: number; contentSha256: string;
}> {
    const sealed = content.t === 'plain' && readEncryptionFeatureEnv(process.env).plainAccountArtifactsAtRest !== 'none';
    if ('staged' in content) {
        const { tempPath, sizeBytes, sha256 } = content.staged;
        const chunks = stagedFileChunks(tempPath);
        if (content.t === 'encrypted') return { stored: { chunks, byteLength: sizeBytes }, sizeBytes, contentSha256: sha256 };
        const prefix = sealed ? '{"t":"sealed_v1","c":"' : '{"t":"plain","v":"';
        const wrappedBytes = sizeBytes + (sealed ? symmetricEnvelopeOverheadBytes : 0);
        const stored = { chunks: base64JsonChunks(prefix, sealed ? encryptBytesChunks(path, chunks) : chunks),
            byteLength: prefix.length + 4 * Math.ceil(wrappedBytes / 3) + 2 };
        return { stored, sizeBytes, contentSha256: sha256 };
    }

    const bytes = new Uint8Array(privacyKit.decodeBase64(content.t === 'plain' ? content.v : content.c));
    const wrapper = sealed ? { t: 'sealed_v1', c: privacyKit.encodeBase64(encryptBytes(path, bytes)) } : content;
    const stored = content.t === 'encrypted' ? bytes : new TextEncoder().encode(JSON.stringify(wrapper));
    return { stored, sizeBytes: bytes.byteLength, contentSha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Explicit persisted mode selects decoding; opaque ciphertext never falls back to Plain. */
export async function openPrivateBinaryContent(path: string[], row: Readonly<{
    storageKey: string; encryptionMode: string;
}>): Promise<Uint8Array> {
    const stored = await readPrivateFile(row.storageKey);
    if (row.encryptionMode === 'e2ee') return stored;
    if (row.encryptionMode !== 'plain') throw new Error('Private binary content mode is unavailable');
    const parsed = PlainBinaryFileSchema.parse(JSON.parse(new TextDecoder().decode(stored)));
    return parsed.t === 'plain' ? new Uint8Array(privacyKit.decodeBase64(parsed.v))
        : new Uint8Array(decryptBytes(path, privacyKit.decodeBase64(parsed.c)));
}
