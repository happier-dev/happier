import { describe, expect, it } from 'vitest';

import { createTtsChunker, resolveStreamingTtsChunkChars } from './TtsChunker';

describe('TtsChunker', () => {
    it('emits chunks near punctuation boundaries', () => {
        const chunker = createTtsChunker(32);
        const chunks = chunker.push('hello world. this sentence is long enough to emit a chunk near punctuation.');
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0]).toContain('hello world.');
    });

    it('flushes remaining buffered text', () => {
        const chunker = createTtsChunker(32);
        expect(chunker.push('small fragment')).toEqual([]);
        expect(chunker.flush()).toEqual(['small fragment']);
    });

    it('bounds configured chunk size', () => {
        expect(resolveStreamingTtsChunkChars(undefined)).toBe(200);
        expect(resolveStreamingTtsChunkChars(1)).toBe(32);
        expect(resolveStreamingTtsChunkChars(10_000)).toBe(2000);
        expect(resolveStreamingTtsChunkChars(128)).toBe(128);
    });
});
