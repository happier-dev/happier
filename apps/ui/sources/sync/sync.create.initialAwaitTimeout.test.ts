import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                            },
                                            AppState: {
                                                addEventListener: appStateAddListener as any,
                                            },
                                        }
    );
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

const trackMocks = vi.hoisted(() => ({
    initializeTracking: vi.fn(),
}));

vi.mock('@/track', () => ({
    initializeTracking: trackMocks.initializeTracking,
    tracking: null,
    trackPaywallPresented: vi.fn(),
    trackPaywallPurchased: vi.fn(),
    trackPaywallCancelled: vi.fn(),
    trackPaywallRestored: vi.fn(),
    trackPaywallError: vi.fn(),
}));

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { flushHookEffects } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';
import { Encryption } from '@/sync/encryption/encryption';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

function buildTokenWithSub(sub: string): string {
    const payload = encodeBase64(encodeUTF8(JSON.stringify({ sub })), 'base64');
    return `hdr.${payload}.sig`;
}

function installLocalStorage(): void {
    if (typeof (globalThis as any).localStorage !== 'undefined') return;

    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
        get length() {
            return store.size;
        },
        clear() {
            store.clear();
        },
        getItem(key: string) {
            return store.has(key) ? store.get(key)! : null;
        },
        key(index: number) {
            const keys = [...store.keys()];
            return typeof keys[index] === 'string' ? keys[index] : null;
        },
        removeItem(key: string) {
            store.delete(key);
        },
        setItem(key: string, value: string) {
            store.set(String(key), String(value));
        },
    };
}

describe('sync.create initial awaits', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        kvStore.clear();
        appStateAddListener.mockClear();
        trackMocks.initializeTracking.mockReset();
        installLocalStorage();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('does not hang forever waiting for initial sync queues', async () => {
        // Simulate a network stall: fetch never resolves.
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        const { sync } = await import('./sync');

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('server-test'),
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
        };

        await TokenStorage.setCredentials(credentials);

        let resolved = false;
        const promise = sync.create(credentials, encryption).then(() => {
            resolved = true;
        });

        // Current behavior (pre-fix) hangs forever; expected behavior resolves via the 2500ms awaitQueue timeout.
        await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 2_500 });
        expect(resolved).toBe(true);

        await promise;
    });

    it('rebinds the tracking identity when switching to a different authenticated account', async () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        const secretA = new Uint8Array(32).fill(7);
        const secretB = new Uint8Array(32).fill(8);
        const encryptionA = await Encryption.create(secretA);
        const encryptionB = await Encryption.create(secretB);
        const { sync } = await import('./sync');

        const credentialsA: AuthCredentials = {
            token: buildTokenWithSub('server-a'),
            secret: encodeBase64(secretA, 'base64url'),
        };
        const credentialsB: AuthCredentials = {
            token: buildTokenWithSub('server-b'),
            secret: encodeBase64(secretB, 'base64url'),
        };

        await TokenStorage.setCredentials(credentialsA);

        const createPromise = sync.create(credentialsA, encryptionA);
        await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 2_500 });
        await createPromise;

        await sync.switchServer(credentialsB);

        expect(trackMocks.initializeTracking).toHaveBeenNthCalledWith(1, encryptionA.anonID);
        expect(trackMocks.initializeTracking).toHaveBeenNthCalledWith(2, encryptionB.anonID);
    });
});
