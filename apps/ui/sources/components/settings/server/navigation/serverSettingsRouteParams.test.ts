import { describe, expect, it } from 'vitest';

import { parseServerSettingsRouteParams } from './serverSettingsRouteParams';

describe('parseServerSettingsRouteParams', () => {
    it('returns null url when missing', () => {
        expect(parseServerSettingsRouteParams({})).toEqual({ url: null, auto: false, source: null });
    });

    it('parses url and auto=1', () => {
        expect(parseServerSettingsRouteParams({ url: 'https://stack.example.test', auto: '1' })).toEqual({
            url: 'https://stack.example.test',
            auto: true,
            source: null,
        });
    });

    it('trims and normalizes values', () => {
        expect(parseServerSettingsRouteParams({ url: ' https://stack.example.test ', auto: 'true' })).toEqual({
            url: 'https://stack.example.test',
            auto: true,
            source: null,
        });
    });

    it('parses source=notification', () => {
        expect(parseServerSettingsRouteParams({ url: 'https://stack.example.test', source: 'notification' })).toEqual({
            url: 'https://stack.example.test',
            auto: false,
            source: 'notification',
        });
    });
});
