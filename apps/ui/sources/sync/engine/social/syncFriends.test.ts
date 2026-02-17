import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeaturesResponse } from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-1',
        serverUrl: 'https://api.example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const credentials: AuthCredentials = { token: 'token-1', secret: 'secret-1' };
const initialStorageState = storage.getState();

function createFeaturesResponse(friendsEnabled: boolean): FeaturesResponse {
    return {
        features: {
            bugReports: {
                enabled: true,
                providerUrl: 'https://reports.happier.dev',
                defaultIncludeDiagnostics: true,
                maxArtifactBytes: 10 * 1024 * 1024,
                acceptedArtifactKinds: ['ui-mobile', 'daemon', 'server', 'cli'],
                uploadTimeoutMs: 20_000,
                contextWindowMs: 30 * 60 * 1_000,
            },
            automations: { enabled: true, existingSessionTarget: false },
            connectedServices: {
                enabled: true,
                webOauthProxyEnabled: true,
                quotas: { enabled: true },
            },
            updates: {
                ota: { enabled: true },
            },
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: false },
            },
            voice: {
                enabled: false,
                configured: false,
                provider: null,
            },
            social: {
                friends: {
                    enabled: friendsEnabled,
                    allowUsername: false,
                    requiredIdentityProviderId: 'github',
                },
            },
            oauth: {
                providers: {
                    github: {
                        enabled: true,
                        configured: true,
                    },
                },
            },
            auth: {
                signup: { methods: [{ id: 'anonymous', enabled: true }] },
                login: { requiredProviders: [] },
                recovery: { providerReset: { enabled: false, providers: [] } },
                ui: {
                    autoRedirect: { enabled: false, providerId: null },
                    recoveryKeyReminder: { enabled: true },
                },
                providers: {
                    github: {
                        enabled: true,
                        configured: true,
                        restrictions: { usersAllowlist: false, orgsAllowlist: false, orgMatch: 'any' },
                        offboarding: {
                            enabled: false,
                            intervalSeconds: 600,
                            mode: 'per-request-cache',
                            source: 'oauth_user_token',
                        },
                    },
                },
                misconfig: [],
            },
        },
    };
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
        vi.resetModules();
        resetServerFeaturesClientForTests();
    });

    it('does not call /v1/friends when /v1/features is missing (404)', async () => {
        const { fetchAndApplyFriends } = await import('./syncFriends');

        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features') {
                return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
            }
            if (url.pathname === '/v1/friends') {
                return { ok: true, status: 200, json: async () => ({ friends: [] }) } as unknown as Response;
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
            if (url.pathname === '/v1/features') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => createFeaturesResponse(false),
                } as unknown as Response;
            }
            if (url.pathname === '/v1/friends') {
                return { ok: true, status: 200, json: async () => ({ friends: [] }) } as unknown as Response;
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
            if (url.pathname === '/v1/features') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => createFeaturesResponse(true),
                } as unknown as Response;
            }
            if (url.pathname === '/v1/friends') {
                return { ok: true, status: 200, json: async () => ({ friends: [] }) } as unknown as Response;
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
});
