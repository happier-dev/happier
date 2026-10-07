import { afterEach, describe, expect, it, vi } from 'vitest';
import { MMKV } from 'react-native-mmkv';

import { scopedStorageId } from '@/utils/system/storageScope';

function randomScope(): string {
    return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function stubWebRuntime(
    origin: string,
    options: Readonly<{ locks?: boolean }> = {},
) {
    const store = new Map<string, string>();
    const storageListeners = new Set<(event: { key: string | null }) => void>();
    const storage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => void store.clear(),
    };
    vi.stubGlobal('sessionStorage', {
        ...storage,
    });
    let hostname = '';
    try {
        hostname = new URL(origin).hostname;
    } catch {
        hostname = '';
    }
    vi.stubGlobal('window', {
        location: { origin, hostname },
        localStorage: storage,
        addEventListener: (type: string, listener: (event: { key: string | null }) => void) => {
            if (type === 'storage') storageListeners.add(listener);
        },
        removeEventListener: (type: string, listener: (event: { key: string | null }) => void) => {
            if (type === 'storage') storageListeners.delete(listener);
        },
    });
    vi.stubGlobal('document', {});
    if (options.locks !== false) {
        const lockTails = new Map<string, Promise<void>>();
        vi.stubGlobal('navigator', {
            locks: {
                request: <T>(name: string, callback: () => T | PromiseLike<T>): Promise<T> => {
                    const previous = lockTails.get(name) ?? Promise.resolve();
                    const result = previous.then(callback);
                    lockTails.set(name, result.then(() => undefined, () => undefined));
                    return result;
                },
            },
        });
    } else {
        vi.stubGlobal('navigator', {});
    }
    return {
        store,
        emitStorage: (key: string | null) => {
            for (const listener of storageListeners) listener({ key });
        },
    };
}

function stubWebRuntimeWithRuntimeConfig(origin: string, runtimeConfig: Record<string, unknown>) {
    let hostname = '';
    try {
        hostname = new URL(origin).hostname;
    } catch {
        hostname = '';
    }
    vi.stubGlobal('window', {
        location: { origin, hostname },
        __HAPPIER_WEB_RUNTIME_CONFIG__: runtimeConfig,
    });
    vi.stubGlobal('document', {});
}

async function importFresh(options: Readonly<{ resetModules?: boolean }> = {}) {
    if (options.resetModules !== false) vi.resetModules();
    return await import('./serverProfiles');
}

describe('serverProfiles', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    const previousServerContext = process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
    const previousCanonicalServerUrl = process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
    const previousServerUrl = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
    const previousLegacyGenericServerUrl = process.env.EXPO_PUBLIC_SERVER_URL;
    const previousPreconfigured = process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
    const previousBuildFeaturesDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    afterEach(() => {
        vi.unstubAllGlobals();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        if (previousServerContext === undefined) delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
        else process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = previousServerContext;
        if (previousCanonicalServerUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        else process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL = previousCanonicalServerUrl;
        if (previousServerUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        else process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = previousServerUrl;
        if (previousLegacyGenericServerUrl === undefined) delete process.env.EXPO_PUBLIC_SERVER_URL;
        else process.env.EXPO_PUBLIC_SERVER_URL = previousLegacyGenericServerUrl;
        if (previousPreconfigured === undefined) delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        else process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS = previousPreconfigured;
        if (previousBuildFeaturesDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousBuildFeaturesDeny;
    });

    it('migrates focused Home selection into device-global state once', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        seedServerState(scope, homeAState());
        const profiles = await importFresh();
        const first = await profiles.migrateHomeViewStateFromSettings({
            serverSelectionGroups: [{ id: 'g', name: 'Group', serverIds: ['home-a', 'home-a'] }],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'g',
        });
        const second = await profiles.migrateHomeViewStateFromSettings({
            serverSelectionGroups: [{ id: 'other', name: 'Other', serverIds: ['home-b'] }],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: 'srv_home_b_marker_1',
        });
        expect(first).toMatchObject({ activeTargetKind: 'group', activeTargetId: 'g' });
        expect(second).toEqual(first);
        expect(profiles.loadHomeViewState()).toEqual(first);
    });

    it('maps Home aliases and keeps not-yet-adopted Home ids during scoped migration', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        seedServerState(scope, homeAState());
        const profiles = await importFresh();

        const migrated = await profiles.migrateHomeViewStateFromSettings({
            serverSelectionGroups: [{
                id: 'homes',
                name: 'Homes',
                serverIds: ['home-a', 'srv_home_a_marker_1', '   ', 'srv_future_home_1'],
            }],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: 'srv_future_home_1',
        });

        expect(migrated).toEqual({
            version: 1,
            groups: [{
                id: 'homes',
                name: 'Homes',
                serverIds: ['srv_home_a_marker_1', 'srv_future_home_1'],
                presentation: 'grouped',
            }],
            activeTargetKind: 'server',
            activeTargetId: 'srv_future_home_1',
        });
    });

    it('preserves an unadopted Home scope id through load, save and later adoption', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = seedServerState(scope, {
            ...homeAState(),
            homeViewStateInitialized: true,
            homeViewState: {
                version: 1,
                groups: [{
                    id: 'homes',
                    name: 'Homes',
                    serverIds: ['srv_home_a_marker_1', 'srv_late_home_1'],
                    presentation: 'grouped',
                }],
                activeTargetKind: 'group',
                activeTargetId: 'homes',
            },
        });
        const profiles = await importFresh();

        const loaded = profiles.loadHomeViewState();
        expect(loaded).toMatchObject({
            groups: [{ id: 'homes', serverIds: ['srv_home_a_marker_1', 'srv_late_home_1'] }],
            activeTargetKind: 'group',
            activeTargetId: 'homes',
        });
        expect(readPersistedBlob(storage).homeViewState).toEqual(loaded);

        // The Home is adopted after the view referencing it was already stored.
        const late = await profiles.upsertServerProfile({ serverUrl: 'https://late-home.example.test', source: 'manual' });
        await profiles.setServerProfileIdentityForUrl(late.serverUrl, 'srv_late_home_1');

        expect(profiles.loadHomeViewState()).toMatchObject({
            groups: [{ id: 'homes', serverIds: ['srv_home_a_marker_1', 'srv_late_home_1'] }],
            activeTargetKind: 'group',
            activeTargetId: 'homes',
        });
    });

    it('resolves canonical aliases only on explicit opt-in and rejects ambiguous aliases without changing primary URL intents', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const web = stubWebRuntime('https://app.example.test');
        const key = `${scopedStorageId('server-profiles', scope)}:server-state-v1`;
        const alias = 'https://canonical-home.example.test';
        const first = { id: 'home-a', name: 'Home A', serverUrl: 'https://home-a.example.test',
            canonicalServerUrl: alias, serverIdentityId: 'srv_alias_home_a', source: 'manual' };
        web.store.set(key, JSON.stringify({ servers: { 'home-a': first } }));
        const profiles = await importFresh();
        expect(profiles.resolveSavedServerProfileByUrl(alias).kind).toBe('missing');
        expect(profiles.resolveUniqueServerProfileByUrl(`${alias}/`, { includeCanonicalServerUrl: true })?.id).toBe(first.id);
        web.store.set(key, JSON.stringify({ servers: {
            'home-a': first,
            'home-b': { ...first, id: 'home-b', serverUrl: 'https://home-b.example.test', serverIdentityId: 'srv_alias_home_b' },
        } }));
        profiles.resetServerProfilesRuntimeForTests();
        expect(profiles.resolveSavedServerProfileByUrl(alias).kind).toBe('missing');
        expect(profiles.resolveSavedServerProfileByUrl(alias, { includeCanonicalServerUrl: true }).kind).toBe('ambiguous');
        expect(profiles.resolveUniqueServerProfileByUrl(alias, { includeCanonicalServerUrl: true })).toBeNull();
        expect(profiles.resolveUniqueServerProfileByUrl(first.serverUrl)?.id).toBe(first.id);
    });

    function seedServerState(scope: string, state: Record<string, unknown>): MMKV {
        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        storage.set('server-state-v1', JSON.stringify(state));
        return storage;
    }

    type PersistedTestGroup = {
        id?: string;
        name?: string;
        serverIds?: readonly string[];
        presentation?: string;
    };

    type PersistedTestBlob = {
        activeServerId?: string;
        servers?: Record<string, { id?: string }>;
        accountServiceEndpoint?: { url?: string; source?: string } | null;
        homeViewStateInitialized?: boolean;
        homeViewState?: {
            version?: number;
            groups?: readonly PersistedTestGroup[];
            activeTargetKind?: string | null;
            activeTargetId?: string | null;
        } | null;
    };

    function readPersistedBlob(storage: MMKV): PersistedTestBlob {
        const parsed: unknown = JSON.parse(storage.getString('server-state-v1') ?? '{}');
        return (parsed && typeof parsed === 'object' ? parsed : {}) as PersistedTestBlob;
    }

    it('does not treat a newly constructed source-only profile as completed bootstrap truth', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();

        expect(profiles.findPersonalHomeBootstrapCompletedProfile([{
            id: 'personal-home',
            name: 'Personal Home',
            serverUrl: 'http://127.0.0.1:3005',
            serverIdentityId: 'srv_personal_home_1',
            source: 'desktop-personal-home',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
        }])).toBeNull();
    });

    it('migrates a persisted identity-bearing legacy Personal Home source to the scalar once', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = seedServerState(scope, {
            activeServerId: 'personal-home',
            servers: {
                'personal-home': {
                    id: 'personal-home',
                    name: 'Personal Home',
                    serverUrl: 'http://127.0.0.1:3005',
                    serverIdentityId: 'srv_personal_home_1',
                    source: 'desktop-personal-home',
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                },
            },
        });
        const profiles = await importFresh();

        const rawBeforeRead = storage.getString('server-state-v1');
        const migrated = profiles.listServerProfiles().find(
            (profile) => profile.serverIdentityId === 'srv_personal_home_1',
        );
        expect(migrated).toMatchObject({
            source: 'desktop-personal-home',
            personalHomeBootstrapCompleted: true,
        });
        expect(storage.getString('server-state-v1')).toBe(rawBeforeRead);

        await profiles.setServerProfileIdentityForUrl(
            migrated!.serverUrl,
            migrated!.serverIdentityId,
        );
        expect(readPersistedBlob(storage).servers?.['personal-home']).toMatchObject({
            personalHomeBootstrapCompleted: true,
        });

        const persistedAfterMigration = storage.getString('server-state-v1');
        profiles.listServerProfiles();
        expect(storage.getString('server-state-v1')).toBe(persistedAfterMigration);
    });

    it('adopts the verified identity and completion scalar in one profile-owner mutation', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const emissions: Array<readonly import('./serverProfiles').ServerProfile[]> = [];
        const unsubscribe = profiles.subscribeServerProfiles(() => emissions.push(profiles.listServerProfiles()));

        const completed = await profiles.adoptPersonalHomeProfileAndComplete({
            descriptor: {
                serverUrl: 'http://127.0.0.1:3005',
                canonicalServerUrl: 'http://127.0.0.1:3005',
                homeServerIdentityId: 'srv_personal_home_1',
            },
            source: 'desktop-personal-home',
            preserveUserLabel: true,
        });
        unsubscribe();

        expect(completed).toMatchObject({
            serverIdentityId: 'srv_personal_home_1',
            source: 'desktop-personal-home',
            personalHomeBootstrapCompleted: true,
        });
        expect(emissions).toHaveLength(1);
        expect(emissions[0]?.find(
            (profile) => profile.serverIdentityId === 'srv_personal_home_1',
        )).toMatchObject({ personalHomeBootstrapCompleted: true });
    });

    it('preserves completed bootstrap for the same identity when later adoption changes source', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        await profiles.adoptPersonalHomeProfileAndComplete({
            descriptor: {
                serverUrl: 'http://127.0.0.1:3005',
                canonicalServerUrl: 'http://127.0.0.1:3005',
                homeServerIdentityId: 'srv_personal_home_1',
            },
            source: 'desktop-personal-home',
        });

        const readopted = await profiles.adoptHomeProfile({
            descriptor: {
                serverUrl: 'http://127.0.0.1:3005',
                canonicalServerUrl: 'http://127.0.0.1:3005',
                homeServerIdentityId: 'srv_personal_home_1',
            },
            source: 'manual',
        });

        expect(readopted).toMatchObject({
            source: 'manual',
            personalHomeBootstrapCompleted: true,
        });
    });

    it('never transfers completed bootstrap across identities that share a URL', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        seedServerState(scope, {
            activeServerId: 'personal-home',
            servers: {
                'personal-home': {
                    id: 'personal-home',
                    name: 'Personal Home',
                    serverUrl: 'http://127.0.0.1:3005',
                    canonicalServerUrl: 'http://127.0.0.1:3005',
                    serverIdentityId: 'srv_personal_home_1',
                    source: 'manual',
                    personalHomeBootstrapCompleted: true,
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                },
                'different-home': {
                    id: 'different-home',
                    name: 'Different Home',
                    serverUrl: 'http://127.0.0.1:3005',
                    canonicalServerUrl: 'http://127.0.0.1:3005',
                    serverIdentityId: 'srv_different_home_2',
                    source: 'manual',
                    createdAt: 2,
                    updatedAt: 2,
                    lastUsedAt: 2,
                },
            },
        });
        const profiles = await importFresh();

        const loaded = profiles.listServerProfiles();
        expect(loaded.find(
            (profile) => profile.serverIdentityId === 'srv_personal_home_1',
        )).toMatchObject({ personalHomeBootstrapCompleted: true });
        expect(loaded.find(
            (profile) => profile.serverIdentityId === 'srv_different_home_2',
        )).not.toHaveProperty('personalHomeBootstrapCompleted');
    });

    function homeAState(): Record<string, unknown> {
        return {
            activeServerId: 'home-a',
            activeServerIdIsExplicit: true,
            servers: {
                'home-a': {
                    id: 'home-a',
                    name: 'Home A',
                    serverUrl: 'https://home-a.example.test',
                    serverIdentityId: 'srv_home_a_marker_1',
                    source: 'manual',
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                },
                'home-b': {
                    id: 'home-b',
                    name: 'Home B',
                    serverUrl: 'https://home-b.example.test',
                    serverIdentityId: 'srv_home_b_marker_1',
                    source: 'manual',
                    createdAt: 2,
                    updatedAt: 2,
                    lastUsedAt: 2,
                },
            },
            accountServiceEndpoint: { url: 'https://accounts.example.test', source: 'user' },
        };
    }

    it('retains an initialized v1 group target whose members are not adopted yet', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = seedServerState(scope, {
            ...homeAState(),
            homeViewStateInitialized: true,
            homeViewState: {
                version: 1,
                groups: [{ id: 'homes', name: 'Homes', serverIds: ['missing-home'] }],
                activeTargetKind: 'group',
                activeTargetId: 'homes',
            },
        });
        const profiles = await importFresh();

        const loaded = profiles.loadHomeViewState();
        if (!loaded) throw new Error('expected initialized Home-view state');
        expect(loaded).toEqual({
            version: 1,
            groups: [{ id: 'homes', name: 'Homes', serverIds: ['missing-home'], presentation: 'grouped' }],
            activeTargetKind: 'group',
            activeTargetId: 'homes',
        });
        await profiles.saveHomeViewState(loaded);
        expect(readPersistedBlob(storage).homeViewState).toMatchObject({
            groups: [{ id: 'homes', serverIds: ['missing-home'] }],
            activeTargetKind: 'group',
            activeTargetId: 'homes',
        });
    });

    it('drops an initialized v1 group target that no longer names an existing group', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        seedServerState(scope, {
            ...homeAState(),
            homeViewStateInitialized: true,
            homeViewState: {
                version: 1,
                groups: [{ id: 'homes', name: 'Homes', serverIds: ['srv_home_a_marker_1'] }],
                activeTargetKind: 'group',
                activeTargetId: 'gone',
            },
        });
        const profiles = await importFresh();

        expect(profiles.loadHomeViewState()).toEqual({
            version: 1,
            groups: [{ id: 'homes', name: 'Homes', serverIds: ['srv_home_a_marker_1'], presentation: 'grouped' }],
            activeTargetKind: 'server',
            activeTargetId: 'srv_home_a_marker_1',
        });
    });

    it('repairs an initialized corrupt HomeView payload to the focused fallback instead of re-running scoped migration', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = seedServerState(scope, {
            ...homeAState(),
            homeViewStateInitialized: true,
            homeViewState: { version: 2, groups: 'corrupt', activeTargetKind: 'bogus' },
        });
        const profiles = await importFresh();

        const repaired = await profiles.migrateHomeViewStateFromSettings({
            serverSelectionGroups: [{ id: 'stale', name: 'Stale', serverIds: ['home-b'] }],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: 'home-b',
        });

        // Normalized focused fallback (focused profile A scope id); the stale scoped
        // B/group values must never be consulted once the initialization marker exists.
        expect(repaired).toEqual({
            version: 1,
            groups: [],
            activeTargetKind: 'server',
            activeTargetId: 'srv_home_a_marker_1',
        });
        const second = await profiles.migrateHomeViewStateFromSettings({
            serverSelectionGroups: [{ id: 'stale-2', name: 'Stale 2', serverIds: ['home-b'] }],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'stale-2',
        });
        expect(second).toEqual(repaired);

        const persisted = readPersistedBlob(storage);
        expect(persisted.homeViewStateInitialized).toBe(true);
        expect(persisted.homeViewState).toEqual(repaired);
        expect(Object.keys(persisted.servers ?? {})).toEqual(expect.arrayContaining(['home-a', 'home-b']));
        expect(persisted.accountServiceEndpoint).toMatchObject({ url: 'https://accounts.example.test' });
        expect(persisted.activeServerId).toBe('home-a');
    });

    it('keeps preflight adoption read-only while a HomeView marker repair is pending', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = seedServerState(scope, {
            ...homeAState(),
            homeViewStateInitialized: true,
            homeViewState: { version: 2, groups: 'corrupt', activeTargetKind: 'bogus' },
        });
        const profiles = await importFresh();
        const rawBefore = storage.getString('server-state-v1');

        expect(profiles.preflightHomeProfileAdoption({
            source: 'account-directory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_preflight_marker_1',
                canonicalServerUrl: 'https://new-marker.example.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://new-marker.example.test' }],
            },
        })).toEqual({
            canonicalServerUrl: 'https://new-marker.example.test',
            serverIdentityId: 'srv_preflight_marker_1',
            credentialWrite: 'required',
        });
        expect(storage.getString('server-state-v1')).toBe(rawBefore);

        // Ordinary loads expose the canonical projection without rewriting raw state.
        const repaired = profiles.loadHomeViewState();
        expect(repaired).toEqual({
            version: 1,
            groups: [],
            activeTargetKind: 'server',
            activeTargetId: 'srv_home_a_marker_1',
        });
        expect(storage.getString('server-state-v1')).toBe(rawBefore);

        // The next successful explicit mutation owns the pending canonical repair,
        // even when its requested state is already the semantic projection.
        await profiles.saveHomeViewState(repaired!);
        const persisted = readPersistedBlob(storage);
        expect(persisted.homeViewStateInitialized).toBe(true);
        expect(persisted.homeViewState).toMatchObject({ activeTargetId: 'srv_home_a_marker_1' });
    });

    it('preserves a valid pre-marker HomeView without rewriting it until a successful explicit no-op mutation', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const validHomeView = {
            version: 1,
            groups: [{ id: 'homes', name: 'Homes', serverIds: ['srv_home_a_marker_1'], presentation: 'grouped' }],
            activeTargetKind: 'server',
            activeTargetId: 'srv_home_a_marker_1',
        } as const;
        const storage = seedServerState(scope, {
            ...homeAState(),
            homeViewState: validHomeView,
        });
        const profiles = await importFresh();

        const rawBeforeRead = storage.getString('server-state-v1');
        expect(profiles.loadHomeViewState()).toEqual(validHomeView);
        expect(storage.getString('server-state-v1')).toBe(rawBeforeRead);

        await profiles.saveHomeViewState(validHomeView);

        const persisted = readPersistedBlob(storage);
        expect(persisted.homeViewStateInitialized).toBe(true);
        expect(persisted.homeViewState).toEqual(validHomeView);
        expect(Object.keys(persisted.servers ?? {})).toEqual(expect.arrayContaining(['home-a', 'home-b']));
        expect(persisted.accountServiceEndpoint).toMatchObject({ url: 'https://accounts.example.test' });
    });

    it('keeps a marker-less store with an invalid HomeView payload eligible for one-time scoped migration', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = seedServerState(scope, {
            ...homeAState(),
            homeViewState: { version: 9, groups: [] },
        });
        const profiles = await importFresh();

        // Still eligible: a read alone must neither initialize nor write.
        expect(profiles.loadHomeViewState()).toBeNull();

        const migrated = await profiles.migrateHomeViewStateFromSettings({
            serverSelectionGroups: [{ id: 'homes', name: 'Homes', serverIds: ['home-a'] }],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: 'home-a',
        });
        expect(migrated).toMatchObject({
            activeTargetKind: 'server',
            activeTargetId: 'srv_home_a_marker_1',
        });

        const persisted = readPersistedBlob(storage);
        expect(persisted.homeViewStateInitialized).toBe(true);
        expect(persisted.homeViewState).toMatchObject({ activeTargetId: 'srv_home_a_marker_1' });
        expect(Object.keys(persisted.servers ?? {})).toEqual(expect.arrayContaining(['home-a', 'home-b']));
    });

    it('rewrites device-global Home selection when a profile acquires its stable identity', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://identity.example.test', source: 'manual' });
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'homes', name: 'Homes', serverIds: [home.id] }],
            activeTargetKind: 'server',
            activeTargetId: home.id,
        });

        await profiles.setServerProfileIdentityForUrl(home.serverUrl, 'srv_home_identity_123');

        expect(profiles.loadHomeViewState()).toMatchObject({
            groups: [{ id: 'homes', name: 'Homes', serverIds: ['srv_home_identity_123'] }],
            activeTargetKind: 'server',
            activeTargetId: 'srv_home_identity_123',
        });
    });

    it('removes a forgotten Home from device-global groups and clears its explicit target', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const first = await profiles.upsertServerProfile({ serverUrl: 'https://first-home.example.test', source: 'manual' });
        const second = await profiles.upsertServerProfile({ serverUrl: 'https://second-home.example.test', source: 'manual' });
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'homes', name: 'Homes', serverIds: [first.id, second.id] }],
            activeTargetKind: 'server',
            activeTargetId: second.id,
        });
        const focusedHomeId = profiles.getActiveServerSnapshot().serverId;

        await profiles.removeServerProfile(second.id);

        expect(profiles.loadHomeViewState()).toMatchObject({
            groups: [{ id: 'homes', name: 'Homes', serverIds: [first.id] }],
            activeTargetKind: 'server',
            activeTargetId: focusedHomeId,
        });
    });

    it('prunes only the explicitly removed Home and keeps other unadopted members', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const first = await profiles.upsertServerProfile({ serverUrl: 'https://kept-home.example.test', source: 'manual' });
        const second = await profiles.upsertServerProfile({ serverUrl: 'https://forgotten-home.example.test', source: 'manual' });
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'homes', name: 'Homes', serverIds: [first.id, second.id, 'srv_not_adopted_yet_1'] }],
            activeTargetKind: 'group',
            activeTargetId: 'homes',
        });

        await profiles.removeServerProfile(second.id);

        expect(profiles.loadHomeViewState()).toMatchObject({
            groups: [{ id: 'homes', name: 'Homes', serverIds: [first.id, 'srv_not_adopted_yet_1'] }],
            activeTargetKind: 'group',
            activeTargetId: 'homes',
        });
    });

    it('keeps virtual All Homes while two Homes remain and falls back when only one remains', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const { ALL_HOMES_SELECTION_TARGET_ID } = await import('./selection/allHomesSelectionTarget');
        for (const seeded of profiles.listServerProfiles()) await profiles.removeServerProfile(seeded.id);
        const homes = await Promise.all([
            profiles.upsertServerProfile({ serverUrl: 'https://all-a.example.test' }),
            profiles.upsertServerProfile({ serverUrl: 'https://all-b.example.test' }),
            profiles.upsertServerProfile({ serverUrl: 'https://all-c.example.test' }),
        ]);
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'custom', name: 'Custom', serverIds: homes.map((home) => home.id) }],
            activeTargetKind: 'group',
            activeTargetId: ALL_HOMES_SELECTION_TARGET_ID,
        });

        await profiles.removeServerProfile(homes[2]!.id);
        expect(profiles.loadHomeViewState()).toMatchObject({
            groups: [{ id: 'custom', name: 'Custom', serverIds: homes.slice(0, 2).map((home) => home.id) }],
            activeTargetKind: 'group',
            activeTargetId: ALL_HOMES_SELECTION_TARGET_ID,
        });

        await profiles.removeServerProfile(homes[1]!.id);
        expect(profiles.loadHomeViewState()).toMatchObject({
            groups: [{ id: 'custom', name: 'Custom', serverIds: [homes[0]!.id] }],
            activeTargetKind: 'server',
            activeTargetId: homes[0]!.id,
        });
    });

    it('keeps Account Service endpoint separate and adopts strict Home descriptors without focus changes', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const initial = profiles.getActiveServerSnapshot();
        await profiles.setAccountServiceEndpoint({ url: 'https://accounts.example.test', source: 'user' });
        expect(profiles.getAccountServiceEndpointSnapshot()?.url).toBe('https://accounts.example.test');
        const adopted = await profiles.adoptHomeProfile({
            source: 'account-directory',
            preserveUserLabel: true,
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_identity_123',
                canonicalServerUrl: 'https://home.example.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
            },
        });
        expect(adopted.serverIdentityId).toBe('srv_home_identity_123');
        expect(profiles.getAccountServiceEndpointSnapshot()?.url).toBe('https://accounts.example.test');
        expect(profiles.getActiveServerSnapshot().serverId).toBe(initial.serverId);
    });

    it('resolves the owner-defined Happier Cloud sign-in service before any explicit selection', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();

        expect(profiles.getAccountServiceEndpointSnapshot()).toBeNull();
        const fallback = profiles.resolveSelectedAccountServiceEndpoint();
        expect(fallback).toEqual({
            url: profiles.HAPPIER_CLOUD_SERVER_URL,
            displayName: 'Happier Cloud',
            source: 'default',
        });
        // Referential stability is load-bearing: unauthenticated entry reads this through
        // `useSyncExternalStore`, which re-renders forever on a fresh object per call.
        expect(profiles.resolveSelectedAccountServiceEndpoint()).toBe(fallback);

        await profiles.setAccountServiceEndpoint({ url: 'https://accounts.example.test', source: 'user' });
        expect(profiles.resolveSelectedAccountServiceEndpoint()).toMatchObject({
            url: 'https://accounts.example.test',
            source: 'user',
        });
    });

    it('normalizes Account Service endpoint identity consistently for writes and persisted reads', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        const profiles = await importFresh();

        const invalidUrls = [
            'https://user:pass@accounts.example.test',
            'https://accounts.example.test?tenant=other',
            'https://accounts.example.test#other',
        ];
        for (const url of invalidUrls) {
            expect(() => profiles.setAccountServiceEndpoint({ url, source: 'user' })).toThrow(
                'Invalid Account Service endpoint',
            );

            storage.set('server-state-v1', JSON.stringify({
                servers: {},
                accountServiceEndpoint: { url, source: 'user' },
            }));
            expect(profiles.getAccountServiceEndpointSnapshot()).toBeNull();
        }

        await profiles.setAccountServiceEndpoint({
            url: 'https://accounts.example.test/base///',
            source: 'user',
        });
        expect(profiles.getAccountServiceEndpointSnapshot()).toEqual({
            url: 'https://accounts.example.test/base',
            source: 'user',
        });

        storage.set('server-state-v1', JSON.stringify({
            servers: {},
            accountServiceEndpoint: {
                url: 'https://accounts.example.test/persisted///',
                source: 'default',
            },
        }));
        expect(profiles.getAccountServiceEndpointSnapshot()).toEqual({
            url: 'https://accounts.example.test/persisted',
            source: 'default',
        });
    });

    it('rejects the never-released configured Account Service source on read and write without changing Homes', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        seedServerState(scope, {
            ...homeAState(),
            accountServiceEndpoint: { url: 'https://obsolete.example.test', source: 'configured' },
        });
        const profiles = await importFresh();
        const focus = profiles.getActiveServerSnapshot();
        const homes = profiles.listServerProfiles();
        expect(profiles.getAccountServiceEndpointSnapshot()).toBeNull();
        await profiles.setAccountServiceEndpoint({ url: 'https://accounts.example.test', source: 'user' });
        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        const before = storage.getString('server-state-v1');
        expect(() => profiles.setAccountServiceEndpoint({
            url: 'https://obsolete.example.test',
            // Simulates an untyped persisted/external caller of the public writer.
            source: 'configured' as never,
        })).toThrow('Invalid Account Service endpoint');
        expect(storage.getString('server-state-v1')).toBe(before);
        expect(profiles.getAccountServiceEndpointSnapshot()).toEqual({ url: 'https://accounts.example.test', source: 'user' });
        expect(profiles.getActiveServerSnapshot()).toEqual(focus);
        expect(profiles.listServerProfiles()).toEqual(homes);
    });

    it('publishes a newly adopted strict Home exactly once with its complete descriptor-backed profile', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const focused = await profiles.upsertServerProfile({
            serverUrl: 'https://focused.example.test',
            name: 'Focused Home',
            source: 'manual',
        });
        await profiles.setActiveServerId(focused.id, { scope: 'device' });
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'homes', name: 'Homes', serverIds: [focused.id] }],
            activeTargetKind: 'group',
            activeTargetId: 'homes',
        });
        const focusBefore = profiles.getActiveServerSnapshot();
        const homeViewBefore = profiles.loadHomeViewState();
        const publications: Array<{
            generation: number;
            adopted: ReturnType<typeof profiles.getServerProfileById>;
            focus: ReturnType<typeof profiles.getActiveServerSnapshot>;
            homeView: ReturnType<typeof profiles.loadHomeViewState>;
        }> = [];
        const activePublications: ReturnType<typeof profiles.getActiveServerSnapshot>[] = [];
        const homeViewPublications: ReturnType<typeof profiles.loadHomeViewState>[] = [];
        let adoptedId = '';
        const unsubscribers = [
            profiles.subscribeServerProfiles((generation) => {
                const adopted = profiles.listServerProfiles().find(
                    (profile) => profile.serverIdentityId === 'srv_atomic_adoption_1'
                        || profile.serverUrl === 'https://atomic.example.test',
                ) ?? null;
                adoptedId = adopted?.id ?? adoptedId;
                publications.push({
                    generation,
                    adopted,
                    focus: profiles.getActiveServerSnapshot(),
                    homeView: profiles.loadHomeViewState(),
                });
            }),
            profiles.subscribeActiveServer((snapshot) => activePublications.push(snapshot)),
            profiles.subscribeHomeViewState(() => {
                homeViewPublications.push(profiles.loadHomeViewState());
            }),
        ];

        const adopted = await profiles.adoptHomeProfile({
            source: 'account-directory',
            preserveUserLabel: true,
            suggestedName: 'Atomic Home',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_atomic_adoption_1',
                canonicalServerUrl: 'https://atomic.example.test',
                revision: 12,
                endpoints: [
                    {
                        kind: 'iroh',
                        endpointId: 'a'.repeat(64),
                        relayUrls: ['https://relay.atomic.example.test'],
                        directAddresses: ['192.0.2.12:443'],
                    },
                    { kind: 'https', url: 'https://public.atomic.example.test' },
                ],
            },
        });
        for (const unsubscribe of unsubscribers) unsubscribe();

        expect(adoptedId).toBe(adopted.id);
        expect(publications).toHaveLength(1);
        expect(publications[0]?.adopted).toMatchObject({
            id: adopted.id,
            name: 'Atomic Home',
            serverUrl: 'https://atomic.example.test',
            canonicalServerUrl: 'https://atomic.example.test',
            publicServerUrl: 'https://public.atomic.example.test',
            serverIdentityId: 'srv_atomic_adoption_1',
            source: 'account-directory',
            homeConnectionDescriptor: {
                revision: 12,
                endpoints: expect.arrayContaining([{ kind: 'iroh',
                endpointId: 'a'.repeat(64),
                relayUrls: ['https://relay.atomic.example.test'],
                directAddresses: ['192.0.2.12:443'],
            }]),
            },
        });
        expect(publications[0]?.adopted?.createdAt).toBeGreaterThan(0);
        expect(publications[0]?.adopted?.updatedAt).toBeGreaterThan(0);
        expect(publications[0]?.focus).toMatchObject({
            serverId: focusBefore.serverId,
            serverUrl: focusBefore.serverUrl,
            isSelectionExplicit: focusBefore.isSelectionExplicit,
        });
        expect(publications[0]?.homeView).toEqual(homeViewBefore);
        expect(activePublications).toHaveLength(0);
        expect(homeViewPublications).toHaveLength(0);
        expect(profiles.getActiveServerSnapshot()).toBe(focusBefore);
        expect(profiles.loadHomeViewState()).toEqual(homeViewBefore);
    });

    it('discards an Account Service endpoint with a malformed present identity while tolerating absence and future fields', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        storage.set('server-state-v1', JSON.stringify({
            servers: {},
            accountServiceEndpoint: {
                url: 'https://accounts-invalid.example.test',
                serverIdentityId: 'not-a-server-identity',
                source: 'user',
            },
        }));
        const profiles = await importFresh();
        expect(profiles.getAccountServiceEndpointSnapshot()).toBeNull();

        storage.set('server-state-v1', JSON.stringify({
            servers: {},
            accountServiceEndpoint: {
                url: 'https://accounts-valid.example.test',
                source: 'user',
                futurePresentationHint: 'ignored',
            },
        }));
        expect(profiles.getAccountServiceEndpointSnapshot()).toEqual({
            url: 'https://accounts-valid.example.test',
            source: 'user',
        });
    });

    it('records the requested Personal Home source when adopting an existing URL profile', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const existing = await profiles.upsertServerProfile({
            serverUrl: 'http://127.0.0.1:43123',
            source: 'preconfigured',
        });

        const adopted = await profiles.adoptHomeProfile({
            source: 'desktop-personal-home',
            preserveUserLabel: true,
            descriptor: {
                serverUrl: existing.serverUrl,
                canonicalServerUrl: existing.serverUrl,
                homeServerIdentityId: 'personal-home-identity-1',
            },
        });

        expect(adopted.id).toBe(existing.id);
        expect(adopted.source).toBe('desktop-personal-home');
        expect(profiles.getServerProfileById(existing.id)?.source).toBe('desktop-personal-home');
    });

    it('migrates legacy Personal Home provenance to identity-bound completion and lets later adoption update provenance', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = seedServerState(scope, {
            activeServerId: 'personal-home',
            servers: {
                'personal-home': {
                    id: 'personal-home',
                    name: 'Personal Home',
                    serverUrl: 'http://127.0.0.1:43123',
                    serverIdentityId: 'srv_personal_home_sticky_source',
                    source: 'desktop-personal-home',
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                },
            },
        });
        const profiles = await importFresh();

        const rawBeforeRead = storage.getString('server-state-v1');
        const migrated = profiles.listServerProfiles();
        expect(migrated).toContainEqual(expect.objectContaining({
            id: 'personal-home',
            source: 'desktop-personal-home',
            serverIdentityId: 'srv_personal_home_sticky_source',
            personalHomeBootstrapCompleted: true,
        }));
        expect(storage.getString('server-state-v1')).toBe(rawBeforeRead);
        await profiles.setServerProfileIdentityForUrl(
            migrated[0]!.serverUrl,
            migrated[0]!.serverIdentityId,
        );
        expect(readPersistedBlob(storage).servers?.['personal-home']).toMatchObject({
            personalHomeBootstrapCompleted: true,
        });

        const readopted = await profiles.adoptHomeProfile({
            source: 'qr',
            preserveUserLabel: true,
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_personal_home_sticky_source',
                canonicalServerUrl: 'http://127.0.0.1:43123',
                revision: 2,
                endpoints: [{ kind: 'https', url: 'http://127.0.0.1:43123' }],
            },
        });
        const upserted = await profiles.upsertServerProfile({
            serverUrl: 'http://127.0.0.1:43123',
            source: 'manual',
        });
        const directoryReadopted = await profiles.adoptHomeProfile({
            source: 'account-directory',
            preserveUserLabel: true,
            descriptor: {
                v: 1,
                canonicalServerUrl: 'http://127.0.0.1:43123',
                homeServerIdentityId: 'srv_personal_home_sticky_source',
                revision: 3,
                endpoints: [{ kind: 'https', url: 'http://127.0.0.1:43123' }],
            },
        });

        expect(readopted.source).toBe('qr');
        expect(readopted.personalHomeBootstrapCompleted).toBe(true);
        expect(upserted.source).toBe('manual');
        expect(upserted.personalHomeBootstrapCompleted).toBe(true);
        expect(directoryReadopted.source).toBe('account-directory');
        expect(directoryReadopted.personalHomeBootstrapCompleted).toBe(true);
    });

    it('adopts completion only for the exact Home identity and never transfers it across a URL collision', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const personalHome = await profiles.adoptPersonalHomeProfileAndComplete({
            source: 'desktop-personal-home',
            preserveUserLabel: true,
            descriptor: {
                serverUrl: 'http://127.0.0.1:43123',
                canonicalServerUrl: 'http://127.0.0.1:43123',
                homeServerIdentityId: 'srv_personal_home_identity_a',
            },
        });
        expect(personalHome.personalHomeBootstrapCompleted).toBe(true);

        await expect(profiles.adoptHomeProfile({
            source: 'qr',
            preserveUserLabel: true,
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_personal_home_identity_b',
                canonicalServerUrl: 'http://127.0.0.1:43123',
                revision: 2,
                endpoints: [{ kind: 'https', url: 'http://127.0.0.1:43123' }],
            },
        })).rejects.toThrow('Home identity conflicts with URL');

        expect(profiles.getServerProfileById(personalHome.id)?.personalHomeBootstrapCompleted).toBe(true);

        await profiles.removeServerProfile(personalHome.id);
        expect(profiles.getServerProfileById(personalHome.id)).toBeNull();
        expect(profiles.listServerProfiles().some((profile) => profile.personalHomeBootstrapCompleted === true)).toBe(false);
    });

    it('fails closed when persisted completion facts name more than one Home identity', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        seedServerState(scope, {
            servers: {
                one: {
                    id: 'one', name: 'One', serverUrl: 'http://127.0.0.1:43123',
                    serverIdentityId: 'srv_completed_one', personalHomeBootstrapCompleted: true,
                    createdAt: 1, updatedAt: 1, lastUsedAt: 1,
                },
                two: {
                    id: 'two', name: 'Two', serverUrl: 'http://127.0.0.1:43124',
                    serverIdentityId: 'srv_completed_two', personalHomeBootstrapCompleted: true,
                    createdAt: 1, updatedAt: 1, lastUsedAt: 1,
                },
            },
        });
        const profiles = await importFresh();

        expect(profiles.findPersonalHomeBootstrapCompletedProfile(profiles.listServerProfiles())).toBeNull();
    });

    it('makes an adopted local Home the implicit default only while no explicit selection exists', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        stubWebRuntime('null');
        const profiles = await importFresh();
        const preconfigured = await profiles.upsertServerProfile({
            serverUrl: 'https://preconfigured.example.test',
            source: 'preconfigured',
        });
        const personalHome = await profiles.upsertServerProfile({
            serverUrl: 'http://127.0.0.1:43123',
            source: 'desktop-personal-home',
        });

        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: preconfigured.id,
            isSelectionExplicit: false,
        });
        expect(await profiles.activateServerProfileIfSelectionImplicit(personalHome.id)).toBe(true);
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: personalHome.id,
            isSelectionExplicit: false,
        });

        await profiles.setActiveServerId(preconfigured.id, { scope: 'device' });
        expect(await profiles.activateServerProfileIfSelectionImplicit(personalHome.id)).toBe(false);
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: preconfigured.id,
            isSelectionExplicit: true,
        });
    });

    it('never replaces an explicit tab selection when activating an adopted local Home', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        stubWebRuntime('null');
        const profiles = await importFresh();
        const tabHome = await profiles.upsertServerProfile({
            serverUrl: 'https://tab-home.example.test',
            source: 'manual',
        });
        const personalHome = await profiles.upsertServerProfile({
            serverUrl: 'http://127.0.0.1:43123',
            source: 'desktop-personal-home',
        });
        await profiles.setActiveServerId(tabHome.id, { scope: 'tab' });

        expect(await profiles.activateServerProfileIfSelectionImplicit(personalHome.id)).toBe(false);
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: tabHome.id,
            isSelectionExplicit: true,
        });
    });

    it('ignores obsolete scalar transport authority when reading and merging persisted profiles', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const descriptor = {
            v: 1, homeServerIdentityId: 'srv_exact_owner_1',
            canonicalServerUrl: 'https://exact-owner.example.test', revision: 2,
            endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }],
        };
        seedServerState(scope, {
            activeServerId: 'exact',
            servers: {
                exact: { id: 'exact', name: 'Exact', serverUrl: descriptor.canonicalServerUrl,
                    serverIdentityId: descriptor.homeServerIdentityId, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
                    homeConnectionDescriptor: descriptor, connectionDescriptorRevision: 500,
                    irohEndpoint: { endpointId: 'b'.repeat(64) } },
                obsolete: { id: 'obsolete', name: 'Obsolete', serverUrl: descriptor.canonicalServerUrl,
                    serverIdentityId: descriptor.homeServerIdentityId, createdAt: 2, updatedAt: 2, lastUsedAt: 2,
                    connectionDescriptorRevision: 999, irohEndpoint: { endpointId: 'c'.repeat(64) } },
            },
        });
        const profiles = await importFresh();
        expect(profiles.getServerProfileById('exact')?.homeConnectionDescriptor).toEqual(descriptor);
        expect(profiles.getActiveServerSnapshot().connectionDescriptorRevision).toBe(2);
        const result = await profiles.reconcileServerProfileHomeConnectionDescriptor({
            serverUrl: descriptor.canonicalServerUrl,
            observedServerIdentityId: descriptor.homeServerIdentityId,
            descriptor: { ...descriptor, v: 1, revision: 3, endpoints: [{ kind: 'https', url: descriptor.canonicalServerUrl }] },
        });
        expect(result.kind).toBe('applied');
        const persisted = new MMKV({ id: scopedStorageId('server-profiles', scope) }).getString('server-state-v1')!;
        expect(persisted).not.toContain('connectionDescriptorRevision');
        expect(persisted).not.toContain('irohEndpoint');
    });

    it('preserves the Iroh endpoint sub-descriptor and revision through adoption and restart', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const irohDescriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_home_iroh_1',
            canonicalServerUrl: 'https://iroh.example.test',
            revision: 7,
            endpoints: [
                { kind: 'iroh' as const, endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'], directAddresses: ['192.0.2.10:443'] },
            ],
        };
        const adopted = await profiles.adoptHomeProfile({ source: 'qr', descriptor: irohDescriptor });
        const stored = profiles.getServerProfileById(adopted.id);
        expect(stored?.homeConnectionDescriptor?.endpoints.find((endpoint) => endpoint.kind === 'iroh')).toEqual({ kind: 'iroh',
            endpointId: 'a'.repeat(64),
            relayUrls: ['https://relay.example.test'],
            directAddresses: ['192.0.2.10:443'],
        });
        expect(stored?.homeConnectionDescriptor?.revision).toBe(7);
        // The canonical URL is the stable identity: adoption never substitutes an
        // Iroh transport detail (endpoint id, relay, or loopback origin) for it.
        expect(stored?.serverUrl).toBe('https://iroh.example.test');
        expect(stored?.canonicalServerUrl).toBe('https://iroh.example.test');

        // A newer descriptor revision updates transport hints and revision in place.
        await profiles.adoptHomeProfile({
            source: 'account-directory',
            descriptor: {
                ...irohDescriptor,
                revision: 8,
                endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64), directAddresses: ['192.0.2.11:443'] }],
            },
        });
        const updated = profiles.getServerProfileById(adopted.id);
        expect(updated?.homeConnectionDescriptor?.revision).toBe(8);
        expect(updated?.homeConnectionDescriptor?.endpoints.find((endpoint) => endpoint.kind === 'iroh')).toEqual({ kind: 'iroh', endpointId: 'a'.repeat(64), directAddresses: ['192.0.2.11:443'] });
        expect(updated?.serverUrl).toBe('https://iroh.example.test');

        // A descriptor without an Iroh endpoint clears the stale transport identity.
        await profiles.adoptHomeProfile({
            source: 'account-directory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_iroh_1',
                canonicalServerUrl: 'https://iroh.example.test',
                revision: 9,
                endpoints: [{ kind: 'https', url: 'https://iroh.example.test' }],
            },
        });
        const cleared = profiles.getServerProfileById(adopted.id);
        expect(cleared?.homeConnectionDescriptor?.endpoints.find((endpoint) => endpoint.kind === 'iroh')).toBeUndefined();
        expect(cleared?.homeConnectionDescriptor?.revision).toBe(9);
    });

    it('preserves the adopted Iroh endpoint and revision when a profile is upserted again', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const adopted = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_upsert_iroh_1',
                canonicalServerUrl: 'https://upsert.example.test',
                revision: 5,
                endpoints: [{ kind: 'iroh', endpointId: 'e'.repeat(64), relayUrls: ['https://relay.example.test'] }],
            },
        });

        await profiles.upsertServerProfile({ serverUrl: adopted.serverUrl, source: 'manual' });

        const stored = profiles.getServerProfileById(adopted.id);
        expect(stored?.homeConnectionDescriptor?.endpoints.find((endpoint) => endpoint.kind === 'iroh')).toEqual({ kind: 'iroh', endpointId: 'e'.repeat(64), relayUrls: ['https://relay.example.test'] });
        expect(stored?.homeConnectionDescriptor?.revision).toBe(5);
    });

    it('never lets a stale descriptor revision replace newer profile and transport facts', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const irohDescriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_home_stale_1',
            canonicalServerUrl: 'https://stale.example.test',
            revision: 9,
            endpoints: [
                { kind: 'iroh' as const, endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'], directAddresses: ['192.0.2.10:443'] },
                { kind: 'https' as const, url: 'https://public-current.example.test' },
            ],
        };
        const adopted = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: irohDescriptor,
            suggestedName: 'Trusted Home',
        });

        // An older descriptor without an Iroh endpoint is not authoritative:
        // it can neither clear the newer transport identity nor roll the
        // revision back.
        await profiles.adoptHomeProfile({
            source: 'account-directory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_stale_1',
                canonicalServerUrl: 'https://stale-directory.example.test',
                revision: 8,
                endpoints: [{ kind: 'https', url: 'https://public-stale.example.test' }],
            },
            preserveUserLabel: true,
            suggestedName: 'Stale Directory Label',
        });
        const stale = profiles.getServerProfileById(adopted.id);
        expect(stale?.homeConnectionDescriptor?.endpoints.find((endpoint) => endpoint.kind === 'iroh')).toEqual({ kind: 'iroh',
            endpointId: 'a'.repeat(64),
            relayUrls: ['https://relay.example.test'],
            directAddresses: ['192.0.2.10:443'],
        });
        expect(stale?.homeConnectionDescriptor?.revision).toBe(9);
        expect(stale).toMatchObject({
            serverIdentityId: 'srv_home_stale_1',
            serverUrl: 'https://stale.example.test',
            canonicalServerUrl: 'https://stale.example.test',
            publicServerUrl: 'https://public-current.example.test',
            source: 'qr',
            name: 'Trusted Home',
        });

        // The same stale revision also cannot swap in its own older endpoint.
        await profiles.adoptHomeProfile({
            source: 'account-directory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_stale_1',
                canonicalServerUrl: 'https://stale.example.test',
                revision: 7,
                endpoints: [{ kind: 'iroh', endpointId: 'c'.repeat(64) }],
            },
        });
        const stillNewer = profiles.getServerProfileById(adopted.id);
        expect(stillNewer?.homeConnectionDescriptor?.endpoints.find((endpoint) => endpoint.kind === 'iroh')).toEqual({ kind: 'iroh',
            endpointId: 'a'.repeat(64),
            relayUrls: ['https://relay.example.test'],
            directAddresses: ['192.0.2.10:443'],
        });
        expect(stillNewer?.homeConnectionDescriptor?.revision).toBe(9);
    });

    it('rejects an equal descriptor revision when canonical descriptor facts diverge', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const adopted = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_equal_revision_1',
                canonicalServerUrl: 'https://equal-revision.example.test',
                revision: 8,
                endpoints: [
                    { kind: 'iroh', endpointId: 'a'.repeat(64), directAddresses: ['192.0.2.80:443'] },
                    { kind: 'https', url: 'https://public-current.example.test' },
                ],
            },
        });

        await expect(profiles.adoptHomeProfile({
            source: 'account-directory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_equal_revision_1',
                canonicalServerUrl: 'https://equal-revision.example.test',
                revision: 8,
                endpoints: [
                    { kind: 'iroh', endpointId: 'b'.repeat(64), directAddresses: ['192.0.2.81:443'] },
                    { kind: 'https', url: 'https://public-conflict.example.test' },
                ],
            },
        })).rejects.toMatchObject({ code: 'equal_revision_conflict' });

        expect(profiles.getServerProfileById(adopted.id)).toMatchObject({
            homeConnectionDescriptor: {
                revision: 8,
                endpoints: expect.arrayContaining([{ kind: 'iroh',
                endpointId: 'a'.repeat(64),
                directAddresses: ['192.0.2.80:443'],
            }]),
            },
            publicServerUrl: 'https://public-current.example.test',
        });
    });

    it('commits unrelated adoption before notifying independent profile observers only', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const laterProfileObserver = vi.fn();
        const laterActiveObserver = vi.fn();
        const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const unsubscribers = [
            profiles.subscribeServerProfiles(() => {
                throw new Error('profile observer failed');
            }),
            profiles.subscribeServerProfiles(laterProfileObserver),
            profiles.subscribeActiveServer(() => {
                throw new Error('active observer failed');
            }),
            profiles.subscribeActiveServer(laterActiveObserver),
        ];

        try {
            const adopted = await profiles.adoptHomeProfile({
                source: 'qr',
                descriptor: {
                    v: 1,
                    homeServerIdentityId: 'srv_observer_commit_1',
                    canonicalServerUrl: 'https://observer-commit.example.test',
                    revision: 1,
                    endpoints: [{ kind: 'https', url: 'https://observer-commit.example.test' }],
                },
            });

            expect(profiles.getServerProfileById(adopted.id)).toMatchObject({
                serverIdentityId: 'srv_observer_commit_1',
                homeConnectionDescriptor: {
                    revision: 1,
                },
            });
            expect(laterProfileObserver).toHaveBeenCalledOnce();
            expect(laterActiveObserver).not.toHaveBeenCalled();
            expect(reported).toHaveBeenCalledTimes(1);
        } finally {
            for (const unsubscribe of unsubscribers) unsubscribe();
            reported.mockRestore();
        }
    });

    it('reconciles an ordinary trusted feature descriptor through the existing profile owner', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const created = await profiles.upsertServerProfile({
            serverUrl: 'https://refresh.example.test',
            name: 'User Label',
            source: 'manual',
        });
        await profiles.setServerProfileIdentityForUrl(created.serverUrl, 'srv_refresh_home_1');
        await profiles.setActiveServerId(created.id, { scope: 'device' });
        await profiles.saveHomeViewState({
            version: 1,
            activeTargetKind: 'server',
            activeTargetId: 'srv_refresh_home_1',
            groups: [{ id: 'homes', name: 'Homes', serverIds: ['srv_refresh_home_1'], presentation: 'grouped' }],
        });

        const applied = await profiles.reconcileServerProfileHomeConnectionDescriptor({
            serverUrl: created.serverUrl,
            observedServerIdentityId: 'srv_refresh_home_1',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_refresh_home_1',
                canonicalServerUrl: 'https://canonical-refresh.example.test',
                revision: 3,
                endpoints: [
                    {
                        kind: 'iroh',
                        endpointId: 'a'.repeat(64),
                        relayUrls: ['https://relay-refresh.example.test'],
                        directAddresses: ['192.0.2.90:443'],
                    },
                    { kind: 'https', url: 'https://public-refresh.example.test' },
                ],
            },
        });

        expect(applied.kind).toBe('applied');
        expect(profiles.getServerProfileById(created.id)).toMatchObject({
            id: created.id,
            name: 'User Label',
            source: 'manual',
            serverIdentityId: 'srv_refresh_home_1',
            serverUrl: 'https://canonical-refresh.example.test',
            canonicalServerUrl: 'https://canonical-refresh.example.test',
            publicServerUrl: 'https://public-refresh.example.test',
            homeConnectionDescriptor: {
                revision: 3,
                endpoints: expect.arrayContaining([{ kind: 'iroh',
                endpointId: 'a'.repeat(64),
                relayUrls: ['https://relay-refresh.example.test'],
                directAddresses: ['192.0.2.90:443'],
            }]),
            },
        });
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: 'srv_refresh_home_1',
            serverUrl: 'https://canonical-refresh.example.test',
            connectionDescriptorRevision: 3,
        });
        expect(profiles.loadHomeViewState()).toEqual({
            version: 1,
            activeTargetKind: 'server',
            activeTargetId: 'srv_refresh_home_1',
            groups: [{ id: 'homes', name: 'Homes', serverIds: ['srv_refresh_home_1'], presentation: 'grouped' }],
        });

        const identical = await profiles.reconcileServerProfileHomeConnectionDescriptor({
            serverUrl: 'https://canonical-refresh.example.test',
            observedServerIdentityId: 'srv_refresh_home_1',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_refresh_home_1',
                canonicalServerUrl: 'https://canonical-refresh.example.test',
                revision: 3,
                endpoints: [
                    {
                        kind: 'iroh',
                        endpointId: 'a'.repeat(64),
                        relayUrls: ['https://relay-refresh.example.test'],
                        directAddresses: ['192.0.2.90:443'],
                    },
                    { kind: 'https', url: 'https://public-refresh.example.test' },
                ],
            },
        });
        expect(identical.kind).toBe('unchanged');

        const equalConflict = await profiles.reconcileServerProfileHomeConnectionDescriptor({
            serverUrl: 'https://canonical-refresh.example.test',
            observedServerIdentityId: 'srv_refresh_home_1',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_refresh_home_1',
                canonicalServerUrl: 'https://canonical-refresh.example.test',
                revision: 3,
                endpoints: [{ kind: 'iroh', endpointId: 'c'.repeat(64) }],
            },
        });
        expect(equalConflict).toMatchObject({ kind: 'conflict', code: 'equal_revision_conflict' });

        const stale = await profiles.reconcileServerProfileHomeConnectionDescriptor({
            serverUrl: 'https://canonical-refresh.example.test',
            observedServerIdentityId: 'srv_refresh_home_1',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_refresh_home_1',
                canonicalServerUrl: 'https://stale-refresh.example.test',
                revision: 2,
                endpoints: [{ kind: 'https', url: 'https://stale-public.example.test' }],
            },
        });
        expect(stale.kind).toBe('stale');

        const identityConflict = await profiles.reconcileServerProfileHomeConnectionDescriptor({
            serverUrl: 'https://canonical-refresh.example.test',
            observedServerIdentityId: 'srv_refresh_home_1',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_other_home_1',
                canonicalServerUrl: 'https://canonical-refresh.example.test',
                revision: 4,
                endpoints: [{ kind: 'https', url: 'https://canonical-refresh.example.test' }],
            },
        });
        expect(identityConflict).toMatchObject({ kind: 'conflict', code: 'identity_mismatch' });
        expect(profiles.getServerProfileById(created.id)?.homeConnectionDescriptor?.revision).toBe(3);

        const endpointRemoved = await profiles.reconcileServerProfileHomeConnectionDescriptor({
            serverUrl: 'https://canonical-refresh.example.test',
            observedServerIdentityId: 'srv_refresh_home_1',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_refresh_home_1',
                canonicalServerUrl: 'https://canonical-refresh.example.test',
                revision: 4,
                endpoints: [{ kind: 'https', url: 'https://public-refresh.example.test' }],
            },
        });
        expect(endpointRemoved.kind).toBe('applied');
        expect(profiles.getServerProfileById(created.id)).toMatchObject({
            homeConnectionDescriptor: {
                revision: 4,
            },
            publicServerUrl: 'https://public-refresh.example.test',
        });
        expect(profiles.getServerProfileById(created.id)?.homeConnectionDescriptor?.endpoints.find((endpoint) => endpoint.kind === 'iroh')).toBeUndefined();
    });

    it('keeps privacy-reduced public descriptor observations from advancing an established private descriptor generation', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        await profiles.adoptHomeProfile({
            source: 'account-directory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_public_observation_1',
                canonicalServerUrl: 'https://public-observation.example.test',
                revision: 4,
                endpoints: [{
                    kind: 'iroh',
                    endpointId: 'a'.repeat(64),
                    relayUrls: ['https://relay-old.example.test'],
                    directAddresses: ['192.0.2.90:443'],
                }],
            },
        });

        const publicResult = await profiles.reconcileServerProfileHomeConnectionDescriptor({
            serverUrl: 'https://public-observation.example.test',
            observedServerIdentityId: 'srv_public_observation_1',
            observation: 'public',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_public_observation_1',
                canonicalServerUrl: 'https://public-observation.example.test',
                revision: 5,
                endpoints: [{
                    kind: 'iroh',
                    endpointId: 'a'.repeat(64),
                    relayUrls: ['https://relay-public.example.test'],
                }],
            },
        });

        expect(publicResult.kind).toBe('unchanged');
        expect(profiles.getServerProfileById('srv_public_observation_1')).toMatchObject({
            homeConnectionDescriptor: {
                revision: 4,
                endpoints: expect.arrayContaining([{ kind: 'iroh',
                endpointId: 'a'.repeat(64),
                relayUrls: ['https://relay-old.example.test'],
                directAddresses: ['192.0.2.90:443'],
            }]),
            },
        });

        const authenticatedResult = await profiles.reconcileServerProfileHomeConnectionDescriptor({
            serverUrl: 'https://public-observation.example.test',
            observedServerIdentityId: 'srv_public_observation_1',
            observation: 'exact',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_public_observation_1',
                canonicalServerUrl: 'https://public-observation.example.test',
                revision: 5,
                endpoints: [{
                    kind: 'iroh',
                    endpointId: 'a'.repeat(64),
                    relayUrls: ['https://relay-authenticated.example.test'],
                    directAddresses: ['192.0.2.91:443'],
                }],
            },
        });

        expect(authenticatedResult.kind).toBe('applied');
        expect(profiles.getServerProfileById('srv_public_observation_1')).toMatchObject({
            homeConnectionDescriptor: {
                revision: 5,
                endpoints: expect.arrayContaining([{ kind: 'iroh',
                endpointId: 'a'.repeat(64),
                relayUrls: ['https://relay-authenticated.example.test'],
                directAddresses: ['192.0.2.91:443'],
            }]),
            },
        });
    });

    it('preserves legacy profile metadata when learning identity and replaces a malformed persisted descriptor', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        storage.set('server-state-v1', JSON.stringify({
            activeServerId: 'persisted-home',
            servers: {
                'persisted-home': {
                    id: 'persisted-home',
                    name: 'User Renamed Home',
                    serverUrl: 'https://persisted.example.test',
                    shareableServerUrl: 'https://share-persisted.example.test',
                    shareableServerUrlValidatedAgainstServerUrl: 'https://persisted.example.test',
                    canonicalServerUrl: 'https://persisted.example.test',
                    publicServerUrl: 'https://public-persisted.example.test',
                    homeConnectionDescriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_persisted_home_1',
                        canonicalServerUrl: 'https://persisted.example.test',
                        revision: 8,
                        endpoints: [{ kind: 'iroh', endpointId: 'malformed' }],
                    },
                    legacyServerIds: ['legacy-persisted-home'],
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 2,
                    source: 'future-source',
                },
            },
        }));
        const profiles = await importFresh();

        await profiles.setServerProfileIdentityForUrl('https://persisted.example.test', 'srv_persisted_home_1');
        expect(profiles.getServerProfileById('srv_persisted_home_1')).toMatchObject({
            id: 'persisted-home',
            name: 'User Renamed Home',
            shareableServerUrl: 'https://share-persisted.example.test',
            shareableServerUrlValidatedAgainstServerUrl: 'https://persisted.example.test',
            canonicalServerUrl: 'https://persisted.example.test',
            publicServerUrl: 'https://public-persisted.example.test',
            legacyServerIds: ['legacy-persisted-home'],
            createdAt: 1,
            lastUsedAt: 2,
            source: 'legacy',
            legacySource: 'future-source',
        });
        expect(profiles.getServerProfileById('srv_persisted_home_1')?.homeConnectionDescriptor).toBeUndefined();

        const repaired = await profiles.reconcileServerProfileHomeConnectionDescriptor({
            serverUrl: 'https://persisted.example.test',
            observedServerIdentityId: 'srv_persisted_home_1',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_persisted_home_1',
                canonicalServerUrl: 'https://persisted.example.test',
                revision: 9,
                endpoints: [{ kind: 'iroh', endpointId: 'b'.repeat(64) }],
            },
        });
        expect(repaired.kind).toBe('applied');
        expect(profiles.getServerProfileById('srv_persisted_home_1')).toMatchObject({
            homeConnectionDescriptor: {
                revision: 9,
                endpoints: expect.arrayContaining([{ kind: 'iroh', endpointId: 'b'.repeat(64) }]),
            },
        });
    });

    it('preserves Iroh transport facts through ordinary revision-less profile updates', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const adopted = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home_manual_update_1',
                canonicalServerUrl: 'https://manual-update.example.test',
                revision: 4,
                endpoints: [{ kind: 'iroh', endpointId: 'd'.repeat(64), relayUrls: ['https://relay.example.test'] }],
            },
        });

        // An ordinary/legacy update carries no descriptor revision, so it has
        // no authority over transport facts; removal requires an authoritative
        // newer descriptor.
        const updated = await profiles.adoptHomeProfile({
            source: 'desktop-personal-home',
            preserveUserLabel: true,
            descriptor: {
                serverUrl: adopted.serverUrl,
                canonicalServerUrl: adopted.serverUrl,
                homeServerIdentityId: 'srv_home_manual_update_1',
                publicServerUrl: 'https://unpublished-ingress.example.test',
            },
        });
        expect(updated.id).toBe(adopted.id);
        expect(updated.homeConnectionDescriptor?.endpoints.find((endpoint) => endpoint.kind === 'iroh')).toEqual({ kind: 'iroh', endpointId: 'd'.repeat(64), relayUrls: ['https://relay.example.test'] });
        expect(updated.homeConnectionDescriptor?.revision).toBe(4);
        expect(updated.publicServerUrl).toBeNull();
        expect(profiles.getServerProfileById(adopted.id)?.homeConnectionDescriptor?.endpoints.find((endpoint) => endpoint.kind === 'iroh')).toEqual({ kind: 'iroh',
            endpointId: 'd'.repeat(64),
            relayUrls: ['https://relay.example.test'],
        });
        await expect(profiles.adoptHomeProfile({
            source: 'manual',
            descriptor: {
                serverUrl: 'https://unpublished-canonical.example.test',
                homeServerIdentityId: 'srv_home_manual_update_1',
            },
        })).rejects.toThrow('Exact Home descriptor is required');
        expect(profiles.getServerProfileById(adopted.id)?.serverUrl).toBe(adopted.serverUrl);
    });

    it('rejects malformed exact descriptors from manual sources through the canonical parser', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        await expect(profiles.adoptHomeProfile({
            source: 'manual',
            descriptor: {
                serverUrl: 'https://manual-endpoint.example.test',
                canonicalServerUrl: 'https://manual-endpoint.example.test',
                homeServerIdentityId: 'srv_home_manual_endpoint_1',
                // Runtime endpoint shape is malformed: it must never enter the
                // profile through a non-strict adoption path.
                endpoints: [{ kind: 'iroh', endpointId: 'not-an-endpoint-id' }],
                revision: 3,
            } as never,
        })).rejects.toThrow('Invalid Home connection descriptor');
    });

    it('keeps the Iroh endpoint and revision when equivalent profiles merge', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        storage.set('server-state-v1', JSON.stringify({
            activeServerId: 'merge-home',
            servers: {
                'merge-home': {
                    id: 'merge-home',
                    name: 'Named',
                    serverUrl: 'https://merge.example.test',
                    serverIdentityId: 'srv_merge_identity_1',
                    source: 'qr',
                    createdAt: 10,
                    updatedAt: 10,
                    lastUsedAt: 10,
                },
                'merge-copy': {
                    id: 'merge-copy',
                    name: 'Copy',
                    serverUrl: 'https://merge.example.test',
                    serverIdentityId: 'srv_merge_identity_1',
                    source: 'manual',
                    createdAt: 5,
                    updatedAt: 5,
                    lastUsedAt: 5,
                    homeConnectionDescriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_merge_identity_1',
                        canonicalServerUrl: 'https://merge.example.test',
                        revision: 12,
                        endpoints: [{ kind: 'iroh',
                        endpointId: 'd'.repeat(64),
                        relayUrls: ['https://relay.example.test'],
                        directAddresses: ['192.0.2.61:443'],
                    }],
                    },
                },
            },
        }));
        const profiles = await importFresh();

        const merged = profiles.getServerProfileById('merge-home');
        expect(merged).toBeTruthy();
        expect(merged?.homeConnectionDescriptor?.endpoints.find((endpoint) => endpoint.kind === 'iroh')).toEqual({ kind: 'iroh',
            endpointId: 'd'.repeat(64),
            relayUrls: ['https://relay.example.test'],
            directAddresses: ['192.0.2.61:443'],
        });
        expect(merged?.homeConnectionDescriptor?.revision).toBe(12);
    });

    it('adopts the highest-revision transport facts atomically when equivalent profiles merge', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        storage.set('server-state-v1', JSON.stringify({
            activeServerId: 'merge-newer',
            servers: {
                'merge-newer': {
                    id: 'merge-newer',
                    name: 'Newer',
                    serverUrl: 'https://merge-coherence.example.test',
                    serverIdentityId: 'srv_merge_coherence_1',
                    source: 'qr',
                    createdAt: 10,
                    updatedAt: 10,
                    lastUsedAt: 10,
                    homeConnectionDescriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_merge_coherence_1',
                        canonicalServerUrl: 'https://merge-coherence.example.test',
                        revision: 9,
                        endpoints: [{ kind: 'https', url: 'https://merge-coherence.example.test' }],
                    },
                },
                'merge-stale-copy': {
                    id: 'merge-stale-copy',
                    name: 'Stale copy',
                    serverUrl: 'https://merge-coherence.example.test',
                    serverIdentityId: 'srv_merge_coherence_1',
                    source: 'qr',
                    createdAt: 5,
                    updatedAt: 5,
                    lastUsedAt: 5,
                    homeConnectionDescriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_merge_coherence_1',
                        canonicalServerUrl: 'https://merge-coherence.example.test',
                        revision: 5,
                        endpoints: [{ kind: 'iroh', endpointId: 'e'.repeat(64), directAddresses: ['192.0.2.70:443'] }],
                    },
                },
            },
        }));
        const profiles = await importFresh();

        const merged = profiles.getServerProfileById('merge-newer');
        expect(merged).toBeTruthy();
        // Revision 9's descriptor generation removed the Iroh endpoint: the
        // stale endpoint from the revision-5 copy must not be resurrected and
        // endpoint/revision pairs must never splice across generations.
        expect(merged?.homeConnectionDescriptor?.endpoints.find((endpoint) => endpoint.kind === 'iroh')).toBeUndefined();
        expect(merged?.homeConnectionDescriptor?.revision).toBe(9);
    });

    it('keeps canonical and ingress projections with the selected exact descriptor during identity dedupe', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const oldDescriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_merge_destination_1',
            canonicalServerUrl: 'https://old-home.example.test',
            revision: 1,
            endpoints: [{ kind: 'https' as const, url: 'https://old-ingress.example.test' }],
        };
        const currentDescriptor = {
            ...oldDescriptor,
            canonicalServerUrl: 'https://current-home.example.test',
            revision: 2,
            endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
        };
        const profile = (id: string, descriptor: typeof oldDescriptor | typeof currentDescriptor) => ({
            id, name: id, serverUrl: descriptor.canonicalServerUrl,
            canonicalServerUrl: descriptor.canonicalServerUrl,
            publicServerUrl: descriptor.endpoints.find((endpoint) => endpoint.kind === 'https')?.url ?? null,
            serverIdentityId: descriptor.homeServerIdentityId,
            homeConnectionDescriptor: descriptor,
            createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        });
        seedServerState(scope, {
            activeServerId: 'preferred-old',
            servers: {
                'preferred-old': profile('preferred-old', oldDescriptor),
                'current': profile('current', currentDescriptor),
            },
        });
        const profiles = await importFresh();
        expect(profiles.getServerProfileById('preferred-old')).toMatchObject({
            serverUrl: currentDescriptor.canonicalServerUrl,
            canonicalServerUrl: currentDescriptor.canonicalServerUrl,
            publicServerUrl: null,
            homeConnectionDescriptor: currentDescriptor,
        });
        expect(profiles.getActiveServerSnapshot().serverUrl).toBe(currentDescriptor.canonicalServerUrl);
    });

    it('returns only the exact retained server-published descriptor for shareable flows', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        // An Iroh-capable loopback Personal Home with no public ingress: the descriptor
        // must carry Iroh without advertising its loopback canonical URL as HTTPS ingress.
        const personalHome = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_personal_home_qr_1',
                canonicalServerUrl: 'http://127.0.0.1:43110',
                revision: 7,
                endpoints: [
                    { kind: 'iroh', endpointId: 'f'.repeat(64), relayUrls: ['https://relay.example.test'], directAddresses: ['[2001:db8::1]:443'] },
                ],
            },
        });
        expect(profiles.buildHomeConnectionDescriptorForProfile(personalHome)).toEqual({
            v: 1,
            homeServerIdentityId: 'srv_personal_home_qr_1',
            canonicalServerUrl: 'http://127.0.0.1:43110',
            revision: 7,
            endpoints: [
                { kind: 'iroh', endpointId: 'f'.repeat(64), relayUrls: ['https://relay.example.test'], directAddresses: ['[2001:db8::1]:443'] },
            ],
        });

        // Derived profile scalars cannot change the retained outer descriptor.
        expect(profiles.buildHomeConnectionDescriptorForProfile({
            ...personalHome,
            publicServerUrl: 'https://public.example.test',
        })?.endpoints).toEqual([
            { kind: 'iroh', endpointId: 'f'.repeat(64), relayUrls: ['https://relay.example.test'], directAddresses: ['[2001:db8::1]:443'] },
        ]);

        // Non-Iroh Homes keep the current reachable HTTPS behavior.
        const ordinary = await profiles.adoptHomeProfile({
            source: 'account-directory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_ordinary_home_qr_1',
                canonicalServerUrl: 'https://ordinary.example.test',
                revision: 2,
                endpoints: [{ kind: 'https', url: 'https://ordinary.example.test' }],
            },
        });
        expect(profiles.buildHomeConnectionDescriptorForProfile(ordinary)).toEqual({
            v: 1,
            homeServerIdentityId: 'srv_ordinary_home_qr_1',
            canonicalServerUrl: 'https://ordinary.example.test',
            revision: 2,
            endpoints: [{ kind: 'https', url: 'https://ordinary.example.test' }],
        });

        // A Directory descriptor is signed and safe to use for its one enrollment
        // attempt, but remains advisory until the Home authenticates its complete
        // current generation. It must not become a shareable QR/link descriptor.
        const advisory = await profiles.adoptHomeProfile({
            source: 'account-directory',
            descriptorAuthority: 'advisory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_advisory_home_1',
                canonicalServerUrl: 'https://advisory.example.test',
                revision: 3,
                endpoints: [{ kind: 'https', url: 'https://advisory.example.test' }],
            },
        });
        expect(profiles.buildHomeConnectionDescriptorForProfile(advisory)).toBeNull();

        // Scalars alone never synthesize a descriptor or revision 1.
        const anonymous = await profiles.upsertServerProfile({ serverUrl: 'https://anonymous.example.test', source: 'manual' });
        expect(profiles.buildHomeConnectionDescriptorForProfile(anonymous)).toBeNull();
        expect(profiles.buildHomeConnectionDescriptorForProfile({
            ...anonymous,
            serverIdentityId: 'srv_scalar_only',
            canonicalServerUrl: 'https://anonymous.example.test',
            publicServerUrl: 'https://ingress.example.test',
        })).toBeNull();
    });

    it('uses the canonical strict descriptor parser before adopting QR Homes', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();

        await expect(profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_strict_home_1',
                canonicalServerUrl: 'https://strict.example.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://strict.example.test' }],
                unexpectedAuthorityHint: true,
            } as never,
        })).rejects.toThrow('Invalid Home connection descriptor');
        expect(profiles.listServerProfiles().some((profile) => profile.serverIdentityId === 'srv_strict_home_1')).toBe(false);
    });

    it('requires an explicit stable Home identity before strict adoption', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();

        await expect(profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: '',
                canonicalServerUrl: 'https://identity-required.example.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://identity-required.example.test' }],
            },
        })).rejects.toThrow('Invalid Home connection descriptor');
        expect(profiles.listServerProfiles().some((profile) => (
            profile.canonicalServerUrl === 'https://identity-required.example.test'
            || profile.serverUrl === 'https://identity-required.example.test'
        ))).toBe(false);
    });

    it('rejects a stable identity whose canonical URL belongs to another Home', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const existing = await profiles.upsertServerProfile({ serverUrl: 'https://claimed.example.test', source: 'manual' });
        await profiles.setServerProfileIdentityForUrl(existing.serverUrl, 'srv_existing_home_1');

        await expect(profiles.adoptHomeProfile({
            source: 'account-directory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_different_home_1',
                canonicalServerUrl: 'https://claimed.example.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://claimed.example.test' }],
            },
        })).rejects.toThrow('Home identity conflicts with URL');
        expect(profiles.getServerProfileById(existing.id)?.serverIdentityId).toBe('srv_existing_home_1');
    });

    it('preflights strict adoption with the canonical conflict rules without mutating profile, focus, or group state', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const existing = await profiles.upsertServerProfile({ serverUrl: 'https://claimed.example.test', source: 'manual' });
        await profiles.setServerProfileIdentityForUrl(existing.serverUrl, 'srv_existing_home_1');
        await profiles.setActiveServerId(existing.id);
        await profiles.saveHomeViewState({
            version: 1,
            activeTargetKind: 'server',
            activeTargetId: 'srv_existing_home_1',
            groups: [{ id: 'homes', name: 'Homes', serverIds: ['srv_existing_home_1'] }],
        });
        const profilesBefore = profiles.listServerProfiles();
        const focusBefore = profiles.getActiveServerSnapshot();
        const homeViewBefore = profiles.loadHomeViewState();

        expect(profiles.preflightHomeProfileAdoption({
            source: 'account-directory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_preflight_home_1',
                canonicalServerUrl: 'https://preflight.example.test/',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://preflight.example.test/' }],
            },
        })).toEqual({
            canonicalServerUrl: 'https://preflight.example.test',
            serverIdentityId: 'srv_preflight_home_1',
            credentialWrite: 'required',
        });

        expect(() => profiles.preflightHomeProfileAdoption({
            source: 'account-directory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_different_home_1',
                canonicalServerUrl: 'https://claimed.example.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://claimed.example.test' }],
            },
        })).toThrow('Home identity conflicts with URL');
        expect(profiles.listServerProfiles()).toEqual(profilesBefore);
        expect(profiles.getActiveServerSnapshot()).toEqual(focusBefore);
        expect(profiles.loadHomeViewState()).toEqual(homeViewBefore);
    });

    it('does not persist profile or Home-view canonicalization while preflighting adoption', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const profiles = await importFresh();
        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        const rawState = JSON.stringify({
            activeServerId: 'legacy-home-b',
            activeServerIdIsExplicit: true,
            servers: {
                'legacy-home-a': {
                    id: 'legacy-home-a',
                    name: 'Legacy Home A',
                    serverUrl: 'https://legacy-home.example.test',
                    serverIdentityId: 'srv_legacy_preflight_home_1',
                    source: 'manual',
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                },
                'legacy-home-b': {
                    id: 'legacy-home-b',
                    name: 'Legacy Home B',
                    serverUrl: 'https://legacy-home.example.test/',
                    serverIdentityId: 'srv_legacy_preflight_home_1',
                    source: 'manual',
                    createdAt: 2,
                    updatedAt: 2,
                    lastUsedAt: 2,
                },
            },
            accountServiceEndpoint: null,
            homeViewState: {
                version: 1,
                activeTargetKind: 'server',
                activeTargetId: 'legacy-home-b',
                groups: [{ id: 'homes', name: 'Homes', serverIds: ['legacy-home-a', 'legacy-home-b'] }],
            },
        });
        storage.set('server-state-v1', rawState);

        expect(profiles.preflightHomeProfileAdoption({
            source: 'account-directory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_new_preflight_home_1',
                canonicalServerUrl: 'https://new-preflight.example.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://new-preflight.example.test' }],
            },
        })).toEqual({
            canonicalServerUrl: 'https://new-preflight.example.test',
            serverIdentityId: 'srv_new_preflight_home_1',
            credentialWrite: 'required',
        });
        expect(storage.getString('server-state-v1')).toBe(rawState);

        // Ordinary reads expose the canonical projection but never rewrite raw state.
        expect(profiles.listServerProfiles()).toHaveLength(1);
        expect(storage.getString('server-state-v1')).toBe(rawState);

        // A successful explicit semantic no-op persists the latest canonical state.
        await profiles.setActiveServerId('srv_legacy_preflight_home_1', { scope: 'device' });
        expect(storage.getString('server-state-v1')).not.toBe(rawState);
    });

    it('preserves canonical/public transport URLs and exact unknown persisted source through same-profile adoption', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        storage.set('server-state-v1', JSON.stringify({
            activeServerId: 'future-home',
            activeServerIdIsExplicit: true,
            servers: {
                'future-home': {
                    id: 'future-home',
                    name: 'Future',
                    serverUrl: 'https://future.example.test',
                    source: 'Future-Directory-V2',
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                },
            },
        }));
        const profiles = await importFresh();
        expect(profiles.getServerProfileById('future-home')).toMatchObject({
            source: 'legacy',
            legacySource: 'Future-Directory-V2',
        });

        const adopted = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_transport_home_1',
                canonicalServerUrl: 'https://future.example.test',
                revision: 4,
                endpoints: [
                    { kind: 'https', url: 'https://public.example.test' },
                    { kind: 'iroh', endpointId: 'b'.repeat(64), relayUrls: ['https://relay.example.test'], directAddresses: ['192.0.2.44:443'] },
                ],
            },
        });
        await profiles.upsertServerProfile({ serverUrl: 'https://unrelated.example.test', source: 'manual' });

        const persisted = JSON.parse(storage.getString('server-state-v1') ?? '{}') as {
            servers?: Record<string, { source?: string }>;
        };
        expect(persisted.servers?.['future-home']?.source).toBe('Future-Directory-V2');

        const reloaded = await importFresh();
        expect(reloaded.getServerProfileById(adopted.id)).toMatchObject({
            serverUrl: 'https://future.example.test',
            canonicalServerUrl: 'https://future.example.test',
            publicServerUrl: 'https://public.example.test',
            source: 'legacy',
            legacySource: 'Future-Directory-V2',
            homeConnectionDescriptor: {
                revision: 4,
                endpoints: expect.arrayContaining([{ kind: 'iroh',
                endpointId: 'b'.repeat(64),
                relayUrls: ['https://relay.example.test'],
                directAddresses: ['192.0.2.44:443'],
            }]),
            },
        });
    });

    it('updates runtime origin without changing stable Home profile fields', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://home.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const before = profiles.getActiveServerSnapshot();
        const target = profiles.captureActiveServerRuntimeTarget();
        profiles.publishActiveServerRuntimeOrigin({ target, leaseId: 'lease-home', runtimeOrigin: 'http://127.0.0.1:4123', carrier: 'iroh' });
        const after = profiles.getActiveServerSnapshot();
        expect(after.runtimeOrigin).toBe('http://127.0.0.1:4123');
        expect(after.carrier).toBe('iroh');
        expect(after.serverUrl).toBe(before.serverUrl);
        expect(profiles.getServerProfileById(home.id)?.serverUrl).toBe('https://home.example.test');
    });

    it('clears a transient runtime origin when focus moves to another Home', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const first = await profiles.upsertServerProfile({ serverUrl: 'https://first.example.test', source: 'manual' });
        const second = await profiles.upsertServerProfile({ serverUrl: 'https://second.example.test', source: 'manual' });
        await profiles.setActiveServerId(first.id, { scope: 'device' });
        const target = profiles.captureActiveServerRuntimeTarget();
        profiles.publishActiveServerRuntimeOrigin({ target, leaseId: 'lease-first', runtimeOrigin: 'http://127.0.0.1:4312', carrier: 'iroh' });
        await profiles.setActiveServerId(second.id, { scope: 'device' });
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
        expect(profiles.getActiveServerSnapshot().carrier).toBeUndefined();
    });

    it('fences focused runtime origin by focus basis and lease ownership', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const first = await profiles.upsertServerProfile({ serverUrl: 'https://first-origin.example.test', source: 'manual' });
        const second = await profiles.upsertServerProfile({ serverUrl: 'https://second-origin.example.test', source: 'manual' });

        await profiles.setActiveServerId(first.id, { scope: 'device' });
        const oldFirstTarget = profiles.captureActiveServerRuntimeTarget();
        expect(profiles.publishActiveServerRuntimeOrigin({
            target: oldFirstTarget,
            leaseId: 'lease-first-old',
            runtimeOrigin: 'http://127.0.0.1:4101',
            carrier: 'iroh',
        })).toBe(true);

        await profiles.setActiveServerId(second.id, { scope: 'device' });
        const secondTarget = profiles.captureActiveServerRuntimeTarget();
        expect(profiles.publishActiveServerRuntimeOrigin({
            target: secondTarget,
            leaseId: 'lease-second',
            runtimeOrigin: 'http://127.0.0.1:4102',
            carrier: 'iroh',
        })).toBe(true);
        expect(profiles.releaseActiveServerRuntimeOrigin({ target: oldFirstTarget, leaseId: 'lease-first-old' })).toBe(false);
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: profiles.resolveServerProfileScopeId(second),
            runtimeOrigin: 'http://127.0.0.1:4102',
            carrier: 'iroh',
        });

        await profiles.setActiveServerId(first.id, { scope: 'device' });
        const newFirstTarget = profiles.captureActiveServerRuntimeTarget();
        expect(newFirstTarget).not.toEqual(oldFirstTarget);
        expect(profiles.publishActiveServerRuntimeOrigin({
            target: newFirstTarget,
            leaseId: 'lease-first-new',
            runtimeOrigin: 'http://127.0.0.1:4103',
            carrier: 'iroh',
        })).toBe(true);
        expect(profiles.releaseActiveServerRuntimeOrigin({ target: oldFirstTarget, leaseId: 'lease-first-old' })).toBe(false);
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBe('http://127.0.0.1:4103');

        // Normal profile emissions change ActiveServerSnapshot.generation, but do
        // not invalidate the focused Home's lease basis.
        await profiles.upsertServerProfile({ serverUrl: 'https://unrelated-origin.example.test', source: 'manual' });
        expect(profiles.releaseActiveServerRuntimeOrigin({ target: newFirstTarget, leaseId: 'lease-first-new' })).toBe(true);
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
    });

    it('rejects a stale-generation release that reuses a lease id after refocus', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const first = await profiles.upsertServerProfile({ serverUrl: 'https://reused-first.example.test', source: 'manual' });
        const second = await profiles.upsertServerProfile({ serverUrl: 'https://reused-second.example.test', source: 'manual' });

        await profiles.setActiveServerId(first.id, { scope: 'device' });
        const staleTarget = profiles.captureActiveServerRuntimeTarget();
        expect(profiles.publishActiveServerRuntimeOrigin({
            target: staleTarget,
            leaseId: 'lease-reused',
            runtimeOrigin: 'http://127.0.0.1:4201',
            carrier: 'iroh',
        })).toBe(true);

        // Refocus away and back: the native supervisor may hand out the same lease id.
        await profiles.setActiveServerId(second.id, { scope: 'device' });
        await profiles.setActiveServerId(first.id, { scope: 'device' });
        const currentTarget = profiles.captureActiveServerRuntimeTarget();
        expect(currentTarget).not.toEqual(staleTarget);
        expect(profiles.publishActiveServerRuntimeOrigin({
            target: currentTarget,
            leaseId: 'lease-reused',
            runtimeOrigin: 'http://127.0.0.1:4202',
            carrier: 'iroh',
        })).toBe(true);

        expect(profiles.releaseActiveServerRuntimeOrigin({ target: staleTarget, leaseId: 'lease-reused' })).toBe(false);
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBe('http://127.0.0.1:4202');

        expect(profiles.releaseActiveServerRuntimeOrigin({ target: currentTarget, leaseId: 'lease-reused' })).toBe(true);
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
    });

    it('invalidates the active runtime publication when the focused Home adopts a newer descriptor', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const descriptorV1 = {
            v: 1 as const,
            homeServerIdentityId: 'srv_descriptor_rotation',
            canonicalServerUrl: 'http://localhost:3010',
            revision: 1,
            endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
        };
        const home = await profiles.adoptHomeProfile({ descriptor: descriptorV1, source: 'qr' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const staleTarget = profiles.captureActiveServerRuntimeTarget();
        expect(profiles.publishActiveServerRuntimeOrigin({
            target: staleTarget,
            leaseId: 'lease-descriptor-v1',
            runtimeOrigin: 'http://127.0.0.1:4101',
            carrier: 'iroh',
        })).toBe(true);

        await profiles.adoptHomeProfile({
            descriptor: {
                ...descriptorV1,
                revision: 2,
                endpoints: [{ kind: 'iroh' as const, endpointId: 'b'.repeat(64) }],
            },
            source: 'account-directory',
        });

        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
        expect(profiles.captureActiveServerRuntimeTarget()).not.toEqual(staleTarget);
        expect(profiles.publishActiveServerRuntimeOrigin({
            target: staleTarget,
            leaseId: 'lease-descriptor-v1-late',
            runtimeOrigin: 'http://127.0.0.1:4102',
            carrier: 'iroh',
        })).toBe(false);
    });

    it('does not advance the focused Home generation when a non-focused Home adopts a newer descriptor', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();
        const active = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_active_unchanged',
                canonicalServerUrl: 'https://active-unchanged.example.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://active-unchanged.example.test' }],
            },
        });
        const secondaryDescriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_secondary_updated',
            canonicalServerUrl: 'https://secondary-updated.example.test',
            revision: 1,
            endpoints: [{ kind: 'https' as const, url: 'https://secondary-updated.example.test' }],
        };
        await profiles.adoptHomeProfile({ source: 'qr', descriptor: secondaryDescriptor });
        await profiles.setActiveServerId(active.id, { scope: 'device' });
        const before = profiles.getActiveServerSnapshot();
        const listener = vi.fn();
        const unsubscribe = profiles.subscribeActiveServer(listener);

        await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: { ...secondaryDescriptor, revision: 2 },
        });

        expect(profiles.getActiveServerSnapshot()).toBe(before);
        expect(listener).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('prefers sessionStorage activeServerId on web over the device default', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();

        const created = await profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        const tabProfile = await profiles.upsertServerProfile({
            serverUrl: 'https://tab.example.test',
            name: 'Tab',
        });
        await profiles.setActiveServerId(created.id, { scope: 'device' });
        await profiles.setActiveServerId(tabProfile.id, { scope: 'tab' });

        expect(profiles.getActiveServerUrl()).toBe('https://tab.example.test');
    });

    it('returns a stable active server snapshot reference until the store changes', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();
        const created = await profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        await profiles.setActiveServerId(created.id, { scope: 'device' });

        const first = profiles.getActiveServerSnapshot();
        const second = profiles.getActiveServerSnapshot();

        expect(second).toBe(first);

        const next = await profiles.upsertServerProfile({
            serverUrl: 'https://next.example.test',
            name: 'Next',
        });
        await profiles.setActiveServerId(next.id, { scope: 'device' });

        const third = profiles.getActiveServerSnapshot();
        expect(third).not.toBe(first);
        expect(third.serverUrl).toBe('https://next.example.test');
    });

    it('publishes an unrelated profile mutation without invalidating the focused Home snapshot', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();
        const active = await profiles.upsertServerProfile({
            serverUrl: 'https://active.example.test',
            name: 'Active',
        });
        await profiles.setActiveServerId(active.id, { scope: 'device' });

        const first = profiles.getActiveServerSnapshot();
        const activeListener = vi.fn();
        const profileListener = vi.fn();
        const unsubscribeActive = profiles.subscribeActiveServer(activeListener);
        const unsubscribeProfiles = profiles.subscribeServerProfiles(profileListener);

        await profiles.upsertServerProfile({
            serverUrl: 'https://next.example.test',
            name: 'Next',
        });

        const second = profiles.getActiveServerSnapshot();

        expect(profileListener).toHaveBeenCalledOnce();
        expect(second).toBe(first);
        expect(second.generation).toBe(first.generation);
        expect(activeListener).not.toHaveBeenCalled();
        unsubscribeActive();
        unsubscribeProfiles();
    });

    it('tracks whether the active server selection is explicit', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();

        expect(profiles.isActiveServerSelectionExplicit()).toBe(false);

        const created = await profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        await profiles.setActiveServerId(created.id, { scope: 'device' });

        expect(profiles.isActiveServerSelectionExplicit()).toBe(true);
    });

    it('emits active server changes when selection becomes explicit without changing the URL', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('null');

        const profiles = await importFresh();
        const created = await profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });

        expect(profiles.getActiveServerSnapshot().serverId).toBe(created.id);
        expect(profiles.isActiveServerSelectionExplicit()).toBe(false);

        const listener = vi.fn();
        profiles.subscribeActiveServer(listener);

        await profiles.setActiveServerId(created.id, { scope: 'device' });

        expect(profiles.isActiveServerSelectionExplicit()).toBe(true);
        expect(listener).toHaveBeenCalled();
    });

    it('returns referentially stable profile lists while the persisted raw state is unchanged', async () => {
        // readPersistedState is on hot selector paths (17 call sites); re-parsing the whole
        // persisted blob per call costs real CPU and breaks referential stability for
        // consumers comparing identities. The parse must be cached by the raw string.
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();
        const created = await profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });

        const firstList = profiles.listServerProfiles();
        const secondList = profiles.listServerProfiles();
        const firstEntry = firstList.find((profile) => profile.id === created.id);
        const secondEntry = secondList.find((profile) => profile.id === created.id);
        expect(firstEntry).toBeTruthy();
        expect(secondEntry).toBe(firstEntry);
        expect(profiles.getServerProfileById(created.id)).toBe(firstEntry);

        // A write must invalidate the cached parse.
        const baselineCount = firstList.length;
        await profiles.upsertServerProfile({
            serverUrl: 'https://next.example.test',
            name: 'Next',
        });
        expect(profiles.listServerProfiles()).toHaveLength(baselineCount + 1);
    });

    it('persists a shareable relay URL on the active server snapshot', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();
        const created = await profiles.upsertServerProfile({
            serverUrl: 'https://relay.example.test',
            name: 'Relay',
        });
        await profiles.setActiveServerId(created.id, { scope: 'device' });
        await profiles.setServerProfileShareableUrl(created.id, 'https://relay.example.ts.net/path?token=abc#frag', {
            validatedAgainstServerUrl: 'http://127.0.0.1:3005/',
        });

        const snapshot = profiles.getActiveServerSnapshot();
        expect(snapshot.activeShareableServerUrl).toBe('https://relay.example.ts.net/path');
        expect(snapshot.activeShareableServerUrlValidatedAgainstServerUrl).toBe('http://127.0.0.1:3005');
        expect(profiles.getActiveServerUrl()).toBe('https://relay.example.test');
    });

    it('exposes device default and tab override server ids separately on web', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const profiles = await importFresh();

        const device = await profiles.upsertServerProfile({
            serverUrl: 'https://device.example.test',
            name: 'Device',
        });
        const tab = await profiles.upsertServerProfile({
            serverUrl: 'https://tab.example.test',
            name: 'Tab',
        });
        await profiles.setActiveServerId(device.id, { scope: 'device' });
        await profiles.setActiveServerId(tab.id, { scope: 'tab' });

        expect(profiles.getActiveServerId()).toBe(tab.id);
        expect(profiles.getDeviceDefaultServerId()).toBe(device.id);
        expect(profiles.getTabActiveServerId()).toBe(tab.id);
    });

    it('keeps routine web Home targets tab-scoped while sharing device-global groups and default target', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');
        const profiles = await importFresh();
        const selection = await import('./selection/homeViewSelectionState');
        const homeA = await profiles.upsertServerProfile({ serverUrl: 'https://a.example.test', name: 'A' });
        const homeB = await profiles.upsertServerProfile({ serverUrl: 'https://b.example.test', name: 'B' });
        await profiles.setActiveServerId(homeA.id, { scope: 'device' });
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'all', name: 'All', serverIds: [homeA.id, homeB.id], presentation: 'grouped' }],
            activeTargetKind: 'server',
            activeTargetId: homeA.id,
        });

        await selection.updateEffectiveHomeViewState(() => ({
            version: 1,
            groups: [{ id: 'all', name: 'All', serverIds: [homeA.id, homeB.id], presentation: 'grouped' }],
            activeTargetKind: 'group',
            activeTargetId: 'all',
        }), { scope: 'tab' });

        expect(profiles.loadHomeViewState()).toMatchObject({
            activeTargetKind: 'server',
            activeTargetId: homeA.id,
        });
        expect(selection.loadEffectiveHomeViewState()).toMatchObject({
            activeTargetKind: 'group',
            activeTargetId: 'all',
        });

        const secondTab = new Map<string, string>();
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) => secondTab.get(key) ?? null,
            setItem: (key: string, value: string) => void secondTab.set(key, value),
            removeItem: (key: string) => void secondTab.delete(key),
        });
        expect(selection.loadEffectiveHomeViewState()).toMatchObject({
            groups: [{ id: 'all', serverIds: [homeA.id, homeB.id] }],
            activeTargetKind: 'server',
            activeTargetId: homeA.id,
        });
    });

    it('does not republish stale device-global groups from a tab-scoped target-only update', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');
        const profiles = await importFresh();
        const selection = await import('./selection/homeViewSelectionState');
        const homeA = await profiles.upsertServerProfile({ serverUrl: 'https://a.example.test', name: 'A' });
        const homeB = await profiles.upsertServerProfile({ serverUrl: 'https://b.example.test', name: 'B' });
        const originalGroup = { id: 'original', name: 'Original', serverIds: [homeA.id], presentation: 'grouped' as const };
        const concurrentlySavedGroup = { id: 'latest', name: 'Latest', serverIds: [homeB.id], presentation: 'grouped' as const };
        await profiles.saveHomeViewState({
            version: 1,
            groups: [originalGroup],
            activeTargetKind: 'server',
            activeTargetId: homeA.id,
        });

        await profiles.updateHomeViewState((latest) => ({ ...latest, groups: [concurrentlySavedGroup] }));
        await selection.updateEffectiveHomeViewState((latest) => ({
            ...latest,
            activeTargetKind: 'server',
            activeTargetId: homeB.id,
        }), { scope: 'tab' });

        expect(profiles.loadHomeViewState()?.groups).toEqual([concurrentlySavedGroup]);
        expect(selection.loadEffectiveHomeViewState()).toMatchObject({
            groups: [concurrentlySavedGroup],
            activeTargetKind: 'server',
            activeTargetId: homeB.id,
        });
    });

    it('repairs a removed tab-scoped Home target before New Session resolves and does not resurrect it', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');
        const profiles = await importFresh();
        const selection = await import('./selection/homeViewSelectionState');
        const resolver = await import('./selection/serverSelectionResolver');
        const homeA = await profiles.upsertServerProfile({ serverUrl: 'https://a.example.test', name: 'A' });
        const homeB = await profiles.upsertServerProfile({ serverUrl: 'https://b.example.test', name: 'B' });
        await profiles.setServerProfileIdentityForUrl(homeB.serverUrl, 'srv_home_b');
        await profiles.setActiveServerId(homeA.id, { scope: 'device' });
        await profiles.saveHomeViewState({
            version: 1,
            groups: [],
            activeTargetKind: 'server',
            activeTargetId: homeA.id,
        });
        await selection.updateEffectiveHomeViewState((current) => ({
            ...current,
            activeTargetKind: 'server',
            activeTargetId: homeB.id,
        }), { scope: 'tab' });
        expect(selection.loadEffectiveHomeViewState()).toMatchObject({
            activeTargetKind: 'server',
            activeTargetId: 'srv_home_b',
        });

        await profiles.removeServerProfile(homeB.id);

        const effective = selection.loadEffectiveHomeViewState();
        expect(effective).toMatchObject({
            activeTargetKind: 'server',
            activeTargetId: homeA.id,
        });
        expect(globalThis.sessionStorage.getItem('homeViewActiveTargetV1')).toBeNull();
        expect(resolver.getNewSessionServerTargeting({
            activeServerId: profiles.getActiveServerId(),
            availableServerIds: profiles.listServerProfiles().map(profiles.resolveServerProfileScopeId),
            settings: {
                serverSelectionGroups: effective?.groups ?? [],
                serverSelectionActiveTargetKind: effective?.activeTargetKind ?? null,
                serverSelectionActiveTargetId: effective?.activeTargetId ?? null,
            },
        })).toEqual({ allowedServerIds: [homeA.id], pickerEnabled: false });

        await profiles.upsertServerProfile({ serverUrl: 'https://b.example.test', name: 'B again' });
        expect(selection.loadEffectiveHomeViewState()).toMatchObject({
            activeTargetKind: 'server',
            activeTargetId: homeA.id,
        });
    });

    it('publishes matching cross-tab profile state writes while preserving this tab override', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const web = stubWebRuntime('https://origin.example.test');
        const profiles = await importFresh();
        const device = await profiles.upsertServerProfile({ serverUrl: 'https://device.example.test', name: 'Device' });
        const tab = await profiles.upsertServerProfile({ serverUrl: 'https://tab.example.test', name: 'Tab' });
        await profiles.setActiveServerId(device.id, { scope: 'device' });
        await profiles.setActiveServerId(tab.id, { scope: 'tab' });

        const profileGenerations: number[] = [];
        const activeIds: string[] = [];
        const homeViewChanges: number[] = [];
        const accountEndpoints: Array<string | null> = [];
        const unsubscribers = [
            profiles.subscribeServerProfiles((generation) => profileGenerations.push(generation)),
            profiles.subscribeActiveServer((snapshot) => activeIds.push(snapshot.serverId)),
            profiles.subscribeHomeViewState(() => homeViewChanges.push(1)),
            profiles.subscribeAccountServiceEndpoint((endpoint) => accountEndpoints.push(endpoint?.url ?? null)),
        ];

        const key = `${scopedStorageId('server-profiles', scope)}:server-state-v1`;
        const persisted = JSON.parse(web.store.get(key) ?? '{}') as Record<string, unknown>;
        const externalProfile = {
            id: 'external-profile',
            name: 'External',
            serverUrl: 'https://external.example.test',
            source: 'manual',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
        };
        web.store.set(key, JSON.stringify({
            ...persisted,
            activeServerId: 'external-profile',
            activeServerIdIsExplicit: true,
            servers: {
                ...(persisted.servers as Record<string, unknown>),
                'external-profile': externalProfile,
            },
            accountServiceEndpoint: { url: 'https://accounts.example.test', source: 'user' },
            homeViewStateInitialized: true,
            homeViewState: {
                version: 1,
                groups: [],
                activeTargetKind: 'server',
                activeTargetId: 'external-profile',
            },
        }));
        web.emitStorage(key);

        expect(profileGenerations).toHaveLength(1);
        expect(homeViewChanges).toHaveLength(1);
        expect(accountEndpoints).toEqual(['https://accounts.example.test']);
        expect(activeIds).toEqual([]);
        expect(profiles.getDeviceDefaultServerId()).toBe('external-profile');
        expect(profiles.getActiveServerId()).toBe(tab.id);
        expect(profiles.listServerProfiles().some((profile) => profile.id === 'external-profile')).toBe(true);

        // A profile-only write still publishes to profile subscribers, but a label
        // edit is not part of the focused ActiveServerSnapshot and must not
        // invalidate its generation/reference or publish an active-server event.
        const activeBeforeRename = profiles.getActiveServerSnapshot();
        const renamed = JSON.parse(web.store.get(key) ?? '{}') as Record<string, unknown>;
        const renamedServers = renamed.servers as Record<string, Record<string, unknown>>;
        web.store.set(key, JSON.stringify({
            ...renamed,
            servers: {
                ...renamedServers,
                [tab.id]: { ...(renamedServers[tab.id] ?? {}), name: 'Tab renamed elsewhere' },
            },
        }));
        web.emitStorage(key);

        expect(profileGenerations).toHaveLength(2);
        expect(activeIds).toEqual([]);
        expect(profiles.getActiveServerSnapshot()).toBe(activeBeforeRename);
        expect(profiles.getActiveServerId()).toBe(tab.id);
        for (const unsubscribe of unsubscribers) unsubscribe();
    });

    it('does not publish an unrelated first cross-tab write when subscribed before reading the active snapshot', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const web = stubWebRuntime('https://origin.example.test');
        const key = `${scopedStorageId('server-profiles', scope)}:server-state-v1`;
        web.store.set(key, JSON.stringify(homeAState()));
        const profiles = await importFresh();
        const activeListener = vi.fn();
        const profileListener = vi.fn();
        const unsubscribeActive = profiles.subscribeActiveServer(activeListener);
        const unsubscribeProfiles = profiles.subscribeServerProfiles(profileListener);
        const persisted = JSON.parse(web.store.get(key) ?? '{}') as Record<string, unknown>;

        web.store.set(key, JSON.stringify({
            ...persisted,
            servers: {
                ...(persisted.servers as Record<string, unknown>),
                unrelated: {
                    id: 'unrelated',
                    name: 'Unrelated',
                    serverUrl: 'https://unrelated.example.test',
                    source: 'manual',
                    createdAt: 3,
                    updatedAt: 3,
                    lastUsedAt: 3,
                },
            },
        }));
        web.emitStorage(key);

        expect(profileListener).toHaveBeenCalledOnce();
        expect(activeListener).not.toHaveBeenCalled();
        unsubscribeActive();
        unsubscribeProfiles();
    });

    it('preserves a disjoint mutation when two current tabs overlap whole-state updates', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('https://origin.example.test');

        const tabB = await importFresh();
        const profile = await tabB.upsertServerProfile({
            serverUrl: 'https://home.example.test',
            name: 'Home before B',
            source: 'manual',
        });
        const tabA = await importFresh();
        const stateKey = `${scopedStorageId('server-profiles', scope)}:server-state-v1`;
        const sharedStorage = globalThis.window.localStorage;
        const originalGetItem = sharedStorage.getItem.bind(sharedStorage);
        let interleaved = false;
        let tabAWrite: Promise<void> | null = null;

        sharedStorage.getItem = (key: string): string | null => {
            const captured = originalGetItem(key);
            if (!interleaved && key === stateKey) {
                interleaved = true;
                tabAWrite = tabA.setAccountServiceEndpoint({
                    url: 'https://accounts.example.test',
                    source: 'user',
                });
            }
            return captured;
        };

        // Tab B has captured the old whole state. Tab A commits a disjoint valid
        // mutation before B resumes and adopts its profile from that base.
        await tabB.adoptHomeProfile({
            descriptor: { serverUrl: profile.serverUrl },
            source: 'manual',
            suggestedName: 'Home adopted by B',
            preserveUserLabel: false,
        });
        await tabAWrite;

        expect(interleaved).toBe(true);
        expect(tabA.getServerProfileById(profile.id)?.name).toBe('Home adopted by B');
        expect(tabA.getAccountServiceEndpointSnapshot()).toEqual({
            url: 'https://accounts.example.test',
            source: 'user',
        });
    });

    it('rejects web persisted mutations when browser-wide locking is unavailable without changing raw state', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const web = stubWebRuntime('https://origin.example.test', { locks: false });
        const key = `${scopedStorageId('server-profiles', scope)}:server-state-v1`;
        const raw = JSON.stringify(homeAState());
        web.store.set(key, raw);
        const profiles = await importFresh();

        await expect(profiles.adoptHomeProfile({
            descriptor: { serverUrl: 'https://home-a.example.test' },
            source: 'manual',
            suggestedName: 'Adopted',
        })).rejects.toThrow(
            'Browser storage locking is unavailable',
        );
        expect(web.store.get(key)).toBe(raw);
    });

    it('applies native persisted mutations immediately while retaining the Promise API', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const profiles = await importFresh();

        const mutation = profiles.upsertServerProfile({
            serverUrl: 'https://native-immediate.example.test',
            name: 'Native immediate',
        });
        expect(profiles.listServerProfiles()).toContainEqual(expect.objectContaining({
            serverUrl: 'https://native-immediate.example.test',
            name: 'Native immediate',
        }));

        await expect(mutation).resolves.toMatchObject({
            serverUrl: 'https://native-immediate.example.test',
        });
    });

    it('seeds Happier Cloud on native when no preconfigured env exists', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('https://api.happier.dev');
    });

    it('does not seed Happier Cloud on native when build policy denies the setup surface policy gate', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relay.allowHappierCloud';

        const profiles = await importFresh();
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(false);
        expect(profiles.getActiveServerUrl()).not.toBe('https://api.happier.dev');
    });

    it('seeds a same-origin server profile on web when no preconfigured env exists', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        stubWebRuntime('https://selfhost.example.test');

        const profiles = await importFresh();
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://selfhost.example.test')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('https://selfhost.example.test');
        expect(profiles.getActiveServerId()).toBeTruthy();
    });

    it('avoids seeding Metro/local UI origins as a relay server in stack context', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        stubWebRuntime('http://localhost:8081');

        const profiles = await importFresh();

        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'http://localhost:8081')).toBe(false);
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('https://api.happier.dev');
    });

    it('avoids seeding Metro/local UI origins as a relay server when stack context comes from runtime config', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        stubWebRuntimeWithRuntimeConfig('http://127.0.0.1:8081', { serverContext: 'stack' });

        const profiles = await importFresh();

        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'http://127.0.0.1:8081')).toBe(false);
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('https://api.happier.dev');
    });

    it('dedupes loopback-equivalent servers and prefers same-origin on web', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        stubWebRuntime('http://qa-stack.localhost:24577');

        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        storage.set(
            'server-state-v1',
            JSON.stringify({
                activeServerIdIsExplicit: true,
                activeServerId: 'localhost-24577',
                servers: {
                    'qa-stack.localhost-24577': {
                        id: 'qa-stack.localhost-24577',
                        name: 'Stack',
                        serverUrl: 'http://qa-stack.localhost:24577/',
                        createdAt: 100,
                        updatedAt: 200,
                        lastUsedAt: 200,
                        source: 'url',
                    },
                    'localhost-24577': {
                        id: 'localhost-24577',
                        name: 'Local',
                        serverUrl: 'http://localhost:24577/',
                        createdAt: 150,
                        updatedAt: 250,
                        lastUsedAt: 250,
                        source: 'url',
                    },
                },
            }),
        );

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();

        expect(all.length).toBe(1);
        expect(profiles.getActiveServerUrl()).toBe('http://qa-stack.localhost:24577');
        expect(profiles.getActiveServerId()).toBe('qa-stack.localhost-24577');
    });

    it('dedupes equivalent servers without rewriting the explicit active server id when no same-origin override exists', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        storage.set(
            'server-state-v1',
            JSON.stringify({
                activeServerIdIsExplicit: true,
                activeServerId: 'manual-id',
                servers: {
                    'manual-id': {
                        id: 'manual-id',
                        name: 'Manual Active',
                        serverUrl: 'https://api.example.test',
                        createdAt: 100,
                        updatedAt: 200,
                        lastUsedAt: 999,
                        source: 'manual',
                    },
                    'stack-id': {
                        id: 'stack-id',
                        name: 'Stack Seeded',
                        serverUrl: 'https://api.example.test',
                        createdAt: 150,
                        updatedAt: 250,
                        lastUsedAt: 0,
                        source: 'stack-env',
                    },
                },
            }),
        );

        const profiles = await importFresh();
        expect(profiles.listServerProfiles()).toHaveLength(1);
        expect(profiles.getActiveServerUrl()).toBe('https://api.example.test');
        expect(profiles.getActiveServerId()).toBe('manual-id');
    });

    it('uses a stored server identity as the active durable scope id while preserving the profile id', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const created = await profiles.upsertServerProfile({ serverUrl: 'https://relay.example.test', name: 'Relay' });
        await profiles.setActiveServerId(created.id, { scope: 'device' });

        expect(profiles.getActiveServerSnapshot().serverId).toBe(created.id);

        await profiles.setServerProfileIdentityForUrl('https://relay.example.test', 'srv_identity_123');

        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: 'srv_identity_123',
            serverUrl: 'https://relay.example.test',
        });
        expect(profiles.getActiveServerId()).toBe('srv_identity_123');
        expect(profiles.getDeviceDefaultServerScopeId()).toBe('srv_identity_123');
        expect(profiles.resolveServerProfileScopeIdForIdentifier(created.id)).toBe('srv_identity_123');
        expect(profiles.resolveServerProfileScopeIdForIdentifier('srv_identity_123')).toBe('srv_identity_123');
        expect(profiles.areServerProfileIdentifiersEquivalent(created.id, 'srv_identity_123')).toBe(true);
        expect(profiles.areServerProfileIdentifiersEquivalent(created.id, 'missing-server')).toBe(false);
        expect(profiles.getServerProfileById('srv_identity_123')?.id).toBe(created.id);
        expect(profiles.getServerProfileLegacyServerIds('srv_identity_123')).toContain(created.id);
    });

    it('resolves a portable server identity to its current device-local routing profile', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const created = await profiles.upsertServerProfile({
            serverUrl: 'https://relay.example.test',
            name: 'Relay',
        });
        await profiles.setServerProfileIdentityForUrl(created.serverUrl, 'srv_identity_123');

        const resolver = profiles as unknown as Readonly<{
            resolveServerProfileForPortableIdentity?: (serverIdentityId: string) => unknown;
        }>;

        expect(resolver.resolveServerProfileForPortableIdentity?.('srv_identity_123')).toEqual(
            expect.objectContaining({
                kind: 'resolved',
                serverIdentityId: 'srv_identity_123',
                profile: expect.objectContaining({
                    id: created.id,
                    serverIdentityId: 'srv_identity_123',
                }),
            }),
        );
    });

    it('does not invalidate the active server generation when the same identity is learned again', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const created = await profiles.upsertServerProfile({ serverUrl: 'https://relay.example.test', name: 'Relay' });
        await profiles.setActiveServerId(created.id, { scope: 'device' });
        await profiles.setServerProfileIdentityForUrl(created.serverUrl, 'srv_identity_123');
        const before = profiles.getActiveServerSnapshot();
        expect(profiles.getServerProfileById('srv_identity_123')).toMatchObject({
            id: created.id,
            serverIdentityId: 'srv_identity_123',
        });
        expect(profiles.listServerProfiles().filter((profile) => (
            profile.serverUrl === created.serverUrl
            || profile.serverIdentityId === 'srv_identity_123'
        ))).toHaveLength(1);
        const listener = vi.fn();
        const unsubscribe = profiles.subscribeActiveServer(listener);

        const learned = await profiles.setServerProfileIdentityForUrl(created.serverUrl, 'srv_identity_123');

        expect(learned?.serverIdentityId).toBe('srv_identity_123');
        expect(profiles.getActiveServerSnapshot()).toBe(before);
        expect(listener).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('publishes non-focused identity learning only to profile subscribers', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();

        const profiles = await importFresh();
        const active = await profiles.upsertServerProfile({ serverUrl: 'https://active.example.test', name: 'Active' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://secondary.example.test', name: 'Secondary' });
        await profiles.setActiveServerId(active.id, { scope: 'device' });
        const before = profiles.getActiveServerSnapshot();
        const activeListener = vi.fn();
        const profileListener = vi.fn();
        const unsubscribeActive = profiles.subscribeActiveServer(activeListener);
        const unsubscribeProfiles = profiles.subscribeServerProfiles(profileListener);

        const learned = await profiles.setServerProfileIdentityForUrl(secondary.serverUrl, 'srv_secondary_identity_1');

        expect(learned?.serverIdentityId).toBe('srv_secondary_identity_1');
        expect(profileListener).toHaveBeenCalledOnce();
        expect(profiles.getActiveServerSnapshot()).toBe(before);
        expect(activeListener).not.toHaveBeenCalled();
        unsubscribeActive();
        unsubscribeProfiles();
    });

    it('rejects a conflicting stable identity without rewriting the profile or its aliases', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const created = await profiles.upsertServerProfile({ serverUrl: 'https://relay.example.test', name: 'Relay' });
        await profiles.setActiveServerId(created.id, { scope: 'device' });

        const learned = await profiles.setServerProfileIdentityForUrl('https://relay.example.test', 'srv_old_identity');
        const beforeConflict = profiles.getServerProfileById('srv_old_identity');
        const rejected = await profiles.setServerProfileIdentityForUrl('https://relay.example.test', 'srv_new_identity');

        expect(learned?.serverIdentityId).toBe('srv_old_identity');
        expect(rejected).toBeNull();
        expect(profiles.getActiveServerSnapshot().serverId).toBe('srv_old_identity');
        expect(profiles.getServerProfileById('srv_old_identity')).toEqual(beforeConflict);
        expect(profiles.getServerProfileById('srv_new_identity')).toBeNull();
        expect(profiles.resolveServerProfileScopeIdForIdentifier('srv_old_identity')).toBe('srv_old_identity');
        expect(profiles.resolveServerProfileScopeIdForIdentifier('srv_new_identity')).toBe('srv_new_identity');
        expect(profiles.areServerProfileIdentifiersEquivalent(created.id, 'srv_old_identity')).toBe(true);
        expect(profiles.areServerProfileIdentifiersEquivalent('srv_old_identity', 'srv_new_identity')).toBe(false);
        expect(profiles.getServerProfileById('srv_old_identity')?.id).toBe(created.id);
        expect(profiles.getServerProfileLegacyServerIds('srv_old_identity')).toContain(created.id);
        expect(profiles.getServerProfileLegacyServerIds('srv_old_identity')).not.toContain('srv_new_identity');
    });

    it('keeps the original portable identity authoritative after a conflicting observation', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const created = await profiles.upsertServerProfile({
            serverUrl: 'https://relay.example.test',
            name: 'Relay',
        });
        await profiles.setServerProfileIdentityForUrl(created.serverUrl, 'srv_old_identity');
        await profiles.setServerProfileIdentityForUrl(created.serverUrl, 'srv_new_identity');

        const resolver = profiles as unknown as Readonly<{
            resolveServerProfileForPortableIdentity?: (serverIdentityId: string) => unknown;
        }>;

        expect(resolver.resolveServerProfileForPortableIdentity?.('srv_old_identity')).toEqual(
            expect.objectContaining({
                kind: 'resolved',
                serverIdentityId: 'srv_old_identity',
                profile: expect.objectContaining({
                    id: created.id,
                    serverIdentityId: 'srv_old_identity',
                }),
            }),
        );
        expect(resolver.resolveServerProfileForPortableIdentity?.('srv_new_identity')).toEqual({
            kind: 'missing',
            serverIdentityId: 'srv_new_identity',
        });
    });

    it('preserves an identityless legacy profile id as an alias when its equivalent URL profile has a stable identity', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        const now = Date.now();
        storage.set('server-state-v1', JSON.stringify({
            activeServerId: 'new-profile',
            servers: {
                'old-profile': {
                    id: 'old-profile',
                    name: 'Old',
                    serverUrl: 'https://relay.example.test',
                    createdAt: now - 10,
                    updatedAt: now - 10,
                    lastUsedAt: now - 10,
                },
                'new-profile': {
                    id: 'new-profile',
                    name: 'New',
                    serverUrl: 'https://relay.example.test/',
                    serverIdentityId: 'srv_new_identity',
                    createdAt: now,
                    updatedAt: now,
                    lastUsedAt: now,
                },
            },
        }));

        const profiles = await importFresh();
        const active = profiles.getActiveServerSnapshot();

        expect(active.serverId).toBe('srv_new_identity');
        expect(profiles.getServerProfileById('old-profile')?.serverIdentityId).toBe('srv_new_identity');
        expect(profiles.getServerProfileLegacyServerIds('srv_new_identity')).toEqual(
            expect.arrayContaining(['old-profile', 'new-profile']),
        );
    });

    it('dedupes conflicting legacy identities before canonical Home URLs while retaining aliases', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        storage.set('server-state-v1', JSON.stringify({
            activeServerId: 'new-profile',
            activeServerIdIsExplicit: true,
            servers: {
                'old-profile': { id: 'old-profile', name: 'Old', serverUrl: 'https://relay.example.test', serverIdentityId: 'srv_old_identity', personalHomeBootstrapCompleted: true, createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
                'new-profile': { id: 'new-profile', name: 'New', serverUrl: 'https://relay.example.test/', serverIdentityId: 'srv_new_identity', createdAt: 2, updatedAt: 2, lastUsedAt: 2 },
            },
        }));
        const profiles = await importFresh();
        expect(profiles.listServerProfiles()).toHaveLength(1);
        expect(profiles.getServerProfileById('srv_old_identity')?.serverIdentityId).toBe('srv_new_identity');
        expect(profiles.getServerProfileById('srv_new_identity')).not.toHaveProperty('personalHomeBootstrapCompleted');
        expect(profiles.getServerProfileLegacyServerIds('srv_new_identity')).toEqual(
            expect.arrayContaining(['old-profile', 'new-profile', 'srv_old_identity']),
        );
    });

    it('keeps host-derived active ids when no server identity is known', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const created = await profiles.upsertServerProfile({ serverUrl: 'https://old-server.example.test', name: 'Old Relay' });
        await profiles.setActiveServerId(created.id, { scope: 'device' });

        expect(profiles.getActiveServerId()).toBe(created.id);
        expect(profiles.getActiveServerSnapshot().serverId).toBe(created.id);
    });

    it('ignores unsafe server identity ids from server payloads', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const created = await profiles.upsertServerProfile({ serverUrl: 'https://relay.example.test', name: 'Relay' });
        await profiles.setActiveServerId(created.id, { scope: 'device' });

        expect(await profiles.setServerProfileIdentityForUrl('https://relay.example.test', 'relay.example.test')).toBeNull();

        expect(profiles.getActiveServerSnapshot().serverId).toBe(created.id);
        const profile = profiles.getServerProfileById(created.id);
        expect(profile?.id).toBe(created.id);
        expect(profile).not.toHaveProperty('serverIdentityId');
        expect(profile).not.toHaveProperty('legacyServerIds');
    });

    it('rejects learning an established stable identity at an unrelated URL', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const lan = await profiles.upsertServerProfile({ serverUrl: 'https://macbook.local:18829', name: 'LAN' });
        const tunnel = await profiles.upsertServerProfile({ serverUrl: 'https://public.example.test', name: 'Public' });

        expect(await profiles.setServerProfileIdentityForUrl(lan.serverUrl, 'srv_shared_identity')).not.toBeNull();
        expect(await profiles.setServerProfileIdentityForUrl(tunnel.serverUrl, 'srv_shared_identity')).toBeNull();

        const all = profiles.listServerProfiles().filter((profile) => profile.serverIdentityId === 'srv_shared_identity');
        expect(all).toHaveLength(1);
        expect(all[0]?.serverUrl).toBe(lan.serverUrl);
        expect(profiles.getServerProfileById(tunnel.id)).toMatchObject({
            id: tunnel.id,
            serverUrl: tunnel.serverUrl,
        });
        expect(profiles.getServerProfileById(tunnel.id)).not.toHaveProperty('serverIdentityId');
    });

    it('surfaces a canonicalization repair write failure without substituting seeded empty state', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        storage.set('server-state-v1', JSON.stringify({
            activeServerId: 'home-a',
            servers: {
                'home-a': { id: 'home-a', name: 'A', serverUrl: 'https://home.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
                'home-a-duplicate': { id: 'home-a-duplicate', name: 'A duplicate', serverUrl: 'https://home.example.test/', createdAt: 2, updatedAt: 2, lastUsedAt: 2 },
            },
        }));
        const originalSet = MMKV.prototype.set;
        const repairWrite = vi.spyOn(MMKV.prototype, 'set').mockImplementation(function (this: MMKV, key, value) {
            if (key === 'server-state-v1') throw new Error('storage unavailable');
            return originalSet.call(this, key, value);
        });

        const profiles = await importFresh();
        try {
            expect(profiles.listServerProfiles()).toEqual([
                expect.objectContaining({ serverUrl: 'https://home.example.test' }),
            ]);
            await expect(profiles.setActiveServerId('home-a', { scope: 'device' })).rejects.toThrow(
                'Failed to persist Home profiles',
            );
        } finally {
            repairWrite.mockRestore();
        }

        expect(profiles.listServerProfiles()).toEqual([
            expect.objectContaining({ serverUrl: 'https://home.example.test' }),
        ]);
    });

    it('does not merge conflicting Home identities merely because their canonical URLs match', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const raw = JSON.stringify({
            activeServerId: 'home-a',
            activeServerIdIsExplicit: true,
            servers: {
                'home-a': { id: 'home-a', name: 'A', serverUrl: 'https://shared.example.test', canonicalServerUrl: 'https://shared.example.test', serverIdentityId: 'srv_identity_a', source: 'manual', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
                'home-b': { id: 'home-b', name: 'B', serverUrl: 'https://shared.example.test', canonicalServerUrl: 'https://shared.example.test', serverIdentityId: 'srv_identity_b', source: 'manual', createdAt: 2, updatedAt: 2, lastUsedAt: 2 },
            },
        });
        new MMKV({ id: scopedStorageId('server-profiles', scope) }).set('server-state-v1', raw);
        const profiles = await importFresh({ resetModules: true });
        const identities = profiles.listServerProfiles().map((profile) => profile.serverIdentityId).filter(Boolean);
        expect(identities).toEqual(expect.arrayContaining(['srv_identity_a', 'srv_identity_b']));
    });

    it.each(['https://cloud.happier.dev', 'https://app.happier.dev'])(
        'seeds api.happier.dev on the hosted web origin %s when no preconfigured env exists',
        async (webOrigin) => {
            const scope = randomScope();
            process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
            delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
            delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
            stubWebRuntime(webOrigin);

            const profiles = await importFresh();
            const all = profiles.listServerProfiles();
            expect(all.some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(true);
            expect(all.some((p) => p.serverUrl === webOrigin)).toBe(false);
            expect(profiles.getActiveServerUrl()).toBe('https://api.happier.dev');
        },
    );

    it('never treats the desktop webview origin as a relay', async () => {
        // The desktop app's page is its own bundle (http://tauri.localhost on Windows, the Metro
        // devUrl in `tauri dev`), not a relay: it must neither seed a profile nor become the local
        // relay that desktop setup hands the CLI as `--local-server-url`.
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        stubWebRuntime('http://tauri.localhost');
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => null });

        const profiles = await importFresh();
        const created = await profiles.upsertServerProfile({ serverUrl: 'https://relay.example.test', name: 'Relay' });
        await profiles.setActiveServerId(created.id, { scope: 'device' });

        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'http://tauri.localhost')).toBe(false);
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
        });
    });

    it('does not seed a same-origin server profile when EXPO_PUBLIC_HAPPY_SERVER_URL is set', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://configured.example.test';
        delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        stubWebRuntime('https://selfhost.example.test');

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();
        expect(all.some((p) => p.serverUrl === 'https://configured.example.test')).toBe(true);
        expect(all.some((p) => p.serverUrl === 'https://selfhost.example.test')).toBe(false);
    });

    it('derives deterministic filesystem-safe ids from server URLs', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const one = await profiles.upsertServerProfile({
            serverUrl: 'https://Example.COM:8443/',
            name: 'Existing',
        });
        const two = await profiles.upsertServerProfile({
            serverUrl: 'https://example.com:8443',
            name: 'Replacement',
        });

        expect(one.id).toBe(two.id);
        expect(two.createdAt).toBe(one.createdAt);
        expect(two.name).toBe('Existing');
        expect(profiles.listServerProfiles().filter((profile) => profile.id === one.id)).toHaveLength(1);
        expect(one.id).toMatch(/^[a-z0-9._-]+$/);
    });

    it('seeds a preconfigured server from EXPO_PUBLIC_HAPPY_SERVER_URL', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_SERVER_URL;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3999';

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();

        expect(all.some((p) => p.serverUrl === 'http://localhost:3999')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('http://localhost:3999');
    });

    it('preserves the stack-env server profile id when rewriting a private IP URL to a loopback hostname on web', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_SERVER_URL;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://172.20.10.4:53288';
        stubWebRuntime('http://happier-dev.localhost:19364');

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();

        expect(all.some((p) => p.id === '172.20.10.4-53288' && p.serverUrl === 'http://happier-dev.localhost:53288')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('http://happier-dev.localhost:53288');
    });

    it('updates an existing stack-env server profile URL without changing its id when the web loopback hostname changes', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_SERVER_URL;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://172.20.10.4:53288';

        stubWebRuntime('http://172.20.10.4:19364');
        const initial = await importFresh();
        expect(initial.listServerProfiles().some((p) => p.id === '172.20.10.4-53288' && p.serverUrl === 'http://172.20.10.4:53288')).toBe(true);

        stubWebRuntime('http://happier-dev.localhost:19364');
        const updated = await importFresh();
        const all = updated.listServerProfiles();

        expect(all.filter((p) => p.id.startsWith('172.20.10.4-53288')).length).toBe(1);
        expect(all.some((p) => p.id === '172.20.10.4-53288' && p.serverUrl === 'http://happier-dev.localhost:53288')).toBe(true);
        expect(updated.getActiveServerUrl()).toBe('http://happier-dev.localhost:53288');
    });

    it('seeds from EXPO_PUBLIC_HAPPIER_SERVER_URL and prefers it over legacy aliases', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL = 'https://canonical.example.test';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://legacy-happy.example.test';
        process.env.EXPO_PUBLIC_SERVER_URL = 'https://legacy-generic.example.test';

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();

        expect(all.some((p) => p.serverUrl === 'https://canonical.example.test')).toBe(true);
        expect(all.some((p) => p.serverUrl === 'https://legacy-happy.example.test')).toBe(false);
        expect(all.some((p) => p.serverUrl === 'https://legacy-generic.example.test')).toBe(false);
        expect(profiles.getActiveServerUrl()).toBe('https://canonical.example.test');
    });

    it('uses EXPO_PUBLIC_SERVER_URL as a final alias when canonical and happy aliases are unset', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        process.env.EXPO_PUBLIC_SERVER_URL = 'https://legacy-generic.example.test';

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();

        expect(all.some((p) => p.serverUrl === 'https://legacy-generic.example.test')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('https://legacy-generic.example.test');
    });

    it('seeds multiple preconfigured servers from EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS = JSON.stringify([
            { name: 'Local 3013', url: 'http://localhost:3013' },
            { name: 'Cloud Alt', url: 'https://api.happier.dev' },
        ]);

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();

        expect(all.some((p) => p.serverUrl === 'http://localhost:3013')).toBe(true);
        expect(all.some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(true);
    });

    it('treats a remote URL added manually as a normal removable profile', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const remote = await profiles.upsertServerProfile({ serverUrl: 'https://api.happier.dev', name: 'remote-manual' });
        expect(profiles.listServerProfiles().some((p) => p.id === remote.id)).toBe(true);
        await expect(profiles.removeServerProfile(remote.id)).resolves.toBeUndefined();
        expect(profiles.listServerProfiles().some((p) => p.id === remote.id)).toBe(false);
    });

    it('reports durable profile removal failure instead of publishing a memory-only success', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const profiles = await importFresh();
        const remote = await profiles.upsertServerProfile({
            serverUrl: 'https://persistence-failure.example.test',
            name: 'Persistence failure',
        });
        const originalSet = MMKV.prototype.set;
        const persistedStateWrite = vi.spyOn(MMKV.prototype, 'set').mockImplementation(function (this: MMKV, key, value) {
            if (key === 'server-state-v1') throw new Error('storage unavailable');
            return originalSet.call(this, key, value);
        });

        try {
            await expect(profiles.removeServerProfile(remote.id)).rejects.toThrow('Failed to persist Home profiles');
        } finally {
            persistedStateWrite.mockRestore();
        }

        expect(profiles.getServerProfileById(remote.id)).not.toBeNull();
    });

    it('emits a server profile generation update when profiles change', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const before = profiles.getServerProfilesGeneration();
        const generations: number[] = [];
        const unsubscribe = profiles.subscribeServerProfiles((generation: number) => {
            generations.push(generation);
        });

        const remote = await profiles.upsertServerProfile({ serverUrl: 'https://relay-gen.example.test', name: 'remote-gen' });
        await profiles.removeServerProfile(remote.id);
        unsubscribe();

        const after = profiles.getServerProfilesGeneration();
        expect(after).toBeGreaterThan(before);
        expect(generations.length).toBeGreaterThan(0);
        expect(generations[generations.length - 1]!).toBe(after);
    });

    it('does not bump server profiles generation when reading an existing Happier Cloud profile', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const before = profiles.getServerProfilesGeneration();

        await profiles.getOrCreateHappierCloudServerProfile();
        const afterCreate = profiles.getServerProfilesGeneration();

        await profiles.getOrCreateHappierCloudServerProfile();
        const afterRead = profiles.getServerProfilesGeneration();

        expect(afterCreate).toBeGreaterThanOrEqual(before);
        expect(afterRead).toBe(afterCreate);
    });

    it('treats a happier-*.localhost web origin as stack context even if EXPO_PUBLIC_HAPPY_SERVER_CONTEXT is unset', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;

        stubWebRuntime('http://happier-qa-agent-2.localhost:8085');

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();
        expect(all.some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(false);
    });

    it('treats a happier-*.localhost web origin as stack context even if EXPO_PUBLIC_HAPPY_SERVER_CONTEXT is an unknown value', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'dev';
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;

        stubWebRuntime('http://happier-qa-agent-2.localhost:8085');

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();
        expect(all.some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(false);
    });

    it('does not let an unknown EXPO_PUBLIC_HAPPY_SERVER_CONTEXT disable localhost stack inference', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'custom-env';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013';

        stubWebRuntime('http://happier-qa-agent-2.localhost:8085');

        const profiles = await importFresh();
        const seeded = profiles.listServerProfiles().find((p) => p.serverUrl === 'http://localhost:3013');
        expect(seeded?.source).toBe('stack-env');
    });

    it('does not re-seed removed preconfigured servers after initial load', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS = JSON.stringify([
            { name: 'Cloud Embedded', url: 'https://api.happier.dev' },
        ]);

        const profiles = await importFresh();
        const seeded = profiles.listServerProfiles().find((p) => p.serverUrl === 'https://api.happier.dev');
        expect(seeded).toBeTruthy();

        await profiles.removeServerProfile(seeded!.id);
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(false);

        expect(profiles.getActiveServerUrl()).toBe('');
        expect(profiles.getResetToDefaultServerId()).toBe('');
        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'https://api.happier.dev')).toBe(false);
    });

    it('dedupes localhost and 127.0.0.1 loopback URLs into one profile without rewriting the stored host form', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const first = await profiles.upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'local-a' });
        const second = await profiles.upsertServerProfile({ serverUrl: 'http://127.0.0.1:3012', name: 'local-b' });

        expect(second.id).toBe(first.id);
        expect(second.name).toBe('local-a');
        expect(second.serverUrl).toBe('http://localhost:3012');
        expect(profiles.listServerProfiles().filter((p) => p.id === first.id)).toHaveLength(1);
    });

    it('dedupes equivalent URLs that differ only by query/hash and stores canonical URL', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        const profiles = await importFresh();
        const first = await profiles.upsertServerProfile({
            serverUrl: 'https://admin:secret@example.com:8443/path/?token=abc#frag',
            name: 'Query Hash Server',
        });
        const second = await profiles.upsertServerProfile({
            serverUrl: 'https://admin:secret@example.com:8443/path',
            name: 'Canonical Server',
        });

        expect(second.id).toBe(first.id);
        expect(second.serverUrl).toBe('https://example.com:8443/path');
        expect(profiles.listServerProfiles().filter((p) => p.id === first.id)).toHaveLength(1);
    });

    it('reset-to-default targets the stack env server in stack context', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013';

        const profiles = await importFresh();
        const other = await profiles.upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'other' });
        await profiles.setActiveServerId(other.id, { scope: 'device' });

        const resetId = profiles.getResetToDefaultServerId();
        expect(resetId).toBeTruthy();

        await profiles.setActiveServerId(resetId, { scope: 'device' });
        expect(profiles.getActiveServerUrl()).toBe('http://localhost:3013');
    });

    it('reset-to-default targets the seeded cloud profile outside stack context when no preconfigured env exists', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;

        const profiles = await importFresh();
        const cloud = profiles.listServerProfiles().find((p) => p.serverUrl === 'https://api.happier.dev');
        expect(cloud).toBeTruthy();

        const one = await profiles.upsertServerProfile({ serverUrl: 'https://one.example.test', name: 'one' });
        const two = await profiles.upsertServerProfile({ serverUrl: 'https://two.example.test', name: 'two' });
        await profiles.setActiveServerId(two.id, { scope: 'device' });
        expect(profiles.getResetToDefaultServerId()).toBe(cloud!.id);
    });

    it('seeds the stack env server profile on load in stack context', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013';

        const profiles = await importFresh();
        const all = profiles.listServerProfiles();
        expect(all.some((p) => p.serverUrl === 'http://localhost:3013')).toBe(true);
        expect(profiles.getActiveServerUrl()).toBe('http://localhost:3013');
    });

    it('does not throw when setting active server id to an unknown value (ignores request)', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013';

        const profiles = await importFresh();
        const other = await profiles.upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'other' });
        await profiles.setActiveServerId(other.id, { scope: 'device' });

        await expect(profiles.setActiveServerId('missing', { scope: 'device' })).resolves.toBeUndefined();
        expect(profiles.getActiveServerUrl()).toBe('http://localhost:3012');
    });
});
