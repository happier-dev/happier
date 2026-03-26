import type { StorageState } from '@/sync/store/types';
import type { Settings } from '@/sync/domains/settings/settings';
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
    const store = createStorageStoreMock({
        sessions: {},
        machines: {},
        getProjectForSession: () => null,
    } satisfies Partial<StorageState>);

    const defaults = {
        storage: store,
        useSettings: () => ({} as Settings),
        useSetting: createUseSettingMock(),
        useAllMachines: () => allMachines,
        useAllSessions: () => allSessions,
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
