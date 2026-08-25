import { describe, expect, it } from 'vitest';

import {
    resolveProjectedLocalizedText,
    resolvePluginDisplayString,
} from './resolvePluginDisplayString';

describe('resolvePluginDisplayString', () => {
    it('resolves a keyed plugin value before using its developer fallback', () => {
        expect(resolvePluginDisplayString({
            developerFallback: 'My Plugin Tab',
            keys: ['common.copy'],
            fallback: 'descriptor-id',
        })).toBe('Copy');
    });

    it('uses the projection-bound plugin resolver instead of falling into the host catalog', () => {
        expect(resolvePluginDisplayString({
            developerFallback: 'My Plugin Tab',
            keys: ['common.copy'],
            resolveKey: () => null,
            fallback: 'descriptor-id',
        })).toBe('My Plugin Tab');
        expect(resolvePluginDisplayString({
            developerFallback: 'My Plugin Tab',
            keys: ['plugin.tab.title'],
            resolveKey: (key) => key === 'plugin.tab.title' ? 'Mon onglet' : null,
            fallback: 'descriptor-id',
        })).toBe('Mon onglet');
    });

    it('resolves a translation key when it exists in the catalog', () => {
        expect(resolvePluginDisplayString({
            keys: ['common.copy'],
            fallback: 'descriptor-id',
        })).toBe('Copy');
    });

    it('never leaks an unresolved key and falls through to the fallback', () => {
        expect(resolvePluginDisplayString({
            keys: ['plugin.totally.unknown.titleKey'],
            fallback: 'descriptor-id',
        })).toBe('descriptor-id');
    });

    it('treats *Key candidates as keys, not literals (a raw non-key never renders)', () => {
        // A plugin author who stuffed a human string into `titleKey` instead of
        // `developerFallback` must not have that raw string rendered.
        expect(resolvePluginDisplayString({
            keys: ['Just a raw title not a key'],
        })).toBeNull();
    });

    it('honors literal candidates before keys', () => {
        expect(resolvePluginDisplayString({
            literals: ['Literal Label'],
            keys: ['common.copy'],
        })).toBe('Literal Label');
    });

    it('returns null when every candidate is empty', () => {
        expect(resolvePluginDisplayString({
            developerFallback: '   ',
            literals: [null, ''],
            keys: [undefined, 'plugin.unknown'],
            fallback: '  ',
        })).toBeNull();
    });
});

describe('resolveProjectedLocalizedText', () => {
    it('delegates projected plugin text to its projection-bound resolver', () => {
        expect(resolveProjectedLocalizedText({
            key: 'plugin.copy',
            fallback: 'Duplicate',
        }, (value) => (
            typeof value === 'object' && value !== null && 'key' in value
                ? 'Copier'
                : ''
        ))).toBe('Copier');
    });

    it('never treats a bare projected literal as a translation key', () => {
        // A descriptor that projected the plain string `common.copy` declared a
        // literal, not a key; resolving it would silently rewrite plugin copy.
        expect(resolveProjectedLocalizedText('common.copy', (value) => String(value))).toBe('common.copy');
    });

    it('yields empty text for an absent projection so callers can fall through', () => {
        expect(resolveProjectedLocalizedText(undefined, () => '')).toBe('');
        expect(resolveProjectedLocalizedText(null, () => '')).toBe('');
        expect(resolveProjectedLocalizedText({ fallback: '   ' }, () => '')).toBe('');
    });
});
