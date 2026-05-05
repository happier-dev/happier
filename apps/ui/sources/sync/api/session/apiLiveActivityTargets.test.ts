import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    serverFetch: vi.fn(),
    runtimeFetchWithServerReachability: vi.fn(),
    getActiveServerSnapshot: vi.fn(() => ({
        serverId: 'active-server',
        serverUrl: 'https://active.example.test',
        generation: 1,
    })),
    getServerProfileById: vi.fn((serverId: string) => {
        if (serverId === 'server-b') {
            return { serverId: 'server-b', serverUrl: 'https://server-b.example.test' };
        }
        return null;
    }),
    getCredentialsForServerUrl: vi.fn(async () => ({ token: 'server-b-token', secret: 's' })),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: mocks.runtimeFetchWithServerReachability,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: mocks.getActiveServerSnapshot,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getServerProfileById: mocks.getServerProfileById,
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: mocks.getCredentialsForServerUrl,
    },
}));

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createRegistrationInput() {
    return {
        deviceId: 'device-1',
        serverId: 'active-server',
        sessionId: 'session-1',
        activityInstanceKey: 'active-server:HappierFocusLiveActivity:session-1',
        activityId: 'activity-1',
        activityName: 'HappierFocusLiveActivity' as const,
        transportMode: 'direct_apns' as const,
        bundleId: 'dev.happier.custom',
        environment: 'sandbox' as const,
        tokenKind: 'activitykit_update_token' as const,
        rawToken: 'raw-activitykit-token',
    };
}

async function loadModule() {
    return import('./apiLiveActivityTargets').catch(() => null);
}

function parseRequestBody(call: unknown[]): Record<string, unknown> {
    const init = call[1] as RequestInit | undefined;
    const body = typeof init?.body === 'string' ? init.body : '';
    return JSON.parse(body) as Record<string, unknown>;
}

describe('apiLiveActivityTargets', () => {
    beforeEach(() => {
        mocks.serverFetch.mockReset();
        mocks.runtimeFetchWithServerReachability.mockReset();
        mocks.getServerProfileById.mockClear();
        mocks.getCredentialsForServerUrl.mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('registers live activity targets through the active selected server route', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({
            success: true,
            target: { id: 'target-1' },
        }));

        const result = await mod.registerLiveActivityTarget(createRegistrationInput());

        expect(result).toEqual({ targetId: 'target-1' });
        expect(mocks.serverFetch).toHaveBeenCalledWith(
            '/v1/live-activity-targets',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('raw-activitykit-token'),
            }),
            expect.any(Object),
        );
        expect(parseRequestBody(mocks.serverFetch.mock.calls[0] ?? [])).toMatchObject({
            clientServerUrl: 'https://active.example.test',
        });
        expect(mocks.runtimeFetchWithServerReachability).not.toHaveBeenCalled();
    });

    it('routes registration to the requested server profile instead of assuming the active server', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;
        mocks.runtimeFetchWithServerReachability.mockResolvedValueOnce(jsonResponse({
            success: true,
            target: { id: 'target-server-b' },
        }));

        const result = await mod.registerLiveActivityTarget({
            ...createRegistrationInput(),
            serverId: 'server-b',
            activityInstanceKey: 'server-b:HappierFocusLiveActivity:session-1',
        });

        expect(result).toEqual({ targetId: 'target-server-b' });
        expect(mocks.runtimeFetchWithServerReachability).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-b.example.test',
            token: 'server-b-token',
            url: 'https://server-b.example.test/v1/live-activity-targets',
            init: expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer server-b-token',
                    'Content-Type': 'application/json',
                }),
            }),
        }));
        const request = mocks.runtimeFetchWithServerReachability.mock.calls[0]?.[0];
        expect(parseRequestBody([null, request?.init])).toMatchObject({
            clientServerUrl: 'https://server-b.example.test',
        });
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('rejects push-to-start target registration before calling the selected server route', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        await expect(mod.registerLiveActivityTarget({
            ...createRegistrationInput(),
            tokenKind: 'activitykit_push_to_start_token',
        })).rejects.toThrow(Error);

        expect(mocks.serverFetch).not.toHaveBeenCalled();
        expect(mocks.runtimeFetchWithServerReachability).not.toHaveBeenCalled();
    });

    it('rejects ActivityKit update tokens for background-wake target registration', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        await expect(mod.registerLiveActivityTarget({
            ...createRegistrationInput(),
            transportMode: 'background_wake_best_effort',
            tokenKind: 'activitykit_update_token',
            rawToken: 'raw-activitykit-token',
            expoPushToken: undefined,
        })).rejects.toThrow(Error);

        expect(mocks.serverFetch).not.toHaveBeenCalled();
        expect(mocks.runtimeFetchWithServerReachability).not.toHaveBeenCalled();
    });

    it('rejects incomplete ActivityKit update-token registrations before calling the selected server route', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        await expect(mod.registerLiveActivityTarget({
            ...createRegistrationInput(),
            rawToken: undefined,
        })).rejects.toThrow(Error);

        expect(mocks.serverFetch).not.toHaveBeenCalled();
        expect(mocks.runtimeFetchWithServerReachability).not.toHaveBeenCalled();
    });

    it('rejects incomplete background-wake target registrations before calling the selected server route', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        await expect(mod.registerLiveActivityTarget({
            ...createRegistrationInput(),
            transportMode: 'background_wake_best_effort',
            tokenKind: 'expo_push_token',
            rawToken: undefined,
            expoPushToken: undefined,
        })).rejects.toThrow(Error);

        expect(mocks.serverFetch).not.toHaveBeenCalled();
        expect(mocks.runtimeFetchWithServerReachability).not.toHaveBeenCalled();
    });

    it('marks live activity targets ended by id', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

        await mod.markLiveActivityTargetEnded('target/with slash');

        expect(mocks.serverFetch).toHaveBeenCalledWith(
            '/v1/live-activity-targets/target%2Fwith%20slash',
            expect.objectContaining({ method: 'DELETE' }),
            expect.any(Object),
        );
    });
});
