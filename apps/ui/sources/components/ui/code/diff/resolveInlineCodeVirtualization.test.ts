import { describe, expect, it } from 'vitest';

import { resolveInlineCodeVirtualization } from './resolveInlineCodeVirtualization';

describe('resolveInlineCodeVirtualization', () => {
    it('returns false when no thresholds are provided', () => {
        expect(resolveInlineCodeVirtualization({ text: 'a\n', lineThreshold: 0, byteThreshold: 0 })).toBe(false);
        expect(resolveInlineCodeVirtualization({ text: 'a\n', lineThreshold: -1, byteThreshold: undefined })).toBe(false);
    });

    it('virtualizes when byte threshold is exceeded', () => {
        expect(resolveInlineCodeVirtualization({ text: 'a'.repeat(2_000), lineThreshold: 50_000, byteThreshold: 100 })).toBe(true);
    });

    it('virtualizes when line threshold is exceeded', () => {
        const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n') + '\n';
        expect(resolveInlineCodeVirtualization({ text, lineThreshold: 4, byteThreshold: 1_000_000 })).toBe(true);
        expect(resolveInlineCodeVirtualization({ text, lineThreshold: 20, byteThreshold: 1_000_000 })).toBe(false);
    });
});
