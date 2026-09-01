import { beforeEach, describe, expect, it, vi } from 'vitest';

const appStateHandlers = vi.hoisted(() => new Set<(state: string) => void>());
const appStateAddListener = vi.hoisted(() => vi.fn((_event: string, handler: (state: string) => void) => {
    appStateHandlers.add(handler);
    return { remove: vi.fn(() => appStateHandlers.delete(handler)) };
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        AppState: {
            currentState: 'active',
            addEventListener: appStateAddListener as any,
        },
    });
});

const socketStatusHandlers = vi.hoisted(() => new Set<(status: string) => void>());
const apiSocketDisconnect = vi.hoisted(() => vi.fn(() => {
    for (const handler of socketStatusHandlers) {
        handler('disconnected');
    }
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn((handler: (status: string) => void) => {
            socketStatusHandlers.add(handler);
            return () => socketStatusHandlers.delete(handler);
        }),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn(),
        disconnect: apiSocketDisconnect,
        initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
    },
}));

const fetchChangesMock = vi.hoisted(() => vi.fn());
const fetchCurrentChangesCursorMock = vi.hoisted(() => vi.fn(async () => ({ status: 'ok', cursor: '2' })));

vi.mock('@/sync/api/session/apiChanges', () => ({
    fetchChanges: fetchChangesMock,
    fetchCurrentChangesCursor: fetchCurrentChangesCursorMock,
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createSyncUnitStub() {
    return {
        invalidateCoalesced: vi.fn(),
        awaitQueue: vi.fn(async () => {}),
        invalidate: vi.fn(),
        invalidateAndAwait: vi.fn(async () => {}),
    };
}

async function createResumableSync() {
    const { sync } = await import('./sync');
    (sync as unknown as { subscribeToUpdates: () => void }).subscribeToUpdates();

    const units = {
        sessionsSync: createSyncUnitStub(),
        machinesSync: createSyncUnitStub(),
        settingsSync: createSyncUnitStub(),
        profileSync: createSyncUnitStub(),
        artifactsSync: createSyncUnitStub(),
        friendsSync: createSyncUnitStub(),
        friendRequestsSync: createSyncUnitStub(),
        feedSync: createSyncUnitStub(),
        automationsSync: createSyncUnitStub(),
        todosSync: createSyncUnitStub(),
        purchasesSync: createSyncUnitStub(),
        pushTokenSync: createSyncUnitStub(),
        nativeUpdateSync: createSyncUnitStub(),
    };
    for (const [field, unit] of Object.entries(units)) {
        (sync as any)[field] = unit;
    }

    (sync as any).credentials = { token: 'token-a', secret: new Uint8Array([1]) };
    (sync as any).serverID = 'account-a';
    (sync as any).changesCursor = '1';
    vi.spyOn(sync as any, 'rearmPendingOutboxForActiveScope').mockResolvedValue(undefined);
    vi.spyOn(sync as any, 'catchUpLoadedDirectSessionsOnResume').mockResolvedValue(undefined);
    const fetchSessions = vi.spyOn(sync as any, 'fetchSessions').mockResolvedValue(undefined);

    return { sync, units, fetchSessions };
}

describe('foreground catch-up request count', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        vi.resetModules();
        vi.restoreAllMocks();
        appStateHandlers.clear();
        socketStatusHandlers.clear();
        appStateAddListener.mockClear();
        apiSocketDisconnect.mockClear();
        fetchChangesMock.mockReset();
        fetchChangesMock.mockResolvedValue({
            status: 'ok',
            changes: [{ cursor: '2', kind: 'session', entityId: 's1' }],
            nextCursor: '2',
        });
    });

    it('issues exactly one session-list refresh for a foreground cycle whose delta contains a session change', async () => {
        const { sync, units, fetchSessions } = await createResumableSync();

        const appStateHandler = Array.from(appStateHandlers)[0];
        expect(appStateHandler).toBeTruthy();

        appStateHandler!('background');
        await vi.advanceTimersByTimeAsync(30_000);

        appStateHandler!('active');
        await (sync as unknown as { resumeInFlight: Promise<void> | null }).resumeInFlight;
        await vi.advanceTimersByTimeAsync(0);

        expect(fetchSessions).toHaveBeenCalledTimes(1);
        expect(fetchSessions.mock.calls[0]?.[0]).toMatchObject({ hydrationTelemetrySource: 'changesCatchUp' });
        // The resume tail must not repeat the refresh the catch-up already completed.
        expect(units.sessionsSync.invalidateCoalesced).not.toHaveBeenCalled();
    });

    it('repeats the session-list refresh only when the catch-up refresh actually failed', async () => {
        // Coverage is reported per completed refresh, so a genuinely failed one is still retried by
        // the resume tail. This is the coupling that turned a *falsely* reported failure inside
        // required-row hydration into a second complete catch-up wave on device, so it is pinned:
        // the retry must be reachable exactly when the refresh really did not complete.
        const { sync, units, fetchSessions } = await createResumableSync();
        fetchSessions.mockRejectedValueOnce(new Error('session list refresh failed'));

        const appStateHandler = Array.from(appStateHandlers)[0];
        appStateHandler!('background');
        await vi.advanceTimersByTimeAsync(30_000);

        appStateHandler!('active');
        await (sync as unknown as { resumeInFlight: Promise<void> | null }).resumeInFlight;
        await vi.advanceTimersByTimeAsync(0);

        expect(fetchSessions).toHaveBeenCalledTimes(1);
        expect(units.sessionsSync.invalidateCoalesced).toHaveBeenCalledTimes(1);
    });

    it('closes the post-subscription gap with one changes-only catch-up queued behind the foreground resume', async () => {
        const { sync, units, fetchSessions } = await createResumableSync();
        fetchChangesMock
            .mockImplementationOnce(async () => {
                // The server-side query has completed, but its empty response has not reached the
                // resume pipeline yet. The socket now subscribes and a durable change can land
                // immediately after the response's database snapshot.
                for (const handler of socketStatusHandlers) {
                    handler('connected');
                }
                return { status: 'ok', changes: [], nextCursor: '1' };
            })
            .mockResolvedValueOnce({
                status: 'ok',
                changes: [{ cursor: '2', kind: 'session', entityId: 's1' }],
                nextCursor: '2',
            });

        const appStateHandler = Array.from(appStateHandlers)[0];
        appStateHandler!('background');
        await vi.advanceTimersByTimeAsync(30_000);

        appStateHandler!('active');
        const foregroundResume = (sync as unknown as { resumeInFlight: Promise<void> | null }).resumeInFlight;
        await foregroundResume;
        await vi.advanceTimersByTimeAsync(0);
        await (sync as unknown as { resumeInFlight: Promise<void> | null }).resumeInFlight;

        expect(fetchChangesMock).toHaveBeenCalledTimes(2);
        expect(fetchSessions).toHaveBeenCalledTimes(1);
        expect(units.sessionsSync.invalidateCoalesced).toHaveBeenCalledTimes(1);
        expect(units.machinesSync.invalidateCoalesced).toHaveBeenCalledTimes(1);
        expect(units.purchasesSync.invalidateCoalesced).toHaveBeenCalledTimes(1);
        expect(units.pushTokenSync.invalidateCoalesced).toHaveBeenCalledTimes(1);
        expect(units.nativeUpdateSync.invalidateCoalesced).toHaveBeenCalledTimes(1);
    });
});
