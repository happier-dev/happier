import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: 'https://active.example.test',
        generation: 1,
    }),
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

describe('serverFeaturesClient', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        globalThis.fetch = vi.fn() as unknown as typeof fetch;
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
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
            () =>
                new Promise<Response>((resolve) => {
                    resolver = resolve;
                }),
        );

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const first = getServerFeaturesSnapshot({ force: true, timeoutMs: 2000 });
        const second = getServerFeaturesSnapshot({ force: true, timeoutMs: 2000 });

        expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

        const resolveFetch: (value: Response) => void =
            resolver ?? (() => { throw new Error('Expected fetch resolver to be assigned'); });
        resolveFetch(createResponse(200, payload));
        const [a, b] = await Promise.all([first, second]);

        expect(a.status).toBe('ready');
        expect(b.status).toBe('ready');
    });

    it('classifies 404 features endpoint as unsupported', async () => {
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createResponse(404, {}));

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

        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(htmlResponse);

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

        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce(createResponse(404, {}))
            // If the client incorrectly refetches during cooldown, this 200 would flip the snapshot to ready.
            .mockResolvedValueOnce(createResponse(200, payload));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-13T00:00:00.000Z'));

        const first = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });
        const second = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });

        expect(first.status).toBe('unsupported');
        expect(second.status).toBe('unsupported');
        expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
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

        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce(createResponse(404, {}))
            .mockResolvedValueOnce(createResponse(200, payload));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-13T00:00:00.000Z'));

        const first = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });
        expect(first.status).toBe('unsupported');
        expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

        // After cooldown, a forced refresh should revalidate.
        vi.setSystemTime(new Date('2026-02-13T00:01:00.000Z'));

        const second = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50 });
        expect(second.status).toBe('ready');
        expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
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

        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValueOnce(createResponse(200, payload));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-13T00:00:00.000Z'));

        const first = await getServerFeaturesSnapshot({ timeoutMs: 50 });
        expect(first.status).toBe('error');
        expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

        // Within the short error TTL, we should not refetch.
        const second = await getServerFeaturesSnapshot({ timeoutMs: 50 });
        expect(second.status).toBe('error');
        expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

        // After TTL, the client should retry.
        vi.setSystemTime(new Date('2026-02-13T00:00:06.000Z'));
        const third = await getServerFeaturesSnapshot({ timeoutMs: 50 });
        expect(third.status).toBe('ready');
        expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
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

        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createResponse(200, payload));

        const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('./serverFeaturesClient');
        resetServerFeaturesClientForTests();

        const result = await getServerFeaturesSnapshot({ force: true, timeoutMs: 50, serverId: 'server-b' });
        expect(result.status).toBe('ready');

        const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls.length).toBe(1);
        expect(String(calls[0]?.[0] ?? '')).toContain('https://other.example.test');
    });
});
