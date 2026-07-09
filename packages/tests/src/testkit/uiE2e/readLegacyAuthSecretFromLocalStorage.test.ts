import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import {
    captureAuthBootstrapStorageSnapshot,
    installAuthBootstrapStorageSnapshot,
    readLegacyAuthSecretFromLocalStorage,
    type AuthBootstrapStorageWritablePage,
    type LocalStorageReadablePage,
} from './readLegacyAuthSecretFromLocalStorage';

type StorageSnapshot = Readonly<{
    localStorage?: Readonly<Record<string, string>>;
    sessionStorage?: Readonly<Record<string, string>>;
}>;

type WritableStorageState = {
    localStorage: Map<string, string>;
    sessionStorage: Map<string, string>;
};

function createStorageMock(storage: Map<string, string>): Storage {
    return {
        get length() {
            return storage.size;
        },
        key(index: number) {
            return [...storage.keys()][index] ?? null;
        },
        getItem(key: string) {
            return storage.get(key) ?? null;
        },
        setItem(key: string, value: string) {
            storage.set(key, value);
        },
        removeItem(key: string) {
            storage.delete(key);
        },
        clear() {
            storage.clear();
        },
    } as Storage;
}

function createPageWithStorageSnapshots(
    snapshots: ReadonlyArray<StorageSnapshot>,
): LocalStorageReadablePage {
    const remaining = [...snapshots];

    return {
        evaluate: vi.fn(async (fn: () => unknown) => {
            const snapshot = remaining.shift() ?? {};
            const previousWindow = (globalThis as { window?: unknown }).window;
            (globalThis as { window?: unknown }).window = {
                localStorage: createStorageMock(new Map(Object.entries(snapshot.localStorage ?? {}))),
                sessionStorage: createStorageMock(new Map(Object.entries(snapshot.sessionStorage ?? {}))),
            };
            try {
                if (typeof fn !== 'function') return undefined;
                // Playwright serializes the function and evaluates it in the browser context, so it
                // must not rely on closures from the Node test runner.
                const serializedResult = new Function(`return (${fn.toString()})();`)();
                return await Promise.resolve(serializedResult);
            } finally {
                if (previousWindow === undefined) {
                    delete (globalThis as { window?: unknown }).window;
                } else {
                    (globalThis as { window?: unknown }).window = previousWindow;
                }
            }
        }),
    };
}

function withWindowStorage<T>(
    initialSnapshot: StorageSnapshot,
    run: (state: WritableStorageState) => Promise<T> | T,
): Promise<T> | T {
    const state: WritableStorageState = {
        localStorage: new Map(Object.entries(initialSnapshot.localStorage ?? {})),
        sessionStorage: new Map(Object.entries(initialSnapshot.sessionStorage ?? {})),
    };
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
        localStorage: createStorageMock(state.localStorage),
        sessionStorage: createStorageMock(state.sessionStorage),
    };

    const cleanup = () => {
        if (previousWindow === undefined) {
            delete (globalThis as { window?: unknown }).window;
        } else {
            (globalThis as { window?: unknown }).window = previousWindow;
        }
    };

    try {
        const result = run(state);
        if (result instanceof Promise) {
            return result.finally(cleanup);
        }
        cleanup();
        return result;
    } catch (error) {
        cleanup();
        throw error;
    }
}

function runSerializedScript(fn: (snapshot: unknown) => void, arg: unknown): void {
    const serialized = (0, eval)(`(${String(fn)})`) as (value: unknown) => void;
    serialized(arg);
}

function createWritablePage(options: Readonly<{
    throwOnEvaluate?: boolean;
    initialSnapshot?: StorageSnapshot;
}> = {}): AuthBootstrapStorageWritablePage & {
    initScripts: Array<{ fn: (snapshot: unknown) => void; arg: unknown }>;
    currentSnapshot: StorageSnapshot;
} {
    const initScripts: Array<{ fn: (snapshot: unknown) => void; arg: unknown }> = [];
    let currentSnapshot: StorageSnapshot = {
        localStorage: { ...(options.initialSnapshot?.localStorage ?? {}) },
        sessionStorage: { ...(options.initialSnapshot?.sessionStorage ?? {}) },
    };

    return {
        addInitScript: vi.fn(async (fn: unknown, arg?: unknown) => {
            initScripts.push({
                fn: fn as (snapshot: unknown) => void,
                arg,
            });
        }) as Page['addInitScript'],
        evaluate: vi.fn(async (fn: unknown, arg?: unknown) => {
            if (options.throwOnEvaluate) {
                throw new Error('SecurityError: localStorage is not available for opaque origins');
            }
            if (typeof fn !== 'function') return undefined;
            return await withWindowStorage(currentSnapshot, async (state) => {
                const result = runSerializedScript(fn as (snapshot: unknown) => void, arg);
                currentSnapshot = {
                    localStorage: Object.fromEntries(state.localStorage.entries()),
                    sessionStorage: Object.fromEntries(state.sessionStorage.entries()),
                };
                return result;
            });
        }) as Page['evaluate'],
        initScripts,
        get currentSnapshot() {
            return currentSnapshot;
        },
    };
}

describe('readLegacyAuthSecretFromLocalStorage', () => {
    it('returns the scoped legacy secret for the active server and ignores encryption-only credentials', async () => {
        const page = createPageWithStorageSnapshots([
            {
                localStorage: {
                    'server-profiles:server-state-v1': JSON.stringify({
                        activeServerId: '127.0.0.1-33628',
                        servers: {
                            '127.0.0.1-33628': {
                                id: '127.0.0.1-33628',
                                serverUrl: 'http://127.0.0.1:33628',
                            },
                        },
                    }),
                    'auth_credentials__srv_127.0.0.1-3009': JSON.stringify({
                        token: 'wrong-token',
                        secret: 'wrong-secret',
                    }),
                    'auth_credentials__srv_127.0.0.1-33628': JSON.stringify({
                        token: 'token-33628',
                        secret: 'right-secret',
                    }),
                    'auth_credentials__srv_127.0.0.1-4455': JSON.stringify({
                        token: 'token-4455',
                        encryption: {
                            publicKey: 'public-key',
                            machineKey: 'machine-key',
                        },
                    }),
                },
            },
        ]);

        await expect(readLegacyAuthSecretFromLocalStorage(page)).resolves.toBe('right-secret');
    });

    it('throws when the active server only has encryption credentials and no legacy restore secret', async () => {
        const page = createPageWithStorageSnapshots([
            {
                localStorage: {
                    'server-profiles:server-state-v1': JSON.stringify({
                        activeServerId: '127.0.0.1-33628',
                        servers: {
                            '127.0.0.1-33628': {
                                id: '127.0.0.1-33628',
                                serverUrl: 'http://127.0.0.1:33628',
                            },
                        },
                    }),
                    'auth_credentials__srv_127.0.0.1-33628': JSON.stringify({
                        token: 'token-33628',
                        encryption: {
                            publicKey: 'public-key',
                            machineKey: 'machine-key',
                        },
                    }),
                },
            },
        ]);

        await expect(readLegacyAuthSecretFromLocalStorage(page)).rejects.toThrow(
            'missing legacy auth secret in localStorage',
        );
    });
});

describe('captureAuthBootstrapStorageSnapshot', () => {
    it('captures only auth bootstrap storage keys and ignores unrelated storage', async () => {
        const page = createPageWithStorageSnapshots([
            {
                localStorage: {
                    'server-profiles:server-state-v1': JSON.stringify({ activeServerId: 'server-a' }),
                    'auth_credentials__srv_server-a': JSON.stringify({ token: 'token-a', encryption: { publicKey: 'p', machineKey: 'm' } }),
                    'auth_credentials__srv_server-b': JSON.stringify({ token: 'token-b', secret: 'secret-b' }),
                    unrelated: 'ignore-me',
                },
                sessionStorage: {
                    activeServerId: 'server-a',
                    unrelatedSession: 'ignore-me',
                },
            },
        ]);

        await expect(captureAuthBootstrapStorageSnapshot(page)).resolves.toEqual({
            localStorage: {
                'server-profiles:server-state-v1': JSON.stringify({ activeServerId: 'server-a' }),
                'auth_credentials__srv_server-a': JSON.stringify({ token: 'token-a', encryption: { publicKey: 'p', machineKey: 'm' } }),
                'auth_credentials__srv_server-b': JSON.stringify({ token: 'token-b', secret: 'secret-b' }),
            },
            sessionStorage: {
                activeServerId: 'server-a',
            },
        });
    });
});

describe('installAuthBootstrapStorageSnapshot', () => {
    it('primes both init-script and current-document storage with the provided snapshot', async () => {
        const page = createWritablePage();
        const snapshot = {
            localStorage: {
                'server-profiles:server-state-v1': JSON.stringify({ activeServerId: 'server-a' }),
                'auth_credentials__srv_server-a': JSON.stringify({ token: 'token-a', encryption: { publicKey: 'p', machineKey: 'm' } }),
            },
            sessionStorage: {
                activeServerId: 'server-a',
            },
        } satisfies StorageSnapshot;

        await expect(installAuthBootstrapStorageSnapshot(page, snapshot)).resolves.toBeUndefined();
        expect(page.addInitScript).toHaveBeenCalledTimes(1);
        expect(page.evaluate).toHaveBeenCalledTimes(1);

        await withWindowStorage({}, async () => {
            for (const { fn, arg } of page.initScripts) {
                runSerializedScript(fn, arg);
            }
            expect(window.localStorage.getItem('server-profiles:server-state-v1')).toBe(
                snapshot.localStorage?.['server-profiles:server-state-v1'] ?? null,
            );
            expect(window.localStorage.getItem('auth_credentials__srv_server-a')).toBe(
                snapshot.localStorage?.['auth_credentials__srv_server-a'] ?? null,
            );
            expect(window.sessionStorage.getItem('activeServerId')).toBe('server-a');
        });

        expect(page.currentSnapshot).toEqual(snapshot);
    });

    it('still succeeds when the current document cannot access localStorage before navigation', async () => {
        const page = createWritablePage({ throwOnEvaluate: true });
        const snapshot = {
            localStorage: {
                'auth_credentials__srv_server-a': JSON.stringify({ token: 'token-a', encryption: { publicKey: 'p', machineKey: 'm' } }),
            },
            sessionStorage: {
                activeServerId: 'server-a',
            },
        } satisfies StorageSnapshot;

        await expect(installAuthBootstrapStorageSnapshot(page, snapshot)).resolves.toBeUndefined();
        expect(page.addInitScript).toHaveBeenCalledTimes(1);
        expect(page.evaluate).toHaveBeenCalledTimes(1);
    });

    it('clears stale bootstrap keys before replaying the captured snapshot', async () => {
        const page = createWritablePage({
            initialSnapshot: {
                localStorage: {
                    'server-profiles:server-state-v1': JSON.stringify({ activeServerId: 'stale-server' }),
                    'auth_credentials__srv_stale-server': JSON.stringify({ token: 'stale-token', secret: 'stale-secret' }),
                },
                sessionStorage: {
                    activeServerId: 'stale-server',
                },
            },
        });
        const snapshot = {
            localStorage: {
                'auth_credentials__srv_server-a': JSON.stringify({ token: 'token-a', secret: 'secret-a' }),
            },
            sessionStorage: {
                activeServerId: 'server-a',
            },
        } satisfies StorageSnapshot;

        await installAuthBootstrapStorageSnapshot(page, snapshot);

        await withWindowStorage({
            localStorage: {
                'server-profiles:server-state-v1': JSON.stringify({ activeServerId: 'stale-server' }),
                'auth_credentials__srv_stale-server': JSON.stringify({ token: 'stale-token', secret: 'stale-secret' }),
            },
            sessionStorage: {
                activeServerId: 'stale-server',
            },
        }, async () => {
            for (const { fn, arg } of page.initScripts) {
                runSerializedScript(fn, arg);
            }
            expect(window.localStorage.getItem('server-profiles:server-state-v1')).toBeNull();
            expect(window.localStorage.getItem('auth_credentials__srv_stale-server')).toBeNull();
            expect(window.localStorage.getItem('auth_credentials__srv_server-a')).toBe(
                snapshot.localStorage?.['auth_credentials__srv_server-a'] ?? null,
            );
            expect(window.sessionStorage.getItem('activeServerId')).toBe('server-a');
        });

        expect(page.currentSnapshot).toEqual(snapshot);
    });
});
