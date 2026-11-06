import { describe, expect, it } from 'vitest';
import { admitCatalogBrandMark } from './catalogBrandMark';

describe('catalog artwork admission', () => {
    it('keeps light and dark artwork distinct and retains equal admitted identity', () => {
        const input = { displayName: 'Release helper', iconUrl: 'https://catalog.test/light.png', iconDarkUrl: 'https://catalog.test/dark.png' };
        const first = admitCatalogBrandMark(input);
        expect(first).toEqual({ displayName: input.displayName, light: { uri: input.iconUrl }, dark: { uri: input.iconDarkUrl } });
        expect(admitCatalogBrandMark({ ...input }, first)).toBe(first);
        expect(admitCatalogBrandMark({ ...input, iconDarkUrl: 'https://catalog.test/replacement.png' }, first)).not.toBe(first);
    });

    it.each(['file:///tmp/private.png', 'data:image/png;base64,AAAA', 'https://person:secret@catalog.test/icon.png', 'not a URL'])
    ('keeps inadmissible artwork %s out of the platform image source', iconUrl => {
        expect(admitCatalogBrandMark({ displayName: 'Release helper', iconUrl, iconDarkUrl: iconUrl }))
            .toEqual({ displayName: 'Release helper' });
    });
});
