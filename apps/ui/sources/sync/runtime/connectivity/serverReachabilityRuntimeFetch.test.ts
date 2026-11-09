import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';

import {
    recordAccountStoredContentServerRequirements,
    withAccountStoredContentCompatibilityRequestDeclaration,
} from '@/sync/http/accountStoredContentCompatibility';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import { runtimeFetchWithServerReachability } from './serverReachabilityRuntimeFetch';
import {
    peekServerReachabilityState,
    resetServerReachabilitySupervisors,
    startServerReachabilitySupervisor,
    subscribeServerReachabilityState,
} from './serverReachabilitySupervisorPool';

afterEach(async () => {
    delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS;
    resetRuntimeFetch();
    await resetServerReachabilitySupervisors();
    vi.clearAllMocks();
});

describe('runtimeFetchWithServerReachability', () => {
    it('consumes a successful response without a caller signal', async () => {
        const runtimeFetchMock = vi.fn(async () => new Response(JSON.stringify({ accountId: 'account-a' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        setRuntimeFetch(runtimeFetchMock);

        await expect(runtimeFetchWithServerReachability({
            serverUrl: 'https://api.example.test', token: 'token-a',
            url: 'https://api.example.test/v1/account/profile', init: { method: 'GET' },
        }, response => response.json())).resolves.toEqual({ accountId: 'account-a' });
    });

    it.each(['request', 'init'] as const)('rejects cancellation during response consumption from the %s signal', async source => {
        const runtimeFetchMock = vi.fn(async () => new Response('body', { status: 200 }));
        setRuntimeFetch(runtimeFetchMock);
        const controller = new AbortController();
        const reason = new DOMException('Response consumption cancelled', 'AbortError');
        let consumptionStarted!: () => void;
        let finishConsumption!: () => void;
        const started = new Promise<void>(resolve => { consumptionStarted = resolve; });
        const finish = new Promise<void>(resolve => { finishConsumption = resolve; });
        const pending = runtimeFetchWithServerReachability({
            serverUrl: 'https://api.example.test', token: 'token-a',
            url: 'https://api.example.test/v1/account/profile',
            ...(source === 'request' ? { signal: controller.signal } : {}),
            init: { method: 'GET', ...(source === 'init' ? { signal: controller.signal } : {}) },
        }, async response => {
            const body = await response.text();
            consumptionStarted();
            await finish;
            return body;
        });
        const rejected = expect(pending).rejects.toBe(reason);
        try {
            await started;
            controller.abort(reason);
        } finally {
            finishConsumption();
        }
        await rejected;
    });

    it('refuses authenticated cross-origin requests (prevents token leakage)', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        const runtimeFetchMock = vi.fn(async () => {
            throw new Error('Unexpected runtimeFetch call');
        });
        setRuntimeFetch(runtimeFetchMock);

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

        const runtimeFetchMock = vi.fn(async (
            input: RequestInfo | URL,
            _init?: RequestInit,
        ) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/account/profile')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        setRuntimeFetch(runtimeFetchMock);

        recordAccountStoredContentServerRequirements({
            serverUrl: 'https://api.example.test',
            requirements: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: 3,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        });
        const response = await runtimeFetchWithServerReachability({
            serverUrl: 'https://api.example.test',
            token: 'token-a',
            url: 'https://api.example.test/v1/account/profile',
            init: {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer token-a',
                    'x-happier-account-stored-content-protocol': '1',
                },
            },
        });

        expect(response.ok).toBe(true);
        const requestCall = runtimeFetchMock.mock.calls.find(([input]) =>
            String(input).endsWith('/v1/account/profile'));
        expect(new Headers(requestCall?.[1]?.headers).get(
            'x-happier-account-stored-content-protocol',
        )).toBe(String(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION.protocolVersion));

        await expect(runtimeFetchWithServerReachability({
            serverUrl: 'https://api.example.test',
            token: 'token-a',
            url: 'https://api.example.test/v1/plugins/data/ui-query',
            init: withAccountStoredContentCompatibilityRequestDeclaration({
                method: 'POST',
                headers: { Authorization: 'Bearer token-a' },
            }, PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
        })).resolves.toMatchObject({ ok: true });
        const dataRequestCall = runtimeFetchMock.mock.calls.find(([input]) =>
            String(input).endsWith('/v1/plugins/data/ui-query'));
        expect(new Headers(dataRequestCall?.[1]?.headers).get(
            'x-happier-account-stored-content-protocol',
        )).toBe('3');
    });

    it('uses the Bearer token from Authorization header for reachability probing when token param is null', async () => {
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
        setRuntimeFetch(runtimeFetchMock);

        const response = await runtimeFetchWithServerReachability({
            serverUrl: 'https://api.example.test',
            token: null,
            url: 'https://api.example.test/v1/account/profile',
            init: {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer token-a',
                },
            },
        });

        expect(response.ok).toBe(true);
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).endsWith('/v1/auth/ping'))).toBe(true);
        // The authenticated ping subsumes /health; an authenticated client must not pay for both round trips.
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).endsWith('/health'))).toBe(false);
    });

    it('rejects a failed main request without declaring a responsive Home offline', async () => {
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
        setRuntimeFetch(runtimeFetchMock);

        let latestPhase: string | null = null;
        const phases: string[] = [];
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', (state) => {
            latestPhase = state.phase;
            phases.push(state.phase);
        }, 'token-a');
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
        await vi.waitFor(() => expect(latestPhase).toBe('online'));
        unsubscribe();

        expect(phases).not.toContain('offline');
    });

    it('publishes request issuance only at the physical request boundary', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '50';
        const calls: string[] = [];
        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/v1/auth/ping')) return new Response(null, { status: 200 });
            calls.push('fetch');
            throw new TypeError('response lost');
        });
        setRuntimeFetch(runtimeFetchMock);
        await expect(runtimeFetchWithServerReachability({
            serverUrl: 'https://api.example.test',
            token: 'token-a',
            url: 'https://api.example.test/v1/account/profile',
            init: { method: 'POST', headers: { Authorization: 'Bearer token-a' } },
            onIssued: () => calls.push('issued'),
        })).rejects.toThrow('response lost');
        expect(calls).toEqual(['issued', 'fetch']);

        const refused = vi.fn();
        await expect(runtimeFetchWithServerReachability({
            serverUrl: 'https://api.example.test',
            token: 'token-a',
            url: 'https://other.example.test/v1/account/profile',
            init: { method: 'POST', headers: { Authorization: 'Bearer token-a' } },
            onIssued: refused,
        })).rejects.toThrow('Refused authenticated request');
        expect(refused).not.toHaveBeenCalled();
    });

    it('marks the server auth_failed when an authenticated main request returns 401', async () => {
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
                return new Response(null, { status: 401, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        setRuntimeFetch(runtimeFetchMock);

        let latestPhase: string | null = null;
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', (state) => {
            latestPhase = state.phase;
        }, 'token-a');
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

        expect(response.status).toBe(401);

        await startServerReachabilitySupervisor({
            serverUrl: 'https://api.example.test',
            token: 'token-b',
        });
        unsubscribe();

        expect(latestPhase).toBe('auth_failed');
        expect(peekServerReachabilityState('https://api.example.test', 'token-b')?.phase).toBe('online');
    });

    it('keeps the Home reachable when an authenticated domain request returns forbidden', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '50';

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(JSON.stringify({ error: 'session_access_forbidden' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        setRuntimeFetch(runtimeFetchMock);

        let latestPhase: string | null = null;
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', (state) => {
            latestPhase = state.phase;
        }, 'token-a');
        const response = await runtimeFetchWithServerReachability({
            serverUrl: 'https://api.example.test',
            token: 'token-a',
            url: 'https://api.example.test/v1/sessions/session-1/public-share',
            init: { method: 'GET', headers: { Authorization: 'Bearer token-a' } },
        });

        expect(response.status).toBe(403);
        expect(latestPhase).toBe('online');
        unsubscribe();
    });

    it.each([
        {
            name: 'non-http(s) file: URLs',
            serverUrl: 'file:///tmp/server?token=super-secret-token',
            url: 'file:///tmp/target?token=super-secret-token',
            secrets: ['super-secret-token'],
        },
        {
            name: 'an unparsable request URL',
            serverUrl: 'https://admin:secret@example.com:8443/path?token=abc#frag',
            url: 'https://[::1',
            secrets: ['admin:secret', 'token=abc'],
        },
    ])('refuses authenticated requests without leaking URL secrets for $name', async ({ serverUrl, url, secrets }) => {
        const runtimeFetchMock = vi.fn(async () => {
            throw new Error('runtimeFetch should not be called');
        });
        setRuntimeFetch(runtimeFetchMock);

        const thrown = await runtimeFetchWithServerReachability({
            serverUrl,
            token: 'token-a',
            url,
            init: {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer token-a',
                },
            },
        }).catch((error) => error);

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toMatch(/refused authenticated request/i);
        for (const secret of secrets) expect((thrown as Error).message).not.toContain(secret);

        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });
});
