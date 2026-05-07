import { describe, expect, it } from 'vitest';

import {
    computeLineContentHash,
    findLineIndexByContentHash,
    isLineContentHash,
    normalizeLineContentForHash,
} from './lineContentHash';

describe('lineContentHash', () => {
    it('computes a stable reusable hash for exact line content', () => {
        const first = computeLineContentHash('const value = 1;');
        const second = computeLineContentHash('const value = 1;');

        expect(first).toBe(second);
        expect(isLineContentHash(first)).toBe(true);
    });

    it('changes when line content changes, including whitespace', () => {
        expect(computeLineContentHash('const value = 1;')).not.toBe(computeLineContentHash('const value = 2;'));
        expect(computeLineContentHash('const value = 1;')).not.toBe(computeLineContentHash('  const value = 1;'));
    });

    it('normalizes newline encodings without trimming meaningful line content', () => {
        expect(normalizeLineContentForHash('hello\r\n')).toBe('hello\n');
        expect(normalizeLineContentForHash('hello  ')).toBe('hello  ');
    });

    it('finds a line by reusable content hash with optional candidate filtering', () => {
        const lines = [
            { side: 'before', text: 'const oldValue = 1;' },
            { side: 'after', text: 'const value = 2;' },
            { side: 'before', text: 'const value = 2;' },
        ] as const;

        const lineHash = computeLineContentHash('const value = 2;');

        expect(findLineIndexByContentHash({
            lines,
            lineHash,
            getLineContent: (line) => line.text,
            isCandidate: (line) => line.side === 'after',
        })).toBe(1);
    });
});
