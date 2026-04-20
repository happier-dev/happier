import type { StorageState } from '@/sync/store/types';

type StorageStateReader = () => StorageState;
type StorageStateSubscribe = (listener: (state: StorageState) => void) => () => void;

let storageStateReader: StorageStateReader | null = null;
let storageStateSubscribe: StorageStateSubscribe | null = null;

export function registerStorageStateReader(reader: StorageStateReader): void {
    storageStateReader = reader;
}

export function readRegisteredStorageState(): StorageState | null {
    return storageStateReader ? storageStateReader() : null;
}

export function registerStorageStateSubscribe(subscribe: StorageStateSubscribe): void {
    storageStateSubscribe = subscribe;
}

export function subscribeRegisteredStorageState(listener: (state: StorageState) => void): (() => void) | null {
    return storageStateSubscribe ? storageStateSubscribe(listener) : null;
}
