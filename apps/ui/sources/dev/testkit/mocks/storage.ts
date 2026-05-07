import { vi } from 'vitest';

import type { StorageState } from '@/sync/store/types';
import type { Settings } from '@/sync/domains/settings/settings';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import type { StoreApi, UseBoundStore } from 'zustand';

import { mergeModuleMock, type MergeModuleMockOptions } from './_shared';

type StorageModule = typeof import('@/sync/domains/state/storage');

export type CreateStorageModuleMockOptions = MergeModuleMockOptions<StorageModule>;

export async function createStorageModuleMock(options: CreateStorageModuleMockOptions): Promise<StorageModule> {
    return mergeModuleMock<StorageModule>(options);
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
    const allSessions = [] as ReturnType<StorageModule['useAllSessions']>;
    const allSessionListRenderables = [] as ReturnType<StorageModule['useAllSessionListRenderables']>;
    const allAttentionSessions = [] as ReturnType<StorageModule['useAllSessionsForAttention']>;
    const allAttentionSessionListRenderables = [] as ReturnType<StorageModule['useAllSessionListRenderablesForAttention']>;
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
    const useSetting = createUseSettingMock();
    const useSettingMutable = createUseSettingMutableMock(useSetting);
    const useLocalSetting = createUseLocalSettingMock();
    const useLocalSettingMutable = createUseLocalSettingMutableMock(useLocalSetting);
    const store = createStorageStoreMock({
        sessions: {},
        machines: {},
        getProjectForSession: () => null,
        applySessionListRenderablePatches: () => undefined,
        upsertWorkspaceReviewCommentDraft: () => undefined,
        setWorkspaceReviewCommentDraftIncluded: () => undefined,
        deleteWorkspaceReviewCommentDraft: () => undefined,
        clearWorkspaceReviewCommentDrafts: () => undefined,
    } satisfies Partial<StorageState>);

    const defaults = {
        storage: store,
        useSettings: () => ({} as Settings),
        useLocalSettings: () => localSettingsDefaults,
        useSetting,
        useSettingMutable,
        useLocalSetting,
        useLocalSettingMutable,
        useSessionMessages: () => ({ messages: [], isLoaded: true } as const),
        useSessionMessagesVersion: () => 0,
        useAllMachines: () => allMachines,
        useAllSessions: () => allSessions,
        useAllSessionListRenderables: () => allSessionListRenderables,
        useAllSessionsForAttention: () => allAttentionSessions,
        useAllSessionListRenderablesForAttention: () => allAttentionSessionListRenderables,
        useMachine: () => null,
        useSocketStatus: () => socketStatus,
        useEndpointConnectivity: () => endpointConnectivity,
        useSyncError: () => null,
        useArtifacts: () => [],
        useWorkspaceReviewCommentsDrafts: () => [],
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

export function createStorageStoreMock(state: Partial<StorageState>): UseBoundStore<StoreApi<StorageState>> {
    const snapshot = state as StorageState;

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
