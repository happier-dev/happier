import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let activeServerSnapshot = {
    serverId: 'server-a',
    serverUrl: 'https://active.example.test',
    generation: 1,
};

let featuresFetchMock: ReturnType<typeof vi.fn>;
let setServerProfileIdentityForUrlMock: ReturnType<typeof vi.fn>;
let reconcileServerProfileHomeConnectionDescriptorMock: ReturnType<typeof vi.fn>;
let learnedServerIdentityId: string | null;
let serverBProfileOverrides: Record<string, unknown>;

const frozenServerFeaturesTime = new Date('2026-02-13T00:00:00.000Z');
const frozenServerFeaturesTimeAfterErrorTtl = new Date('2026-02-13T00:00:06.000Z');

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
    getActiveServerHomeCarrier: () => null,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => {
        const normalize = (value: unknown) => {
            const id = String(value ?? '').trim();
            return learnedServerIdentityId && id === learnedServerIdentityId ? 'server-a' : id;
        };
        return normalize(left) === normalize(right);
    },
    getServerProfileById: (idRaw: string) => {
        const id = String(idRaw ?? '').trim();
        if (!id) return null;
        if (id === 'server-a' || (learnedServerIdentityId && id === learnedServerIdentityId)) {
            return {
                id: 'server-a',
                serverUrl: 'https://active.example.test',
                ...(learnedServerIdentityId ? { serverIdentityId: learnedServerIdentityId } : {}),
            };
        }
        if (id === 'server-b') return { id, serverUrl: 'https://other.example.test', ...serverBProfileOverrides };
        return null;
    },
    resolveServerProfileScopeIdForIdentifier: (idRaw: unknown) => {
        const id = String(idRaw ?? '').trim();
        return learnedServerIdentityId && (id === 'server-a' || id === learnedServerIdentityId)
            ? learnedServerIdentityId
            : id;
    },
    setServerProfileIdentityForUrl: (...args: unknown[]) => setServerProfileIdentityForUrlMock(...args),
    reconcileServerProfileHomeConnectionDescriptor: (...args: unknown[]) => reconcileServerProfileHomeConnectionDescriptorMock(...args),
}));

function createResponse(status: number, payload: unknown) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function createValidFeaturesPayload() {
    return FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
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
        learnedServerIdentityId = null;
        serverBProfileOverrides = {};
        setServerProfileIdentityForUrlMock = vi.fn((_url: string, identity: string) => {
            learnedServerIdentityId = identity;
            activeServerSnapshot = {
                ...activeServerSnapshot,
                serverId: identity,
                generation: activeServerSnapshot.generation + 1,
            };
            return {
                id: 'server-a',
                serverUrl: 'https://active.example.test',
                serverIdentityId: identity,
            };
        });
        reconcileServerProfileHomeConnectionDescriptorMock = vi.fn(async () => ({ kind: 'applied' }));
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
        vi.doUnmock('@/auth/storage/tokenStorage');
        vi.doUnmock('@/sync/runtime/browserIroh/hostEligibility');
        vi.doUnmock('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier');
        vi.resetModules();
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
    });

    it('restores last-known public feature discovery before a reload refresh settles, without renewing freshness or crossing Homes', async () => {
        useFrozenServerFeaturesClock();
        const client = await import('./serverFeaturesClient');
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        client.resetServerFeaturesClientForTests();
        const payload = FeaturesResponseSchema.parse({ features: { workflows: { enabled: true }, automations: { enabled: true } }, capabilities: {} });
        featuresFetchMock.mockResolvedValue(createResponse(200, payload));
        const ready = await client.getServerFeaturesSnapshot({ force: true });
        const key = 'server-features-snapshot-v1:server-a';
        const persisted = getPersistenceStorage().getString(key);
        expect(persisted).toBeDefined();
        client.resetServerFeaturesClientForTests();
        getPersistenceStorage().set(key, persisted!);
        setFrozenServerFeaturesClock(new Date(frozenServerFeaturesTime.getTime() + 11 * 60 * 1000));
        expect(client.getCachedServerFeaturesSnapshot()).toEqual(ready);
        getPersistenceStorage().set('server-features-snapshot-v1:server-b', persisted!);
        expect(client.getCachedServerFeaturesSnapshot({ serverId: 'server-b' })).toBeNull();
        let settle: ((response: Response) => void) | undefined;
        featuresFetchMock.mockImplementation(() => new Promise<Response>(resolve => { settle = resolve; }));
        const refreshing = client.getServerFeaturesSnapshot();
        await vi.waitFor(() => expect(settle).toBeDefined());
        const disabled = FeaturesResponseSchema.parse({ features: { workflows: { enabled: false }, automations: { enabled: false } }, capabilities: {} });
        settle!(createResponse(200, disabled));
        await refreshing;
        expect(client.getCachedServerFeaturesSnapshot()).toMatchObject({ status: 'ready', features: { features: { workflows: { enabled: false } } } });
        client.deleteServerFeaturesSnapshot();
        expect(client.getCachedServerFeaturesSnapshot()).toBeNull();
        expect(getPersistenceStorage().getString(key)).toBeUndefined();
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

        const {
            getServerFeaturesSnapshot,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const first = getServerFeaturesSnapshot({ force: true, timeoutMs: 2000 });
        const second = getServerFeaturesSnapshot({ force: true, timeoutMs: 2000 });

        await vi.waitFor(() => {
            expect(featuresFetchMock.mock.calls.length).toBe(1);
        });

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

        const patient = getServerFeaturesSnapshot({ force: true });
        await vi.waitFor(() => expect(featuresFetchMock).toHaveBeenCalledTimes(1));
        const impatient = getServerFeaturesSnapshot({ force: true, timeoutMs: 10 });
        await vi.advanceTimersByTimeAsync(10);
        await expect(impatient).resolves.toEqual({ status: 'error', reason: 'timeout' });

        resolveFetch(createResponse(200, createValidFeaturesPayload()));
        await expect(patient).resolves.toMatchObject({ status: 'ready' });
        expect(featuresFetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps a last-ready snapshot visible while scheduling a transient refresh retry', async () => {
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

        await expect(getServerFeaturesSnapshot({ force: true })).resolves.toMatchObject({ status: 'ready' });
        await expect(getServerFeaturesSnapshot({ force: true })).resolves.toMatchObject({ status: 'ready' });
        const cached = getCachedServerFeaturesSnapshot();
        expect(cached).toMatchObject({ status: 'ready' });
        const retryDelayMs = getServerFeaturesSnapshotRetryDelayMs({ snapshot: cached! });
        expect(retryDelayMs).not.toBeNull();
        expect(retryDelayMs!).toBeGreaterThan(0);
        expect(retryDelayMs!).toBeLessThanOrEqual(5_000);
    });

    it('uses a primed feature snapshot without issuing a feature request', async () => {
        const primed = {
            status: 'ready' as const,
            features: FeaturesResponseSchema.parse({
                features: {
                    sessions: {
                        enabled: true,
                        folders: { enabled: false },
                    },
                },
                capabilities: {},
            }),
        };

        const {
            getServerFeaturesSnapshot,
            primeServerFeaturesSnapshot,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        primeServerFeaturesSnapshot({ serverId: 'server-a', snapshot: primed });

        const result = await getServerFeaturesSnapshot({ serverId: 'server-a' });

        expect(result).toBe(primed);
        expect(featuresFetchMock).not.toHaveBeenCalled();
    });

    it('deletes a primed feature snapshot for a server', async () => {
        const primed = {
            status: 'ready' as const,
            features: FeaturesResponseSchema.parse({
                features: {
                    sessions: {
                        enabled: true,
                        folders: { enabled: false },
                    },
                },
                capabilities: {},
            }),
        };

        const {
            deleteServerFeaturesSnapshot,
            getCachedServerFeaturesSnapshot,
            primeServerFeaturesSnapshot,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        primeServerFeaturesSnapshot({ serverId: 'server-a', snapshot: primed });
        expect(getCachedServerFeaturesSnapshot({ serverId: 'server-a' })).toBe(primed);

        deleteServerFeaturesSnapshot({ serverId: 'server-a' });

        expect(getCachedServerFeaturesSnapshot({ serverId: 'server-a' })).toBeNull();
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

        const {
            getServerFeaturesSnapshot,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const result = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });

        expect(result).toMatchObject({ status: 'ready' });
        expect(setServerProfileIdentityForUrlMock).toHaveBeenCalledWith(
            'https://active.example.test',
            'srv_active_identity',
        );
    });

    it('fails closed when the advertised identity conflicts with the saved Home identity', async () => {
        setServerProfileIdentityForUrlMock.mockReturnValueOnce(null);
        featuresFetchMock.mockResolvedValueOnce(createResponse(200, {
            capabilities: {
                serverIdentity: {
                    serverIdentityId: 'srv_conflicting_identity',
                },
            },
            features: {},
        }));

        const {
            getCachedServerFeaturesSnapshot,
            getServerFeaturesSnapshot,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const result = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });

        expect(result).toEqual({ status: 'error', reason: 'identity_conflict' });
        expect(getCachedServerFeaturesSnapshot()).toEqual(result);
        expect(reconcileServerProfileHomeConnectionDescriptorMock).not.toHaveBeenCalled();
    });

    it('rekeys a ready feature snapshot when learning the active server identity', async () => {
        const payload = FeaturesResponseSchema.parse({
            features: {
                machines: {
                    enabled: true,
                    rpc: {
                        enabled: true,
                        directPeer: { enabled: true },
                    },
                },
            },
            capabilities: {
                serverIdentity: {
                    serverIdentityId: 'srv_active_identity',
                },
            },
        });
        featuresFetchMock.mockResolvedValueOnce(createResponse(200, payload));

        const {
            getCachedServerFeaturesSnapshot,
            getServerFeaturesSnapshot,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const fetched = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });

        expect(fetched).toMatchObject({
            status: 'ready',
            serverIdentityId: 'srv_active_identity',
        });
        expect(activeServerSnapshot.serverId).toBe('srv_active_identity');
        expect(getCachedServerFeaturesSnapshot({ serverId: 'srv_active_identity' })).toBe(fetched);
        expect(getCachedServerFeaturesSnapshot({ serverId: 'srv_active_identity' })).toMatchObject({
            status: 'ready',
            serverIdentityId: 'srv_active_identity',
        });
    });

    it('surfaces the authenticated full Home descriptor as an exact current-connection observation', async () => {
        const homeConnectionDescriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_active_identity',
            canonicalServerUrl: 'https://active.example.test',
            revision: 4,
            endpoints: [{
                kind: 'iroh' as const,
                endpointId: 'a'.repeat(64),
                directAddresses: ['192.168.1.10:4242'],
            }],
        };
        const payload = FeaturesResponseSchema.parse({
            features: {},
            capabilities: {
                serverIdentity: { serverIdentityId: 'srv_active_identity' },
            },
            homeConnectionDescriptor,
        });
        featuresFetchMock.mockResolvedValueOnce(createResponse(200, payload));

        const {
            refreshAuthenticatedServerFeaturesSnapshot,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();
        const result = await refreshAuthenticatedServerFeaturesSnapshot({
            credentials: { token: 'home-token' },
            force: true,
            timeoutMs: 50,
        });

        expect(result.status).toBe('ready');
        expect(reconcileServerProfileHomeConnectionDescriptorMock).toHaveBeenCalledWith({
            serverUrl: 'https://active.example.test',
            observedServerIdentityId: 'srv_active_identity',
            descriptor: homeConnectionDescriptor,
            observation: 'exact',
        });
        expect(featuresFetchMock.mock.calls.some(([input]) => (
            String(input).endsWith('/v1/features/authenticated')
        ))).toBe(true);
    });

    it('falls back to the public projection on older Homes and preserves its advisory observation mode', async () => {
        const homeConnectionDescriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_active_identity',
            canonicalServerUrl: 'https://active.example.test',
            revision: 4,
            endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
        };
        const payload = FeaturesResponseSchema.parse({
            features: {},
            capabilities: {
                serverIdentity: { serverIdentityId: 'srv_active_identity' },
            },
            homeConnectionDescriptor,
        });
        featuresFetchMock
            .mockResolvedValueOnce(createResponse(404, {}))
            .mockResolvedValueOnce(createResponse(200, payload));

        const {
            refreshAuthenticatedServerFeaturesSnapshot,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();
        const result = await refreshAuthenticatedServerFeaturesSnapshot({
            credentials: { token: 'home-token' },
            force: true,
            timeoutMs: 50,
        });

        expect(result.status).toBe('ready');
        expect(reconcileServerProfileHomeConnectionDescriptorMock).toHaveBeenCalledWith({
            serverUrl: 'https://active.example.test',
            observedServerIdentityId: 'srv_active_identity',
            descriptor: homeConnectionDescriptor,
            observation: 'public',
        });
    });

    it('keeps the default active feature projection public and unauthenticated', async () => {
        featuresFetchMock.mockResolvedValueOnce(createResponse(200, {
            capabilities: {
                serverIdentity: { serverIdentityId: 'srv_active_identity' },
            },
            features: {},
        }));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const result = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });

        expect(result.status).toBe('ready');
        expect(featuresFetchMock).toHaveBeenCalledTimes(1);
        expect(String(featuresFetchMock.mock.calls[0]?.[0])).toMatch(/\/v1\/features$/);
        expect(String(featuresFetchMock.mock.calls[0]?.[0])).not.toContain('/authenticated');
    });

    it('classifies 404 features endpoint as unsupported', async () => {
        featuresFetchMock
            .mockResolvedValueOnce(createResponse(404, {}))
            .mockResolvedValueOnce(createResponse(404, {}));

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

    it('caches ordinary endpoint-missing reads but immediately honors explicit revalidation', async () => {
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
        const second = await getServerFeaturesSnapshot({ timeoutMs: 50 });

        expect(first.status).toBe('unsupported');
        expect(second.status).toBe('unsupported');
        expect(featuresFetchMock.mock.calls.length).toBe(1);
        const refreshed = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });
        expect(refreshed.status).toBe('ready');
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

        const {
            getServerFeaturesSnapshot,
            getServerFeaturesSnapshotRetryDelayMs,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        useFrozenServerFeaturesClock();

        const firstPromise = getServerFeaturesSnapshot({ timeoutMs: 50 });
        await vi.advanceTimersByTimeAsync(0);
        const first = await firstPromise;
        expect(first.status).toBe('error');
        expect(featuresFetchMock.mock.calls.length).toBe(1);

        setFrozenServerFeaturesClock(new Date(frozenServerFeaturesTime.getTime() + 4_000));
        expect(getServerFeaturesSnapshotRetryDelayMs({ snapshot: first })).toBe(1_000);

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

    it('refreshes transitional Home indexing snapshots and stops retrying once Home search settles', async () => {
        const indexingPayload = FeaturesResponseSchema.parse({
            features: {},
            capabilities: {
                homeSearch: { enabled: false, reason: 'indexing' },
            },
        });
        const readyPayload = FeaturesResponseSchema.parse({
            features: {},
            capabilities: {
                homeSearch: { enabled: true },
            },
        });

        featuresFetchMock
            .mockResolvedValueOnce(createResponse(200, indexingPayload))
            .mockResolvedValueOnce(createResponse(200, readyPayload));

        const {
            getServerFeaturesSnapshot,
            getServerFeaturesSnapshotRetryDelayMs,
            primeServerFeaturesSnapshot,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();
        useFrozenServerFeaturesClock();

        const indexing = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });
        expect(indexing).toMatchObject({
            status: 'ready',
            features: { capabilities: { homeSearch: { enabled: false, reason: 'indexing' } } },
        });

        setFrozenServerFeaturesClock(new Date(frozenServerFeaturesTime.getTime() + 4_000));
        expect(getServerFeaturesSnapshotRetryDelayMs({ snapshot: indexing })).toBe(1_000);

        setFrozenServerFeaturesClock(frozenServerFeaturesTimeAfterErrorTtl);
        const settled = await getServerFeaturesSnapshot({ timeoutMs: 50 });
        expect(settled).toMatchObject({
            status: 'ready',
            features: { capabilities: { homeSearch: { enabled: true } } },
        });
        expect(featuresFetchMock).toHaveBeenCalledTimes(2);
        expect(getServerFeaturesSnapshotRetryDelayMs({ snapshot: settled })).toBeNull();

        const unavailable = {
            status: 'ready' as const,
            features: FeaturesResponseSchema.parse({
                features: {},
                capabilities: {
                    homeSearch: { enabled: false, reason: 'index_unavailable' },
                },
            }),
        };
        primeServerFeaturesSnapshot({ snapshot: unavailable });
        expect(getServerFeaturesSnapshotRetryDelayMs({ snapshot: unavailable })).toBeNull();

        setFrozenServerFeaturesClock(new Date(frozenServerFeaturesTimeAfterErrorTtl.getTime() + 6_000));
        expect(await getServerFeaturesSnapshot({ timeoutMs: 50 })).toBe(unavailable);
        expect(featuresFetchMock).toHaveBeenCalledTimes(2);
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

    it('retries a post-response stale server generation without caching a network error', async () => {
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
            .mockImplementationOnce(() => {
                activeServerSnapshot = {
                    serverId: 'server-b',
                    serverUrl: 'https://other.example.test',
                    generation: 2,
                };
                return Promise.resolve(createResponse(200, payload));
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

    it('retries a generation-only stale response within the active server cache scope', async () => {
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
            .mockImplementationOnce(() => {
                activeServerSnapshot = {
                    ...activeServerSnapshot,
                    generation: activeServerSnapshot.generation + 1,
                };
                return Promise.resolve(createResponse(200, payload));
            })
            .mockResolvedValueOnce(createResponse(200, payload));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        try {
            const first = await Promise.race([
                getServerFeaturesSnapshot({ timeoutMs: 50 }),
                new Promise<never>((_resolve, reject) => {
                    timeoutHandle = setTimeout(
                        () => reject(new Error('timed out waiting for a same-scope generation retry')),
                        250,
                    );
                }),
            ]);
            expect(first.status).toBe('ready');
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
        }

        const calls = featuresFetchMock.mock.calls;
        expect(calls.length).toBe(2);
        expect(String(calls[0]?.[0] ?? '')).toContain('https://active.example.test');
        expect(String(calls[1]?.[0] ?? '')).toContain('https://active.example.test');
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

    it('refreshes a nonfocused ingress-less Home through its authenticated server-scoped carrier after a public privacy-reduced observation', async () => {
        const publicDescriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_iroh_home',
            canonicalServerUrl: 'http://localhost:3010',
            revision: 5,
            endpoints: [{
                kind: 'iroh' as const,
                endpointId: 'a'.repeat(64),
                relayUrls: ['https://relay-public.example.test'],
            }],
        };
        const authenticatedDescriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_iroh_home',
            canonicalServerUrl: 'http://localhost:3010',
            revision: 5,
            endpoints: [{
                kind: 'iroh' as const,
                endpointId: 'a'.repeat(64),
                relayUrls: ['https://relay-authenticated.example.test'],
                directAddresses: ['192.0.2.91:443'],
            }],
        };
        serverBProfileOverrides = {
            canonicalServerUrl: 'http://localhost:3010',
            publicServerUrl: null,
            serverIdentityId: 'srv_iroh_home',
            homeConnectionDescriptor: {
                v: 1,
                homeServerIdentityId: 'srv_iroh_home',
                canonicalServerUrl: 'http://localhost:3010',
                revision: 4,
                endpoints: [{
                    kind: 'iroh',
                    endpointId: 'a'.repeat(64),
                    relayUrls: ['https://relay-old.example.test'],
                    directAddresses: ['192.0.2.90:443'],
                }],
            },
        };
        const release = vi.fn(async () => {});
        const homeCarrierRequest = vi.fn(async (url: string) => new Response(JSON.stringify({
            features: {},
            capabilities: {
                serverIdentity: { serverIdentityId: 'srv_iroh_home' },
            },
            homeConnectionDescriptor: url.endsWith('/v1/features/authenticated')
                ? authenticatedDescriptor
                : publicDescriptor,
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        const homeCarrier = {
            leaseId: 'browser-iroh-lease',
            homeServerIdentityId: 'srv_iroh_home',
            appliedRelayUrls: ['https://relay.example.test'],
            endpointId: 'a'.repeat(64),
            readObservedPath: () => 'relay' as const,
            request: homeCarrierRequest,
            createWebSocket: vi.fn(),
            release,
        };
        vi.doMock('@/auth/storage/tokenStorage', async (importOriginal) => {
            const original = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
            return {
                ...original,
                TokenStorage: {
                    ...original.TokenStorage,
                    getCredentialsForServerUrl: vi.fn(async () => ({ token: 'home-token' })),
                },
            };
        });
        vi.doMock('@/sync/runtime/browserIroh/hostEligibility', () => ({
            resolveBrowserIrohHostDecision: () => ({ eligible: true }),
        }));
        vi.doMock('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier', async (importOriginal) => {
            const original = await importOriginal<
                typeof import('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier')
            >();
            return {
                ...original,
                acquireBrowserIrohHomeCarrier: vi.fn(async () => homeCarrier),
            };
        });

        const {
            getServerFeaturesSnapshot,
            refreshAuthenticatedServerFeaturesSnapshot,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const publicResult = await getServerFeaturesSnapshot({
            force: true,
            timeoutMs: 2_000,
            serverId: 'server-b',
        });
        const authenticatedResult = await refreshAuthenticatedServerFeaturesSnapshot({
            credentials: { token: 'home-token' },
            force: true,
            timeoutMs: 2_000,
            serverId: 'server-b',
        });

        expect(publicResult).toMatchObject({ status: 'ready', serverIdentityId: 'srv_iroh_home' });
        expect(authenticatedResult).toMatchObject({ status: 'ready', serverIdentityId: 'srv_iroh_home' });
        expect(homeCarrierRequest.mock.calls.map(([url]) => url)).toEqual([
            'http://localhost:3010/v1/features',
            'http://localhost:3010/v1/features/authenticated',
        ]);
        expect(reconcileServerProfileHomeConnectionDescriptorMock).toHaveBeenNthCalledWith(1, {
            serverUrl: 'https://other.example.test',
            observedServerIdentityId: 'srv_iroh_home',
            descriptor: publicDescriptor,
            observation: 'public',
        });
        expect(reconcileServerProfileHomeConnectionDescriptorMock).toHaveBeenNthCalledWith(2, {
            serverUrl: 'https://other.example.test',
            observedServerIdentityId: 'srv_iroh_home',
            descriptor: authenticatedDescriptor,
            observation: 'exact',
        });
        expect(release).toHaveBeenCalledTimes(2);
    });

    it('discovers features for a nonfocused ingress-less Home through its server-scoped browser Iroh carrier', async () => {
        serverBProfileOverrides = {
            canonicalServerUrl: 'http://localhost:3010',
            publicServerUrl: null,
            serverIdentityId: 'srv_iroh_home',
            homeConnectionDescriptor: {
                v: 1,
                homeServerIdentityId: 'srv_iroh_home',
                canonicalServerUrl: 'http://localhost:3010',
                revision: 4,
                endpoints: [{
                    kind: 'iroh',
                    endpointId: 'iroh-home-endpoint',
                    relayUrls: ['https://relay.example.test'],
                }],
            },
        };
        const release = vi.fn(async () => {});
        const homeCarrierRequest = vi.fn(async () => new Response(JSON.stringify({
            features: {},
            capabilities: {
                serverIdentity: { serverIdentityId: 'srv_iroh_home' },
            },
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        const homeCarrier = {
            leaseId: 'browser-iroh-lease',
            homeServerIdentityId: 'srv_iroh_home',
            appliedRelayUrls: ['https://relay.example.test'],
            endpointId: 'iroh-home-endpoint',
            readObservedPath: () => 'relay' as const,
            request: homeCarrierRequest,
            createWebSocket: vi.fn(),
            release,
        };
        vi.doMock('@/auth/storage/tokenStorage', async (importOriginal) => {
            const original = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
            return {
                ...original,
                TokenStorage: {
                    ...original.TokenStorage,
                    getCredentialsForServerUrl: vi.fn(async () => ({ token: 'home-token' })),
                },
            };
        });
        vi.doMock('@/sync/runtime/browserIroh/hostEligibility', () => ({
            resolveBrowserIrohHostDecision: () => ({ eligible: true }),
        }));
        vi.doMock('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier', async (importOriginal) => {
            const original = await importOriginal<
                typeof import('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier')
            >();
            return {
                ...original,
                acquireBrowserIrohHomeCarrier: vi.fn(async () => homeCarrier),
            };
        });

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const result = await getServerFeaturesSnapshot({
            force: true,
            timeoutMs: 2_000,
            serverId: 'server-b',
        });

        expect(result).toMatchObject({ status: 'ready', serverIdentityId: 'srv_iroh_home' });
        expect(homeCarrierRequest).toHaveBeenCalledWith(
            'http://localhost:3010/v1/features',
            expect.objectContaining({ method: 'GET' }),
        );
        expect(release).toHaveBeenCalledTimes(1);
        expect(featuresFetchMock).not.toHaveBeenCalled();
    });

    it('retries retained explicit transport release custody before returning a cached feature snapshot', async () => {
        serverBProfileOverrides = {
            canonicalServerUrl: 'http://localhost:3010',
            publicServerUrl: null,
            serverIdentityId: 'srv_iroh_home',
            homeConnectionDescriptor: {
                v: 1,
                homeServerIdentityId: 'srv_iroh_home',
                canonicalServerUrl: 'http://localhost:3010',
                revision: 4,
                endpoints: [{
                    kind: 'iroh',
                    endpointId: 'iroh-home-endpoint',
                    relayUrls: ['https://relay.example.test'],
                }],
            },
        };
        const releaseError = new Error('feature transport release failed');
        const release = vi.fn(async () => {})
            .mockRejectedValueOnce(releaseError)
            .mockResolvedValue(undefined);
        const homeCarrierRequest = vi.fn(async () => new Response(JSON.stringify({
            features: {},
            capabilities: {
                serverIdentity: { serverIdentityId: 'srv_iroh_home' },
            },
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        const homeCarrier = {
            leaseId: 'browser-iroh-lease',
            homeServerIdentityId: 'srv_iroh_home',
            appliedRelayUrls: ['https://relay.example.test'],
            endpointId: 'iroh-home-endpoint',
            readObservedPath: () => 'relay' as const,
            request: homeCarrierRequest,
            createWebSocket: vi.fn(),
            release,
        };
        vi.doMock('@/auth/storage/tokenStorage', async (importOriginal) => {
            const original = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
            return {
                ...original,
                TokenStorage: {
                    ...original.TokenStorage,
                    getCredentialsForServerUrl: vi.fn(async () => ({ token: 'home-token' })),
                },
            };
        });
        vi.doMock('@/sync/runtime/browserIroh/hostEligibility', () => ({
            resolveBrowserIrohHostDecision: () => ({ eligible: true }),
        }));
        vi.doMock('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier', async (importOriginal) => {
            const original = await importOriginal<
                typeof import('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier')
            >();
            return {
                ...original,
                acquireBrowserIrohHomeCarrier: vi.fn(async () => homeCarrier),
            };
        });

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        await expect(getServerFeaturesSnapshot({
            force: true,
            timeoutMs: 2_000,
            serverId: 'server-b',
        })).rejects.toBe(releaseError);
        expect(release).toHaveBeenCalledTimes(1);
        expect(homeCarrierRequest).toHaveBeenCalledTimes(1);

        const cached = await getServerFeaturesSnapshot({
            timeoutMs: 2_000,
            serverId: 'server-b',
        });

        expect(cached).toMatchObject({ status: 'ready', serverIdentityId: 'srv_iroh_home' });
        expect(release).toHaveBeenCalledTimes(2);
        expect(homeCarrierRequest).toHaveBeenCalledTimes(1);
    });

    it('does not reuse an in-flight old-origin identity observation for a new runtime origin', async () => {
        let resolveOldOrigin: ((response: Response) => void) | null = null;
        featuresFetchMock.mockImplementation(async (input: unknown) => {
            const url = String(input);
            if (url === 'https://home.example.test/v1/features') {
                return await new Promise<Response>((resolve) => {
                    resolveOldOrigin = resolve;
                });
            }
            if (url === 'http://127.0.0.1:43123/v1/features') {
                return createResponse(200, {
                    features: {},
                    capabilities: {
                        serverIdentity: { serverIdentityId: 'srv_wrong_home' },
                    },
                });
            }
            throw new Error(`Unexpected feature probe: ${url}`);
        });

        const {
            probeServerFeaturesAtUrl,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const oldOriginProbe = probeServerFeaturesAtUrl({
            endpointUrl: 'https://home.example.test/',
            runtimeOrigin: 'https://home.example.test',
            timeoutMs: 2_000,
        });
        await vi.waitFor(() => {
            expect(featuresFetchMock).toHaveBeenCalledTimes(1);
        });

        const newOriginProbe = probeServerFeaturesAtUrl({
            endpointUrl: 'https://home.example.test',
            runtimeOrigin: 'http://127.0.0.1:43123/',
            timeoutMs: 2_000,
        });

        let concurrentProbeError: unknown = null;
        try {
            await vi.waitFor(() => {
                expect(featuresFetchMock).toHaveBeenCalledTimes(2);
            }, { timeout: 100 });
        } catch (error) {
            concurrentProbeError = error;
        }

        const completeOldOrigin: (response: Response) => void = resolveOldOrigin
            ?? (() => { throw new Error('Expected the old-origin probe to be in flight'); });
        completeOldOrigin(createResponse(200, {
            features: {},
            capabilities: {
                serverIdentity: { serverIdentityId: 'srv_expected_home' },
            },
        }));
        const [httpsResult, irohResult] = await Promise.all([oldOriginProbe, newOriginProbe]);

        if (concurrentProbeError) throw concurrentProbeError;

        expect(httpsResult.status).toBe('ready');
        expect(irohResult.status).toBe('ready');
        if (httpsResult.status !== 'ready' || irohResult.status !== 'ready') {
            throw new Error('Expected both endpoint observations to be ready');
        }
        expect(httpsResult.serverIdentityId).toBe('srv_expected_home');
        expect(irohResult.serverIdentityId).toBe('srv_wrong_home');
        expect(featuresFetchMock).toHaveBeenCalledTimes(2);
        expect(featuresFetchMock.mock.calls.map((call) => String(call[0]))).toEqual(
            expect.arrayContaining([
                'https://home.example.test/v1/features',
                'http://127.0.0.1:43123/v1/features',
            ]),
        );
    });

    it('lets a short endpoint-probe waiter expire without aborting the shared request', async () => {
        useFrozenServerFeaturesClock();
        let requestSignal: AbortSignal | undefined;
        let resolveRequest!: (response: Response) => void;
        featuresFetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
            requestSignal = init?.signal ?? undefined;
            return await new Promise<Response>((resolve) => {
                resolveRequest = resolve;
            });
        });

        const { probeServerFeaturesAtUrl, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const impatient = probeServerFeaturesAtUrl({
            endpointUrl: 'https://home.example.test',
            timeoutMs: 10,
        });
        const patient = probeServerFeaturesAtUrl({
            endpointUrl: 'https://home.example.test',
        });

        await vi.dynamicImportSettled();
        await vi.advanceTimersByTimeAsync(10);
        expect(requestSignal).toBeDefined();
        await expect(impatient).resolves.toEqual({ status: 'error', reason: 'timeout' });
        await vi.advanceTimersByTimeAsync(1_490);
        expect(requestSignal?.aborted).toBe(false);
        resolveRequest(createResponse(200, {
            features: {},
            capabilities: { serverIdentity: { serverIdentityId: 'srv_expected_home' } },
        }));
        await expect(patient).resolves.toMatchObject({
            status: 'ready',
            serverIdentityId: 'srv_expected_home',
        });
        expect(featuresFetchMock).toHaveBeenCalledOnce();
    });

    it.each(['endpoint', 'focused'] as const)('lets a cancelled %s waiter leave the shared observation available to another caller', async (projection) => {
        useFrozenServerFeaturesClock();
        let requestSignal: AbortSignal | null | undefined;
        featuresFetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
            requestSignal = init?.signal;
            await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
            return createResponse(200, createValidFeaturesPayload());
        });
        const { probeServerFeaturesAtUrl, getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();
        const probe = (signal?: AbortSignal) => projection === 'endpoint'
            ? probeServerFeaturesAtUrl({ endpointUrl: 'https://home.example.test', signal })
            : getServerFeaturesSnapshot({ force: true, signal });
        const controller = new AbortController();
        let cancellationResult: unknown;
        const cancelled = probe(controller.signal).then((snapshot) => { cancellationResult = snapshot; return snapshot; });
        const patient = probe();
        await vi.dynamicImportSettled();
        await vi.advanceTimersByTimeAsync(100);
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(cancellationResult).toEqual({ status: 'error', reason: 'network' });
        await expect(cancelled).resolves.toEqual({ status: 'error', reason: 'network' });
        expect(requestSignal).toBeDefined();
        expect(requestSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1_400);
        await expect(patient).resolves.toMatchObject({ status: 'ready' });
        expect(featuresFetchMock).toHaveBeenCalledOnce();
    });

    it.each(['endpoint', 'focused'] as const)('accepts a valid slow %s feature response without an invented attempt deadline', async (projection) => {
        useFrozenServerFeaturesClock();
        let requestSignal: AbortSignal | null | undefined;
        let resolveFetch!: (response: Response) => void;
        featuresFetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
            requestSignal = init?.signal;
            return await new Promise<Response>((resolve, reject) => {
                resolveFetch = resolve;
                requestSignal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
            });
        });
        const { probeServerFeaturesAtUrl, getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();
        let settled = false;
        const result = (projection === 'endpoint'
            ? probeServerFeaturesAtUrl({ endpointUrl: 'https://home.example.test' })
            : getServerFeaturesSnapshot()).then((snapshot) => {
            settled = true;
            return snapshot;
        });
        await vi.dynamicImportSettled();
        await vi.advanceTimersByTimeAsync(61_000);
        expect(settled).toBe(false);
        expect(requestSignal?.aborted).toBe(false);
        resolveFetch(createResponse(200, createValidFeaturesPayload()));
        await expect(result).resolves.toMatchObject({ status: 'ready' });
    });

    it('probes an explicit ingress-less Home through its semantic carrier', async () => {
        const homeCarrierRequest = vi.fn(async () => createResponse(200, {
            features: {},
            capabilities: {
                serverIdentity: { serverIdentityId: 'srv_iroh_home' },
            },
        }));
        const homeCarrier = {
            endpointId: 'iroh-home-endpoint',
            readObservedPath: () => 'relay' as const,
            request: homeCarrierRequest,
            createWebSocket: vi.fn(),
        };
        const {
            probeServerFeaturesAtUrl,
            resetServerFeaturesClientForTests,
        } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const result = await probeServerFeaturesAtUrl({
            endpointUrl: 'http://localhost:3010',
            homeCarrier,
            timeoutMs: 2_000,
        });

        expect(result).toMatchObject({ status: 'ready', serverIdentityId: 'srv_iroh_home' });
        expect(homeCarrierRequest).toHaveBeenCalledWith(
            'http://localhost:3010/v1/features',
            expect.objectContaining({ method: 'GET' }),
        );
        expect(featuresFetchMock).not.toHaveBeenCalled();
    });
});
