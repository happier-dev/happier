import { describe, expect, it } from 'vitest';

import { parseOnboardingScanPayload } from './scanPayload';

describe('parseOnboardingScanPayload', () => {
    it('parses pairing links', () => {
        expect(parseOnboardingScanPayload('happier:///pair?v=1&pairId=pair_1&secret=sec_1&server=https%3A%2F%2Frelay.example.com')).toEqual({
            kind: 'pairing_link',
            pairId: 'pair_1',
            secret: 'sec_1',
            serverUrl: 'https://relay.example.com',
        });
    });

    it('keeps pairing links without an embedded server url marked as missing relay metadata', () => {
        expect(parseOnboardingScanPayload('happier:///pair?v=1&pairId=pair_1&secret=sec_1')).toEqual({
            kind: 'pairing_link',
            pairId: 'pair_1',
            secret: 'sec_1',
            serverUrl: null,
        });
    });

    it('parses account connect links', () => {
        expect(parseOnboardingScanPayload('happier:///account?publicKeyB64Url')).toEqual({
            kind: 'account_connect',
            publicKeyB64Url: 'publicKeyB64Url',
        });
    });

    it('parses plain relay urls and rejects unsafe schemes', () => {
        expect(parseOnboardingScanPayload('https://relay.example.com/path/?foo=bar#frag')).toEqual({
            kind: 'relay_url',
            serverUrl: 'https://relay.example.com/path',
        });
        expect(parseOnboardingScanPayload('relay-example')).toEqual({ kind: 'unknown' });
        expect(parseOnboardingScanPayload('javascript:alert(1)')).toEqual({ kind: 'unknown' });
    });
});
