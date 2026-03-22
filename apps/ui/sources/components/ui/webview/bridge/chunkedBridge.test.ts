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

        let seen: any = null;
        for (const message of encoded.slice(0, Math.floor(encoded.length / 2))) {
            const decoded = decodeChunkedEnvelope({ message });
            if (decoded) {
                seen = decoded;
                break;
            }
        }
        expect(seen).toBeNull();

        const restDecoded = encoded.slice(Math.floor(encoded.length / 2)).map((message) => decodeChunkedEnvelope({ message }));
        const finals = restDecoded.filter((item) => item !== null);
        expect(finals).toHaveLength(1);
        expect(finals[0]).toEqual(envelope);
    });

    it('evicts stale incomplete chunk assemblies after the ttl expires', () => {
        const staleEnvelope = { v: 1 as const, type: 'doc', payload: { doc: 'stale'.repeat(60_000) } };
        const freshEnvelope = { v: 1 as const, type: 'doc', payload: { doc: 'fresh'.repeat(60_000) } };
        const staleChunks = encodeChunkedEnvelope({ envelope: staleEnvelope, maxChunkBytes: 2_000, messageId: 'm4-stale' });
        const freshChunks = encodeChunkedEnvelope({ envelope: freshEnvelope, maxChunkBytes: 2_000, messageId: 'm4-fresh' });

        expect(decodeChunkedEnvelope({ message: staleChunks[0]!, nowMs: 0, pendingTtlMs: 5_000 })).toBeNull();
        expect(decodeChunkedEnvelope({ message: freshChunks[0]!, nowMs: 6_000, pendingTtlMs: 5_000 })).toBeNull();

        const staleDecoded = staleChunks
            .slice(1)
            .map((message) => decodeChunkedEnvelope({ message, nowMs: 6_000, pendingTtlMs: 5_000 }))
            .find((item) => item !== null) ?? null;
        expect(staleDecoded).toBeNull();

        const freshDecoded = freshChunks
            .slice(1)
            .map((message) => decodeChunkedEnvelope({ message, nowMs: 6_000, pendingTtlMs: 5_000 }))
            .find((item) => item !== null);
        expect(freshDecoded).toEqual(freshEnvelope);
    });

    it('evicts the oldest incomplete assembly when the pending limit is exceeded', () => {
        const firstEnvelope = { v: 1 as const, type: 'doc', payload: { doc: 'first'.repeat(60_000) } };
        const secondEnvelope = { v: 1 as const, type: 'doc', payload: { doc: 'second'.repeat(60_000) } };
        const firstChunks = encodeChunkedEnvelope({ envelope: firstEnvelope, maxChunkBytes: 2_000, messageId: 'm5-first' });
        const secondChunks = encodeChunkedEnvelope({ envelope: secondEnvelope, maxChunkBytes: 2_000, messageId: 'm5-second' });

        expect(decodeChunkedEnvelope({ message: firstChunks[0]!, maxPendingMessages: 1 })).toBeNull();
        expect(decodeChunkedEnvelope({ message: secondChunks[0]!, maxPendingMessages: 1 })).toBeNull();

        const secondDecoded = secondChunks
            .slice(1)
            .map((message) => decodeChunkedEnvelope({ message, maxPendingMessages: 1 }))
            .find((item) => item !== null);
        expect(secondDecoded).toEqual(secondEnvelope);

        const firstDecoded = firstChunks
            .slice(1)
            .map((message) => decodeChunkedEnvelope({ message, maxPendingMessages: 1 }))
            .find((item) => item !== null) ?? null;
        expect(firstDecoded).toBeNull();
    });

    it('rejects malformed non-chunk envelopes instead of returning them as-is', () => {
        expect(
            decodeChunkedEnvelope({
                message: { v: 1, type: 42 as unknown as string, payload: null },
            }),
        ).toBeNull();
        expect(
            decodeChunkedEnvelope({
                message: { v: 2 as 1, type: 'init', payload: {} },
            }),
        ).toBeNull();
    });

    it('rejects chunk envelopes that declare too many parts', () => {
        expect(() =>
            decodeChunkedEnvelope({
                message: {
                    v: 1,
                    type: 'chunk',
                    payload: {
                        messageId: 'too-many',
                        index: 0,
                        total: 2 ** 32,
                        data: 'YQ==',
                    },
                },
            }),
        ).not.toThrow();
    });
});
