import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeaturesResponse } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    subscribeActiveServer: () => () => {},
    getActiveServerSnapshot: () => ({
        serverId: 'server-1',
        serverUrl: 'https://api.example.test',
        kind: 'custom',
        generation: 1,
    }),
    getActiveServerHomeCarrier: () => null,
}));

const credentials: AuthCredentials = { token: 'token-1', secret: 'secret-1' };
const initialStorageState = storage.getState();

function createFeaturesResponse(friendsEnabled: boolean): FeaturesResponse {
    return createRootLayoutFeaturesResponse({
        features: {
            social: { friends: { enabled: friendsEnabled } },
        },
        capabilities: {
            social: { friends: { allowUsername: false, requiredIdentityProviderId: 'github' } },
            oauth: { providers: { github: { enabled: true, configured: true } } },
        },
    });
}

function createFeatureHttpResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('syncFriends', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        storage.getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });
        resetServerFeaturesClientForTests();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        resetServerFeaturesClientForTests();
    });

    it('does not call /v1/friends when /v1/features is missing (404)', async () => {
        const { fetchAndApplyFriends } = await import('./syncFriends');

        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') {
                return createFeatureHttpResponse({});
            }
            if (url.pathname === '/v1/features') {
                return createFeatureHttpResponse({}, 404);
            }
            if (url.pathname === '/v1/friends') {
                return createFeatureHttpResponse({ friends: [] });
            }
            throw new Error(`unexpected request: ${url.pathname}`);
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const applyFriends = vi.fn();
        await fetchAndApplyFriends({ credentials, applyFriends });

        const paths = fetchSpy.mock.calls.map(([arg]) => new URL(String(arg)).pathname);
        expect(paths).not.toContain('/v1/friends');
        expect(applyFriends).not.toHaveBeenCalled();
    });

    it('does not call /v1/friends when server features report friends disabled', async () => {
        const { fetchAndApplyFriends } = await import('./syncFriends');

        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') {
                return createFeatureHttpResponse({});
            }
            if (url.pathname === '/v1/features') {
                return createFeatureHttpResponse(createFeaturesResponse(false));
            }
            if (url.pathname === '/v1/friends') {
                return createFeatureHttpResponse({ friends: [] });
            }
            throw new Error(`unexpected request: ${url.pathname}`);
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const applyFriends = vi.fn();
        await fetchAndApplyFriends({ credentials, applyFriends });

        const paths = fetchSpy.mock.calls.map(([arg]) => new URL(String(arg)).pathname);
        expect(paths).not.toContain('/v1/friends');
        expect(applyFriends).not.toHaveBeenCalled();
    });

    it('calls /v1/friends when friends feature is enabled', async () => {
        const { fetchAndApplyFriends } = await import('./syncFriends');

        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') {
                return createFeatureHttpResponse({});
            }
            if (url.pathname === '/v1/features') {
                return createFeatureHttpResponse(createFeaturesResponse(true));
            }
            if (url.pathname === '/v1/friends') {
                return createFeatureHttpResponse({ friends: [] });
            }
            throw new Error(`unexpected request: ${url.pathname}`);
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const applyFriends = vi.fn();
        await fetchAndApplyFriends({ credentials, applyFriends });

        const paths = fetchSpy.mock.calls.map(([arg]) => new URL(String(arg)).pathname);
        expect(paths).toContain('/v1/friends');
        expect(applyFriends).toHaveBeenCalledWith([]);
    });

    it('rejects a transient feature probe failure so the sync owner retries it', async () => {
        const { fetchAndApplyFriends } = await import('./syncFriends');

        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new TypeError('network unavailable');
        }) as unknown as typeof fetch);

        const applyFriends = vi.fn();
        await expect(fetchAndApplyFriends({ credentials, applyFriends })).rejects.toMatchObject({
            name: 'RuntimeFeatureDecisionUnavailableError',
            retryable: true,
        });
        expect(applyFriends).not.toHaveBeenCalled();
    });

    it('drops fetched friends when the captured sync scope is stale before apply', async () => {
        const { fetchAndApplyFriends } = await import('./syncFriends');

        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') {
                return createFeatureHttpResponse({});
            }
            if (url.pathname === '/v1/features') {
                return createFeatureHttpResponse(createFeaturesResponse(true));
            }
            if (url.pathname === '/v1/friends') {
                return createFeatureHttpResponse({
                    friends: [{
                        id: 'friend-a',
                        firstName: 'Friend',
                        lastName: null,
                        avatar: null,
                        username: 'friend-a',
                        bio: null,
                        badges: [],
                        status: 'friend',
                        publicKey: null,
                        contentPublicKey: null,
                        contentPublicKeySig: null,
                    }],
                });
            }
            throw new Error(`unexpected request: ${url.pathname}`);
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const applyFriends = vi.fn();
        await fetchAndApplyFriends({
            credentials,
            applyFriends,
            shouldContinue: () => false,
        } as Parameters<typeof fetchAndApplyFriends>[0] & { shouldContinue: () => boolean });

        expect(applyFriends).not.toHaveBeenCalled();
    });
});
