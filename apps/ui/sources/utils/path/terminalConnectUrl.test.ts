import { describe, expect, it } from 'vitest';

import { buildTerminalConnectDeepLink, parseTerminalConnectUrl } from './terminalConnectUrl';

describe('parseTerminalConnectUrl', () => {
    it('parses legacy terminal deeplink format', () => {
        expect(parseTerminalConnectUrl('happier://terminal?abcDEF_123-zzz')).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: null,
        });
    });

    it('parses canonical terminal deeplink format with server URL', () => {
        expect(
            parseTerminalConnectUrl(
                'happier://terminal?key=abcDEF_123-zzz&server=https%3A%2F%2Fstack.example.test',
            ),
        ).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });
    });

    it('parses complete authenticated-pairing context', () => {
        expect(parseTerminalConnectUrl(
            'happier://terminal?key=abc&pairingSecret=secret&createdAt=1000&expiresAt=61000&supportsTokenOnly=1',
        )).toEqual({
            publicKeyB64Url: 'abc',
            serverUrl: null,
            pairing: {
                secretB64Url: 'secret',
                createdAtMs: 1000,
                expiresAtMs: 61000,
            },
            supportsTokenOnly: true,
        });
    });

    it('ignores incomplete or invalid authenticated-pairing context for compatibility', () => {
        expect(parseTerminalConnectUrl('happier://terminal?key=abc&pairingSecret=secret')).toEqual({
            publicKeyB64Url: 'abc',
            serverUrl: null,
        });
        expect(parseTerminalConnectUrl(
            'happier://terminal?key=abc&pairingSecret=secret&createdAt=61000&expiresAt=1000',
        )).toEqual({
            publicKeyB64Url: 'abc',
            serverUrl: null,
        });
    });

    it('parses terminal connect web URLs with hash parameters', () => {
        expect(
            parseTerminalConnectUrl(
                'https://web.happier.dev/terminal/connect#server=https%3A%2F%2Fstack.example.test&key=abcDEF_123-zzz',
            ),
        ).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });
    });

    it('rejects non-terminal links', () => {
        expect(parseTerminalConnectUrl('happier://server?url=https%3A%2F%2Fstack.example.test')).toBeNull();
    });

    it('ignores unsafe server URL schemes', () => {
        expect(
            parseTerminalConnectUrl('happier://terminal?key=abcDEF_123-zzz&server=javascript%3Aalert(1)'),
        ).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: null,
        });
    });

    it('returns null for canonical format with missing key value', () => {
        expect(parseTerminalConnectUrl('happier://terminal?key=&server=https%3A%2F%2Fstack.example.test')).toBeNull();
    });

    it('normalizes server URL by trimming trailing slashes', () => {
        expect(
            parseTerminalConnectUrl(
                'happier://terminal?key=abcDEF_123-zzz&server=https%3A%2F%2Fstack.example.test%2F%2F',
            ),
        ).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });
    });
});

describe('buildTerminalConnectDeepLink', () => {
    it('builds canonical deep links with encoded values', () => {
        expect(
            buildTerminalConnectDeepLink({
                publicKeyB64Url: 'abcDEF_123-zzz',
                serverUrl: 'https://stack.example.test/path?x=1',
            }),
        ).toBe(
            'happier://terminal?key=abcDEF_123-zzz&server=https%3A%2F%2Fstack.example.test%2Fpath%3Fx%3D1',
        );
    });

    it('includes complete authenticated-pairing context', () => {
        expect(buildTerminalConnectDeepLink({
            publicKeyB64Url: 'abc',
            serverUrl: null,
            pairing: {
                secretB64Url: 'secret',
                createdAtMs: 1000,
                expiresAtMs: 61000,
            },
            supportsTokenOnly: true,
        })).toBe(
            'happier://terminal?key=abc&pairingSecret=secret&createdAt=1000&expiresAt=61000&supportsTokenOnly=1',
        );
    });

    it('omits token-only support without authenticated pairing context', () => {
        expect(buildTerminalConnectDeepLink({
            publicKeyB64Url: 'abc',
            serverUrl: null,
            supportsTokenOnly: true,
        })).toBe('happier://terminal?abc');
        expect(parseTerminalConnectUrl(
            'happier://terminal?key=abc&supportsTokenOnly=1',
        )).toEqual({
            publicKeyB64Url: 'abc',
            serverUrl: null,
        });
    });

    it('falls back to legacy format when server URL is missing', () => {
        expect(
            buildTerminalConnectDeepLink({
                publicKeyB64Url: 'abcDEF_123-zzz',
                serverUrl: null,
            }),
        ).toBe('happier://terminal?abcDEF_123-zzz');
    });
});
