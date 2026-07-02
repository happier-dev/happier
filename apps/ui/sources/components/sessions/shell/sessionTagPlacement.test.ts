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

    it('places compact tags inline when their combined labels fit the inline budget', () => {
        expect(resolveSessionTagPlacement({
            density: 'compact',
            tags: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
            rowWidth: null,
            hasTrailingMeta: true,
            hasRowActions: false,
        })).toBe('inline');
    });

    it('keeps compact tags below when their combined labels exceed the inline budget', () => {
        expect(resolveSessionTagPlacement({
            density: 'compact',
            tags: [{ label: 'tag' }, { label: 'tag 12' }, { label: 'tag 3' }],
            rowWidth: null,
            hasTrailingMeta: true,
            hasRowActions: false,
        })).toBe('below');
    });

    it('keeps cozy tags below when the leading identity leaves only a small inline budget', () => {
        expect(resolveSessionTagPlacement({
            density: 'compact',
            tags: [{ label: 'tag' }, { label: 'tag 2' }],
            rowWidth: null,
            hasTrailingMeta: true,
            hasRowActions: false,
            hasLeadingIdentity: true,
        })).toBe('below');
    });

    it('places the same cozy tags inline when the leading identity is hidden', () => {
        expect(resolveSessionTagPlacement({
            density: 'compact',
            tags: [{ label: 'tag' }, { label: 'tag 2' }],
            rowWidth: null,
            hasTrailingMeta: true,
            hasRowActions: false,
            hasLeadingIdentity: false,
        })).toBe('inline');
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

    it('keeps short compact tags inline even when they take modest title space', () => {
        expect(resolveSessionTagPlacement({
            density: 'compact',
            tags: [{ label: 'v2' }],
            rowWidth: 250,
            hasTrailingMeta: true,
            hasRowActions: false,
        })).toBe('inline');
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
