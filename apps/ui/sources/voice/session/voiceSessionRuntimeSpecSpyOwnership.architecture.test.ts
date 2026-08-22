import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const SPEC_PATH = 'sources/voice/session/VoiceSessionRuntime.spec.tsx';

/**
 * `it(` / `it.each(` / `test(` and their modifiers, up to the opening paren of the call.
 * A match inside a string or comment is harmless: it just yields a span with no spy in it.
 */
const TEST_DECLARATION = /\b(?:it|test)(?:\.(?:each|for|only|skip|todo|fails|concurrent|sequential)\b[^(\n]*)?\(/g;

const SPY_CONSTRUCTION = /\bvi\.fn[<(]/g;

/**
 * Index of the `)` that closes the `(` at `openIndex`, skipping string, template and
 * comment content so that a paren inside a literal cannot end the span early.
 */
function findClosingParen(source: string, openIndex: number): number {
    let depth = 0;
    for (let index = openIndex; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1];

        if (char === '/' && next === '/') {
            index = source.indexOf('\n', index);
            if (index === -1) return source.length - 1;
            continue;
        }
        if (char === '/' && next === '*') {
            const close = source.indexOf('*/', index + 2);
            index = close === -1 ? source.length : close + 1;
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            const quote = char;
            index += 1;
            while (index < source.length && source[index] !== quote) {
                if (source[index] === '\\') index += 1;
                index += 1;
            }
            continue;
        }
        if (char === '(') depth += 1;
        if (char === ')') {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return source.length - 1;
}

/** Character spans covered by every test declaration, including the `it.each(...)(...)` tail. */
function findTestSpans(source: string): ReadonlyArray<Readonly<{ start: number; end: number }>> {
    const spans: Array<{ start: number; end: number }> = [];
    for (const match of source.matchAll(TEST_DECLARATION)) {
        const start = (match.index ?? 0) + match[0].length - 1;
        let end = findClosingParen(source, start);

        const tail = source.slice(end + 1).match(/^\s*\(/);
        if (tail) end = findClosingParen(source, end + tail[0].length);

        spans.push({ start, end });
    }
    return spans;
}

function lineOf(source: string, index: number): number {
    return source.slice(0, index).split('\n').length;
}

describe('VoiceSessionRuntime spec spy ownership', () => {
    /**
     * `@vitest/spy` adds every `vi.fn()` to a module-level `Set` it never prunes, and neither
     * `vi.restoreAllMocks()` nor `mockReset()` releases the implementation a spy was built with.
     * A spy constructed inside a test body therefore keeps that body's closure context — and so
     * the module generation the test imported after `vi.resetModules()` — alive for the whole
     * file. At ~525 MB per generation the spec grew by about a generation per test and blew
     * through Node's 4192 MB default old-space limit by its eighth test, so it only ran under
     * an explicitly raised heap — unenforced coverage rather than a lane the suite carries.
     *
     * Every spy the spec uses is built by a module-scope factory instead. This guard fails if
     * one is constructed inside a test body again.
     */
    it('builds every spy at module scope so no test body pins its module generation', async () => {
        const source = await readFile(SPEC_PATH, 'utf8');
        const spans = findTestSpans(source);

        expect(spans.length).toBeGreaterThan(0);

        const offenders = [...source.matchAll(SPY_CONSTRUCTION)]
            .map((match) => match.index ?? 0)
            .filter((index) => spans.some((span) => index > span.start && index < span.end))
            .map((index) => `${SPEC_PATH}:${lineOf(source, index)}`);

        expect(offenders).toEqual([]);
    });
});
