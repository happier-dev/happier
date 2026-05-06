import type { Settings } from '@/sync/domains/settings/settings';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import type { StorageState } from '@/sync/store/types';
import type { StoreApi, UseBoundStore } from 'zustand';

type StorageModule = typeof import('@/sync/domains/state/storage');

export type StorageMutableSetterFactory = () => (value: unknown) => void;

export type StorageRuntimeOptions = Readonly<{
    createMutableSetter?: StorageMutableSetterFactory;
}>;

const createDefaultMutableSetter: StorageMutableSetterFactory = () => () => undefined;

function resolveMutableSetterFactory(options?: StorageRuntimeOptions): StorageMutableSetterFactory {
    return options?.createMutableSetter ?? createDefaultMutableSetter;
}

export function createStorageModuleStub<TOverrides extends object>(
    overrides: TOverrides,
    options?: StorageRuntimeOptions,
): StorageModule {
    const allMachines = [] as ReturnType<StorageModule['useAllMachines']>;
    const allSessions = [] as ReturnType<StorageModule['useAllSessions']>;
    const allAttentionSessions = [] as ReturnType<StorageModule['useAllSessionsForAttention']>;
    const allSessionListRenderables = [] as ReturnType<StorageModule['useAllSessionListRenderables']>;
    const allSessionListAttentionRows = [] as ReturnType<StorageModule['useAllSessionListAttentionRows']>;
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
        useSettings: () => ({} as Settings),
        useSetting,
        useSettingMutable,
        useLocalSetting,
        useLocalSettingMutable,
        useSessionMessages: () => ({ messages: [], isLoaded: true } as const),
        useSessionMessagesVersion: () => 0,
        useHasUnreadMessages: () => false,
        useSessionLatestThinkingMessageActivityAtMs: () => null,
        useSessionListMeaningfulActivityAt: () => null,
        useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true } as const),
        useAllMachines: () => allMachines,
        useAllSessions: () => allSessions,
        useAllSessionsForAttention: () => allAttentionSessions,
        useAllSessionListRenderables: () => allSessionListRenderables,
        useAllSessionListAttentionRows: () => allSessionListAttentionRows,
        useMachine: (machineId: string) => store.getState().machines[machineId] ?? null,
        useSession: () => null,
        useProjectForSession: (sessionId: string | null) => {
            if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
                return null;
            }
            return store.getState().getProjectForSession?.(sessionId) ?? null;
        },
        useSessionListRenderable: () => null,
        useSessionListRenderableWithServerScope: () => null,
        useSessionListRenderablesById: () => sessionListRenderablesById,
        useSessionListRowStateByServerId: () => sessionListRowStateByServerId,
        useSessionListIndexByServerId: () => sessionListIndexByServerId,
        useArtifacts: () => [],
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
        useSyncError: () => null,
    } satisfies Partial<StorageModule>;

    return { ...defaults, ...(overrides as Partial<StorageModule>) } as StorageModule;
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
