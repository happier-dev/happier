import { vi } from 'vitest';

import type { StorageState } from '@/sync/store/types';
import type { StoreApi, UseBoundStore } from 'zustand';

import {
    createStorageModuleStub as createStorageModuleRuntimeStub,
    createStorageStoreMock as createStorageRuntimeStoreMock,
    createUseLocalSettingMock as createUseLocalSettingRuntimeMock,
    createUseLocalSettingMutableMock as createUseLocalSettingRuntimeMutableMock,
    createUseSettingMock as createUseSettingRuntimeMock,
    createUseSettingMutableMock as createUseSettingRuntimeMutableMock,
    type CreateUseLocalSettingMockOptions as CreateUseLocalSettingRuntimeMockOptions,
    type CreateUseSettingMockOptions as CreateUseSettingRuntimeMockOptions,
} from '../runtime/storageRuntime';
import { mergeModuleMock, type MergeModuleMockOptions } from './_shared';

type StorageModule = typeof import('@/sync/domains/state/storage');
type MutableSetter = (value: unknown) => void;

export type CreateStorageModuleMockOptions = MergeModuleMockOptions<StorageModule>;
export type CreateUseSettingMockOptions = CreateUseSettingRuntimeMockOptions;
export type CreateUseLocalSettingMockOptions = CreateUseLocalSettingRuntimeMockOptions;

function createVitestMutableSetter(): MutableSetter {
    return vi.fn<MutableSetter>();
}

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
    return createStorageModuleRuntimeStub(overrides, {
        createMutableSetter: createVitestMutableSetter,
    });
}

export const createUseSettingMock = createUseSettingRuntimeMock;

export function createUseSettingMutableMock(useSetting: StorageModule['useSetting']): StorageModule['useSettingMutable'] {
    return createUseSettingRuntimeMutableMock(useSetting, {
        createMutableSetter: createVitestMutableSetter,
    });
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
