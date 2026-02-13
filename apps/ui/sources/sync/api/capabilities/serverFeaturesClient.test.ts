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

        resolver?.(createResponse(200, payload));
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
