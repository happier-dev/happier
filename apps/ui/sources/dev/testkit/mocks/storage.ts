import { vi } from 'vitest';

import type {
    Settings,
    WritableSettingsKey,
} from '@/sync/domains/settings/settings';
import type { StorageState } from '@/sync/store/types';
import type { StoreApi, UseBoundStore } from 'zustand';

import {
    createStorageModuleStub as createStorageModuleRuntimeStub,
    createLiveStorageStoreMock as createLiveStorageRuntimeStoreMock,
    createStorageStoreMock as createStorageRuntimeStoreMock,
    createUseCurrentSecretBindingsByProfileIdMutableMock,
    createUseLocalSettingMock as createUseLocalSettingRuntimeMock,
    createUseLocalSettingMutableMock as createUseLocalSettingRuntimeMutableMock,
    createUseSettingMock as createUseSettingRuntimeMock,
    createUseSettingMutableMock as createUseSettingRuntimeMutableMock,
    createStableStorageReader,
    adaptStorageStoreLike,
    isStorageStoreLike,
    type CreateUseLocalSettingMockOptions as CreateUseLocalSettingRuntimeMockOptions,
    type CreateUseSettingMockOptions as CreateUseSettingRuntimeMockOptions,
} from '../runtime/storageRuntime';
import { mergeModuleMock, type MergeModuleMockOptions } from './_shared';

type StorageModule = typeof import('@/sync/domains/state/storage');
type StorageStoreModule = typeof import('@/sync/domains/state/storageStore');
type MutableSetter = (value: unknown) => void;

export type CreateStorageModuleMockOptions = MergeModuleMockOptions<StorageModule>;
export type CreateStorageStoreModuleMockOptions = MergeModuleMockOptions<StorageStoreModule>;
export type CreateUseSettingMockOptions = CreateUseSettingRuntimeMockOptions;
export type CreateUseLocalSettingMockOptions = CreateUseLocalSettingRuntimeMockOptions;

function createVitestMutableSetter(): MutableSetter {
    return vi.fn<MutableSetter>();
}

export async function createStorageModuleMock(options: CreateStorageModuleMockOptions): Promise<StorageModule> {
    const module = await mergeModuleMock<StorageModule>(options);
    const overrides = options.overrides as Partial<StorageModule>;
    const moduleWithCurrentSecretBindings: StorageModule = !Object.prototype.hasOwnProperty.call(
        overrides,
        'useCurrentSecretBindingsByProfileIdMutable',
    ) && (
        Object.prototype.hasOwnProperty.call(overrides, 'useSetting')
        || Object.prototype.hasOwnProperty.call(overrides, 'useSettingMutable')
    )
        ? {
            ...module,
            useCurrentSecretBindingsByProfileIdMutable:
                createUseCurrentSecretBindingsByProfileIdMutableMock(module.useSetting, {
                    createMutableSetter: createVitestMutableSetter,
                }),
        }
        : module;
    const storageOverride = (options.overrides as { storage?: unknown }).storage;
    if (isStorageStoreLike(storageOverride) && typeof storageOverride !== 'function') {
        const storage = adaptStorageStoreLike(storageOverride);
        return {
            ...moduleWithCurrentSecretBindings,
            storage,
            getStorage: () => storage,
        };
    }
    if (typeof (options.overrides as { getStorage?: unknown }).getStorage === 'function') {
        return moduleWithCurrentSecretBindings;
    }
    return {
        ...moduleWithCurrentSecretBindings,
        getStorage: () => moduleWithCurrentSecretBindings.storage,
    };
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

export async function createStorageStoreModuleMock(
    options: CreateStorageStoreModuleMockOptions,
): Promise<StorageStoreModule> {
    return mergeModuleMock<StorageStoreModule>(options);
}

export function createStorageModuleStub<TOverrides extends object>(overrides: TOverrides): StorageModule {
    return createStorageModuleRuntimeStub(overrides, {
        createMutableSetter: createVitestMutableSetter,
    });
}

export { createStableStorageReader };

export const createUseSettingMock = createUseSettingRuntimeMock;

export function createUseSettingMutableMock(useSetting: StorageModule['useSetting']): StorageModule['useSettingMutable'] {
    return createUseSettingRuntimeMutableMock(useSetting, {
        createMutableSetter: createVitestMutableSetter,
    });
}

type UseSettingMutableMockReader = (
    key: WritableSettingsKey,
) => readonly [unknown, (...args: never[]) => unknown];

export function createUseSettingMutableMockFromReader(
    reader: UseSettingMutableMockReader,
): StorageModule['useSettingMutable'] {
    return ((key: WritableSettingsKey) => {
        const result = reader(key);
        if (!Array.isArray(result) || result.length !== 2 || typeof result[1] !== 'function') {
            throw new TypeError(`Mutable setting fixture '${String(key)}' must return a value/setter tuple`);
        }
        // Test boundary: the reader is key-constrained above; production retains its exact generic hook contract.
        return result;
    }) as StorageModule['useSettingMutable'];
}

export const createUseLocalSettingMock = createUseLocalSettingRuntimeMock;

export function createUseLocalSettingMutableMock(
    useLocalSetting: StorageModule['useLocalSetting'],
): StorageModule['useLocalSettingMutable'] {
    return createUseLocalSettingRuntimeMutableMock(useLocalSetting, {
        createMutableSetter: createVitestMutableSetter,
    });
}

export function installPartialStorageModuleMock(overrides: object) {
    return async (importOriginal: <T>() => Promise<T>) => createPartialStorageModuleMock(importOriginal, overrides);
}

export function createStorageStoreMock(state: Partial<StorageState>): UseBoundStore<StoreApi<StorageState>> {
    return createStorageRuntimeStoreMock(state);
}

export function createLiveStorageStoreMock(readState: () => Partial<StorageState>): UseBoundStore<StoreApi<StorageState>> {
    return createLiveStorageRuntimeStoreMock(readState);
}
