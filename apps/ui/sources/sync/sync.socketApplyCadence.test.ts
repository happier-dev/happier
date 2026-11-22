import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            currentState: 'active',
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    });
});

vi.mock('@/log', () => ({ log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        onReady: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));
vi.mock('@/track', () => ({ initializeTracking: vi.fn(), tracking: null }));

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: requestMock,
        emitWithAck: vi.fn(),
        send: vi.fn(),
        onMessage: vi.fn(),
        onStatusChange: vi.fn(),
        onReconnected: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
    },
}));

import { storage } from './domains/state/storage';
import { markSessionVisible, markSessionHidden } from './domains/session/activeViewingSession';
import type { ApiUpdateContainer } from './api/types/apiTypes';

type SyncCadenceTestAccess = {
    encryption: { getSessionEncryption: (sessionId: string) => null };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
    handleUpdate: (update: ApiUpdateContainer) => Promise<void>;
};

const initialStorageState = storage.getState();
const SESSION_ID = 's-socket-cadence';

function activityUpdate(seq: number): ApiUpdateContainer {
    return {
        id: `u${seq}`,
        seq: 100 + seq,
        createdAt: 1_000 + seq,
        body: { t: 'update-session', id: SESSION_ID, active: true, activeAt: 1_000 + seq },
    } as ApiUpdateContainer;
}

describe('sync socket apply cadence', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        requestMock.mockReset();
    });

    afterEach(async () => {
        const { sync } = await import('./sync');
        sync.disconnectServer();
        markSessionHidden(SESSION_ID);
    });

    it('publishes the Session once for the socket updates that arrive within one frame', async () => {
        const { sync } = await import('./sync');
        sync.disconnectServer();
        (sync as unknown as { credentials: unknown }).credentials = { token: 'test-token' };
        storage.getState().applySessions([createSessionFixture({
            id: SESSION_ID, seq: 1, encryptionMode: 'plain', metadata: null, activeAt: 1_000,
        })]);
        const access = sync as unknown as SyncCadenceTestAccess;
        access.encryption = { getSessionEncryption: () => null };
        access.activeServerSessionIds = new Set([SESSION_ID]);
        access.hasFetchedSessionsSnapshotForActiveServer = true;
        access.isForeground = true;
        markSessionVisible(SESSION_ID);

        let publishes = 0;
        const unsubscribe = storage.subscribe((state, previous) => {
            if (state.sessions[SESSION_ID] !== previous.sessions[SESSION_ID]) publishes += 1;
        });
        try {
            // Each socket update reaches the socket owner through the Sync wiring, as in production.
            await access.handleUpdate(activityUpdate(1));
            await access.handleUpdate(activityUpdate(2));
            await access.handleUpdate(activityUpdate(3));
            expect(publishes).toBe(0);

            await new Promise((resolve) => setTimeout(resolve, 40));

            expect(publishes).toBe(1);
            expect(storage.getState().sessions[SESSION_ID]?.activeAt).toBe(1_003);
        } finally {
            unsubscribe();
        }
    });
});
