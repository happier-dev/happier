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

    it('accepts padded numeric chunk sizes', () => {
        expect(resolveStreamingTtsChunkChars(' 128 ')).toBe(128);
    });

    describe('aggressive first chunk (time-to-first-audio)', () => {
        it('flushes the first chunk early on the first sentence terminator, well below the steady-state bound', () => {
            const chunker = createTtsChunker(200);
            // The first terminator arrives far before the 200-char steady-state bound.
            const chunks = chunker.push('Sure. Let me walk through the full explanation that follows afterwards.');
            expect(chunks[0]).toBe('Sure.');
        });

        it('flushes the first chunk on a clause comma when no terminator has arrived yet', () => {
            const chunker = createTtsChunker(200);
            const chunks = chunker.push('Okay then, here is a much longer continuation that keeps streaming in.');
            expect(chunks[0]).toBe('Okay then,');
        });

        it('flushes the first chunk after a small word budget when no early punctuation exists', () => {
            const chunker = createTtsChunker(200);
            // No early terminator/comma; should still cut after a few words so audio starts fast.
            const chunks = chunker.push('one two three four five six seven eight nine ten eleven twelve thirteen');
            expect(chunks.length).toBeGreaterThan(0);
            // The aggressive first chunk should be short (<= ~6 words).
            expect(chunks[0]!.split(/\s+/).length).toBeLessThanOrEqual(6);
        });

        it('uses the larger steady-state bound only after the first chunk has been emitted', () => {
            const chunker = createTtsChunker(60);
            const first = chunker.push('Hi there. ');
            expect(first).toEqual(['Hi there.']);
            // Steady-state: no early flush until punctuation or the larger bound is reached.
            const second = chunker.push('this is a steady state fragment without any terminator yet');
            expect(second).toEqual([]);
        });
    });

    describe('abbreviation and decimal guards', () => {
        it('does not split on a period inside a decimal number', () => {
            const chunker = createTtsChunker(200);
            chunker.push('The value is 3.14159 and the rest of the sentence continues for a while longer here.');
            // The aggressive first chunk must not be cut at "3." — it should run to a real boundary.
            const flushed = chunker.flush();
            const all = flushed.join(' ');
            // No emitted chunk should end at the decimal point.
            expect(all).not.toMatch(/\b3\.$/m);
        });

        it('does not split on a known abbreviation like "e.g."', () => {
            const chunker = createTtsChunker(200);
            const chunks = chunker.push('Use a tool, e.g. the editor, before you continue with the longer reply afterwards.');
            // First chunk should flush at the clause comma, not at "e.g."
            expect(chunks[0]).toBe('Use a tool,');
            expect(chunks.join(' ')).not.toMatch(/e\.g\.$/m);
        });

        it('does not split on "Dr." abbreviation', () => {
            const chunker = createTtsChunker(200);
            const flushed: string[] = [];
            for (const c of chunker.push('Dr. Smith arrived and then the rest of the explanation kept going for some time.')) {
                flushed.push(c);
            }
            for (const c of chunker.flush()) flushed.push(c);
            // "Dr." must never be the trailing token of a chunk.
            for (const chunk of flushed) {
                expect(chunk.endsWith('Dr.')).toBe(false);
            }
        });
    });

    it('drains all text without loss across push and flush', () => {
        const chunker = createTtsChunker(40);
        const input = 'First sentence here. Second one follows. And a third trailing fragment without terminator';
        const collected: string[] = [];
        for (const c of chunker.push(input)) collected.push(c);
        for (const c of chunker.flush()) collected.push(c);
        // Concatenating chunks (normalizing whitespace) should reproduce the input words.
        const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
        expect(normalize(collected.join(' '))).toBe(normalize(input));
    });
});
