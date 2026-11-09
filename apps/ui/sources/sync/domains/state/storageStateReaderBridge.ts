import type { StorageState } from '@/sync/store/types';
import { storageScopePaths, subscribeStoragePaths, type StorageSubscriptionScope } from './storageSubscriptions';

type StorageStateReader = () => StorageState;
type StorageStateSubscribe = (listener: (state: StorageState, previousState?: StorageState) => void, scope?: StorageSubscriptionScope) => () => void;
type MachineUpdateSubscribe = (listener: (serverId: string, machineIds: readonly string[]) => void) => () => void;

let storageStateReader: StorageStateReader | null = null;
let storageStateSubscribe: StorageStateSubscribe | null = null;
let machineUpdateSubscribe: MachineUpdateSubscribe | null = null;

export function registerStorageStateReader(reader: StorageStateReader): void {
    storageStateReader = reader;
}

export function readRegisteredStorageState(): StorageState | null {
    return storageStateReader ? storageStateReader() : null;
}

export function registerStorageStateSubscribe(subscribe: StorageStateSubscribe): void {
    storageStateSubscribe = subscribe;
}

export function subscribeRegisteredStorageState(listener: (state: StorageState, previousState?: StorageState) => void, scope?: StorageSubscriptionScope): () => void {
    if (storageStateSubscribe) return storageStateSubscribe(listener, scope);
    // The shared publication index exists before the Store's adapter is initialized.
    return subscribeStoragePaths(storageScopePaths(scope), event => {
        if (event.kind === 'state') listener(event.state, event.previous);
    });
}

export function registerStorageMachineUpdateSubscribe(subscribe: MachineUpdateSubscribe): void {
    machineUpdateSubscribe = subscribe;
}

export function subscribeRegisteredStorageMachineUpdates(listener: Parameters<MachineUpdateSubscribe>[0]): (() => void) | null {
    return machineUpdateSubscribe ? machineUpdateSubscribe(listener) : null;
}
