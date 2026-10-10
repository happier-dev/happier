import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import {
    settingsParse,
    type Settings,
    type WritableSettingsKey,
} from '@/sync/domains/settings/settings';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { createReducer } from "@happier-dev/session-core/reducer";
import type { StorageState } from '@/sync/store/types';
import { readCurrentProjectAccountRows, readProjectWorkspaceRefs, EMPTY_PROJECT_ORGANIZATIONS, EMPTY_WORKSPACE_RELATIONSHIPS, EMPTY_PINNED_WORKSPACE_REF_IDS } from '@/sync/store/domains/projectAccountRows';
import { authoringMemoryDefaults } from '@/sync/store/domains/authoringMemory';
import { readSessionMessagesSnapshot } from '@/sync/store/sessionMessagesSnapshot';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { CurrentSecretBindingsByProfileId } from '@/sync/domains/settings/secretBindings';

const { isDeepStrictEqual } = getVitestNodeBuiltin<{
    isDeepStrictEqual: (left: unknown, right: unknown) => boolean;
}>('node:util');

type StorageModule = typeof import('@/sync/domains/state/storage');
type Profile = ReturnType<StorageModule['useProfile']>;
type StorageStore = StorageModule['storage'];
type StorageStoreLike = Readonly<{
    getState: () => StorageState;
    getInitialState?: () => StorageState;
    setState?: StoreApi<StorageState>['setState'];
    subscribe?: StoreApi<StorageState>['subscribe'];
    destroy?: () => void;
}>;

export type StorageMutableSetterFactory = () => (value: unknown) => void;

export type StorageRuntimeOptions = Readonly<{
    createMutableSetter?: StorageMutableSetterFactory;
    readCurrentSecretBindingsByProfileId?: () => CurrentSecretBindingsByProfileId;
}>;

const createDefaultMutableSetter: StorageMutableSetterFactory = () => () => undefined;
const emptyCurrentSecretBindingsByProfileId: CurrentSecretBindingsByProfileId = {};
const defaultStorageSettings = settingsParse({});

const defaultProfile: Profile = Object.freeze({
    id: '',
    timestamp: 0,
    firstName: null,
    lastName: null,
    username: null,
    avatar: null,
    linkedProviders: [],
    connectedServices: [],
    connectedServicesV2: [],
    connectedServiceCredentialRevisionsV1: [],
    connectedAccountsV4: [],
    connectedAccountGroupsV4: [],
});

const buildSessionListReachabilityRenderableKey: StorageModule['buildSessionListReachabilityRenderableKey'] =
    buildSessionListServerScopedRowKey;

// Stable identity so a multi-Home organization consumer does not rebuild its view state on
// every render, matching the real selector's shared empty result.
const emptySessionOrganizationProjectionsByServerId: ReturnType<
    StorageModule['useSessionOrganizationProjections']
> = Object.freeze({});

function resolveMutableSetterFactory(options?: StorageRuntimeOptions): StorageMutableSetterFactory {
    return options?.createMutableSetter ?? createDefaultMutableSetter;
}

export function createUseCurrentSecretBindingsByProfileIdMutableMock(
    _useSetting: StorageModule['useSetting'],
    options?: StorageRuntimeOptions,
): StorageModule['useCurrentSecretBindingsByProfileIdMutable'] {
    const createMutableSetter = resolveMutableSetterFactory(options);
    return () => {
        const value = options?.readCurrentSecretBindingsByProfileId?.() ?? emptyCurrentSecretBindingsByProfileId;
        const setter = createMutableSetter();
        return [
            value && typeof value === 'object' && !Array.isArray(value)
                ? value
                : emptyCurrentSecretBindingsByProfileId,
            async next => { await setter(next); },
        ];
    };
}

/**
 * Reproduces the referential stability the real storage hooks give their readers.
 *
 * `useSetting`, `useProfile` and `useActiveServerAccountScope` all select out of one
 * immutable zustand snapshot through `useShallow`, so an unchanged value is handed back
 * as the SAME object on every render. Consumers depend on that: a value derived from the
 * reader (a `useMemo` parse, an effect dependency) only changes when the setting really
 * changed. A fixture that rebuilds its object literal on every call breaks the contract —
 * every derived identity churns per render, and an effect that publishes into a store the
 * same tree subscribes to then re-renders forever instead of settling.
 *
 * The returned reader memoizes per first argument, which is the hooks' setting key (and
 * `undefined` for the argument-less readers), and hands back the previous value whenever
 * the fixture produced an equal one.
 */
export function createStableStorageReader<TArgs extends readonly unknown[], TValue>(
    read: (...args: TArgs) => TValue,
): (...args: TArgs) => TValue {
    const previousByKey = new Map<unknown, TValue>();
    return (...args: TArgs) => {
        const key = args[0];
        const next = read(...args);
        if (previousByKey.has(key)) {
            const previous = previousByKey.get(key) as TValue;
            if (previous === next || isDeepStrictEqual(previous, next)) return previous;
        }
        previousByKey.set(key, next);
        return next;
    };
}

export function isStorageStoreLike(value: unknown): value is StorageStoreLike {
    return value != null
        && (typeof value === 'object' || typeof value === 'function')
        && typeof (value as { getState?: unknown }).getState === 'function';
}

/**
 * Completes a store-like fixture into the real `storage` export's shape.
 *
 * The production export is a zustand bound store: callable as a selector AND
 * carrying `getState`/`subscribe`/`setState`/`getInitialState`/`destroy`.
 * Readers use both halves — `useSyncExternalStore(storage.subscribe, …)` is a
 * live production pattern — so a fixture that supplies only some of them must
 * be completed here rather than crashing the reader at passive-effect mount.
 * A callable fixture keeps its own selector: some fixtures subscribe from
 * inside it to stay reactive, and replacing it with a snapshot read would
 * silently make those tests static.
 */
export function adaptStorageStoreLike(storeLike: StorageStoreLike): StorageStore {
    // Both callable and hand-rolled store fixtures may return partial snapshots, and readers such
    // as `state.sessions[sessionId]` index into records the real store always
    // exposes. Complete those snapshots at this boundary — the same minimal
    // real shape the canonical store mocks use — and memoize per raw snapshot
    // so unchanged fixtures keep the referential stability readers rely on.
    const rawGetState = storeLike.getState;
    const isCallableFixture = typeof storeLike === 'function';
    const completedByRawSnapshot = new WeakMap<StorageState, StorageState>();
    const completeSnapshot = (raw: StorageState): StorageState => {
        const cached = completedByRawSnapshot.get(raw);
        if (cached) return cached;
        const completed = completePartialStorageState(raw);
        completedByRawSnapshot.set(raw, completed);
        return completed;
    };
    const readCompletedState = () => completeSnapshot(rawGetState());
    const select = isCallableFixture
        ? (selector?: (value: StorageState) => unknown) => (storeLike as unknown as StorageStore)((raw) => {
            const snapshot = completeSnapshot(raw);
            return typeof selector === 'function' ? selector(snapshot) : snapshot;
        })
        : (selector?: (value: StorageState) => unknown) => {
            const snapshot = readCompletedState();
            return typeof selector === 'function' ? selector(snapshot) : snapshot;
        };
    return Object.assign(select as StorageStore, {
        getState: readCompletedState,
        getInitialState: storeLike.getInitialState
            ? () => completeSnapshot(storeLike.getInitialState!())
            : readCompletedState,
        setState: storeLike.setState ?? (() => undefined),
        subscribe: storeLike.subscribe ?? (() => () => undefined),
        destroy: storeLike.destroy ?? (() => undefined),
    });
}

/**
 * The real storage store always exposes these identity/list records, even when
 * empty. A minimal fixture must mirror that boundary so readers can index into
 * them without guarding; fixture values always win over the empty base.
 */
function completePartialStorageState(state: Partial<StorageState>): StorageState {
    return {
        sessions: {},
        machines: {},
        sessionMessages: {},
        sessionLastViewed: {},
        sessionPending: {},
        sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {},
        archivedSessionListMembershipByServerId: {},
        sessionTailContiguousBoundary: {},
        sessionTranscriptLoadIssues: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        sessionListQueryMembershipByKey: {},
        authoringMemory: authoringMemoryDefaults,
        applyAuthoringMemory: () => undefined,
        resetAuthoringMemory: () => undefined,
        projectAccountRows: null,
        pinnedWorkspaceRefIds: EMPTY_PINNED_WORKSPACE_REF_IDS,
        applyLocalSettings: () => undefined,
        ...state,
        settings: state.settings
            ? Object.keys(defaultStorageSettings).every((key) => Object.prototype.hasOwnProperty.call(state.settings, key))
                ? state.settings
                : { ...defaultStorageSettings, ...state.settings }
            : defaultStorageSettings,
        profile: state.profile ?? defaultProfile,
        localSettings: state.localSettings
            ? Object.keys(localSettingsDefaults).every((key) => Object.prototype.hasOwnProperty.call(state.localSettings, key))
                ? state.localSettings
                : { ...localSettingsDefaults, ...state.localSettings }
            : localSettingsDefaults,
    } as StorageState;
}

export function createStorageModuleStub<TOverrides extends object>(
    overrides: TOverrides,
    options?: StorageRuntimeOptions,
): StorageModule {
    const defaultSettings = settingsParse({});
    const allMachines = [] as ReturnType<StorageModule['useAllMachines']>;
    const machineDisplayById = {} as ReturnType<StorageModule['useMachineDisplayById']>;
    const allSessions = [] as ReturnType<StorageModule['useAllSessions']>;
    const allAttentionSessions = [] as ReturnType<StorageModule['useAllSessionsForAttention']>;
    const allSessionListRenderables = [] as ReturnType<StorageModule['useAllSessionListRenderables']>;
    const allSessionListAttentionRows = [] as ReturnType<StorageModule['useAllSessionListAttentionRows']>;
    const sessionTranscriptIds = [] as string[];
    const sessionMessagesById = {} as ReturnType<StorageModule['useSessionMessagesById']>;
    const messagesByRefs = [] as ReturnType<StorageModule['useMessagesByRefs']>;
    const sessionMessagesReducerState = createReducer();
    const sessionListRenderablesById = {} as ReturnType<StorageModule['useSessionListRenderablesById']>;
    const sessionListRowsByServerId = {} as ReturnType<StorageModule['useSessionListRowsByServerId']>;
    const ordinarySessionListMembershipByServerId = {} as ReturnType<StorageModule['useOrdinarySessionListMembershipByServerId']>;
    const archivedSessionListMembershipByServerId = {} as ReturnType<StorageModule['useArchivedSessionListMembershipByServerId']>;
    const sessionListIndexByServerId = {} as ReturnType<StorageModule['useSessionListIndexByServerId']>;
    const useSetting = createUseSettingMock();
    const useSettingMutable = createUseSettingMutableMock(useSetting, options);
    const useCurrentSecretBindingsByProfileIdMutable =
        createUseCurrentSecretBindingsByProfileIdMutableMock(useSetting, options);
    const useLocalSetting = createUseLocalSettingMock();
    const useLocalSettingMutable = createUseLocalSettingMutableMock(useLocalSetting, options);
    const updateWorkspaceScmSnapshot = () => undefined;
    const updateWorkspaceScmSnapshotError = () => undefined;
    const updateWorkspaceScmStatus = () => undefined;
    const pruneWorkspaceScmTouchedPaths = () => undefined;
    const pruneWorkspaceScmCommitSelectionPaths = () => undefined;
    const pruneWorkspaceScmCommitSelectionPatches = () => undefined;
    // A transcript session reference is present-and-unnamed by default: not deleted, and with no
    // cached metadata, which is what an uncached (for example archived) target looks like.
    const sessionReferenceTarget = {
        deleted: false,
        metadata: null,
    } satisfies ReturnType<StorageModule['useSessionReferenceTarget']>;
    const store = createStorageStoreMock({
        sessions: {},
        machines: {},
        getProjectForSession: () => null,
        updateWorkspaceScmSnapshot,
        updateWorkspaceScmSnapshotError,
        updateWorkspaceScmStatus,
        pruneWorkspaceScmTouchedPaths,
        pruneWorkspaceScmCommitSelectionPaths,
        pruneWorkspaceScmCommitSelectionPatches,
        clearSessionReviewCommentDrafts: () => undefined,
        upsertWorkspaceReviewCommentDraft: () => undefined,
        deleteWorkspaceReviewCommentDraft: () => undefined,
        clearWorkspaceReviewCommentDrafts: () => undefined,
    } satisfies Partial<StorageState>);

    const defaults = {
        storage: store,
        getStorage: () => store,
        useSettings: () => defaultSettings,
        useSettingsSelector: <T>(selector: (settings: Settings) => T): T => selector(defaultSettings),
        useSetting,
        useSettingMutable,
        useCurrentSecretBindingsByProfileIdMutable,
        useLocalSetting,
        useLocalSettingMutable,
        useActiveServerAccountScope: () => null,
        useSessionLastMobileSurface: () => null,
        usePersistSessionLastMobileSurface: () => () => undefined,
        useSessionCompanionPreferenceSlot: () => ({ storageKey: null, stored: undefined }),
        useMutateSessionCompanionPreference: () => () => false,
        useProjectLastMobileSurface: () => null,
        useProjectLastMobileSurfacesByWorkspaceRefId: () => ({}),
        usePersistProjectLastMobileSurface: () => () => undefined,
        useProfile: () => store.getState().profile ?? defaultProfile,
        useIsDataReady: () => true,
        useAutomations: () => [],
        useWorkflowRunRows: () => [],
        useSessionMessages: () => ({ messages: [], isLoaded: true } as const),
        readSessionMessagesSnapshot,
        useSessionMessagesReducerState: () => sessionMessagesReducerState,
        useSessionMessagesById: () => sessionMessagesById,
        useMessagesByRefs: () => messagesByRefs,
        useSessionMessagesVersion: () => 0,
        useSessionTranscriptIds: () => ({ ids: sessionTranscriptIds, isLoaded: true } as const),
        useSessionVisibleReadSeq: () => 0,
        useSessionReadyActivity: () => ({
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
        }),
        useSessionUsage: () => null,
        useSessionProjectScmSnapshot: () => null,
        useSessionDirectoryKind: () => null,
        useSessionSubagentSourceMessages: () => [],
        useSessionSidechainMessages: () => [],
        useMachineCliDetectionTarget: () => ({ daemonStateVersion: 0, isOnline: false }),
        useSessionForkSupportSource: () => null,
        useSessionInteractionSource: () => null,
        useSessionReferenceTarget: () => sessionReferenceTarget,
        useSessionChatFooterState: () => null,
        useSessionCatchingUpNewer: () => false,
        useHasUnreadMessages: () => false,
        useSessionLatestThinkingMessageActivityAtMs: () => null,
        useSessionListMeaningfulActivityAt: () => null,
        useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true } as const),
        useAllMachines: () => allMachines,
        useMachineDisplayById: () => machineDisplayById,
        useMachineDisplayNamesById: () => ({}),
        useAllSessions: () => allSessions,
        useFriendRequestCount: () => 0,
        useAllSessionsForAttention: () => allAttentionSessions,
        useAllSessionListRenderables: () => allSessionListRenderables,
        useAllSessionListAttentionRows: () => allSessionListAttentionRows,
        useMachine: (machineId: string) => store.getState().machines[machineId] ?? null,
        useSession: () => null,
        // No session records in the stub, so every projection sees the absent source.
        useSessionDisplayNameProjections: <T,>(addresses: ReadonlyArray<unknown>, project: (source: null) => T): readonly T[] => addresses.map(() => project(null)),
        useSessionWorkspacePath: () => null,
        useSessionRpcAvailabilityState: () => ({
            sessionExists: false,
            sessionRpcAvailable: false,
        }),
        useProjectForSession: (sessionId: string | null) => {
            if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
                return null;
            }
            return store.getState().getProjectForSession?.(sessionId) ?? null;
        },
        useSessionListRenderable: () => null,
        useSessionListRenderableWithServerScope: () => null,
        buildSessionListReachabilityRenderableKey,
        useSessionListReachabilityRenderablesForItems: () => new Map(),
        useSessionListRowRenderablesForItems: () => new Map(),
        useSessionListRenderablesById: () => sessionListRenderablesById,
        useSessionListRowsByServerId: () => sessionListRowsByServerId,
        useOrdinarySessionListMembershipByServerId: () => ordinarySessionListMembershipByServerId,
        useArchivedSessionListMembershipByServerId: () => archivedSessionListMembershipByServerId,
        useSessionListIndexByServerId: () => sessionListIndexByServerId,
        useSessionOrganizationProjection: () => null,
        useSessionOrganizationProjections: () => emptySessionOrganizationProjectionsByServerId,
        useArtifacts: () => [],
        useArtifact: () => null,
        useOpenApprovalSessionReferences: () => [],
        useOpenApprovalArtifactsForSession: () => [],
        useEnabledAutomationsCountForSession: () => 0,
        useWorkspaceReviewCommentsDrafts: () => [],
        useMachineListByServerId: () => ({}),
        useMachineListStatusByServerId: () => ({}),
        useMachineListForServer: () => null,
        useMachineListStatusForServer: () => 'idle' as const,
        useIsActiveMachineListSettled: () => true,
        useServerScopedMachine: () => null,
        useWorkspaceScmSnapshot: () => null,
        useWorkspaceScmSnapshotError: () => null,
        useSocketStatus: () => ({
            status: 'connected',
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            lastError: null,
            lastErrorAt: null,
        }),
        useEndpointConnectivity: () => ({
            status: 'online',
            reason: null,
            attempt: 0,
            nextRetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        }),
        useEndpointStatus: () => 'online',
        useSyncError: () => null,
        useAuthoringMemoryField: ((name: keyof typeof authoringMemoryDefaults) =>
            (store.getState().authoringMemory ?? authoringMemoryDefaults)[name]) as StorageModule['useAuthoringMemoryField'],
    } satisfies Partial<StorageModule>;

    const module = { ...defaults, ...(overrides as Partial<StorageModule>) } as StorageModule;
    const moduleWithSettingReader: StorageModule = Object.prototype.hasOwnProperty.call(overrides, 'useSettingMutable')
        ? module
        : { ...module, useSettingMutable: createUseSettingMutableMock(module.useSetting, options) };
    const moduleWithCurrentSecretBindings: StorageModule = Object.prototype.hasOwnProperty.call(
        overrides,
        'useCurrentSecretBindingsByProfileIdMutable',
    )
        ? moduleWithSettingReader
        : {
            ...moduleWithSettingReader,
            useCurrentSecretBindingsByProfileIdMutable:
                createUseCurrentSecretBindingsByProfileIdMutableMock(moduleWithSettingReader.useSetting, options),
        };
    const storageOverride = (overrides as { storage?: unknown }).storage;
    const finalStorage = isStorageStoreLike(storageOverride)
        ? adaptStorageStoreLike(storageOverride)
        : moduleWithCurrentSecretBindings.storage;
    // The real hook closes over storageStore.getStorage, not this fixture's facade.
    // Read the injected store here, delegating all owner-layout and machine policy to production.
    const sessionMachineReader = Object.prototype.hasOwnProperty.call(overrides, 'useSessionMachineId')
        ? {}
        : { useSessionMachineId: (sessionId: string) => finalStorage((state) => {
            const session = state.sessions[sessionId];
            return session ? resolveSessionMachineId(readSessionOwnerMetadataView(session)) : null;
        }) };
    const projectRowReaders = createProjectAccountRowHookMocks(finalStorage, overrides);
    if (finalStorage !== moduleWithCurrentSecretBindings.storage) {
        return {
            ...moduleWithCurrentSecretBindings,
            storage: finalStorage,
            getStorage: () => finalStorage,
            ...sessionMachineReader,
            ...projectRowReaders,
            ...(!Object.prototype.hasOwnProperty.call(overrides, 'useAuthoringMemoryField') ? {
                useAuthoringMemoryField: ((name: keyof typeof authoringMemoryDefaults) =>
                    (finalStorage.getState().authoringMemory ?? authoringMemoryDefaults)[name]) as StorageModule['useAuthoringMemoryField'],
            } : {}),
        };
    }
    return {
        ...moduleWithCurrentSecretBindings,
        getStorage: () => finalStorage,
        ...sessionMachineReader,
        ...projectRowReaders,
    };
}

/** Boundary hook mocks select the same explicit row projection as production. */
export function createProjectAccountRowHookMocks(storage: StorageStore, overrides: object = {}): Partial<StorageModule> {
    const readers = {
        useProjectAccountRows: () => storage(readCurrentProjectAccountRows),
        useWorkspaceRefs: () => storage(readProjectWorkspaceRefs),
        useProjectOrganizations: () => storage(state => readCurrentProjectAccountRows(state)?.organizations ?? EMPTY_PROJECT_ORGANIZATIONS),
        useWorkspaceSyncRelationships: () => storage(state => readCurrentProjectAccountRows(state)?.relationships ?? EMPTY_WORKSPACE_RELATIONSHIPS),
        usePinnedWorkspaceRefIds: () => storage(state => readCurrentProjectAccountRows(state) ? state.pinnedWorkspaceRefIds : EMPTY_PINNED_WORKSPACE_REF_IDS),
    } satisfies Partial<StorageModule>;
    return Object.fromEntries(Object.entries(readers).filter(([key]) => !Object.prototype.hasOwnProperty.call(overrides, key)));
}

export type CreateUseSettingMockOptions = Readonly<{
    values?: Partial<Settings>;
    fallback?: (key: keyof Settings) => Settings[keyof Settings];
}>;

export function createUseSettingMock(options: CreateUseSettingMockOptions = {}): StorageModule['useSetting'] {
    const values = options.values ?? {};
    const fallback = options.fallback;

    return ((key: keyof Settings) => {
        if (Object.prototype.hasOwnProperty.call(values, key)) {
            return values[key];
        }
        return fallback?.(key);
    }) as StorageModule['useSetting'];
}

export function createUseSettingMutableMock(
    useSetting: StorageModule['useSetting'],
    options?: StorageRuntimeOptions,
): StorageModule['useSettingMutable'] {
    const createMutableSetter = resolveMutableSetterFactory(options);

    return ((key: WritableSettingsKey) => [
        useSetting(key),
        createMutableSetter(),
    ]) as StorageModule['useSettingMutable'];
}

export type CreateUseLocalSettingMockOptions = Readonly<{
    values?: Partial<LocalSettings>;
    fallback?: (key: keyof LocalSettings) => LocalSettings[keyof LocalSettings];
}>;

export function createUseLocalSettingMock(
    options: CreateUseLocalSettingMockOptions = {},
): StorageModule['useLocalSetting'] {
    const values = options.values ?? {};
    const fallback = options.fallback;

    return ((key: keyof LocalSettings) => {
        if (Object.prototype.hasOwnProperty.call(values, key)) {
            return values[key];
        }
        return fallback?.(key) ?? localSettingsDefaults[key];
    }) as StorageModule['useLocalSetting'];
}

export function createUseLocalSettingMutableMock(
    useLocalSetting: StorageModule['useLocalSetting'],
    options?: StorageRuntimeOptions,
): StorageModule['useLocalSettingMutable'] {
    const createMutableSetter = resolveMutableSetterFactory(options);

    return ((key: keyof LocalSettings) => [
        useLocalSetting(key),
        createMutableSetter(),
    ]) as StorageModule['useLocalSettingMutable'];
}

export function createStorageStoreMock(state: Partial<StorageState>): UseBoundStore<StoreApi<StorageState>> {
    const snapshot = completePartialStorageState(state);

    return Object.assign(
        ((selector?: (value: StorageState) => unknown) =>
            typeof selector === 'function' ? selector(snapshot) : snapshot) as UseBoundStore<StoreApi<StorageState>>,
        {
            getState: () => snapshot,
            getInitialState: () => snapshot,
            setState: () => undefined,
            subscribe: () => () => undefined,
            destroy: () => undefined,
        } satisfies Pick<StoreApi<StorageState>, 'getState' | 'getInitialState' | 'setState' | 'subscribe'> & {
            destroy: () => void;
        },
    );
}

export function createLiveStorageStoreMock(readState: () => Partial<StorageState>): UseBoundStore<StoreApi<StorageState>> {
    const getSnapshot = (): StorageState => completePartialStorageState(readState());

    return Object.assign(
        ((selector?: (value: StorageState) => unknown) => {
            const snapshot = getSnapshot();
            return typeof selector === 'function' ? selector(snapshot) : snapshot;
        }) as UseBoundStore<StoreApi<StorageState>>,
        {
            getState: getSnapshot,
            getInitialState: getSnapshot,
            setState: () => undefined,
            subscribe: () => () => undefined,
            destroy: () => undefined,
        } satisfies Pick<StoreApi<StorageState>, 'getState' | 'getInitialState' | 'setState' | 'subscribe'> & {
            destroy: () => void;
        },
    );
}
