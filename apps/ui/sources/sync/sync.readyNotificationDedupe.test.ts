import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const voiceOnMessagesMock = vi.hoisted(() => vi.fn());
vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: (...args: unknown[]) => voiceOnMessagesMock(...args),
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

function assistantTextMessage(seq: number, text: string): NormalizedMessage {
    return {
        id: `assistant-${seq}`,
        seq,
        localId: null,
        createdAt: 1_000 + seq,
        isSidechain: false,
        role: 'agent',
        content: [{ type: 'text', text, uuid: `assistant-${seq}`, parentUUID: null }],
    };
}

describe('Sync ready notification dedupe', () => {
    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        voiceOnReadyMock.mockReset();
        voiceOnMessagesMock.mockReset();
        notifyActivityReadyMock.mockReset();

        const { sync } = await import('./sync');
        sync.disconnectServer();
    });

    it('upgrades projection-only ready advancement with the later transcript payload without duplicating activity notifications', async () => {
        const { sync } = await import('./sync');
        const syncForTest = sync as unknown as SyncReadyNotificationTestAccess;
        storage.getState().applySessions([createSession('s1')]);

        syncForTest.notifyReadyProjectionAdvance('s1', 2);
        syncForTest.applyMessages('s1', [
            assistantTextMessage(1, 'Ready with transcript context'),
            readyMessage(2),
        ]);
        syncForTest.applyMessages('s1', [readyMessage(3)]);

        expect(voiceOnReadyMock).toHaveBeenCalledTimes(3);
        expect(notifyActivityReadyMock).toHaveBeenCalledTimes(2);
        // Each activity event carries the ready event's own sequence, the identity every tab shares.
        expect(notifyActivityReadyMock.mock.calls.map((call) => call[2])).toEqual([2, 3]);
        expect(voiceOnReadyMock).toHaveBeenNthCalledWith(1, 's1', []);
        expect(voiceOnReadyMock).toHaveBeenNthCalledWith(
            2,
            's1',
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'agent-text',
                    text: 'Ready with transcript context',
                }),
            ]),
        );
        expect(notifyActivityReadyMock).toHaveBeenNthCalledWith(
            1,
            's1',
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'agent-text',
                    text: 'Ready with transcript context',
                }),
            ]),
            2,
        );
    });

    it('does not send recovered history to live message hooks while queue-dependent output still emits once', async () => {
        const { sync } = await import('./sync');
        const syncForTest = sync as unknown as SyncReadyNotificationTestAccess;
        storage.getState().applySessions([createSession('s1')]);

        syncForTest.applyMessages('s1', [{
            ...assistantTextMessage(1, 'Recovered output'),
            sourceCreatedAt: 100,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
        }]);
        syncForTest.applyMessages('s1', [{
            ...assistantTextMessage(2, 'Live output'),
        }]);

        expect(voiceOnMessagesMock).toHaveBeenCalledTimes(1);
        expect(voiceOnMessagesMock).toHaveBeenCalledWith('s1', [
            expect.objectContaining({ kind: 'agent-text', text: 'Live output' }),
        ]);
    });
});
