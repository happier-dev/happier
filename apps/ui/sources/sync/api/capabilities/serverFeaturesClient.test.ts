import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let activeServerSnapshot = {
    serverId: 'server-a',
    serverUrl: 'https://active.example.test',
    generation: 1,
};

let featuresFetchMock: ReturnType<typeof vi.fn>;

const frozenServerFeaturesTime = new Date('2026-02-13T00:00:00.000Z');
const frozenServerFeaturesTimeAfterCooldown = new Date('2026-02-13T00:01:00.000Z');
const frozenServerFeaturesTimeAfterErrorTtl = new Date('2026-02-13T00:00:06.000Z');

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getServerProfileById: (idRaw: string) => {
        const id = String(idRaw ?? '').trim();
        if (!id) return null;
        if (id === 'server-a') return { id, serverUrl: 'https://active.example.test' };
        if (id === 'server-b') return { id, serverUrl: 'https://other.example.test' };
        return null;
    },
}));

function createResponse(status: number, payload: unknown) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
    } as Response;
}

function useFrozenServerFeaturesClock(now = frozenServerFeaturesTime): void {
    vi.useFakeTimers();
    vi.setSystemTime(now);
}

function setFrozenServerFeaturesClock(now: Date): void {
    vi.setSystemTime(now);
}

describe('serverFeaturesClient', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        activeServerSnapshot = {
            serverId: 'server-a',
            serverUrl: 'https://active.example.test',
            generation: 1,
        };
        featuresFetchMock = vi.fn();
        globalThis.fetch = vi.fn(async (...args: any[]) => {
            const url = String(args[0] ?? '');
            if (url.endsWith('/health')) {
                return createResponse(200, { ok: true });
            }
            if (url.endsWith('/v1/auth/ping')) {
                return createResponse(200, { ok: true });
            }
            return await featuresFetchMock(...args);
        }) as unknown as typeof fetch;
    });

    afterEach(() => {
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('deduplicates in-flight feature fetches per server', async () => {
        const payload = {
            features: {
                sharing: { session: { enabled: true }, public: { enabled: true }, contentKeys: { enabled: true }, pendingQueueV2: { enabled: true } },
                voice: { enabled: false, configured: false, provider: null },
                social: { friends: { enabled: true, allowUsername: false, requiredIdentityProviderId: 'github' } },
                oauth: { providers: {} },
                auth: {
                    signup: { methods: [] },
                    login: { requiredProviders: [] },
                    recovery: { providerReset: { enabled: false, providers: [] } },
                    ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
                    providers: {},
                    misconfig: [],
                },
            },
        };
        let resolver: ((value: Response) => void) | null = null;
        featuresFetchMock.mockImplementation(
            () =>
                new Promise<Response>((resolve) => {
                    resolver = resolve;
                }),
        );

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const first = getServerFeaturesSnapshot({ force: true, timeoutMs: 2000 });
        const second = getServerFeaturesSnapshot({ force: true, timeoutMs: 2000 });

        // Reachability supervision performs an async health probe before starting the /v1/features request.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(featuresFetchMock.mock.calls.length).toBe(1);

        const resolveFetch: (value: Response) => void =
            resolver ?? (() => { throw new Error('Expected fetch resolver to be assigned'); });
        resolveFetch(createResponse(200, payload));
        const [a, b] = await Promise.all([first, second]);

        expect(a.status).toBe('ready');
        expect(b.status).toBe('ready');
    });

    it('probes active-server features without waiting behind reachability supervision', async () => {
        const payload = {
            features: {
                sharing: { session: { enabled: true }, public: { enabled: true }, contentKeys: { enabled: true }, pendingQueueV2: { enabled: true } },
                voice: { enabled: false, configured: false, provider: null },
                social: { friends: { enabled: true, allowUsername: false, requiredIdentityProviderId: 'github' } },
                oauth: { providers: {} },
                auth: {
                    signup: { methods: [] },
                    login: { requiredProviders: [] },
                    recovery: { providerReset: { enabled: false, providers: [] } },
                    ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
                    providers: {},
                    misconfig: [],
                },
            },
        };
        globalThis.fetch = vi.fn(async (...args: any[]) => {
            const url = String(args[0] ?? '');
            if (url.endsWith('/v1/auth/ping') || url.endsWith('/health')) {
                const signal = (args[1] as RequestInit | undefined)?.signal;
                return await new Promise<Response>((_resolve, reject) => {
                    const abort = () => {
                        const error = new Error('aborted');
                        error.name = 'AbortError';
                        reject(error);
                    };
                    if (signal?.aborted) {
                        abort();
                        return;
                    }
                    signal?.addEventListener('abort', abort, { once: true });
                });
            }
            return await featuresFetchMock(...args);
        }) as unknown as typeof fetch;
        featuresFetchMock.mockResolvedValueOnce(createResponse(200, payload));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const result = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });

        expect(result.status).toBe('ready');
        expect(featuresFetchMock).toHaveBeenCalledTimes(1);
        expect(String(featuresFetchMock.mock.calls[0]?.[0] ?? '')).toBe('https://active.example.test/v1/features');
    });

    it('classifies 404 features endpoint as unsupported', async () => {
        featuresFetchMock.mockResolvedValueOnce(createResponse(404, {}));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const result = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });
        expect(result.status).toBe('unsupported');
        if (result.status === 'unsupported') {
            expect(result.reason).toBe('endpoint_missing');
        }
    });

    it('treats a 200 non-JSON features response as invalid_payload (not a network error)', async () => {
        const htmlResponse = {
            ok: true,
            status: 200,
            headers: {
                get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
            },
            json: async () => {
                throw new SyntaxError('Unexpected token < in JSON at position 0');
            },
        } as unknown as Response;

        featuresFetchMock.mockResolvedValueOnce(htmlResponse);

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const result = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });
        expect(result.status).toBe('unsupported');
        if (result.status === 'unsupported') {
            expect(result.reason).toBe('invalid_payload');
        }
    });

    it('caches endpoint-missing responses even when forced (cooldown)', async () => {
        const payload = {
            features: {
                sharing: { session: { enabled: true }, public: { enabled: true }, contentKeys: { enabled: true }, pendingQueueV2: { enabled: true } },
                voice: { enabled: false, configured: false, provider: null },
                social: { friends: { enabled: true, allowUsername: false, requiredIdentityProviderId: 'github' } },
                oauth: { providers: {} },
                auth: {
                    signup: { methods: [] },
                    login: { requiredProviders: [] },
                    recovery: { providerReset: { enabled: false, providers: [] } },
                    ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
                    providers: {},
                    misconfig: [],
                },
            },
        };

        featuresFetchMock
            .mockResolvedValueOnce(createResponse(404, {}))
            // If the client incorrectly refetches during cooldown, this 200 would flip the snapshot to ready.
            .mockResolvedValueOnce(createResponse(200, payload));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        useFrozenServerFeaturesClock();

        const first = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });
        const second = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });

        expect(first.status).toBe('unsupported');
        expect(second.status).toBe('unsupported');
        expect(featuresFetchMock.mock.calls.length).toBe(1);
    });

    it('allows forced revalidation after endpoint-missing cooldown expires', async () => {
        const payload = {
            features: {
                sharing: { session: { enabled: true }, public: { enabled: true }, contentKeys: { enabled: true }, pendingQueueV2: { enabled: true } },
                voice: { enabled: false, configured: false, provider: null },
                social: { friends: { enabled: true, allowUsername: false, requiredIdentityProviderId: 'github' } },
                oauth: { providers: {} },
                auth: {
                    signup: { methods: [] },
                    login: { requiredProviders: [] },
                    recovery: { providerReset: { enabled: false, providers: [] } },
                    ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
                    providers: {},
                    misconfig: [],
                },
            },
        };

        featuresFetchMock
            .mockResolvedValueOnce(createResponse(404, {}))
            .mockResolvedValueOnce(createResponse(200, payload));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        useFrozenServerFeaturesClock();

        const first = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });
        expect(first.status).toBe('unsupported');
        expect(featuresFetchMock.mock.calls.length).toBe(1);

        // After cooldown, a forced refresh should revalidate.
        setFrozenServerFeaturesClock(frozenServerFeaturesTimeAfterCooldown);

        const second = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });
        expect(second.status).toBe('ready');
        expect(featuresFetchMock.mock.calls.length).toBe(2);
    });

    it('retries after a short ttl when probing fails (network error)', async () => {
        const payload = {
            features: {
                sharing: { session: { enabled: true }, public: { enabled: true }, contentKeys: { enabled: true }, pendingQueueV2: { enabled: true } },
                voice: { enabled: false, configured: false, provider: null },
                social: { friends: { enabled: true, allowUsername: false, requiredIdentityProviderId: 'github' } },
                oauth: { providers: {} },
                auth: {
                    signup: { methods: [] },
                    login: { requiredProviders: [] },
                    recovery: { providerReset: { enabled: false, providers: [] } },
                    ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
                    providers: {},
                    misconfig: [],
                },
            },
        };

        featuresFetchMock
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValueOnce(createResponse(200, payload));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        useFrozenServerFeaturesClock();

        const firstPromise = getServerFeaturesSnapshot({ timeoutMs: 50 });
        await vi.advanceTimersByTimeAsync(0);
        const first = await firstPromise;
        expect(first.status).toBe('error');
        expect(featuresFetchMock.mock.calls.length).toBe(1);

        // Within the short error TTL, we should not refetch.
        const secondPromise = getServerFeaturesSnapshot({ timeoutMs: 50 });
        await vi.advanceTimersByTimeAsync(0);
        const second = await secondPromise;
        expect(second.status).toBe('error');
        expect(featuresFetchMock.mock.calls.length).toBe(1);

        // After TTL, the client should retry.
        setFrozenServerFeaturesClock(frozenServerFeaturesTimeAfterErrorTtl);
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
        const thirdPromise = getServerFeaturesSnapshot({ timeoutMs: 50 });
        await vi.advanceTimersByTimeAsync(0);
        const third = await thirdPromise;
        expect(third.status).toBe('ready');
        expect(featuresFetchMock.mock.calls.length).toBe(2);
    });

    it('retries a server-switch abort without caching a timeout error', async () => {
        const payload = {
            features: {
                sharing: { session: { enabled: true }, public: { enabled: true }, contentKeys: { enabled: true }, pendingQueueV2: { enabled: true } },
                voice: { enabled: false, configured: false, provider: null },
                social: { friends: { enabled: true, allowUsername: false, requiredIdentityProviderId: 'github' } },
                oauth: { providers: {} },
                auth: {
                    signup: { methods: [] },
                    login: { requiredProviders: [] },
                    recovery: { providerReset: { enabled: false, providers: [] } },
                    ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
                    providers: {},
                    misconfig: [],
                },
            },
        };

        const abortError = new Error('aborted');
        abortError.name = 'AbortError';

        featuresFetchMock
            .mockImplementationOnce(() => {
                activeServerSnapshot = {
                    serverId: 'server-b',
                    serverUrl: 'https://other.example.test',
                    generation: 2,
                };
                return Promise.reject(abortError);
            })
            .mockResolvedValueOnce(createResponse(200, payload));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const first = await getServerFeaturesSnapshot({ timeoutMs: 50 });
        expect(first.status).toBe('ready');

        const calls = featuresFetchMock.mock.calls;
        expect(calls.length).toBe(2);
        expect(String(calls[0]?.[0] ?? '')).toContain('https://active.example.test');
        expect(String(calls[1]?.[0] ?? '')).toContain('https://other.example.test');

        const second = await getServerFeaturesSnapshot({ timeoutMs: 50 });
        expect(second.status).toBe('ready');
        expect(featuresFetchMock.mock.calls.length).toBe(2);
    });

    it('recovers from a server-switch abort race by retrying automatically', async () => {
        const payload = {
            features: {
                sharing: { session: { enabled: true }, public: { enabled: true }, contentKeys: { enabled: true }, pendingQueueV2: { enabled: true } },
                voice: { enabled: false, configured: false, provider: null },
                social: { friends: { enabled: true, allowUsername: false, requiredIdentityProviderId: 'github' } },
                oauth: { providers: {} },
                auth: {
                    signup: { methods: [] },
                    login: { requiredProviders: [] },
                    recovery: { providerReset: { enabled: false, providers: [] } },
                    ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
                    providers: {},
                    misconfig: [],
                },
            },
        };

        const abortError = new Error('aborted');
        abortError.name = 'AbortError';

        let firstCallSignal: AbortSignal | null = null;
        featuresFetchMock
            .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
                return new Promise<Response>((_resolve, reject) => {
                    const signal = init?.signal;
                    if (!signal) {
                        reject(new Error('missing signal'));
                        return;
                    }
                    firstCallSignal = signal;
                    if (signal.aborted) {
                        reject(abortError);
                        return;
                    }
                    signal.addEventListener('abort', () => reject(abortError), { once: true });
                });
            })
            .mockResolvedValueOnce(createResponse(200, payload));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        const { abortServerFetches } = await import('@/sync/http/client');
        resetServerFeaturesClientForTests();

        const pending = getServerFeaturesSnapshot({ timeoutMs: 2000, force: true });
        for (let i = 0; i < 10 && !firstCallSignal; i += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        expect(firstCallSignal).toBeTruthy();

        activeServerSnapshot = {
            serverId: 'server-b',
            serverUrl: 'https://other.example.test',
            generation: 2,
        };
        abortServerFetches();

        const result = await pending;
        expect(result.status).toBe('ready');

        const calls = featuresFetchMock.mock.calls;
        expect(calls.length).toBe(2);
        expect(String(calls[0]?.[0] ?? '')).toContain('https://active.example.test');
        expect(String(calls[1]?.[0] ?? '')).toContain('https://other.example.test');
    });

    it('retries again when a server-switch abort also cancels the retry attempt', async () => {
        const payload = {
            features: {
                sharing: { session: { enabled: true }, public: { enabled: true }, contentKeys: { enabled: true }, pendingQueueV2: { enabled: true } },
                voice: { enabled: false, configured: false, provider: null },
                social: { friends: { enabled: true, allowUsername: false, requiredIdentityProviderId: 'github' } },
                oauth: { providers: {} },
                auth: {
                    signup: { methods: [] },
                    login: { requiredProviders: [] },
                    recovery: { providerReset: { enabled: false, providers: [] } },
                    ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
                    providers: {},
                    misconfig: [],
                },
            },
        };

        const abortError = new Error('aborted');
        abortError.name = 'AbortError';

        let callIndex = 0;
        let secondCallStartedResolve: (() => void) | null = null;
        const secondCallStarted = new Promise<void>((resolve) => {
            secondCallStartedResolve = resolve;
        });

        featuresFetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
            callIndex += 1;
            const signal = init?.signal;
            if (!signal) return Promise.reject(new Error('missing signal'));

            if (callIndex === 2) {
                secondCallStartedResolve?.();
                secondCallStartedResolve = null;
            }

            if (callIndex >= 3) {
                return Promise.resolve(createResponse(200, payload));
            }

            return new Promise<Response>((_resolve, reject) => {
                if (signal.aborted) {
                    reject(abortError);
                    return;
                }
                signal.addEventListener('abort', () => reject(abortError), { once: true });
            });
        });

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        const { abortServerFetches } = await import('@/sync/http/client');
        resetServerFeaturesClientForTests();

        const pending = getServerFeaturesSnapshot({ timeoutMs: 2000, force: true });

        // First abort occurs while switching from server-a -> server-b.
        activeServerSnapshot = {
            serverId: 'server-b',
            serverUrl: 'https://other.example.test',
            generation: 2,
        };
        abortServerFetches();

        // Second abort simulates the race where the retry is also cancelled by the same switch.
        await secondCallStarted;
        abortServerFetches();

        const result = await pending;
        expect(result.status).toBe('ready');

        const calls = featuresFetchMock.mock.calls;
        expect(calls.length).toBe(3);
        expect(String(calls[0]?.[0] ?? '')).toContain('https://active.example.test');
        expect(String(calls[1]?.[0] ?? '')).toContain('https://other.example.test');
        expect(String(calls[2]?.[0] ?? '')).toContain('https://other.example.test');
    });

    it('fetches features against the explicit serverId url (not the active server)', async () => {
        const payload = {
            features: {
                sharing: { session: { enabled: true }, public: { enabled: true }, contentKeys: { enabled: true }, pendingQueueV2: { enabled: true } },
                voice: { enabled: false, configured: false, provider: null },
                social: { friends: { enabled: true, allowUsername: false, requiredIdentityProviderId: 'github' } },
                oauth: { providers: {} },
                auth: {
                    signup: { methods: [] },
                    login: { requiredProviders: [] },
                    recovery: { providerReset: { enabled: false, providers: [] } },
                    ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
                    providers: {},
                    misconfig: [],
                },
            },
        };

        featuresFetchMock.mockResolvedValueOnce(createResponse(200, payload));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const result = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50, serverId: 'server-b' });
        expect(result.status).toBe('ready');

        const rawCalls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
        expect(rawCalls.some(([input]) => String(input).includes('https://other.example.test/health'))).toBe(true);
        expect(rawCalls.some(([input]) => String(input).includes('https://other.example.test/v1/features'))).toBe(true);

        const calls = featuresFetchMock.mock.calls;
        expect(calls.length).toBe(1);
        expect(String(calls[0]?.[0] ?? '')).toContain('https://other.example.test');
    });
});
