import { describe, expect, it } from 'vitest';

import { decodeChunkedEnvelope, encodeChunkedEnvelope } from './chunkedBridge';

describe('chunkedBridge', () => {
    it('roundtrips small envelopes without chunking', () => {
        const envelope = { v: 1 as const, type: 'init', payload: { doc: 'hello', readOnly: false } };
        const encoded = encodeChunkedEnvelope({ envelope, maxChunkBytes: 64_000, messageId: 'm1' });
        expect(encoded).toHaveLength(1);
        expect(encoded[0]).toEqual(envelope);

        const decoded = decodeChunkedEnvelope({ message: encoded[0]! });
        expect(decoded).toEqual(envelope);
    });

    it('roundtrips multi-megabyte envelopes via chunks', () => {
        const big = 'x'.repeat(2_500_000);
        const envelope = { v: 1 as const, type: 'doc', payload: { doc: big } };

        const encoded = encodeChunkedEnvelope({ envelope, maxChunkBytes: 64_000, messageId: 'm2' });
        expect(encoded.length).toBeGreaterThan(3);
        expect(encoded.every((m) => m.v === 1)).toBe(true);
        expect(encoded[0]!.type).toBe('chunk');

        const decodedPieces = encoded.map((message) => decodeChunkedEnvelope({ message }));
        const final = decodedPieces.find((item) => item !== null);
        expect(final).toEqual(envelope);
    });

    it('returns null until all chunks are received', () => {
        const envelope = { v: 1 as const, type: 'doc', payload: { doc: 'y'.repeat(200_000) } };
        const encoded = encodeChunkedEnvelope({ envelope, maxChunkBytes: 25_000, messageId: 'm3' });
        expect(encoded.length).toBeGreaterThan(2);

        // Feed only the first half.
        let seen: any = null;
        for (const message of encoded.slice(0, Math.floor(encoded.length / 2))) {
            const decoded = decodeChunkedEnvelope({ message });
            if (decoded) {
                seen = decoded;
                break;
            }
        }
        expect(seen).toBeNull();

        // Now feed the rest; it should decode exactly once.
        const restDecoded = encoded.slice(Math.floor(encoded.length / 2)).map((message) => decodeChunkedEnvelope({ message }));
        const finals = restDecoded.filter((item) => item !== null);
        expect(finals).toHaveLength(1);
        expect(finals[0]).toEqual(envelope);
    });
});

