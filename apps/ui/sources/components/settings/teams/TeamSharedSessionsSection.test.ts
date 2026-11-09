import { describe, expect, it } from 'vitest';

import { resolveSharedSessionsLoadReserve } from './TeamSharedSessionsSection';

describe('resolveSharedSessionsLoadReserve', () => {
    it('keeps the empty line\'s height, not a skeleton that would collapse, when this device already holds an empty list', () => {
        expect(resolveSharedSessionsLoadReserve({ loading: true, held: true, itemCount: 0 })).toBe('line');
    });
    it('reserves the rows it may show when nothing is held yet', () => {
        expect(resolveSharedSessionsLoadReserve({ loading: true, held: false, itemCount: 0 })).toBe('rows');
    });
    it('reserves nothing once rows are shown or the read settled', () => {
        expect(resolveSharedSessionsLoadReserve({ loading: true, held: true, itemCount: 2 })).toBe('none');
        expect(resolveSharedSessionsLoadReserve({ loading: false, held: true, itemCount: 0 })).toBe('none');
    });
});
