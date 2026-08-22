import { describe, expect, it } from 'vitest';

import {
    resolveProjectedLocalizedText,
    resolvePluginDisplayString,
} from './resolvePluginDisplayString';

describe('resolvePluginDisplayString', () => {
    it('prefers a developer-authored literal over keys and fallback', () => {
        expect(resolvePluginDisplayString({
            developerFallback: 'My Plugin Tab',
            keys: ['common.copy'],
            fallback: 'descriptor-id',
        })).toBe('My Plugin Tab');
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
    it('translates a projected key and ignores the developer fallback', () => {
        expect(resolveProjectedLocalizedText({
            key: 'common.copy',
            fallback: 'Duplicate',
        })).toBe('Copy');
    });

    it('never treats a bare projected literal as a translation key', () => {
        // A descriptor that projected the plain string `common.copy` declared a
        // literal, not a key; resolving it would silently rewrite plugin copy.
        expect(resolveProjectedLocalizedText('common.copy')).toBe('common.copy');
    });

    it('yields empty text for an absent projection so callers can fall through', () => {
        expect(resolveProjectedLocalizedText(undefined)).toBe('');
        expect(resolveProjectedLocalizedText(null)).toBe('');
        expect(resolveProjectedLocalizedText({ fallback: '   ' })).toBe('');
    });
});
