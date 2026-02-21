import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/rootLayoutTestkit';
import { storage } from '@/sync/domains/state/storage';

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

function createAutomationResponse() {
    return [
        {
            id: 'auto-1',
            name: 'Automation 1',
            description: null,
            enabled: true,
            schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null },
            targetType: 'new_session',
            templateCiphertext: 'ciphertext',
            templateVersion: 1,
            nextRunAt: null,
            lastRunAt: null,
            createdAt: 1,
            updatedAt: 1,
            assignments: [],
        },
    ];
}

describe('syncAutomations', () => {
    afterEach(() => {
        storage.setState(initialStorageState, true);
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW;
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        delete process.env.HAPPIER_BUILD_FEATURES_ALLOW;
        delete process.env.HAPPIER_BUILD_FEATURES_DENY;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('does not call /v2/automations when /v1/features is missing (404)', async () => {
        const { fetchAndApplyAutomations } = await import('./syncAutomations');

        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features') {
                return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
            }
            if (url.pathname === '/v2/automations') {
                return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as unknown as Response;
            }
            throw new Error(`unexpected request: ${url.pathname}`);
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const applyAutomations = vi.fn();
        await expect(fetchAndApplyAutomations({ credentials, applyAutomations })).resolves.toBeUndefined();

        const paths = fetchSpy.mock.calls.map(([arg]) => new URL(String(arg)).pathname);
        expect(paths).not.toContain('/v2/automations');
        expect(applyAutomations).not.toHaveBeenCalled();
    });

    it('does not call /v2/automations when server features report automations disabled', async () => {
        const { fetchAndApplyAutomations } = await import('./syncAutomations');

        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features') {
                return {
                    ok: true,
                    status: 200,
                    json: async () =>
                        createRootLayoutFeaturesResponse({
                            features: {
                                automations: { enabled: false },
                            },
                        }),
                } as unknown as Response;
            }
            if (url.pathname === '/v2/automations') {
                return { ok: true, status: 200, json: async () => createAutomationResponse() } as unknown as Response;
            }
            throw new Error(`unexpected request: ${url.pathname}`);
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const applyAutomations = vi.fn();
        await fetchAndApplyAutomations({ credentials, applyAutomations });

        const paths = fetchSpy.mock.calls.map(([arg]) => new URL(String(arg)).pathname);
        expect(paths).not.toContain('/v2/automations');
        expect(applyAutomations).not.toHaveBeenCalled();
    });

    it('lists and applies automations when server features report automations enabled', async () => {
        storage.getState().applySettingsLocal({
            experiments: true,
            featureToggles: { automations: true },
        });

        const { fetchAndApplyAutomations } = await import('./syncAutomations');

        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features') {
                return {
                    ok: true,
                    status: 200,
                    json: async () =>
                        createRootLayoutFeaturesResponse({
                            features: {
                                automations: { enabled: true },
                            },
                        }),
                } as unknown as Response;
            }
            if (url.pathname === '/v2/automations') {
                return { ok: true, status: 200, json: async () => createAutomationResponse() } as unknown as Response;
            }
            throw new Error(`unexpected request: ${url.pathname}`);
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const applyAutomations = vi.fn();
        await fetchAndApplyAutomations({ credentials, applyAutomations });

        const paths = fetchSpy.mock.calls.map(([arg]) => new URL(String(arg)).pathname);
        expect(paths).toContain('/v2/automations');
        expect(applyAutomations).toHaveBeenCalledWith(createAutomationResponse());
    });

    it('does not call /v2/automations when build policy denies automations', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'automations';
        storage.getState().applySettingsLocal({
            experiments: true,
            featureToggles: { automations: true },
        });

        const { fetchAndApplyAutomations } = await import('./syncAutomations');

        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features') {
                return {
                    ok: true,
                    status: 200,
                    json: async () =>
                        createRootLayoutFeaturesResponse({
                            features: {
                                automations: { enabled: true },
                            },
                        }),
                } as unknown as Response;
            }
            if (url.pathname === '/v2/automations') {
                return { ok: true, status: 200, json: async () => createAutomationResponse() } as unknown as Response;
            }
            throw new Error(`unexpected request: ${url.pathname}`);
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const applyAutomations = vi.fn();
        await fetchAndApplyAutomations({ credentials, applyAutomations });

        const paths = fetchSpy.mock.calls.map(([arg]) => new URL(String(arg)).pathname);
        expect(paths).not.toContain('/v2/automations');
        expect(applyAutomations).not.toHaveBeenCalled();
    });
});
