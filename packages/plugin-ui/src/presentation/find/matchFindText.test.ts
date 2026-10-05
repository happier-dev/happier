import { describe, expect, it } from 'vitest';
import { matchFindText } from './matchFindText.js';

const literal = { matchCase: false, regex: false };

describe('matchFindText', () => {
    it('matches literal whitespace and backslashes verbatim, without trimming', () => {
        expect(matchFindText(' a  a ', ' a ', literal)).toEqual({ ranges: [[0, 3], [3, 6]] });
        expect(matchFindText('C:\\work\\file C:\\work\\other', '\\work\\', literal)).toEqual({ ranges: [[2, 8], [15, 21]] });
        expect(matchFindText('.* a.*b', '.*', literal)).toEqual({ ranges: [[0, 2], [4, 6]] });
        expect(matchFindText('   ', ' ', literal)).toEqual({ ranges: [[0, 1], [1, 2], [2, 3]] });
    });

    it('uses non-overlapping UTF-16 ranges across emoji and case variants', () => {
        expect(matchFindText('😀Aa aa', 'aa', literal)).toEqual({ ranges: [[2, 4], [5, 7]] });
        expect(matchFindText('😀Aa aa', 'aa', { ...literal, matchCase: true })).toEqual({ ranges: [[5, 7]] });
        expect(matchFindText('aaaa', 'aa', literal)).toEqual({ ranges: [[0, 2], [2, 4]] });
        expect(matchFindText('İx x', 'x', literal)).toEqual({ ranges: [[1, 2], [3, 4]] });
    });

    it('reports invalid regex distinctly and treats an empty query as idle', () => {
        expect(matchFindText('text', '[', { ...literal, regex: true })).toEqual({ invalidPattern: true });
        expect(matchFindText('text', '', { ...literal, regex: true })).toEqual({ ranges: [] });
    });

    it('makes zero-width regex progress by Unicode scalar while keeping UTF-16 offsets', () => {
        expect(matchFindText('😀a', '(?=.)', { ...literal, regex: true })).toEqual({ ranges: [[0, 0], [2, 2]] });
        expect(matchFindText('😀a', '^|$', { ...literal, regex: true })).toEqual({ ranges: [[0, 0], [3, 3]] });
        expect(matchFindText('ab', 'a*', { ...literal, regex: true })).toEqual({ ranges: [[0, 1], [1, 1], [2, 2]] });
    });
});
