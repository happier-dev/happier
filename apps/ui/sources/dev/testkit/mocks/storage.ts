import { vi } from 'vitest';

import type {
    Settings,
    WritableSettingsKey,
} from '@/sync/domains/settings/settings';
import type { StorageState } from '@/sync/store/types';
import type { StoreApi, UseBoundStore } from 'zustand';
import { authoringMemoryDefaults } from '@/sync/store/domains/authoringMemory';

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
    createProjectAccountRowHookMocks,
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

/**
 * Adds `extra` to a module mock without spreading it. `mergeModuleMock` keeps the original module's
 * live getters; a spread would read them once, and inside an import cycle that read happens before
 * the original module has initialized (the real `storage` store would be captured as `undefined`).
 */
function extendModuleMock(module: StorageModule, extra: Partial<StorageModule>): StorageModule {
    const out: Record<PropertyKey, unknown> = {};
    for (const key of Reflect.ownKeys(module)) {
        const descriptor = Object.getOwnPropertyDescriptor(module, key);
        if (descriptor) Object.defineProperty(out, key, { ...descriptor, configurable: true });
    }
    for (const [key, value] of Object.entries(extra)) {
        Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
    }
    return out as StorageModule;
}

export async function createStorageModuleMock(options: CreateStorageModuleMockOptions): Promise<StorageModule> {
    const module = await mergeModuleMock<StorageModule>(options);
    const overrides = options.overrides as Partial<StorageModule>;
    const moduleWithSettingReader = Object.prototype.hasOwnProperty.call(overrides, 'useSetting')
        && !Object.prototype.hasOwnProperty.call(overrides, 'useSettingMutable')
        ? extendModuleMock(module, { useSettingMutable: createUseSettingMutableMock(module.useSetting) })
        : module;
    const moduleWithCurrentSecretBindings: StorageModule = !Object.prototype.hasOwnProperty.call(
        overrides,
        'useCurrentSecretBindingsByProfileIdMutable',
    ) && (
        Object.prototype.hasOwnProperty.call(overrides, 'useSetting')
        || Object.prototype.hasOwnProperty.call(overrides, 'useSettingMutable')
    )
        ? extendModuleMock(moduleWithSettingReader, {
            useCurrentSecretBindingsByProfileIdMutable:
                createUseCurrentSecretBindingsByProfileIdMutableMock(moduleWithSettingReader.useSetting, {
                    createMutableSetter: createVitestMutableSetter,
                }),
        })
        : moduleWithSettingReader;
    const storageOverride = (options.overrides as { storage?: unknown }).storage;
    if (isStorageStoreLike(storageOverride)) {
        const storage = adaptStorageStoreLike(storageOverride);
        return extendModuleMock(moduleWithCurrentSecretBindings, {
            storage,
            getStorage: () => storage,
            ...createProjectAccountRowHookMocks(storage, overrides),
            ...(!Object.prototype.hasOwnProperty.call(overrides, 'useAuthoringMemoryField') ? {
                useAuthoringMemoryField: ((name: keyof typeof authoringMemoryDefaults) =>
                    (storage.getState().authoringMemory ?? authoringMemoryDefaults)[name]) as StorageModule['useAuthoringMemoryField'],
            } : {}),
        });
    }
    if (typeof (options.overrides as { getStorage?: unknown }).getStorage === 'function') {
        return moduleWithCurrentSecretBindings;
    }
    return extendModuleMock(moduleWithCurrentSecretBindings, {
        getStorage: () => moduleWithCurrentSecretBindings.storage,
    });
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
