import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS;
    try {
        const { resetServerReachabilitySupervisors } = await import('./serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
    } catch {
        // ignore
    }
    vi.resetModules();
    vi.clearAllMocks();
});

describe('runtimeFetchWithServerReachability', () => {
    it('refuses authenticated cross-origin requests (prevents token leakage)', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        const runtimeFetchMock = vi.fn(async () => {
            throw new Error('Unexpected runtimeFetch call');
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        await expect(
            runtimeFetchWithServerReachability({
                serverUrl: 'https://api.example.test',
                token: 'token-a',
                url: 'https://other.example.test/v1/account/profile',
                init: {
                    method: 'GET',
                    headers: {
                        Authorization: 'Bearer token-a',
                    },
                },
            }),
        ).rejects.toThrow('Refused authenticated request');

        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('returns the response once reachability is online', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '50';

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/account/profile')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        const response = await runtimeFetchWithServerReachability({
            serverUrl: 'https://api.example.test',
            token: 'token-a',
            url: 'https://api.example.test/v1/account/profile',
            init: {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer token-a',
                },
            },
        });

        expect(response.ok).toBe(true);
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).endsWith('/health'))).toBe(true);
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).endsWith('/v1/account/profile'))).toBe(true);
    });

    it('marks the server offline when the main request fails', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '50';

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/account/profile')) {
                throw new TypeError('Network request failed');
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        await expect(
            runtimeFetchWithServerReachability({
                serverUrl: 'https://api.example.test',
                token: 'token-a',
                url: 'https://api.example.test/v1/account/profile',
                init: {
                    method: 'GET',
                    headers: {
                        Authorization: 'Bearer token-a',
                    },
                },
            }),
        ).rejects.toThrow('Network request failed');

        const { subscribeServerReachabilityState } = await import('./serverReachabilitySupervisorPool');
        let latestPhase: string | null = null;
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', (state) => {
            latestPhase = state.phase;
        });
        unsubscribe();

        expect(latestPhase).toBe('offline');
    });

    it('rejects authenticated requests when the request URL origin differs from the serverUrl origin', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '50';

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/account/profile')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        await expect(
            runtimeFetchWithServerReachability({
                serverUrl: 'https://api.example.test',
                token: 'token-a',
                url: 'https://other.example.test/v1/account/profile',
                init: {
                    method: 'GET',
                    headers: {
                        Authorization: 'Bearer token-a',
                    },
                },
            }),
        ).rejects.toThrow(/refused authenticated request/i);
    });

    it('rejects authenticated requests when the request URL is not a valid absolute URL', async () => {
        const runtimeFetchMock = vi.fn(async () => {
            throw new Error('runtimeFetch should not be called');
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        await expect(
            runtimeFetchWithServerReachability({
                serverUrl: 'https://api.example.test',
                token: 'token-a',
                url: 'https://[::1',
                init: {
                    method: 'GET',
                    headers: {
                        Authorization: 'Bearer token-a',
                    },
                },
            }),
        ).rejects.toThrow(/refused authenticated request/i);

        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });
});
