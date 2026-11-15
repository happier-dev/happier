import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
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
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: { getCredentialsForServerUrl: async () => ({ token: 'hdr.eyJzdWIiOiJhY2NvdW50LWEifQ.sig' }) },
    });
});
// The socket transport is the boundary: these overrides shadow only its transport methods.
vi.mock('@/sync/api/session/apiSocket', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/apiSocket')>();
    Object.assign(actual.apiSocket, {
        request: requestMock,
        invalidateRequests: vi.fn(),
        emitWithAck: vi.fn(),
        send: vi.fn(),
        onMessage: vi.fn(),
        onStatusChange: vi.fn(),
        onReconnected: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
    });
    return actual;
});

import { storage } from './domains/state/storage';
import { getActiveServerSnapshot } from './domains/server/serverRuntime';
import { markSessionSurfaceVisible, markSessionSurfaceHidden } from './domains/session/sessionSurfaceVisibility';
import { socketApplyFrame } from './engine/sessions/socketApplyFrame';
import type { ApiUpdateContainer } from './api/types/apiTypes';

type SyncCadenceTestAccess = {
    appliedServerTarget: ReturnType<typeof getActiveServerSnapshot>;
    serverID: string;
    encryption: { getSessionEncryption: (sessionId: string) => null };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
    handleUpdate: (update: ApiUpdateContainer) => Promise<void>;
    onSessionVisible: (sessionId: string) => void;
    submitMessage: (sessionId: string, text: string) => Promise<unknown>;
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

async function seedSession(): Promise<SyncCadenceTestAccess> {
    const { sync } = await import('./syncEngine');
    sync.disconnectServer();
    const appliedServer = getActiveServerSnapshot();
    const accountId = 'account-a';
    storage.getState().activateProfileScope({ serverId: appliedServer.serverId, accountId });
    storage.getState().applySessions([createSessionFixture({
        id: SESSION_ID, serverId: appliedServer.serverId, seq: 1, encryptionMode: 'plain', metadata: null, activeAt: 1_000,
    })]);
    const access = sync as unknown as SyncCadenceTestAccess;
    // Direct Sync tests bind the real applied transport/Account normally established by restore.
    access.appliedServerTarget = appliedServer;
    access.serverID = accountId;
    access.encryption = { getSessionEncryption: () => null };
    access.activeServerSessionIds = new Set([SESSION_ID]);
    access.hasFetchedSessionsSnapshotForActiveServer = true;
    access.isForeground = true;
    markSessionSurfaceVisible(SESSION_ID, appliedServer.serverId);
    return access;
}

describe('sync socket apply cadence', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        requestMock.mockReset();
        requestMock.mockImplementation(() => new Promise(() => {}));
    });

    afterEach(async () => {
        socketApplyFrame.flushNow();
        const { sync } = await import('./syncEngine');
        sync.disconnectServer();
        markSessionSurfaceHidden(SESSION_ID, getActiveServerSnapshot().serverId);
    });

    it('publishes the Session once for the socket updates that arrive within one frame', async () => {
        const sync = await seedSession();
        let publishes = 0;
        const unsubscribe = storage.subscribe((state, previous) => {
            if (state.sessions[SESSION_ID] !== previous.sessions[SESSION_ID]) publishes += 1;
        });
        try {
            // Each socket update reaches the socket owner through the Sync wiring, as in production.
            await sync.handleUpdate(activityUpdate(1));
            await sync.handleUpdate(activityUpdate(2));
            await sync.handleUpdate(activityUpdate(3));
            expect(publishes).toBe(0);

            await new Promise((resolve) => setTimeout(resolve, 40));

            expect(publishes).toBe(1);
            expect(storage.getState().sessions[SESSION_ID]?.activeAt).toBe(1_003);
        } finally {
            unsubscribe();
        }
    });

    it('publishes updates still waiting for their frame when the Session is opened', async () => {
        const sync = await seedSession();
        await sync.handleUpdate(activityUpdate(1));
        expect(storage.getState().sessions[SESSION_ID]?.activeAt).toBe(1_000);

        sync.onSessionVisible(SESSION_ID);

        expect(storage.getState().sessions[SESSION_ID]?.activeAt).toBe(1_001);
    });

    it('publishes updates still waiting for their frame before the person sends', async () => {
        const sync = await seedSession();
        await sync.handleUpdate(activityUpdate(1));
        expect(storage.getState().sessions[SESSION_ID]?.activeAt).toBe(1_000);

        // The send decides from the stored Session as soon as it starts.
        void sync.submitMessage(SESSION_ID, 'hello').catch(() => {});

        expect(storage.getState().sessions[SESSION_ID]?.activeAt).toBe(1_001);
    });
});

// The unconfigured test build seeds no Home; select one through the real owner.
beforeEach(async () => { await selectActiveTestHomeForTests(); });
