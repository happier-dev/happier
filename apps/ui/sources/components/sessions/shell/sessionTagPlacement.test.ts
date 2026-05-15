import { describe, expect, it } from 'vitest';

import { resolveSessionTagPlacement } from './sessionTagPlacement';

describe('resolveSessionTagPlacement', () => {
    it('places short compact tags inline when row width is not known yet', () => {
        expect(resolveSessionTagPlacement({
            density: 'compact',
            tags: [{ label: 'v2' }],
            rowWidth: null,
            hasTrailingMeta: true,
            hasRowActions: false,
        })).toBe('inline');
    });

    it('keeps long compact tags below the title', () => {
        expect(resolveSessionTagPlacement({
            density: 'compact',
            tags: [{ label: 'release' }],
            rowWidth: null,
            hasTrailingMeta: true,
            hasRowActions: false,
        })).toBe('below');
    });

    it('keeps compact tags below when actions own the trailing area', () => {
        expect(resolveSessionTagPlacement({
            density: 'compact',
            tags: [{ label: 'v2' }],
            rowWidth: null,
            hasTrailingMeta: false,
            hasRowActions: true,
        })).toBe('below');
    });

    it('keeps compact tags below when measured width would leave too little title room', () => {
        expect(resolveSessionTagPlacement({
            density: 'compact',
            tags: [{ label: 'v2' }],
            rowWidth: 170,
            hasTrailingMeta: true,
            hasRowActions: false,
        })).toBe('below');
    });

    it('does not place default-density tags inline', () => {
        expect(resolveSessionTagPlacement({
            density: 'default',
            tags: [{ label: 'v2' }],
            rowWidth: 360,
            hasTrailingMeta: true,
            hasRowActions: false,
        })).toBe('below');
    });
});
