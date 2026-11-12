import { createCipheriv } from 'node:crypto';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { serializeSessionDataKeyValue } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { describe, expect, it } from 'vitest';
import { multiAgentPage } from '../../../../packages/session-core/src/raw/__fixtures__/multiAgentPage';
import { encodeSessionMessageContentForStorage, decodeSessionMessageContentFromStorage } from './sessionMessageContent';

// Existing public persisted user/Claude/ACP fixtures, encrypted as the released AES V0 bundle.
function fixtureContent(raw: unknown): { t: 'encrypted'; c: string } {
    const nonce = new Uint8Array(12);
    const cipher = createCipheriv('aes-256-gcm', new Uint8Array(32), nonce);
    const ciphertext = Buffer.concat([cipher.update(serializeSessionDataKeyValue(raw), 'utf8'), cipher.final()]);
    return { t: 'encrypted', c: encodeBase64(Buffer.concat([new Uint8Array([0]), nonce, ciphertext, cipher.getAuthTag()])) };
}

describe('SessionMessage physical content storage', () => {
    it('stores real message ciphertext once as raw bytes and preserves its exact wire envelope', () => {
        const measurements = multiAgentPage.map(fixture => {
            const content = fixtureContent(fixture.raw);
            const stored = encodeSessionMessageContentForStorage(content);
            expect(stored.contentBytes).toBeInstanceOf(Uint8Array);
            expect(stored.contentBytes?.length).toBeLessThan(Buffer.byteLength(JSON.stringify(content)));
            expect(stored.content).toBeNull();
            expect(stored.contentBytes).toEqual(decodeBase64(content.c));
            expect(decodeSessionMessageContentFromStorage(stored)).toEqual(content);
            return { fixture: fixture.id, jsonBytes: Buffer.byteLength(JSON.stringify(content)), ciphertextBytes: stored.contentBytes?.length };
        });
        console.info('SessionMessage fixture byte counts', measurements);
    });

    it('keeps predecessor JSON/plain/base64 rows readable without inventing a byte representation', () => {
        const contents: PrismaJson.SessionMessageContent[] = [
            { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Question' } } },
            { t: 'encrypted', c: 'AAECAw==' },
        ];
        for (const content of contents) {
            expect(decodeSessionMessageContentFromStorage({ content, contentBytes: null })).toBe(content);
        }
        expect(encodeSessionMessageContentForStorage(contents[0]!).contentBytes).toBeNull();
    });

    it('fails closed when neither historical JSON nor ciphertext bytes exist', () => {
        expect(() => decodeSessionMessageContentFromStorage({ content: null, contentBytes: null })).toThrow();
    });

    it('preserves accepted opaque noncanonical strings rather than repairing ciphertext', () => {
        for (const c of ['not ciphertext!', 'AAECAw', 'AB==', 'AAEC\nAw==']) {
            const content = { t: 'encrypted' as const, c };
            const stored = encodeSessionMessageContentForStorage(content);
            expect(stored.contentBytes).toBeNull();
            expect(decodeSessionMessageContentFromStorage(stored)).toEqual(content);
        }
        const empty = encodeSessionMessageContentForStorage({ t: 'encrypted', c: '' });
        expect(empty.contentBytes).toEqual(new Uint8Array());
        expect(decodeSessionMessageContentFromStorage(empty)).toEqual({ t: 'encrypted', c: '' });
    });
});
