import { vi } from 'vitest';

import type { StorageState } from '@/sync/store/types';
import type { Settings } from '@/sync/domains/settings/settings';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Profile } from '@/sync/domains/profiles/profile';
import { create, type StoreApi, type UseBoundStore } from 'zustand';

import { mergeModuleMock, type MergeModuleMockOptions } from './_shared';
import { createSessionMessagesHooksMock } from './sessionMessagesHooks';

// Published from the storage mock because it overrides storage-module hooks; implemented next door
// so this file stays a flat catalogue of mock factories.
export {
    createSessionMessagesHooksMock,
    type CreateSessionMessagesHooksMockOptions,
    type SessionMessagesHooksMock,
    type TestkitSessionMessagesState,
} from './sessionMessagesHooks';

type StorageModule = typeof import('@/sync/domains/state/storage');
type StorageStoreModule = typeof import('@/sync/domains/state/storageStore');
type StoreHooksModule = typeof import('@/sync/store/hooks');

export type CreateStorageModuleMockOptions = MergeModuleMockOptions<StorageModule>;
export type CreateStorageStoreModuleMockOptions = MergeModuleMockOptions<StorageStoreModule>;
export type CreateStoreHooksModuleMockOptions = MergeModuleMockOptions<StoreHooksModule>;

const testkitProfileDefaults = Object.freeze({
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
} satisfies Profile);

export async function createStorageModuleMock(options: CreateStorageModuleMockOptions): Promise<StorageModule> {
    const mock = await mergeModuleMock<StorageModule>(options);
    if (!('useActiveServerAccountScope' in mock)) {
        Object.defineProperty(mock, 'useActiveServerAccountScope', {
            value: () => null,
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }
    return mock;
}

export async function createStorageStoreModuleMock(
    options: CreateStorageStoreModuleMockOptions,
): Promise<StorageStoreModule> {
    return mergeModuleMock<StorageStoreModule>(options);
}

export async function createStoreHooksModuleMock(
    options: CreateStoreHooksModuleMockOptions,
): Promise<StoreHooksModule> {
    return mergeModuleMock<StoreHooksModule>(options);
}

export async function createPartialStorageModuleMock(
    importOriginal: <T>() => Promise<T>,
    overrides: object,
): Promise<StorageModule> {
    return createStorageModuleMock({
        importOriginal,
        overrides: overrides as Partial<StorageModule>,
    });
}

export function createStorageModuleStub<TOverrides extends object>(overrides: TOverrides): StorageModule {
    // Keep default hook results stable across renders so hooks that include them in dependency arrays
    // (via `useMemo`/`useEffect`) don't thrash in unit tests unless a caller opts in to custom data.
    const allMachines = [] as ReturnType<StorageModule['useAllMachines']>;
    const launchSelectionMachines = [] as ReturnType<StorageModule['useLaunchSelectionMachines']>;
    const machineDisplayById = {} as ReturnType<StorageModule['useMachineDisplayById']>;
    const allSessions = [] as ReturnType<StorageModule['useAllSessions']>;
    const allSessionListRenderables = [] as ReturnType<StorageModule['useAllSessionListRenderables']>;
    const allAttentionSessions = [] as ReturnType<StorageModule['useAllSessionsForAttention']>;
    const allAttentionSessionListRenderables = [] as ReturnType<StorageModule['useAllSessionListRenderablesForAttention']>;
    const sessionOrganizationProjection = {
        schemaVersion: null,
        version: null,
        pinnedSessionIds: [],
        pinsBySessionId: {},
        foldersById: {},
        folderAssignmentsBySessionId: {},
        tagsById: {},
        tagAssignmentsBySessionId: {},
        attentionStandingsBySessionId: {},
        orderEntriesByScopeKey: {},
        labelsByLabelKey: {},
    } satisfies NonNullable<ReturnType<StorageModule['useSessionOrganizationProjection']>>;
    const sessionReferenceTarget = {
        deleted: false,
        metadata: null,
    } satisfies ReturnType<StorageModule['useSessionReferenceTarget']>;
    const sessionTranscriptIds = [] as string[];
    const sessionMessagesById = {} as ReturnType<StorageModule['useSessionMessagesById']>;
    const messagesByRefs = [] as ReturnType<StorageModule['useMessagesByRefs']>;
    const connectedServiceAccountSwitchEvents = [] as ReturnType<StorageModule['useSessionConnectedServiceAccountSwitchEvents']>;
    // Session-message hooks come from the shared factory so a caller can express live agent state by
    // spreading `createSessionMessagesHooksMock({ bySessionId })` into `overrides`.
    const sessionMessagesHooks = createSessionMessagesHooksMock();
    const socketStatus = {
        status: 'disconnected',
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastError: null,
        lastErrorAt: null,
    } satisfies ReturnType<StorageModule['useSocketStatus']>;
    const endpointConnectivity = {
        status: 'idle',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    } satisfies ReturnType<StorageModule['useEndpointConnectivity']>;
    const accountSettingsSyncStatus = {
        state: 'idle',
        lastSyncedAt: null,
    } satisfies ReturnType<StorageModule['useAccountSettingsSyncStatus']>;
    const useSetting = createUseSettingMock();
    const useSettingMutable = createUseSettingMutableMock(useSetting);
    const useLocalSetting = createUseLocalSettingMock();
    const useLocalSettingMutable = createUseLocalSettingMutableMock(useLocalSetting);
    const store = createStorageStoreMock({
        sessions: {},
        machines: {},
        getProjectForSession: () => null,
        mergeSessionListRenderables: () => undefined,
        applySessionListRenderablePatches: () => undefined,
        upsertWorkspaceReviewCommentDraft: () => undefined,
        setWorkspaceReviewCommentDraftIncluded: () => undefined,
        deleteWorkspaceReviewCommentDraft: () => undefined,
        clearWorkspaceReviewCommentDrafts: () => undefined,
    } satisfies Partial<StorageState>);

    const defaults = {
        storage: store,
        getStorage: () => store,
        useSettings: () => ({} as Settings),
        useProfile: () => testkitProfileDefaults,
        useLocalSettings: () => localSettingsDefaults,
        useSetting,
        useSettingMutable,
        useLocalSetting,
        useLocalSettingMutable,
        useSessionMessages: sessionMessagesHooks.useSessionMessages,
        useSessionMessagesById: () => sessionMessagesById,
        useMessagesByRefs: () => messagesByRefs,
        useSessionMessagesReducerState: sessionMessagesHooks.useSessionMessagesReducerState,
        useSessionConnectedServiceAccountSwitchEvents: () => connectedServiceAccountSwitchEvents,
        useSessionTranscriptIds: () => ({ ids: sessionTranscriptIds, isLoaded: true } as const),
        useSessionReadyActivity: () => ({
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
        }),
        useSessionVisibleReadSeq: () => null,
        useSessionSubagentSourceMessages: sessionMessagesHooks.useSessionSubagentSourceMessages,
        useSessionMessagesVersion: () => 0,
        useSessionsReady: () => true,
        useSessionRpcAvailabilityState: () => ({
            sessionExists: false,
            sessionRpcAvailable: false,
        }),
        useAllMachines: () => allMachines,
        useLaunchSelectionMachines: () => launchSelectionMachines,
        useMachineDisplayById: () => machineDisplayById,
        useMachineCliDetectionTarget: () => ({
            daemonStateVersion: 0,
            isOnline: false,
        }),
        useAllSessions: () => allSessions,
        useAllSessionListRenderables: () => allSessionListRenderables,
        useAllSessionsForAttention: () => allAttentionSessions,
        useAllSessionListRenderablesForAttention: () => allAttentionSessionListRenderables,
        useSessionOrganizationProjection: () => sessionOrganizationProjection,
        useMachine: () => null,
        useIsDataReady: () => true,
        useSocketStatus: () => socketStatus,
        useEndpointConnectivity: () => endpointConnectivity,
        useSyncError: () => null,
        useAccountSettingsSyncStatus: () => accountSettingsSyncStatus,
        useActiveServerAccountScope: () => null,
        useArtifacts: () => [],
        useOpenApprovalSessionIds: () => [],
        useWorkspaceReviewCommentsDrafts: () => [],
        useProjectForSession: () => null,
        useSessionForkSupportSource: () => null,
        useSessionInteractionSource: () => null,
        useSessionReferenceTarget: () => sessionReferenceTarget,
        useSessionChatFooterState: () => null,
        useSessionWorkspacePath: () => null,
        useSessionLastMobileSurface: () => null,
        usePersistSessionLastMobileSurface: () => vi.fn(),
        useMachineListByServerId: () => ({}),
        useMachineListStatusByServerId: () => ({}),
    } satisfies Partial<StorageModule>;

    // Stub helpers intentionally allow partial boundary-shaped fixtures without forcing
    // every callsite to satisfy the full storage module surface at compile time.
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
): StorageModule['useSettingMutable'] {
    return ((key: keyof Settings) => [useSetting(key), vi.fn()]) as StorageModule['useSettingMutable'];
}

export type CreateUseLocalSettingMockOptions = Readonly<{
    values?: Partial<LocalSettings>;
    fallback?: (key: keyof LocalSettings) => LocalSettings[keyof LocalSettings];
}>;

export function createUseLocalSettingMock(options: CreateUseLocalSettingMockOptions = {}): StorageModule['useLocalSetting'] {
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
): StorageModule['useLocalSettingMutable'] {
    return ((key: keyof LocalSettings) => [useLocalSetting(key), vi.fn()]) as StorageModule['useLocalSettingMutable'];
}

export function installPartialStorageModuleMock(overrides: object) {
    return async (importOriginal: <T>() => Promise<T>) => createPartialStorageModuleMock(importOriginal, overrides);
}

export function installStorageModuleStub<TOverrides extends object>(overrides: TOverrides) {
    return () => createStorageModuleStub(overrides);
}

export function installPartialStoreHooksModuleMock(overrides: Partial<StoreHooksModule>) {
    return async (importOriginal: <T>() => Promise<T>) =>
        createStoreHooksModuleMock({
            importOriginal,
            overrides,
        });
}

export function installStorageStoreModuleMock(overrides: Partial<StorageStoreModule>) {
    return async (importOriginal: <T>() => Promise<T>) =>
        createStorageStoreModuleMock({
            importOriginal,
            overrides,
        });
}

export function createStorageStoreMock(state: Partial<StorageState>): UseBoundStore<StoreApi<StorageState>> {
    const snapshot = createStorageStateSnapshot(state);

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

export function createReactiveStorageStoreMock(
    state: Partial<StorageState>,
): UseBoundStore<StoreApi<StorageState>> {
    const snapshot = createStorageStateSnapshot(state);
    return create<StorageState>()(() => snapshot);
}

export function createStorageStoreStub(
    readState: () => Partial<StorageState>,
): UseBoundStore<StoreApi<StorageState>> {
    const getSnapshot = () => createStorageStateSnapshot(readState());
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

function createStorageStateSnapshot(state: Partial<StorageState>): StorageState {
    return {
        sessions: {},
        sessionListRenderables: {},
        sessionMessages: {},
        profile: testkitProfileDefaults,
        machines: {},
        machineDisplayById: {},
        machineListByServerId: {},
        machineListStatusByServerId: {},
        artifacts: {},
        automations: {},
        friends: {},
        users: {},
        accountPetsById: {},
        localPetSourcesBySourceKey: {},
        ...state,
    } as StorageState;
}
