import { describe, expect, it } from 'vitest';

import { parseServerConfigRouteParams } from './serverParams';

describe('parseServerConfigRouteParams', () => {
    it('returns null url when missing', () => {
        expect(parseServerConfigRouteParams({})).toEqual({ url: null, auto: false });
    });

    it('parses url and auto=1', () => {
        expect(parseServerConfigRouteParams({ url: 'https://stack.example.test', auto: '1' })).toEqual({
            url: 'https://stack.example.test',
            auto: true,
        });
    });

    it('trims and normalizes values', () => {
        expect(parseServerConfigRouteParams({ url: ' https://stack.example.test ', auto: 'true' })).toEqual({
            url: 'https://stack.example.test',
            auto: true,
        });
    });
});

