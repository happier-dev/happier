import { describe, expect, it } from 'vitest';

import { parseServerSettingsRouteParams } from './serverSettingsRouteParams';

describe('parseServerSettingsRouteParams', () => {
    it('returns null url when missing', () => {
        expect(parseServerSettingsRouteParams({})).toEqual({ url: null, auto: false });
    });

    it('parses url and auto=1', () => {
        expect(parseServerSettingsRouteParams({ url: 'https://stack.example.test', auto: '1' })).toEqual({
            url: 'https://stack.example.test',
            auto: true,
        });
    });

    it('trims and normalizes values', () => {
        expect(parseServerSettingsRouteParams({ url: ' https://stack.example.test ', auto: 'true' })).toEqual({
            url: 'https://stack.example.test',
            auto: true,
        });
    });
});

