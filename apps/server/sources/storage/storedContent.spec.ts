import { describe, expect, it } from 'vitest';
import { WORKFLOW_RUN_CIPHERTEXT_PREFIX } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { encodeStoredContent, decodeStoredContent, encodeStoredText, decodeStoredText } from './storedContent';

describe('lossless stored content bytes', () => {
    it('shares the message encoder for canonical root envelopes and preserves additional fields', () => {
        for (const content of [{ t: 'encrypted', c: 'AAEC' }, { t: 'encrypted', c: 'AAEC', binding: 'test' }]) {
            const stored = encodeStoredContent(content);
            expect(stored.contentBytes).toEqual(new Uint8Array([0, 1, 2]));
            expect(decodeStoredContent(stored)).toEqual(content);
        }
    });
    it('preserves text serialization and bare ciphertext without decrypting', () => {
        for (const value of ['AAEC', '{"t":"encrypted","c":"AAEC"}', '{"binding":"test","c":"AAEC","t":"encrypted"}']) {
            const stored = encodeStoredText(value);
            expect(stored.bytes).toEqual(new Uint8Array([0, 1, 2]));
            expect(decodeStoredText(stored.value, stored.bytes)).toBe(value);
        }
    });
    it('preserves the Workflow ciphertext kind and envelope shell', () => {
        const content = { t: 'encrypted', c: WORKFLOW_RUN_CIPHERTEXT_PREFIX + 'AAEC' };
        const value = JSON.stringify(content);
        const stored = encodeStoredText(value);
        expect(stored.bytes).toEqual(new Uint8Array([0, 1, 2]));
        expect(decodeStoredText(stored.value, stored.bytes)).toBe(value);
        expect(decodeStoredContent(encodeStoredContent(content))).toEqual(content);
    });
    it('keeps plain, noncanonical and historical representations exact', () => {
        for (const value of [null, '{"t":"plain","v":"AAEC"}', 'AB==', 'opaque', '{ "t":"encrypted", "c":"AAEC" }']) {
            const stored = encodeStoredText(value);
            expect(stored.bytes).toBeNull();
            expect(stored.value).toBe(value);
            expect(decodeStoredText(value, null)).toBe(value);
        }
        for (const content of [{ t: 'plain', v: 'AAEC' }, { t: 'encrypted', c: 'AB==' }, { sealedPayload: { ciphertext: 'AAEC' } }]) {
            const stored = encodeStoredContent(content);
            expect(stored.contentBytes).toBeNull();
            expect(decodeStoredContent(stored)).toBe(content);
        }
    });
});
