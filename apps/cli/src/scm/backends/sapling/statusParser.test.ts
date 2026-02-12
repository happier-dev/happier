import { describe, expect, it } from 'vitest';

import { parseSaplingStatusLine } from './statusParser';

describe('sapling status parser', () => {
    it('maps unresolved conflict status to conflicted entry kind', () => {
        const parsed = parseSaplingStatusLine('U conflicted.txt');

        expect(parsed).toEqual({
            kind: 'conflicted',
            path: 'conflicted.txt',
            pendingStatus: 'U',
        });
    });

    it('maps primary status codes to stable entry kinds', () => {
        expect(parseSaplingStatusLine('M modified.txt')).toEqual({
            kind: 'modified',
            path: 'modified.txt',
            pendingStatus: 'M',
        });
        expect(parseSaplingStatusLine('A added.txt')).toEqual({
            kind: 'added',
            path: 'added.txt',
            pendingStatus: 'A',
        });
        expect(parseSaplingStatusLine('R removed.txt')).toEqual({
            kind: 'deleted',
            path: 'removed.txt',
            pendingStatus: 'D',
        });
        expect(parseSaplingStatusLine('? untracked.txt')).toEqual({
            kind: 'untracked',
            path: 'untracked.txt',
            pendingStatus: '?',
        });
    });
});
