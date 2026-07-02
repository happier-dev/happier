import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    });
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: vi.fn(),
        emitWithAck: vi.fn(),
        send: vi.fn(),
        onMessage: vi.fn(),
        onStatusChange: vi.fn(),
        onReconnected: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
    },
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: vi.fn(),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: vi.fn(),
    },
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: vi.fn(),
}));

const voiceOnReadyMock = vi.hoisted(() => vi.fn());
vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        onReady: (...args: unknown[]) => voiceOnReadyMock(...args),
        reportContextualUpdate: vi.fn(),
    },
}));

const notifyActivityReadyMock = vi.hoisted(() => vi.fn());
vi.mock('@/activity/notifications/runtime/activityLocalNotificationBus', () => ({
    notifyActivityReady: (...args: unknown[]) => notifyActivityReadyMock(...args),
}));

import { storage } from './domains/state/storage';
import type { Session } from './domains/state/storageTypes';
import type { NormalizedMessage } from './typesRaw';

const initialStorageState = storage.getState();

type SyncReadyNotificationTestAccess = Readonly<{
    notifyReadyProjectionAdvance: (sessionId: string, seq: number) => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => unknown;
    disconnectServer: () => void;
}>;

function createSession(sessionId: string): Session {
    const now = Date.now();
    return {
        id: sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

function readyMessage(seq: number): NormalizedMessage {
    return {
        id: `ready-${seq}`,
        seq,
        localId: null,
        createdAt: 1_000 + seq,
        isSidechain: false,
        role: 'event',
        content: { type: 'ready' },
    };
}

describe('Sync ready notification dedupe', () => {
    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        voiceOnReadyMock.mockReset();
        notifyActivityReadyMock.mockReset();

        const { sync } = await import('./sync');
        sync.disconnectServer();
    });

    it('dedupes projection ready notifications against later transcript catch-up for the same ready seq', async () => {
        const { sync } = await import('./sync');
        const syncForTest = sync as unknown as SyncReadyNotificationTestAccess;
        storage.getState().applySessions([createSession('s1')]);

        syncForTest.notifyReadyProjectionAdvance('s1', 2);
        syncForTest.applyMessages('s1', [readyMessage(2)]);
        syncForTest.applyMessages('s1', [readyMessage(3)]);

        expect(voiceOnReadyMock).toHaveBeenCalledTimes(2);
        expect(notifyActivityReadyMock).toHaveBeenCalledTimes(2);
        expect(voiceOnReadyMock).toHaveBeenNthCalledWith(1, 's1', []);
        expect(notifyActivityReadyMock).toHaveBeenNthCalledWith(1, 's1', []);
        expect(voiceOnReadyMock).toHaveBeenNthCalledWith(2, 's1', []);
        expect(notifyActivityReadyMock).toHaveBeenNthCalledWith(2, 's1', []);
    });
});
