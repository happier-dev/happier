import { useSyncExternalStore } from 'react';

let connectedServiceGroupsRefreshVersion = 0;
const listeners = new Set<() => void>();

export function invalidateConnectedServiceGroupsRefreshSignal(): void {
    connectedServiceGroupsRefreshVersion += 1;
    for (const listener of listeners) {
        listener();
    }
}

export function useConnectedServiceGroupsRefreshSignal(): number {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        () => connectedServiceGroupsRefreshVersion,
        () => connectedServiceGroupsRefreshVersion,
    );
}
