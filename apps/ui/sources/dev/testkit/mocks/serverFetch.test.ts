import { describe, expect, it } from 'vitest';

import { getServerFetchUrl, matchServerFetchUrl } from './serverFetch';

describe('server fetch boundary URL matching', () => {
    it('accepts transport metadata while retaining origin, endpoint and required query facts', () => {
        const expected = matchServerFetchUrl('https://api.example.test/v1/items?cursor=next');
        const actual = 'https://api.example.test/v1/items?happierConnectedServices=%5B%22antigravity%22%5D&cursor=next';
        for (const input of [actual, new URL(actual), new Request(actual)]) {
            expect(expected.asymmetricMatch(input)).toBe(true);
            expect(getServerFetchUrl(input).searchParams.get('cursor')).toBe('next');
        }
        expect(expected.asymmetricMatch('https://other.example.test/v1/items?cursor=next')).toBe(false);
        expect(expected.asymmetricMatch('https://api.example.test/v1/other?cursor=next')).toBe(false);
        expect(expected.asymmetricMatch('https://api.example.test/v1/items?cursor=old')).toBe(false);
        expect(expected.asymmetricMatch('https://api.example.test/v1/items')).toBe(false);
        expect(expected.asymmetricMatch('https://api.example.test/v1/items?cursor=next&cursor=old')).toBe(false);
    });
});
