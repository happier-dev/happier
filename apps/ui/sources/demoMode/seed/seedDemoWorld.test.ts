import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { storage } from '@/sync/domains/state/storage';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getActiveServerSnapshot, subscribeActiveServer, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { loadHomeViewState, saveHomeViewState } from '@/sync/domains/server/serverProfiles';
import { loadSessionReviewCommentsDrafts } from '@/sync/domains/state/sessionPersistence';
import { loadProfile } from '@/sync/domains/state/profilePersistence';
import { loadLocalSettings, loadSettings, saveSettings } from '@/sync/domains/state/settingsPersistence';
import { settingsParse } from '@/sync/domains/settings/settings';
import { loadSessionListWarmCacheEntries, prepareWarmCacheStorage, resolveWarmCacheAccountScope, setWarmCacheAccountScope } from '@/sync/domains/state/warmCachePersistence';
import { getSessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import { deleteServerFeaturesSnapshot, getCachedServerFeaturesSnapshot, primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { connectedServiceProfileKey } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { Socket as SocketIoClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEMO_SERVER_BASE_URL } from '../world/constants';
import { buildDemoWorld, DEMO_RICH_SESSION_ID } from '../world/buildDemoWorld';
import { isDemoModeActive, resetDemoModeDepthForTests } from '../runtime/enterExitDemoMode';
import { getDemoFirewallDenyLog, installDemoFirewall, uninstallDemoFirewall } from '../guards/demoFirewall';
import { clearDemoWorld, seedDemoWorld } from './seedDemoWorld';
import { takeStoreSnapshot } from './storeSnapshot';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const originalState = storage.getState();

function omitKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
    const next: Record<string, T> = {};
    for (const [entryKey, value] of Object.entries(record)) {
        if (entryKey !== key) next[entryKey] = value;
    }
    return next;
}

describe('seedDemoWorld and clearDemoWorld', () => {
    let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'https://demo-owner.example.test' });
        resetDemoModeDepthForTests();
        storage.setState(originalState, true);
    });

    afterEach(async () => {
        try {
            await clearDemoWorld();
        } finally {
            resetDemoModeDepthForTests();
            storage.setState(originalState, true);
            vi.restoreAllMocks();
            browser.restore();
        }
    });

    it('snapshots seeded transcript records and keeps their messages after the live transcript is cleared', async () => {
        await seedDemoWorld();
        const snapshot = takeStoreSnapshot(storage.getState());
        const messages = snapshot.sessionMessages[DEMO_RICH_SESSION_ID]!;
        expect(messages.messageIdsOldestFirst.length).toBeGreaterThan(0);
        expect(messages.messagesMap).toBe(messages.messagesById);
        storage.getState().resetSessionMessages(DEMO_RICH_SESSION_ID);
        expect(new Set(Object.keys(messages.messagesById))).toEqual(new Set(messages.messageIdsOldestFirst));
    });

    it('exposes seeded demo draft surfaces without remote hydration and restores their prior readiness on exit', async () => {
        storage.setState({ isSessionDraftsReady: false });
        await seedDemoWorld();
        expect(storage.getState().isSessionDraftsReady).toBe(true);
        await clearDemoWorld();
        expect(storage.getState().isSessionDraftsReady).toBe(false);
    });

    it('keeps demo session membership out of a retained Account warm cache', async () => {
        await prepareWarmCacheStorage();
        const previousAccountScope = resolveWarmCacheAccountScope(null);
        const accountId = 'demo-persistence-fixture-account';
        setWarmCacheAccountScope(accountId);
        storage.setState(current => ({ profile: { ...current.profile, id: accountId } }));
        installDemoFirewall();
        try {
            await seedDemoWorld();
            const demoServerId = getActiveServerSnapshot().serverId;
            expect(loadSessionListWarmCacheEntries(demoServerId, accountId)).toEqual({});
            await clearDemoWorld();
            expect(loadSessionListWarmCacheEntries(demoServerId, accountId)).toEqual({});
        } finally {
            await clearDemoWorld();
            uninstallDemoFirewall();
            setWarmCacheAccountScope(previousAccountScope);
        }
    });

    it('seeds canonical role documents in memory and restores only demo-owned Artifacts', async () => {
        const durableSettings = structuredClone(loadSettings().settings);
        const roleArtifact = buildDemoWorld().artifacts[0];
        if (!roleArtifact.isDecrypted) throw new Error('Demo role fixture must be readable');
        const existing = { ...roleArtifact, body: 'Retain the original document' };
        storage.setState((current) => ({
            artifacts: { ...current.artifacts, [existing.id]: existing },
        }));
        const originalArtifacts = structuredClone(storage.getState().artifacts);
        const world = await seedDemoWorld();
        expect(world.artifacts).toHaveLength(3);
        for (const artifact of world.artifacts) {
            expect(storage.getState().artifacts[artifact.id]).toEqual(artifact);
        }
        const foreign = { ...world.artifacts[0], id: 'foreign-role' };
        storage.getState().addArtifact(foreign);
        expect(loadSettings().settings).toEqual(durableSettings);
        await clearDemoWorld();
        expect(storage.getState().artifacts).toEqual({ ...originalArtifacts, [foreign.id]: foreign });
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
            storage.getState().markSessionViewed(DEMO_RICH_SESSION_ID);
            storage.getState().applySessions([foreignSession]);
            storage.getState().applyMachines([foreignMachine], false, { sourceServerId: 'foreign-server' });
            const withForeignWrite = takeStoreSnapshot(storage.getState());
            await vi.runOnlyPendingTimersAsync();

            await clearDemoWorld();

            const after = takeStoreSnapshot(storage.getState());
            expect(after.sessions['foreign-session']).toEqual(withForeignWrite.sessions['foreign-session']);
            expect(after.sessionListRowsByServerId['foreign-server']?.['foreign-session']).toEqual(
                withForeignWrite.sessionListRowsByServerId['foreign-server']?.['foreign-session'],
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
            for (const serverId of new Set([
                ...Object.keys(after.sessionListRowsByServerId),
                ...Object.keys(before.sessionListRowsByServerId),
            ])) {
                expect(omitKey(after.sessionListRowsByServerId[serverId] ?? {}, 'foreign-session')).toEqual(
                    before.sessionListRowsByServerId[serverId] ?? {},
                );
            }
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
        expect(await TokenStorage.setCredentials({ token: 'real-token', secret: 'real-secret' })).toBe(true);

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

    it('never persists demo connected accounts or theme profiles to durable storage (seed and clear)', async () => {
        // The A12 accounts/pools and A13 theme profiles are demo presentation state.
        // Routing them through `applyProfile` / `applyLocalSettings` would write them
        // to the real device profile, which a hard exit mid-journey would strand.
        const beforeProfile = structuredClone(storage.getState().profile.connectedServicesV2);
        const beforeThemeProfiles = structuredClone(storage.getState().localSettings.themeProfiles);

        await seedDemoWorld();

        expect(storage.getState().profile.connectedServicesV2.length).toBeGreaterThan(0);
        expect(storage.getState().localSettings.themeProfiles.profiles.length).toBeGreaterThan(0);
        expect(loadProfile().connectedServicesV2).toEqual(beforeProfile);
        expect(loadLocalSettings().themeProfiles).toEqual(beforeThemeProfiles);

        await clearDemoWorld();

        expect(storage.getState().profile.connectedServicesV2).toEqual(beforeProfile);
        expect(storage.getState().localSettings.themeProfiles).toEqual(beforeThemeProfiles);
        expect(loadProfile().connectedServicesV2).toEqual(beforeProfile);
        expect(loadLocalSettings().themeProfiles).toEqual(beforeThemeProfiles);
    });

    it('projects demo personal labels through the canonical catalog and restores the real world on clear', async () => {
        const beforeCatalog = getConnectedMetadataCatalog(null);
        const beforeProfile = structuredClone(storage.getState().profile);
        const beforeDurableProfile = structuredClone(loadProfile());
        const beforeDurableSettings = structuredClone(loadSettings());
        const originalLabels = { deliberatelyUnqualified: 'Retained Settings value' };
        storage.setState(current => ({
            // Poison an old hydrated source without restoring a retired field to effective Settings.
            settings: { ...current.settings, connectedServicesProfileLabelByKey: originalLabels },
        }));

        installDemoFirewall();
        try {
            const world = await seedDemoWorld();
            const work = world.profile.connectedAccountsV4.find(account => account.ref.accountId === 'work');
            if (!work) throw new Error('Demo world must include the qualified work account');
            const key = connectedServiceProfileKey({
                serviceId: buildQualifiedPluginContributionKey(work.ref.service), profileId: work.ref.accountId,
            });
            storage.setState(current => ({
                profile: { ...current.profile, connectedAccountsV4: current.profile.connectedAccountsV4.map(account =>
                    account.ref.accountId === work.ref.accountId ? { ...account, displayName: 'Provider-native name' } : account) },
            }));

            expect(getConnectedMetadataCatalog(null).labelsByKey[key]).toBe('Work');
            expect(Reflect.get(storage.getState().settings, 'connectedServicesProfileLabelByKey')).toEqual(originalLabels);
            expect(loadProfile()).toEqual(beforeDurableProfile);
            expect(loadSettings()).toEqual(beforeDurableSettings);
            expect(getDemoFirewallDenyLog()).toEqual([]);

            await clearDemoWorld();

            expect(getConnectedMetadataCatalog(null)).toBe(beforeCatalog);
            expect(storage.getState().profile.connectedAccountsV4).toEqual(beforeProfile.connectedAccountsV4);
            expect(storage.getState().profile.connectedAccountGroupsV4).toEqual(beforeProfile.connectedAccountGroupsV4);
            expect(Reflect.get(storage.getState().settings, 'connectedServicesProfileLabelByKey')).toEqual(originalLabels);
            expect(loadProfile()).toEqual(beforeDurableProfile);
            expect(loadSettings()).toEqual(beforeDurableSettings);
            expect(getDemoFirewallDenyLog()).toEqual([]);
        } finally {
            await clearDemoWorld();
            uninstallDemoFirewall();
        }
    });

    it('activates the demo server while seeded and restores the previous active server on clear', async () => {
        const previous = await upsertAndActivateServer({
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

    it('restores a pre-existing Home feature observation after clearing the demo world', async () => {
        const previous = await upsertAndActivateServer({
            serverUrl: 'https://retained-demo-features.example.test',
            name: 'Retained feature test Home',
            scope: 'device',
        });
        const snapshot = {
            status: 'ready' as const,
            features: createRootLayoutFeaturesResponse({ features: { automations: { enabled: false } } }),
        };
        primeServerFeaturesSnapshot({ serverId: previous.id, snapshot });
        try {
            await seedDemoWorld();
            expect(getCachedServerFeaturesSnapshot({ serverId: previous.id })).not.toEqual(snapshot);
            await clearDemoWorld();
            expect(getCachedServerFeaturesSnapshot({ serverId: previous.id })).toEqual(snapshot);
        } finally {
            deleteServerFeaturesSnapshot({ serverId: previous.id });
        }
    });

    it('publishes the Demo Home only once its seeded capabilities are readable', async () => {
        resetServerFeaturesClientForTests();
        const observations: ReturnType<typeof getCachedServerFeaturesSnapshot>[] = [];
        const unsubscribe = subscribeActiveServer((active) => {
            if (active.serverUrl === DEMO_SERVER_BASE_URL) {
                observations.push(getCachedServerFeaturesSnapshot({ serverId: active.serverId }));
            }
        });
        try {
            const world = await seedDemoWorld();
            expect(observations.length).toBeGreaterThan(0);
            expect(observations.every((snapshot) => snapshot?.status === 'ready'
                && snapshot.features === world.serverFeatures)).toBe(true);
        } finally {
            unsubscribe();
        }
    });

    it('restores real Home observations when activation fails after capabilities are seeded', async () => {
        const previous = getActiveServerSnapshot();
        const snapshot = { status: 'ready' as const, features: createRootLayoutFeaturesResponse() };
        primeServerFeaturesSnapshot({ serverId: previous.serverId, snapshot });
        const failure = new Error('browser Home mutation lock unavailable');
        const request = navigator.locks.request;
        let injected = false;
        // Web Locks are the genuine browser mutation boundary; keep every other operation real.
        const requestSpy = vi.spyOn(navigator.locks, 'request').mockImplementation((function (this: LockManager, ...args: unknown[]) {
            if (!injected && isDemoModeActive()) {
                injected = true;
                return Promise.reject(failure);
            }
            return Reflect.apply(request, this, args);
        }) as typeof navigator.locks.request);
        installDemoFirewall();
        try {
            await expect(seedDemoWorld()).rejects.toBe(failure);
            expect(injected).toBe(true);
            await clearDemoWorld();
            expect(isDemoModeActive()).toBe(false);
            expect(getActiveServerSnapshot().serverId).toBe(previous.serverId);
            expect(getCachedServerFeaturesSnapshot({ serverId: previous.serverId })).toEqual(snapshot);
        } finally {
            requestSpy.mockRestore();
            await clearDemoWorld();
            uninstallDemoFirewall();
            deleteServerFeaturesSnapshot({ serverId: previous.serverId });
        }
    });

    it('keeps the durable active-target selection coherent when the demo profile is removed', async () => {
        const persistedBefore = loadSettings();
        const previous = await upsertAndActivateServer({
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
        const world = await seedDemoWorld();

        const activeServerId = getActiveServerSnapshot().serverId;
        for (const session of world.sessions) {
            expect(storage.getState().sessions[session.id]).toMatchObject({ serverId: activeServerId });
        }
        const activeIndex = storage.getState().sessionListIndexByServerId[activeServerId];
        const visibleSessionIds = activeIndex
            ?.filter((item) => item.type === 'session')
            .map((item) => item.sessionId) ?? [];

        expect(getSessionStorageKind(storage.getState().sessions[DEMO_RICH_SESSION_ID])).toBe('direct');
        expect(activeIndex).toContainEqual(expect.objectContaining({
            type: 'session', sessionId: DEMO_RICH_SESSION_ID, storageKind: 'direct',
        }));
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

    it('uses and restores the canonical initialized HomeView target while seeded', async () => {
        const previous = await upsertAndActivateServer({
            serverUrl: 'https://home-view-demo-restore.example.test',
            name: 'HomeView restore test server',
            scope: 'device',
        });
        await saveHomeViewState({
            version: 1,
            groups: [{ id: 'homes', name: 'Homes', serverIds: [previous.id] }],
            activeTargetKind: 'group',
            activeTargetId: 'homes',
        });
        const before = loadHomeViewState();

        await seedDemoWorld();

        expect(loadHomeViewState()).toMatchObject({
            activeTargetKind: 'server',
            activeTargetId: getActiveServerSnapshot().serverId,
        });

        await clearDemoWorld();

        expect(loadHomeViewState()).toEqual(before);
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
