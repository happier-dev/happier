import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { loadSessionReviewCommentsDrafts } from '@/sync/domains/state/sessionPersistence';
import { loadSettings, saveSettings } from '@/sync/domains/state/settingsPersistence';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getSessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import { Socket as SocketIoClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEMO_SERVER_BASE_URL } from '../world/constants';
import { DEMO_RICH_SESSION_ID } from '../world/buildDemoWorld';
import { isDemoModeActive, resetDemoModeDepthForTests } from '../runtime/enterExitDemoMode';
import { clearDemoWorld, seedDemoWorld } from './seedDemoWorld';
import { takeStoreSnapshot } from './storeSnapshot';

let storedCredentials: AuthCredentials | null = null;

vi.mock('@/text/i18n', () => ({
    setPreferredLanguageFromSettings: vi.fn(),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => storedCredentials),
    },
}));

const originalState = storage.getState();

function omitKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
    const next: Record<string, T> = {};
    for (const [entryKey, value] of Object.entries(record)) {
        if (entryKey !== key) next[entryKey] = value;
    }
    return next;
}

describe('seedDemoWorld and clearDemoWorld', () => {
    beforeEach(() => {
        storedCredentials = null;
        resetDemoModeDepthForTests();
        storage.setState(originalState, true);
    });

    afterEach(async () => {
        await clearDemoWorld();
        resetDemoModeDepthForTests();
        storage.setState(originalState, true);
        vi.restoreAllMocks();
    });

    it('restores demo-owned slices while preserving interleaved foreign writes', async () => {
        vi.useFakeTimers();
        try {
            const before = takeStoreSnapshot(storage.getState());
            const beforeSettings = structuredClone(storage.getState().settings);
            const foreignSession = createSessionFixture({
                id: 'foreign-session',
                seq: 77,
                metadata: {
                    path: '/tmp/foreign',
                    host: 'foreign.local',
                    homeDir: '/tmp',
                    machineId: 'foreign-machine',
                },
            });
            const foreignMachine = createMachineFixture({
                id: 'foreign-machine',
                seq: 88,
                metadata: {
                    host: 'foreign.local',
                    platform: 'darwin',
                    happyCliVersion: '1.0.0-foreign',
                    happyHomeDir: '/tmp/.happy',
                    homeDir: '/tmp',
                },
            });

            await seedDemoWorld();
            storage.getState().updateSessionDraft(DEMO_RICH_SESSION_ID, 'demo mutation through reducer');
            storage.getState().applySessions([foreignSession]);
            storage.getState().applyMachines([foreignMachine], false, { sourceServerId: 'foreign-server' });
            const withForeignWrite = takeStoreSnapshot(storage.getState());
            await vi.runOnlyPendingTimersAsync();

            await clearDemoWorld();

            const after = takeStoreSnapshot(storage.getState());
            expect(after.sessions['foreign-session']).toEqual(withForeignWrite.sessions['foreign-session']);
            expect(after.sessionListRenderables['foreign-session']).toEqual(
                withForeignWrite.sessionListRenderables['foreign-session'],
            );
            expect(after.machines['foreign-machine']).toEqual(withForeignWrite.machines['foreign-machine']);
            expect(after.machineDisplayById['foreign-machine']).toEqual(withForeignWrite.machineDisplayById['foreign-machine']);
            expect(after.machineListByServerId['foreign-server']).toEqual(
                withForeignWrite.machineListByServerId['foreign-server'],
            );
            expect(after.sessions[DEMO_RICH_SESSION_ID]).toBeUndefined();
            expect(after.sessionMessages[DEMO_RICH_SESSION_ID]).toBeUndefined();
            expect(after.sessionPending[DEMO_RICH_SESSION_ID]).toBeUndefined();
            expect(after.reviewCommentsDraftsBySessionId[DEMO_RICH_SESSION_ID]).toBeUndefined();
            expect(omitKey(after.sessions, 'foreign-session')).toEqual(before.sessions);
            expect(omitKey(after.sessionListRenderables, 'foreign-session')).toEqual(before.sessionListRenderables);
            expect(omitKey(after.machines, 'foreign-machine')).toEqual(before.machines);
            expect(omitKey(after.machineDisplayById, 'foreign-machine')).toEqual(before.machineDisplayById);
            expect(after.settings).toEqual(before.settings);
            expect(storage.getState().settings).toEqual(beforeSettings);
        } finally {
            vi.useRealTimers();
        }
    });

    it('removes the demo-only session-list index when clearing an otherwise empty store', async () => {
        const before = takeStoreSnapshot(storage.getState());

        await seedDemoWorld();
        await clearDemoWorld();

        expect(takeStoreSnapshot(storage.getState()).sessionListIndexByServerId).toEqual(
            before.sessionListIndexByServerId,
        );
    });

    it('refuses to seed when canonical token storage has real credentials', async () => {
        storedCredentials = { token: 'real-token', secret: 'real-secret' };

        await expect(seedDemoWorld()).rejects.toMatchObject({ code: 'demo_credentials_present' });

        expect(takeStoreSnapshot(storage.getState())).toEqual(takeStoreSnapshot(originalState));
    });

    it('does not register timers or global listeners while seeding and clearing', async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const addEventListenerSpy = typeof globalThis.addEventListener === 'function'
            ? vi.spyOn(globalThis, 'addEventListener')
            : null;

        await seedDemoWorld();
        await clearDemoWorld();

        expect(setTimeoutSpy).not.toHaveBeenCalled();
        expect(setIntervalSpy).not.toHaveBeenCalled();
        if (addEventListenerSpy) {
            expect(addEventListenerSpy).not.toHaveBeenCalled();
        }
    });

    it('never persists demo review-comment drafts to durable storage (seed and clear)', async () => {
        // Regression (JV3-LIVEQA live find): the seed wrote drafts through the persisting
        // upsert action, leaving demo drafts in the mmkv-backed review-drafts key even after
        // a clean teardown — and pointing a hard-exited profile at demo residue forever.
        await seedDemoWorld();

        const persistedWhileSeeded = loadSessionReviewCommentsDrafts();
        expect(Object.keys(persistedWhileSeeded).filter((key) => key.startsWith('demo-'))).toEqual([]);
        expect(storage.getState().reviewCommentsDraftsBySessionId[DEMO_RICH_SESSION_ID]?.length ?? 0)
            .toBeGreaterThan(0);

        await clearDemoWorld();

        const persistedAfterClear = loadSessionReviewCommentsDrafts();
        expect(Object.keys(persistedAfterClear).filter((key) => key.startsWith('demo-'))).toEqual([]);
    });

    it('activates the demo server while seeded and restores the previous active server on clear', async () => {
        const previous = upsertAndActivateServer({
            serverUrl: 'https://previous-demo-seed.example.test',
            name: 'Previous seed test server',
            scope: 'device',
        });

        await seedDemoWorld();

        expect(getActiveServerSnapshot()).toMatchObject({
            serverUrl: DEMO_SERVER_BASE_URL,
        });

        await clearDemoWorld();

        expect(getActiveServerSnapshot()).toMatchObject({
            serverId: previous.id,
            serverUrl: previous.serverUrl,
        });
    });

    it('keeps the durable active-target selection coherent when the demo profile is removed', async () => {
        const persistedBefore = loadSettings();
        const previous = upsertAndActivateServer({
            serverUrl: 'https://durable-demo-restore.example.test',
            name: 'Durable restore test server',
            scope: 'device',
        });
        storage.getState().applySettingsLocal({
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: previous.id,
        });

        try {
            await seedDemoWorld();

            expect(storage.getState().settings).toMatchObject({
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: getActiveServerSnapshot().serverId,
            });
            expect(loadSettings().settings).toMatchObject({
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: previous.id,
            });

            await clearDemoWorld();

            expect(getActiveServerSnapshot()).toMatchObject({
                serverId: previous.id,
                serverUrl: previous.serverUrl,
            });
            expect(storage.getState().settings).toMatchObject({
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: previous.id,
            });
            expect(loadSettings().settings).toMatchObject({
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: previous.id,
            });
        } finally {
            saveSettings(settingsParse(persistedBefore.settings), persistedBefore.version ?? 0);
        }
    });

    it('keeps one demo-mode lifetime when a repeated seed reuses the active world', async () => {
        await seedDemoWorld({ residuePolicy: 'diagnostic' });
        await seedDemoWorld({ residuePolicy: 'diagnostic' });

        await clearDemoWorld();

        expect(isDemoModeActive()).toBe(false);
    });

    it('builds the active demo server session-list index from seeded sessions', async () => {
        await seedDemoWorld();

        const activeServerId = getActiveServerSnapshot().serverId;
        const activeIndex = storage.getState().sessionListIndexByServerId[activeServerId];
        const visibleSessionIds = activeIndex
            ?.filter((item) => item.type === 'session')
            .map((item) => item.sessionId) ?? [];

        expect(activeIndex?.some((item) => (
            item.type === 'session'
            && item.sessionId === DEMO_RICH_SESSION_ID
            && item.storageKind === 'direct'
        ))).toBe(true);
        expect(getSessionStorageKind(storage.getState().sessions[DEMO_RICH_SESSION_ID])).toBe('direct');
        expect(visibleSessionIds).toHaveLength(9);
    });

    it('selects the demo server for session-list presentation while seeded', async () => {
        await seedDemoWorld();

        const activeServerId = getActiveServerSnapshot().serverId;

        expect(storage.getState().settings).toMatchObject({
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: activeServerId,
        });
    });

    it('reports runtime residue without rejecting when diagnostic teardown is requested', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await seedDemoWorld();

        const unsubscribe = storage.subscribe(() => undefined);
        try {
            await expect(clearDemoWorld({ residuePolicy: 'diagnostic' })).resolves.toEqual({
                residueFindings: [{
                    kind: 'storeSubscription',
                    label: 'active storage subscriptions',
                    count: 1,
                }],
            });
        } finally {
            unsubscribe();
        }

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[DemoMode]'), {
            code: 'demo_runtime_residue',
            findings: [{
                kind: 'storeSubscription',
                label: 'active storage subscriptions',
                count: 1,
            }],
        });
    });

    it('rejects teardown in strict harness mode when a demo-time store subscription remains active', async () => {
        await seedDemoWorld();

        const unsubscribe = storage.subscribe(() => undefined);

        await expect(clearDemoWorld({ residuePolicy: 'strict' })).rejects.toMatchObject({
            code: 'demo_runtime_residue',
            findings: [expect.objectContaining({ kind: 'storeSubscription' })],
        });

        unsubscribe();
    });

    it('rejects teardown when an animation frame created during demo mode remains pending', async () => {
        const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
        const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
        let nextFrameId = 1;
        const pendingFrames = new Set<number>();
        globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
            const frameId = nextFrameId;
            nextFrameId += 1;
            pendingFrames.add(frameId);
            void callback;
            return frameId;
        }) as typeof globalThis.requestAnimationFrame;
        globalThis.cancelAnimationFrame = ((frameId: number) => {
            pendingFrames.delete(frameId);
        }) as typeof globalThis.cancelAnimationFrame;

        try {
            await seedDemoWorld();
            const frameId = globalThis.requestAnimationFrame(() => undefined);

            await expect(clearDemoWorld()).rejects.toMatchObject({
                code: 'demo_runtime_residue',
                findings: [expect.objectContaining({ kind: 'animationFrame' })],
            });

            globalThis.cancelAnimationFrame(frameId);
        } finally {
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
            globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
        }
    });

    it('rejects teardown when an event listener created during demo mode remains attached', async () => {
        const target = new EventTarget();
        const listener = () => undefined;

        await seedDemoWorld();
        target.addEventListener('demo', listener);

        await expect(clearDemoWorld()).rejects.toMatchObject({
            code: 'demo_runtime_residue',
            findings: [expect.objectContaining({ kind: 'eventListener' })],
        });

        target.removeEventListener('demo', listener);
    });

    it('rejects teardown when a socket listener created during demo mode remains attached', async () => {
        const socket = Object.create(SocketIoClientSocket.prototype) as SocketIoClientSocket;
        const listener = () => undefined;

        await seedDemoWorld();
        socket.on('demo-event', listener);

        await expect(clearDemoWorld()).rejects.toMatchObject({
            code: 'demo_runtime_residue',
            findings: [expect.objectContaining({ kind: 'socketListener' })],
        });

        socket.off('demo-event', listener);
    });
});
