import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

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

const connectionStateListeners = vi.hoisted(() => new Set<(state: ManagedConnectionState) => void>());
const socketStatusListeners = vi.hoisted(() => new Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void>());

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn((listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
            socketStatusListeners.add(listener);
            listener('disconnected');
            return () => socketStatusListeners.delete(listener);
        }),
        onConnectionStateChange: vi.fn((listener: (state: ManagedConnectionState) => void) => {
            connectionStateListeners.add(listener);
            listener({
                phase: 'idle',
                reason: null,
                attempt: 0,
                nextRetryAt: null,
                lastConnectedAt: null,
                lastDisconnectedAt: null,
                lastErrorMessage: null,
            });
            return () => connectionStateListeners.delete(listener);
        }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
    },
}));

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { flushHookEffects } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';
import { Encryption } from '@/sync/encryption/encryption';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import type { SyncTuning } from '@/sync/runtime/syncTuning';

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

function publishConnectionState(state: ManagedConnectionState): void {
    for (const listener of Array.from(connectionStateListeners)) {
        listener(state);
    }
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
        ...init,
        headers: {
            'content-type': 'application/json',
            ...(init?.headers ?? {}),
        },
    });
}

function accountPetMetadata(accountPetId: string) {
    return {
        accountPetId,
        packageFormat: 'codex-compatible-atlas-v1',
        manifest: {
            id: 'blink',
            displayName: 'Blink',
            description: 'Built-in compatible pet',
            spritesheetPath: 'spritesheet.webp',
        },
        spritesheetAssetRef: {
            assetId: 'asset-1',
            mediaType: 'image/webp',
            digest: 'sha256:abc',
            sizeBytes: 3,
        },
        digest: 'sha256:pkg',
        sizeBytes: 128,
        createdAt: 1,
        updatedAt: 2,
        origin: { kind: 'manualImport' },
    };
}

describe('sync.create initial awaits', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        kvStore.clear();
        appStateAddListener.mockClear();
        trackMocks.initializeTracking.mockReset();
        connectionStateListeners.clear();
        socketStatusListeners.clear();
        resetServerFeaturesClientForTests();
        storage.getState().resetEndpointConnectivity();
        installLocalStorage();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        resetServerFeaturesClientForTests();
    });

    it('materializes account pets during initial sync when pets.sync is enabled', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const pet = accountPetMetadata('pet-1');
        const features = FeaturesResponseSchema.parse({
            features: {
                pets: {
                    sync: { enabled: true },
                },
            },
            capabilities: {},
        });
        const fetchSpy = vi.fn<typeof fetch>(async (input) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return jsonResponse({ status: 'ok' });
            }
            if (url.includes('/v1/features')) {
                return jsonResponse(features);
            }
            if (url.includes('/v1/account/encryption/currentness')) {
                return jsonResponse({
                    mode: 'plain',
                    version: 1,
                    signingKeyFingerprint: null,
                    contentKeyFingerprint: null,
                    updatedAt: 1,
                });
            }
            if (url.includes('/v1/account/pets')) {
                return jsonResponse({ ok: true, pets: [pet] });
            }
            return jsonResponse({ error: 'not_found' }, { status: 404 });
        });
        vi.stubGlobal('fetch', fetchSpy);

        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        const { sync } = await import('./sync');
        const syncWithTuning = sync as unknown as {
            syncTuning: SyncTuning;
        };
        syncWithTuning.syncTuning = {
            ...sync.getSyncTuning(),
            invalidateSyncAwaitTimeoutMs: 1,
            bootstrapConcurrencyLimit: 4,
            resumeConcurrencyLimit: 4,
        };

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('server-pets'),
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
        };

        const createPromise = sync.create(credentials, encryption);
        await flushHookEffects({ cycles: 8, turns: 2, advanceTimersMs: 2_500 });
        await createPromise;
        await flushHookEffects({ cycles: 8, turns: 2, advanceTimersMs: 10 });

        const requestedUrls = fetchSpy.mock.calls.map(([input]) => String(input));
        expect(requestedUrls).toEqual(expect.arrayContaining([
            expect.stringContaining('/v1/account/encryption/currentness'),
            expect.stringContaining('/v1/account/pets'),
        ]));
        expect(storage.getState().accountPetsById['pet-1']).toMatchObject({
            accountPetId: 'pet-1',
            digest: 'sha256:pkg',
        });
        const currentnessCallIndex = fetchSpy.mock.calls.findIndex(([input]) =>
            String(input).includes('/v1/account/encryption/currentness'),
        );
        const petsCallIndex = fetchSpy.mock.calls.findIndex(([input]) =>
            String(input).includes('/v1/account/pets'),
        );
        expect(currentnessCallIndex).toBeGreaterThanOrEqual(0);
        expect(petsCallIndex).toBeGreaterThan(currentnessCallIndex);
        expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/v1/account/pets'))).toBe(true);
    });

    it('does not hang forever waiting for initial sync queues', async () => {
        // Simulate a network stall: fetch never resolves.
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        const configureNativeCryptoWorkerSpy = vi.spyOn(encryption, 'configureNativeCryptoWorker');
        const warmNativeCryptoWorkerSpy = vi
            .spyOn(encryption, 'warmNativeCryptoWorkerForDiagnostics')
            .mockResolvedValue(null);
        const { sync } = await import('./sync');
        const syncWithTuning = sync as unknown as {
            syncTuning: SyncTuning;
        };
        syncWithTuning.syncTuning = {
            ...sync.getSyncTuning(),
            nativeCryptoWorkerMode: 'auto',
            nativeCryptoWorkerMaxBatchSize: 32,
            nativeCryptoWorkerMinBatchSize: 2,
            nativeCryptoWorkerMinPayloadBytes: 0,
            nativeCryptoWorkerTimeoutMs: 1234,
            nativeCryptoWorkerLogFallbacks: true,
            nativeCryptoWorkerTelemetryEnabled: true,
            nativeCryptoWorkerStreamingSampleRate: 0.5,
            nativeCryptoWorkerCapabilityStalenessMs: 60_000,
        };

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
        // Routing is no longer forwarded from here: Encryption resolves it from SyncTuning
        // at construction, so it reaches every instance instead of only this one. What sync
        // still owns — and what this pins — is the active account's scope binding.
        expect(configureNativeCryptoWorkerSpy).toHaveBeenCalledWith({
            scope: {
                accountId: 'server-test',
                serverId: expect.any(String),
                generation: 0,
            },
        });
        expect(warmNativeCryptoWorkerSpy).toHaveBeenCalledTimes(1);
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

    it('mirrors auth-failed connection state into endpoint connectivity storage', async () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        const { syncCreate, syncSwitchServer } = await import('./sync');

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('server-auth-failed'),
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
        };

        await TokenStorage.setCredentials(credentials);

        await syncSwitchServer(null);
        const createPromise = syncCreate(credentials);
        await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 2_500 });
        await createPromise;

        publishConnectionState({
            phase: 'auth_failed',
            reason: 'auth_invalid',
            attempt: 3,
            nextRetryAt: null,
            lastConnectedAt: 123,
            lastDisconnectedAt: 456,
            lastErrorMessage: 'HTTP 401',
        });

        expect(storage.getState()).toMatchObject({
            endpointStatus: 'auth_failed',
            endpointReason: 'auth_invalid',
            endpointAttempt: 3,
            endpointNextRetryAt: null,
            endpointLastConnectedAt: 123,
            endpointLastDisconnectedAt: 456,
            endpointLastErrorMessage: 'HTTP 401',
        });
    });

    it('resumes sync when server reachability returns online after an outage', async () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        const { sync, syncCreate, syncSwitchServer } = await import('./sync');
        const resumeSpy = vi.fn(async () => {});
        (sync as unknown as { resumeSync: (reason: string) => Promise<void> }).resumeSync = resumeSpy;

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('server-reachable-again'),
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
        };

        await TokenStorage.setCredentials(credentials);

        await syncSwitchServer(null);
        const createPromise = syncCreate(credentials);
        await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 2_500 });
        await createPromise;

        publishConnectionState({
            phase: 'offline',
            reason: 'server_unreachable',
            attempt: 2,
            nextRetryAt: Date.now() + 1000,
            lastConnectedAt: null,
            lastDisconnectedAt: Date.now(),
            lastErrorMessage: 'Network request failed',
        });
        expect(storage.getState().endpointStatus).toBe('offline');

        publishConnectionState({
            phase: 'online',
            reason: null,
            attempt: 2,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: Date.now() - 1000,
            lastErrorMessage: null,
        });
        await new Promise<void>((resolve) => queueMicrotask(resolve));

        expect(storage.getState().endpointStatus).toBe('online');
        expect(resumeSpy).toHaveBeenCalledWith('server-reachable');
    });

    it('starts a token-only plaintext account without constructing account encryption material', async () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        const { sync, syncCreate, syncSwitchServer } = await import('./sync');
        const credentials: AuthCredentials = {
            token: buildTokenWithSub('plain-account'),
        };

        await TokenStorage.setCredentials(credentials);
        await syncSwitchServer(null);

        const createPromise = syncCreate(credentials);
        await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 2_500 });
        await createPromise;

        expect(sync.encryption).toBeNull();
        expect(trackMocks.initializeTracking).not.toHaveBeenCalled();
        expect(apiSocket.initialize).toHaveBeenLastCalledWith(
            expect.objectContaining({ token: credentials.token }),
            null,
        );
    });
});
