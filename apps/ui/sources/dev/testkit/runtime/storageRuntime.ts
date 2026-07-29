import type { Settings } from '@/sync/domains/settings/settings';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { normalizeTrimmedString } from '@/sync/domains/session/listing/normalizeTrimmedString';
import { createReducer } from '@/sync/reducer/reducer';
import type { StorageState } from '@/sync/store/types';
import type { StoreApi, UseBoundStore } from 'zustand';

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
}>;

const createDefaultMutableSetter: StorageMutableSetterFactory = () => () => undefined;

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

const buildSessionListReachabilityRenderableKey: StorageModule['buildSessionListReachabilityRenderableKey'] = (
    serverId,
    sessionId,
) => {
    const normalizedServerId = normalizeTrimmedString(serverId);
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedServerId || !normalizedSessionId) return null;
    return `${normalizedServerId}\u0000${normalizedSessionId}`;
};

function resolveMutableSetterFactory(options?: StorageRuntimeOptions): StorageMutableSetterFactory {
    return options?.createMutableSetter ?? createDefaultMutableSetter;
}

export function isStorageStoreLike(value: unknown): value is StorageStoreLike {
    return value != null
        && typeof value === 'object'
        && typeof (value as { getState?: unknown }).getState === 'function';
}

export function adaptStorageStoreLike(storeLike: StorageStoreLike): StorageStore {
    const select = (selector?: (value: StorageState) => unknown) => {
        const snapshot = storeLike.getState();
        return typeof selector === 'function' ? selector(snapshot) : snapshot;
    };
    return Object.assign(select as StorageStore, {
        getState: storeLike.getState,
        getInitialState: storeLike.getInitialState ?? storeLike.getState,
        setState: storeLike.setState ?? (() => undefined),
        subscribe: storeLike.subscribe ?? (() => () => undefined),
        destroy: storeLike.destroy ?? (() => undefined),
    });
}

export function createStorageModuleStub<TOverrides extends object>(
    overrides: TOverrides,
    options?: StorageRuntimeOptions,
): StorageModule {
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
    const sessionListRowStateByServerId = {} as ReturnType<StorageModule['useSessionListRowStateByServerId']>;
    const sessionListIndexByServerId = {} as ReturnType<StorageModule['useSessionListIndexByServerId']>;
    const useSetting = createUseSettingMock();
    const useSettingMutable = createUseSettingMutableMock(useSetting, options);
    const useLocalSetting = createUseLocalSettingMock();
    const useLocalSettingMutable = createUseLocalSettingMutableMock(useLocalSetting, options);
    const updateWorkspaceScmSnapshot = () => undefined;
    const updateWorkspaceScmSnapshotError = () => undefined;
    const updateWorkspaceScmStatus = () => undefined;
    const pruneWorkspaceScmTouchedPaths = () => undefined;
    const pruneWorkspaceScmCommitSelectionPaths = () => undefined;
    const pruneWorkspaceScmCommitSelectionPatches = () => undefined;
    const store = createStorageStoreMock({
        sessions: {},
        machines: {},
        getProjectForSession: () => null,
        mergeSessionListRenderables: () => undefined,
        applySessionListRenderablePatches: () => undefined,
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
        useSettings: () => ({} as Settings),
        useSetting,
        useSettingMutable,
        useLocalSetting,
        useLocalSettingMutable,
        useActiveServerAccountScope: () => null,
        useSessionLastMobileSurface: () => null,
        usePersistSessionLastMobileSurface: () => () => undefined,
        useProjectLastMobileSurface: () => null,
        usePersistProjectLastMobileSurface: () => () => undefined,
        useProfile: () => store.getState().profile ?? defaultProfile,
        useIsDataReady: () => true,
        useRealtimeStatus: () => 'connected',
        useAutomations: () => [],
        useSessionMessages: () => ({ messages: [], isLoaded: true } as const),
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
        useSessionSubagentSourceMessages: () => [],
        useMachineCliDetectionTarget: () => ({ daemonStateVersion: 0, isOnline: false }),
        useSessionForkSupportSource: () => null,
        useSessionChatFooterState: () => null,
        useSessionCatchingUpNewer: () => false,
        useHasUnreadMessages: () => false,
        useSessionLatestThinkingMessageActivityAtMs: () => null,
        useSessionListMeaningfulActivityAt: () => null,
        useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true } as const),
        useAllMachines: () => allMachines,
        useMachineDisplayById: () => machineDisplayById,
        useAllSessions: () => allSessions,
        useAllSessionsForAttention: () => allAttentionSessions,
        useAllSessionListRenderables: () => allSessionListRenderables,
        useAllSessionListAttentionRows: () => allSessionListAttentionRows,
        useMachine: (machineId: string) => store.getState().machines[machineId] ?? null,
        useSession: () => null,
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
        useSessionListRowStateByServerId: () => sessionListRowStateByServerId,
        useSessionListIndexByServerId: () => sessionListIndexByServerId,
        useSessionOrganizationProjection: () => null,
        useArtifacts: () => [],
        useOpenApprovalSessionIds: () => [],
        useOpenApprovalArtifactsForSession: () => [],
        useEnabledAutomationsCountForSession: () => 0,
        useWorkspaceReviewCommentsDrafts: () => [],
        useMachineListByServerId: () => ({}),
        useMachineListStatusByServerId: () => ({}),
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
    } satisfies Partial<StorageModule>;

    const module = { ...defaults, ...(overrides as Partial<StorageModule>) } as StorageModule;
    const storageOverride = (overrides as { storage?: unknown }).storage;
    const finalStorage = isStorageStoreLike(storageOverride) && typeof storageOverride !== 'function'
        ? adaptStorageStoreLike(storageOverride)
        : module.storage;
    if (finalStorage !== module.storage) {
        return {
            ...module,
            storage: finalStorage,
            getStorage: () => finalStorage,
        };
    }
    return {
        ...module,
        getStorage: () => finalStorage,
    };
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

    return ((key: keyof Settings) => [useSetting(key), createMutableSetter()]) as StorageModule['useSettingMutable'];
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
    const snapshot = {
        sessions: {},
        machines: {},
        sessionMessages: {},
        sessionPending: {},
        sessionListRenderables: {},
        sessionTailContiguousFloorSeq: {},
        ...state,
        localSettings: state.localSettings ?? localSettingsDefaults,
    } as StorageState;

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
    const getSnapshot = (): StorageState => {
        const state = readState();
        return {
            sessions: {},
            machines: {},
            sessionMessages: {},
            sessionPending: {},
            sessionListRenderables: {},
            sessionTailContiguousFloorSeq: {},
            ...state,
            localSettings: state.localSettings ?? localSettingsDefaults,
        } as StorageState;
    };

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
