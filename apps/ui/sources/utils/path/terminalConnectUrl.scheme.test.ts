import { describe, expect, it, vi } from 'vitest';

describe('terminalConnectUrl scheme override', () => {
    it('builds and parses terminal deep links using the configured app scheme', async () => {
        vi.resetModules();
        vi.doMock('expo-constants', () => ({
            default: {
                expoConfig: {
                    scheme: 'happier-dev',
                },
            },
        }));

        const { buildTerminalConnectDeepLink, parseTerminalConnectUrl } = await import('./terminalConnectUrl');

        expect(
            buildTerminalConnectDeepLink({
                publicKeyB64Url: 'abcDEF_123-zzz',
                serverUrl: null,
            }),
        ).toBe('happier-dev://terminal?abcDEF_123-zzz');

        expect(
            parseTerminalConnectUrl('happier-dev://terminal?key=abcDEF_123-zzz&server=https%3A%2F%2Fstack.example.test'),
        ).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });

        // Fail closed: production-scheme links should not parse in dev-scheme builds.
        expect(parseTerminalConnectUrl('happier://terminal?abcDEF_123-zzz')).toBeNull();
    });
});
