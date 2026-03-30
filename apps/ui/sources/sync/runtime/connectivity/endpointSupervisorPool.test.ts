import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({ currentState: 'active' as string }));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlMock(...args),
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: { OS: 'web' },
                        AppState: {
                            get currentState() {
                                return appState.currentState;
                            },
                        },
                    }
    );
});

function okResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() });
}

describe('endpointSupervisorPool', () => {
    const idleTtlEnvKey = 'EXPO_PUBLIC_HAPPIER_ENDPOINT_SUPERVISOR_IDLE_TTL_MS';
    let originalIdleTtlEnvValue: string | undefined;
    let hadWindow: boolean;
    let originalWindow: unknown;
    const globalWithWindow = globalThis as unknown as { window?: unknown };

    beforeEach(() => {
        originalIdleTtlEnvValue = process.env[idleTtlEnvKey];
        hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
        originalWindow = globalWithWindow.window;
    });

    afterEach(async () => {
        runtimeFetchMock.mockReset();
        getCredentialsForServerUrlMock.mockReset();
        appState.currentState = 'active';
        if (originalIdleTtlEnvValue === undefined) {
            delete process.env[idleTtlEnvKey];
        } else {
            process.env[idleTtlEnvKey] = originalIdleTtlEnvValue;
        }
        if (hadWindow) {
            globalWithWindow.window = originalWindow;
        } else {
            Reflect.deleteProperty(globalThis, 'window');
        }
        vi.resetModules();
        vi.useRealTimers();
    });

    it('reuses one endpoint supervisor per server id + url', async () => {
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'token-1', secret: 'secret' });
        runtimeFetchMock.mockResolvedValue(okResponse());

        const mod = await import('./endpointSupervisorPool');
        expect(Object.keys(mod)).toContain('acquireEndpointSupervisorForServer');
        expect(Object.keys(mod)).toContain('resetEndpointSupervisorPoolForTests');
        const { acquireEndpointSupervisorForServer, resetEndpointSupervisorPoolForTests } = mod;
        const first = await acquireEndpointSupervisorForServer({ serverId: 'server-a', serverUrl: 'https://a.example.test' });
        const second = await acquireEndpointSupervisorForServer({ serverId: 'server-a', serverUrl: 'https://a.example.test' });

        expect(first.supervisor).toBe(second.supervisor);

        await first.release({ immediate: true });
        await second.release({ immediate: true });
        await resetEndpointSupervisorPoolForTests();
    });

    it('does not re-start (re-probe) the supervisor on every acquire when it is already started but offline', async () => {
        vi.useFakeTimers();
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'token-1', secret: 'secret' });
        runtimeFetchMock.mockRejectedValue(new TypeError('Network request failed'));

        const { acquireEndpointSupervisorForServer, resetEndpointSupervisorPoolForTests } = await import('./endpointSupervisorPool');
        const first = await acquireEndpointSupervisorForServer({ serverId: 'server-a', serverUrl: 'https://a.example.test' });
        expect(first.supervisor.getState().phase).toBe('offline');
        const callsBefore = runtimeFetchMock.mock.calls.length;

        const second = await acquireEndpointSupervisorForServer({ serverId: 'server-a', serverUrl: 'https://a.example.test' });
        expect(second.supervisor).toBe(first.supervisor);
        expect(runtimeFetchMock.mock.calls.length).toBe(callsBefore);

        await first.release({ immediate: true });
        await second.release({ immediate: true });
        await resetEndpointSupervisorPoolForTests();
    });

    it('uses the latest token when invalidating the endpoint supervisor', async () => {
        getCredentialsForServerUrlMock
            .mockResolvedValueOnce({ token: 'token-1', secret: 'secret' })
            .mockResolvedValueOnce({ token: 'token-2', secret: 'secret' });

        let sawBearerToken2Resolve: (() => void) | null = null;
        const sawBearerToken2 = new Promise<void>((resolve) => {
            sawBearerToken2Resolve = resolve;
        });

        runtimeFetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const asString = String(url ?? '');
            const headers = new Headers(init?.headers);
            if (headers.get('Authorization') === 'Bearer token-2') {
                sawBearerToken2Resolve?.();
                sawBearerToken2Resolve = null;
            }
            if (asString.endsWith('/v1/auth/ping')) {
                return okResponse();
            }
            return okResponse();
        });

        const mod = await import('./endpointSupervisorPool');
        expect(Object.keys(mod)).toContain('acquireEndpointSupervisorForServer');
        expect(Object.keys(mod)).toContain('resetEndpointSupervisorPoolForTests');
        const { acquireEndpointSupervisorForServer, resetEndpointSupervisorPoolForTests } = mod;
        const lease = await acquireEndpointSupervisorForServer({ serverId: 'server-a', serverUrl: 'https://a.example.test' });
        const supervisor = lease.supervisor;

        supervisor.invalidate();
        await sawBearerToken2;

        const lastCall = runtimeFetchMock.mock.calls.at(-1);
        const init = lastCall?.[1] as RequestInit | undefined;
        const headers = new Headers(init?.headers);
        expect(headers.get('Authorization')).toBe('Bearer token-2');

        await lease.release({ immediate: true });
        await resetEndpointSupervisorPoolForTests();
    });

    it('prefers explicit tokenOverride over TokenStorage token when probing auth', async () => {
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'token-storage', secret: 'secret' });

        let sawBearerOverrideResolve: (() => void) | null = null;
        const sawBearerOverride = new Promise<void>((resolve) => {
            sawBearerOverrideResolve = resolve;
        });

        runtimeFetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const asString = String(url ?? '');
            if (!asString.endsWith('/v1/auth/ping')) {
                return okResponse();
            }
            const headers = new Headers(init?.headers);
            if (headers.get('Authorization') === 'Bearer token-override') {
                sawBearerOverrideResolve?.();
                sawBearerOverrideResolve = null;
            }
            return okResponse();
        });

        const { acquireEndpointSupervisorForServer, resetEndpointSupervisorPoolForTests } = await import('./endpointSupervisorPool');
        const lease = await acquireEndpointSupervisorForServer({
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            tokenOverride: 'token-override',
        });

        await Promise.race([
            sawBearerOverride,
            new Promise<void>((_, reject) => {
                setTimeout(() => reject(new Error('timeout waiting for tokenOverride auth probe')), 50);
            }),
        ]);

        await lease.release({ immediate: true });
        await resetEndpointSupervisorPoolForTests();
    });

    it('invalidates supervisors when the runtime emits an online event (web)', async () => {
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'token-1', secret: 'secret' });
        runtimeFetchMock.mockResolvedValue(okResponse());

        let sawCallAfterOnlineResolve: (() => void) | null = null;
        const sawCallAfterOnline = new Promise<void>((resolve) => {
            sawCallAfterOnlineResolve = resolve;
        });
        let shouldResolveOnNextCall = false;
        runtimeFetchMock.mockImplementation(async (...args: unknown[]) => {
            if (shouldResolveOnNextCall && sawCallAfterOnlineResolve) {
                shouldResolveOnNextCall = false;
                sawCallAfterOnlineResolve();
                sawCallAfterOnlineResolve = null;
            }
            return okResponse();
        });

        const handlers = new Map<string, Set<() => void>>();
        globalWithWindow.window = {
            addEventListener: (event: string, listener: () => void) => {
                const set = handlers.get(event) ?? new Set<() => void>();
                set.add(listener);
                handlers.set(event, set);
            },
            removeEventListener: (event: string, listener: () => void) => {
                handlers.get(event)?.delete(listener);
            },
        };

        const mod = await import('./endpointSupervisorPool');
        expect(Object.keys(mod)).toContain('acquireEndpointSupervisorForServer');
        expect(Object.keys(mod)).toContain('resetEndpointSupervisorPoolForTests');
        const { acquireEndpointSupervisorForServer, resetEndpointSupervisorPoolForTests } = mod;
        const lease = await acquireEndpointSupervisorForServer({ serverId: 'server-a', serverUrl: 'https://a.example.test' });

        const callsBefore = runtimeFetchMock.mock.calls.length;
        shouldResolveOnNextCall = true;
        for (const handler of handlers.get('online') ?? []) {
            handler();
        }

        await sawCallAfterOnline;
        expect(runtimeFetchMock.mock.calls.length).toBeGreaterThan(callsBefore);

        await lease.release({ immediate: true });
        await resetEndpointSupervisorPoolForTests();
    });

    it('invalidates supervisors when the document becomes visible again (web)', async () => {
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'token-1', secret: 'secret' });
        runtimeFetchMock.mockResolvedValue(okResponse());

        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        const handlers = new Map<string, Set<() => void>>();
        const documentStub = {
            visibilityState: 'hidden',
            addEventListener: (event: string, listener: () => void) => {
                const set = handlers.get(event) ?? new Set<() => void>();
                set.add(listener);
                handlers.set(event, set);
            },
            removeEventListener: (event: string, listener: () => void) => {
                handlers.get(event)?.delete(listener);
            },
        };
        globalWithDocument.document = documentStub;

        try {
            let sawCallAfterVisibleResolve: (() => void) | null = null;
            const sawCallAfterVisible = new Promise<void>((resolve) => {
                sawCallAfterVisibleResolve = resolve;
            });
            let shouldResolveOnNextCall = false;
            runtimeFetchMock.mockImplementation(async () => {
                if (shouldResolveOnNextCall && sawCallAfterVisibleResolve) {
                    shouldResolveOnNextCall = false;
                    sawCallAfterVisibleResolve();
                    sawCallAfterVisibleResolve = null;
                }
                return okResponse();
            });

            const mod = await import('./endpointSupervisorPool');
            const { acquireEndpointSupervisorForServer, resetEndpointSupervisorPoolForTests } = mod;
            const lease = await acquireEndpointSupervisorForServer({ serverId: 'server-a', serverUrl: 'https://a.example.test' });

            const callsBefore = runtimeFetchMock.mock.calls.length;
            documentStub.visibilityState = 'visible';
            shouldResolveOnNextCall = true;
            for (const handler of handlers.get('visibilitychange') ?? []) {
                handler();
            }

            await Promise.race([
                sawCallAfterVisible,
                new Promise<void>((_, reject) => {
                    setTimeout(() => reject(new Error('timeout waiting for visibilitychange invalidate')), 50);
                }),
            ]);
            expect(runtimeFetchMock.mock.calls.length).toBeGreaterThan(callsBefore);

            await lease.release({ immediate: true });
            await resetEndpointSupervisorPoolForTests();
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it('invalidates supervisors when the document becomes hidden (web)', async () => {
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'token-1', secret: 'secret' });
        runtimeFetchMock.mockResolvedValue(okResponse());

        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        const handlers = new Map<string, Set<() => void>>();
        const documentStub = {
            visibilityState: 'visible',
            addEventListener: (event: string, listener: () => void) => {
                const set = handlers.get(event) ?? new Set<() => void>();
                set.add(listener);
                handlers.set(event, set);
            },
            removeEventListener: (event: string, listener: () => void) => {
                handlers.get(event)?.delete(listener);
            },
        };
        globalWithDocument.document = documentStub;

        try {
            const { acquireEndpointSupervisorForServer, resetEndpointSupervisorPoolForTests } = await import('./endpointSupervisorPool');
            const lease = await acquireEndpointSupervisorForServer({ serverId: 'server-a', serverUrl: 'https://a.example.test' });
            expect(lease.supervisor.getState().phase).toBe('online');

            documentStub.visibilityState = 'hidden';
            for (const handler of handlers.get('visibilitychange') ?? []) {
                handler();
            }
            await new Promise<void>((resolve) => queueMicrotask(resolve));

            expect(lease.supervisor.getState().phase).toBe('offline');

            await lease.release({ immediate: true });
            await resetEndpointSupervisorPoolForTests();
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it('stops supervisors after the last release once the idle TTL elapses', async () => {
        vi.useFakeTimers();
        process.env[idleTtlEnvKey] = '10';

        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'token-1', secret: 'secret' });
        runtimeFetchMock.mockResolvedValue(okResponse());

        const mod = await import('./endpointSupervisorPool');
        expect(Object.keys(mod)).toContain('acquireEndpointSupervisorForServer');
        expect(Object.keys(mod)).toContain('resetEndpointSupervisorPoolForTests');
        const { acquireEndpointSupervisorForServer, resetEndpointSupervisorPoolForTests } = mod;
        const lease = await acquireEndpointSupervisorForServer({ serverId: 'server-a', serverUrl: 'https://a.example.test' });
        const supervisor = lease.supervisor;

        await lease.release();

        expect(supervisor.getState().phase).not.toBe('shutting_down');

        await vi.advanceTimersByTimeAsync(20);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        expect(supervisor.getState().phase).toBe('shutting_down');

        await resetEndpointSupervisorPoolForTests();
    });
});
