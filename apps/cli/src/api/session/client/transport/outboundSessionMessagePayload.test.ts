import { describe, expect, it } from 'vitest';

import { decodeBase64, decrypt } from '../../../encryption';
import { buildOutboundSessionMessagePayload as encode } from './outboundSessionMessagePayload';

describe('outbound Session message payload', () => {
    it('preserves plain content without acquiring a transport or encryption material', () => {
        const content = { role: 'agent', content: { text: 'hello' } };
        expect(encode({ mode: 'plain', ctx: null }, content)).toEqual({ t: 'plain', v: content });
    });

    it.each(['legacy', 'dataKey'] as const)('seals %s content for the existing message reader', encryptionVariant => {
        const encryptionKey = new Uint8Array(32).fill(7);
        const content = { role: 'agent', content: { text: 'private' } };
        const payload = encode({ mode: 'e2ee', ctx: { encryptionKey, encryptionVariant } }, content);
        expect(typeof payload).toBe('string');
        if (typeof payload !== 'string') throw new Error('Expected encrypted payload');
        expect(decrypt(encryptionKey, encryptionVariant, decodeBase64(payload))).toEqual(content);
    });
});
