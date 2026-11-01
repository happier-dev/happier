import { describe, expect, it } from 'vitest';

import { createTtsChunker, resolveStreamingTtsChunkChars, splitSpeechSentences } from './TtsChunker';

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

    it('continues emitting literal brackets inside inline code opened by an earlier chunk', () => {
        const chunker = createTtsChunker(32);
        chunker.push(`First ready. \`${'a'.repeat(40)}`);
        const chunks = chunker.push(`[literal ${'word '.repeat(30)}`);
        expect(chunks.join(' ')).toContain('[literal');
    });

    it('bounds configured chunk size', () => {
        expect(resolveStreamingTtsChunkChars(undefined)).toBe(200);
        expect(resolveStreamingTtsChunkChars(1)).toBe(32);
        expect(resolveStreamingTtsChunkChars(10_000)).toBe(2000);
        expect(resolveStreamingTtsChunkChars(128)).toBe(128);
    });

    it('does not cut inside abbreviations, decimals, or file names', () => {
        const chunker = createTtsChunker(40);
        const text = 'Use tools, e.g. the linter on file.ts with pi 3.14 here and more words follow after that point';
        const chunks = [...chunker.push(text), ...chunker.flush()];
        for (const chunk of chunks) {
            expect(chunk.endsWith('e.')).toBe(false);
            expect(chunk.endsWith('e.g.')).toBe(false);
            expect(chunk.endsWith('file.')).toBe(false);
            expect(chunk.endsWith('3.')).toBe(false);
        }
        expect(chunks.join(' ')).toBe(text);
    });

    it('waits for a code fence to close before emitting it', () => {
        const chunker = createTtsChunker(32);
        const first = chunker.push('Here is code:\n```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n');
        for (const chunk of first) {
            expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
        }
        const rest = [...chunker.push('```\nDone now. That was the code block we wanted.'), ...chunker.flush()];
        for (const chunk of rest) {
            expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
        }
    });

    it('splits text into sentences for sequential synthesis', () => {
        expect(splitSpeechSentences('First one. Second, e.g. this file.ts! Third?', 200)).toEqual([
            'First one.',
            'Second, e.g. this file.ts!',
            'Third?',
        ]);
        expect(splitSpeechSentences('[First sentence. Second sentence.', 200)).toEqual([
            '[First sentence.',
            'Second sentence.',
        ]);
        expect(splitSpeechSentences('[First sentence. Second sentence.](url)', 200)).toEqual([
            '[First sentence.',
            'Second sentence.](url)',
        ]);
    });

    it('bounds a single very long sentence by maxChars', () => {
        const long = 'word '.repeat(100).trim();
        const parts = splitSpeechSentences(long, 50);
        expect(parts.length).toBeGreaterThan(1);
        for (const part of parts) expect(part.length).toBeLessThanOrEqual(50);
        expect(parts.join(' ')).toBe(long);
    });

    it('treats full-width terminators as sentence ends without trailing whitespace', () => {
        expect(splitSpeechSentences('今日は晴れです。明日は雨です！本当？', 200)).toEqual([
            '今日は晴れです。',
            '明日は雨です！',
            '本当？',
        ]);
    });

    it('never splits a surrogate pair on a hard cut', () => {
        const emoji = '😀'.repeat(40);
        const parts = splitSpeechSentences(emoji, 33);
        expect(parts.join('')).toBe(emoji);
        for (const part of parts) {
            expect(part).not.toMatch(/[\uD800-\uDBFF]$/);
            expect(part).not.toMatch(/^[\uDC00-\uDFFF]/);
        }
    });

    it('does not cut inside a tilde fence or a longer fence wrapping a backtick fence', () => {
        const chunker = createTtsChunker(32);
        const text = 'Look:\n````md\n```ts\nconst a = 1;\n```\nmore inside the outer fence here\n````\nAnd then plain prose follows after it.';
        const chunks = [...chunker.push(text), ...chunker.flush()];
        const outer = chunks.find((chunk) => chunk.includes('````md'));
        expect(outer).toBeDefined();
        expect(outer).toContain('more inside the outer fence here\n````');

        const tilde = createTtsChunker(32);
        const tildeChunks = [...tilde.push('Intro:\n~~~\nline one. line two. line three.\n~~~\nDone.'), ...tilde.flush()];
        expect(tildeChunks.some((chunk) => chunk.includes('~~~\nline one. line two. line three.\n~~~'))).toBe(true);
    });

    it('never emits code from a reply that ends inside an unterminated fence', () => {
        const chunker = createTtsChunker(32);
        const code = Array.from({ length: 20 }, (_, i) => `const value${i} = compute(${i});`).join('\n');
        const pushed = chunker.push(`Here is the fix.\n\`\`\`ts\n${code}\n`);
        const chunks = [...pushed, ...chunker.flush()];

        expect(chunks.join(' ')).toContain('Here is the fix.');
        for (const chunk of chunks) {
            expect(chunk).not.toContain('compute(');
        }
    });
});
