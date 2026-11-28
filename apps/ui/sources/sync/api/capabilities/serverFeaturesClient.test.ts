import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let activeServerSnapshot = {
    serverId: 'server-a',
    serverUrl: 'https://active.example.test',
    generation: 1,
};

let featuresFetchMock: ReturnType<typeof vi.fn>;
let setServerProfileIdentityForUrlMock: ReturnType<typeof vi.fn>;

const frozenServerFeaturesTime = new Date('2026-02-13T00:00:00.000Z');
const frozenServerFeaturesTimeAfterCooldown = new Date('2026-02-13T00:01:00.000Z');
const frozenServerFeaturesTimeAfterErrorTtl = new Date('2026-02-13T00:00:06.000Z');

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
}));

function normalizeServerProfileId(raw: unknown): string {
    return String(raw ?? '').trim();
}

const serverFeatureProfiles = [
    { id: 'server-a', serverIdentityId: 'srv_server_a', serverUrl: 'https://active.example.test' },
    { id: 'server-b', serverUrl: 'https://other.example.test' },
];

function findServerFeatureProfile(idRaw: unknown): { id: string; serverIdentityId?: string; serverUrl: string } | null {
    const id = normalizeServerProfileId(idRaw);
    if (!id) return null;
    return serverFeatureProfiles.find((profile) => (
        profile.id === id
        || profile.serverIdentityId === id
    )) ?? null;
}

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getServerProfileById: (idRaw: string) => findServerFeatureProfile(idRaw),
    resolveServerProfileScopeIdForIdentifier: (idRaw: string) => {
        const profile = findServerFeatureProfile(idRaw);
        return profile?.serverIdentityId ?? profile?.id ?? normalizeServerProfileId(idRaw);
    },
    areServerProfileIdentifiersEquivalent: (leftRaw: string, rightRaw: string) => {
        const left = normalizeServerProfileId(leftRaw);
        const right = normalizeServerProfileId(rightRaw);
        if (!left || !right) return false;
        if (left === right) return true;
        const leftProfile = findServerFeatureProfile(left);
        const rightProfile = findServerFeatureProfile(right);
        return Boolean(leftProfile && rightProfile && leftProfile.id === rightProfile.id);
    },
    setServerProfileIdentityForUrl: (...args: unknown[]) => setServerProfileIdentityForUrlMock(...args),
}));

function createResponse(status: number, payload: unknown) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
    } as Response;
}

function createValidFeaturesPayload() {
    return {
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

    beforeEach(async () => {
        activeServerSnapshot = {
            serverId: 'server-a',
            serverUrl: 'https://active.example.test',
            generation: 1,
        };
        featuresFetchMock = vi.fn();
        setServerProfileIdentityForUrlMock = vi.fn();
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
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
    });

    afterEach(async () => {
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
        vi.resetModules();
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
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
        for (let attempt = 0; attempt < 10 && featuresFetchMock.mock.calls.length === 0; attempt += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        expect(featuresFetchMock.mock.calls.length).toBe(1);

        const resolveFetch: (value: Response) => void =
            resolver ?? (() => { throw new Error('Expected fetch resolver to be assigned'); });
        resolveFetch(createResponse(200, payload));
        const [a, b] = await Promise.all([first, second]);

        expect(a.status).toBe('ready');
        expect(b.status).toBe('ready');
    });

    it('keeps caller wait budgets independent from the shared feature request', async () => {
        useFrozenServerFeaturesClock();
        let resolveFetch!: (response: Response) => void;
        featuresFetchMock.mockImplementation(() => new Promise<Response>((resolve) => {
            resolveFetch = resolve;
        }));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const impatient = getServerFeaturesSnapshot({ force: true, timeoutMs: 10 });
        const patient = getServerFeaturesSnapshot({ force: true, timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(10);
        await expect(impatient).resolves.toEqual({ status: 'error', reason: 'timeout' });

        resolveFetch(createResponse(200, createValidFeaturesPayload()));
        await expect(patient).resolves.toMatchObject({ status: 'ready' });
        expect(featuresFetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the last ready snapshot when a forced refresh has a transient network failure', async () => {
        featuresFetchMock
            .mockResolvedValueOnce(createResponse(200, createValidFeaturesPayload()))
            .mockRejectedValueOnce(new TypeError('network unavailable'));

        const {
            getCachedServerFeaturesSnapshot,
            getServerFeaturesSnapshot,
            getServerFeaturesSnapshotRetryDelayMs,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        await expect(getServerFeaturesSnapshot({ force: true, timeoutMs: 100 })).resolves.toMatchObject({ status: 'ready' });
        await expect(getServerFeaturesSnapshot({ force: true, timeoutMs: 100 })).resolves.toMatchObject({ status: 'ready' });
        const cached = getCachedServerFeaturesSnapshot();
        expect(cached).toMatchObject({ status: 'ready' });
        const retryDelayMs = getServerFeaturesSnapshotRetryDelayMs({ snapshot: cached! });
        expect(retryDelayMs).not.toBeNull();
        expect(retryDelayMs!).toBeGreaterThan(0);
        expect(retryDelayMs!).toBeLessThanOrEqual(5_000);
    });

    it('keeps the last ready snapshot when a forced refresh receives a transient response status', async () => {
        featuresFetchMock
            .mockResolvedValueOnce(createResponse(200, createValidFeaturesPayload()))
            .mockResolvedValueOnce(createResponse(503, {}));

        const {
            getCachedServerFeaturesSnapshot,
            getServerFeaturesSnapshot,
            getServerFeaturesSnapshotRetryDelayMs,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        await expect(getServerFeaturesSnapshot({ force: true, timeoutMs: 100 })).resolves.toMatchObject({ status: 'ready' });
        await expect(getServerFeaturesSnapshot({ force: true, timeoutMs: 100 })).resolves.toMatchObject({ status: 'ready' });
        const cached = getCachedServerFeaturesSnapshot();
        expect(cached).toMatchObject({ status: 'ready' });
        const retryDelayMs = getServerFeaturesSnapshotRetryDelayMs({ snapshot: cached! });
        expect(retryDelayMs).not.toBeNull();
        expect(retryDelayMs!).toBeGreaterThan(0);
        expect(retryDelayMs!).toBeLessThanOrEqual(30_000);
    });

    it('does not preserve a ready snapshot across a non-retryable response status', async () => {
        featuresFetchMock
            .mockResolvedValueOnce(createResponse(200, createValidFeaturesPayload()))
            .mockResolvedValueOnce(createResponse(403, {}));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        await expect(getServerFeaturesSnapshot({ force: true, timeoutMs: 100 })).resolves.toMatchObject({ status: 'ready' });
        await expect(getServerFeaturesSnapshot({ force: true, timeoutMs: 100 })).resolves.toEqual({
            status: 'error',
            reason: 'response_status',
            httpStatus: 403,
        });
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
        expect(String(featuresFetchMock.mock.calls[0]?.[0] ?? '')).toBe('https://active.example.test/v1/features?retentionNotice=1');
    });

    it('treats an explicit profile id for the active durable identity as the active server', async () => {
        activeServerSnapshot = {
            serverId: 'srv_server_a',
            serverUrl: 'https://active.example.test',
            generation: 1,
        };
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
                    ui: { autoRedirect: { enabled: true, providerId: null }, recoveryKeyReminder: { enabled: true } },
                    providers: {},
                    misconfig: [],
                },
            },
        };
        featuresFetchMock.mockResolvedValueOnce(createResponse(200, payload));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const result = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50, serverId: 'server-a' });

        expect(result.status).toBe('ready');
        const rawCalls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
        expect(rawCalls.some(([input]) => String(input).includes('/health'))).toBe(false);
        expect(featuresFetchMock).toHaveBeenCalledTimes(1);
        expect(String(featuresFetchMock.mock.calls[0]?.[0] ?? '')).toBe('https://active.example.test/v1/features?retentionNotice=1');
    });

    it('stores the server identity advertised by the active server features payload', async () => {
        featuresFetchMock.mockResolvedValueOnce(createResponse(200, {
            capabilities: {
                serverIdentity: {
                    serverIdentityId: 'srv_active_identity',
                },
            },
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
        }));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const result = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });

        expect(result.status).toBe('ready');
        expect(setServerProfileIdentityForUrlMock).toHaveBeenCalledWith(
            'https://active.example.test',
            'srv_active_identity',
        );
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

    it('returns error status when the relay is completely offline and even the health probe fails', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(
            new TypeError('Network request failed'),
        ) as unknown as typeof fetch;

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        resetServerFeaturesClientForTests();
        await resetServerReachabilitySupervisors();

        const result = await getServerFeaturesSnapshot({ force: true, timeoutMs: 100 });
        expect(result.status).toBe('error');
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
