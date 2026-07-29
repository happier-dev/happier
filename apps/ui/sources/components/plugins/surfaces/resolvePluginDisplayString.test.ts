import { describe, expect, it } from 'vitest';

import { resolvePluginDisplayString } from './resolvePluginDisplayString';

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
