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
    const actual = await vi.importActual<any>('react-native');
    return {
        ...actual,
        Platform: { ...(actual?.Platform ?? {}), OS: 'web' },
        AppState: { addEventListener: appStateAddListener as any },
    };
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

vi.mock('@/track', () => ({
    initializeTracking: vi.fn(),
    tracking: null,
    trackPaywallPresented: vi.fn(),
    trackPaywallPurchased: vi.fn(),
    trackPaywallCancelled: vi.fn(),
    trackPaywallRestored: vi.fn(),
    trackPaywallError: vi.fn(),
}));

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
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

        // Current behavior (pre-fix) hangs forever; expected behavior resolves via awaitQueue timeouts.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(resolved).toBe(true);

        await promise;
    });
});
