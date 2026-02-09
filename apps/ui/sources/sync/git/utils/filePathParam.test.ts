import { describe, expect, it } from 'vitest';

import { decodeSessionFilePathParam } from './filePathParam';

describe('decodeSessionFilePathParam', () => {
    it('decodes URI-encoded route params', () => {
        expect(decodeSessionFilePathParam('src%2Fgit%2Ff%C3%BCn.ts')).toBe('src/git/fün.ts');
    });

    it('decodes legacy UTF-8 base64 route params', () => {
        const legacy = Buffer.from('src/legacy/éxample.ts', 'utf-8').toString('base64');
        expect(decodeSessionFilePathParam(legacy)).toBe('src/legacy/éxample.ts');
    });

    it('returns plain values as-is', () => {
        expect(decodeSessionFilePathParam('src/plain.ts')).toBe('src/plain.ts');
        expect(decodeSessionFilePathParam('src/path')).toBe('src/path');
    });

    it('returns input when decoding fails', () => {
        expect(decodeSessionFilePathParam('%E0%A4%A')).toBe('%E0%A4%A');
    });
});
