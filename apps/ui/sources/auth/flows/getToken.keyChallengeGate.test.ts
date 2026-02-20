import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    return {
        serverFetch: vi.fn(),
    };
});

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

import { authGetToken } from './getToken';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('authGetToken key-challenge gate', () => {
    beforeEach(() => {
        resetServerFeaturesClientForTests();
        mocks.serverFetch.mockReset();
    });

    it('fails fast when server disables key-challenge login', async () => {
        mocks.serverFetch.mockResolvedValueOnce(
            jsonResponse({
                features: { auth: { login: { keyChallenge: { enabled: false } } } },
                capabilities: {},
            }),
        );

        await expect(authGetToken(new Uint8Array(32))).rejects.toThrow(/key-challenge/i);
        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(mocks.serverFetch.mock.calls[0]?.[0]).toBe('/v1/features');
    });

    it('does not fail fast when server does not advertise key-challenge gate (legacy server)', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { recovery: { providerReset: { enabled: false } }, ui: { recoveryKeyReminder: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: {},
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ token: 'legacy-token' }));

        await expect(authGetToken(new Uint8Array(32))).resolves.toBe('legacy-token');
        expect(mocks.serverFetch).toHaveBeenCalledTimes(2);
        expect(mocks.serverFetch.mock.calls[0]?.[0]).toBe('/v1/features');
        expect(mocks.serverFetch.mock.calls[1]?.[0]).toBe('/v1/auth');
    });

    it('continues when server enables key-challenge login', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: {},
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ token: 'test-token' }));

        await expect(authGetToken(new Uint8Array(32))).resolves.toBe('test-token');
        expect(mocks.serverFetch).toHaveBeenCalledTimes(2);
        expect(mocks.serverFetch.mock.calls[0]?.[0]).toBe('/v1/features');
        expect(mocks.serverFetch.mock.calls[1]?.[0]).toBe('/v1/auth');
    });
});
