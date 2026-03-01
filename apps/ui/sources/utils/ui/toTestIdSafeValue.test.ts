import { describe, expect, it } from 'vitest';

import { toTestIdSafeValue } from './toTestIdSafeValue';

describe('toTestIdSafeValue', () => {
    it('replaces unsafe characters with underscores', () => {
        expect(toTestIdSafeValue('file:src/a b.ts')).toBe('file_src_a_b.ts');
        expect(toTestIdSafeValue('scmReview:working')).toBe('scmReview_working');
        expect(toTestIdSafeValue('src/a/b.ts')).toBe('src_a_b.ts');
    });

    it('trims whitespace', () => {
        expect(toTestIdSafeValue('  hi  ')).toBe('hi');
    });
});
