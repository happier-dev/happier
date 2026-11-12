import { createCipheriv, createDecipheriv } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { CONTENT_VALUE_MAX_DECODED_BYTES, frameContentBytes, readContentFrame } from '@happier-dev/protocol/crypto/contentByteCodec';
import { frameSessionDataKeyBundle, readSessionDataKeyBundle } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';

type AesContentItem = Readonly<{ jsonBase64: string; keyBase64: string; nonceBase64: string }>;
type AesOpenItem = Readonly<{ encryptedPayloadBase64: string; keyBase64: string }>;
type OpenResult = Readonly<{ status: 'authenticated'; serializedJson: string }> | Readonly<{ status: 'unsupported' | 'authentication_failed' | 'invalid_payload' }>;

function json(frame: Uint8Array, legacy: boolean): string | null {
    try {
        if (legacy && frame[0] !== 0 && frame[0] !== 1) return new TextDecoder('utf-8', { fatal: true }).decode(frame);
        const content = readContentFrame(frame);
        if (content.status !== 'ready' || (content.encoding === 'raw' && content.bytes.length > CONTENT_VALUE_MAX_DECODED_BYTES)) return null;
        return new TextDecoder('utf-8', { fatal: true }).decode(content.encoding === 'gzip' ? gunzipSync(content.bytes, { maxOutputLength: CONTENT_VALUE_MAX_DECODED_BYTES }) : content.bytes);
    } catch { return null; }
}

function open(item: AesOpenItem): OpenResult {
    const parts = readSessionDataKeyBundle(Buffer.from(item.encryptedPayloadBase64, 'base64'));
    const key = Buffer.from(item.keyBase64, 'base64');
    if (parts.status !== 'ready' || key.length !== 32) return { status: 'unsupported' };
    let opened: Uint8Array;
    try {
        const cipher = createDecipheriv('aes-256-gcm', key, parts.nonce);
        cipher.setAuthTag(parts.authTag);
        opened = Buffer.concat([cipher.update(parts.ciphertext), cipher.final()]);
    } catch { return { status: 'authentication_failed' }; }
    const serializedJson = parts.version === 1 ? json(opened, false) : new TextDecoder().decode(opened);
    return serializedJson === null ? { status: 'invalid_payload' } : { status: 'authenticated', serializedJson };
}

/** Genuine Expo native compression/cipher boundary, implemented with Node's OS APIs. */
export const happierCryptoWorkerStub = {
    async encodeContentValueBase64(encoded: string): Promise<string> {
        const raw = Buffer.from(encoded, 'base64');
        return Buffer.from(frameContentBytes(raw, gzipSync(raw))).toString('base64');
    },
    async decodeContentValueBase64(encoded: string): Promise<string | null> {
        return json(Buffer.from(encoded, 'base64'), true);
    },
    async encryptAesGcmContentBatch(items: readonly AesContentItem[]): Promise<(string | null)[]> {
        return items.map(item => {
            const raw = Buffer.from(item.jsonBase64, 'base64');
            const nonce = Buffer.from(item.nonceBase64, 'base64');
            const cipher = createCipheriv('aes-256-gcm', Buffer.from(item.keyBase64, 'base64'), nonce);
            const ciphertext = Buffer.concat([cipher.update(frameContentBytes(raw, gzipSync(raw))), cipher.final()]);
            return Buffer.from(frameSessionDataKeyBundle(Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]), 1)).toString('base64');
        });
    },
    async openAesGcmContentBatch(items: readonly AesOpenItem[]): Promise<OpenResult[]> { return items.map(open); },
    async decryptAesGcmJsonBatch(items: readonly AesOpenItem[]): Promise<(string | null)[]> {
        return items.map(item => { const result = open(item); return result.status === 'authenticated' ? result.serializedJson : null; });
    },
};
