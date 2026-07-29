import { describe, expect, it } from 'vitest';

import { resolveVirtualizedListBackend } from '../resolveVirtualizedListBackend';

describe('resolveVirtualizedListBackend', () => {
    it('resolves auto to Legend on native platforms', () => {
        expect(resolveVirtualizedListBackend({ preference: 'auto', platformOS: 'ios' })).toBe('legend');
        expect(resolveVirtualizedListBackend({ preference: 'auto', platformOS: 'android' })).toBe('legend');
    });

    it('resolves auto to Legend on web', () => {
        expect(resolveVirtualizedListBackend({ preference: 'auto', platformOS: 'web' })).toBe('legend');
    });

    it('defaults to auto behavior when preference is omitted', () => {
        expect(resolveVirtualizedListBackend({ platformOS: 'web' })).toBe('legend');
        expect(resolveVirtualizedListBackend({ platformOS: 'ios' })).toBe('legend');
    });

    it('honors an explicit backend preference on every platform', () => {
        expect(resolveVirtualizedListBackend({ preference: 'legend', platformOS: 'web' })).toBe('legend');
        expect(resolveVirtualizedListBackend({ preference: 'legend', platformOS: 'ios' })).toBe('legend');
        expect(resolveVirtualizedListBackend({ preference: 'flat', platformOS: 'ios' })).toBe('flat');
    });
});
