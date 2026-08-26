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

    it('keeps compact tags in the right area when their combined labels exceed the inline budget', () => {
        expect(resolveSessionTagPlacement({
            density: 'compact',
            tags: [{ label: 'tag' }, { label: 'tag 12' }, { label: 'tag 3' }],
            rowWidth: null,
            hasTrailingMeta: true,
            hasRowActions: false,
        })).toBe('inline');
    });

    it('keeps cozy tags in the right area with a leading identity', () => {
        expect(resolveSessionTagPlacement({
            density: 'compact',
            tags: [{ label: 'tag' }, { label: 'tag 2' }],
            rowWidth: null,
            hasTrailingMeta: true,
            hasRowActions: false,
            hasLeadingIdentity: true,
        })).toBe('inline');
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

    it('does not render tags while actions own the trailing area', () => {
        expect(resolveSessionTagPlacement({
            density: 'compact',
            tags: [{ label: 'v2' }],
            rowWidth: null,
            hasTrailingMeta: false,
            hasRowActions: true,
        })).toBe('inline');
    });

    it('keeps compact tags in the right area when measured width is narrow', () => {
        expect(resolveSessionTagPlacement({
            density: 'compact',
            tags: [{ label: 'v2' }],
            rowWidth: 170,
            hasTrailingMeta: true,
            hasRowActions: false,
        })).toBe('inline');
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

    it('places default-density tags in the right area', () => {
        expect(resolveSessionTagPlacement({
            density: 'default',
            tags: [{ label: 'v2' }],
            rowWidth: 360,
            hasTrailingMeta: true,
            hasRowActions: false,
        })).toBe('inline');
    });
});
