import * as React from 'react';
import type { StoreApi } from 'zustand';
import { useStoreWithEqualityFn } from 'zustand/traditional';

import type { StorageState } from '@/sync/store/types';
import { publishStoragePaths, storageScopePaths, subscribeStoragePaths, type StorageSubscriptionScope } from './storageSubscriptions';

let selectorReader: ((state: StorageState) => StorageState) | undefined;

/** Domain queries use their captured get(); collect those reads at the same selector boundary. */
export function readStorageState(state: StorageState): StorageState {
    return selectorReader ? selectorReader(state) : state;
}

export type ScopedStorage = Omit<StoreApi<StorageState>, 'subscribe'> & {
    (): StorageState;
    <T>(selector: (state: StorageState) => T, scope?: StorageSubscriptionScope, equal?: (a: T, b: T) => boolean): T;
    subscribe(listener: (state: StorageState, previous: StorageState) => void, scope?: StorageSubscriptionScope): () => void;
};

/** Keep Zustand's state/setter and make its existing subscribe path route by consumed keys. */
export function scopeStorageSubscriptions(store: StoreApi<StorageState>): ScopedStorage {
    store.subscribe((state, previous) => {
        publishStoragePaths(['state'], state, previous, { kind: 'state', state, previous });
    });
    const subscribe: ScopedStorage['subscribe'] = (listener, scope) => subscribeStoragePaths(storageScopePaths(scope), event => {
        if (event.kind === 'state') listener(event.state, event.previous);
    });
    const identity = (state: StorageState) => state;

    function useStorage(): StorageState;
    function useStorage<T>(selector: (state: StorageState) => T, scope?: StorageSubscriptionScope, equal?: (a: T, b: T) => boolean): T;
    function useStorage<T>(selector?: (state: StorageState) => T, scope?: StorageSubscriptionScope, equal?: (a: T | StorageState, b: T | StorageState) => boolean): T | StorageState {
        const select = selector ?? identity;
        const source = React.useMemo(() => {
            let paths: readonly (readonly PropertyKey[])[] = [];
            let stop: (() => void) | undefined;
            let notify: Parameters<StoreApi<StorageState>['subscribe']>[0] | undefined;
            const bind = () => subscribeStoragePaths(paths, event => { if (event.kind === 'state') notify?.(event.state, event.previous); });
            const read = (state: StorageState, select: (state: StorageState) => T | StorageState, scope?: StorageSubscriptionScope) => {
                const keys = new Set<keyof StorageState>();
                let wholeState = false;
                // Only the root is proxied: records, arrays, classes and selector results retain their real identity.
                const viewState = (input: StorageState): StorageState => new Proxy(input, {
                    get(target, key, receiver) { keys.add(key as keyof StorageState); return Reflect.get(target, key, receiver); },
                    has(target, key) { keys.add(key as keyof StorageState); return Reflect.has(target, key); },
                    ownKeys(target) { wholeState = true; return Reflect.ownKeys(target); },
                });
                const view = viewState(state);
                const previousReader = selectorReader;
                selectorReader = input => input === state ? view : viewState(input);
                let value: T | StorageState;
                try { value = select(view); } finally { selectorReader = previousReader; }
                const demandedKeys = new Set([...keys, ...Object.keys(scope ?? {}) as (keyof StorageState)[]]);
                const nextPaths = value === view || wholeState ? [['state']] :
                    storageScopePaths(Object.fromEntries([...demandedKeys].map(key => [key, scope?.[key] ?? true])));
                const changed = paths.length !== nextPaths.length || paths.some((path, index) =>
                    path.length !== nextPaths[index].length || path.some((key, part) => key !== nextPaths[index][part]));
                if (changed) {
                    paths = nextPaths;
                    if (notify) { stop?.(); stop = bind(); }
                }
                return value === view ? state : value;
            };
            return {
                getState: store.getState,
                getInitialState: store.getInitialState,
                select: read,
                subscribe(listener: Parameters<StoreApi<StorageState>['subscribe']>[0]) {
                    notify = listener;
                    stop = bind();
                    return () => { stop?.(); stop = undefined; notify = undefined; };
                },
            };
        }, []);
        // The source owns the subscription lifetime; each render supplies its current closure and scope.
        const read = React.useCallback((state: StorageState) => source.select(state, select, scope), [source, select, scope]);
        return useStoreWithEqualityFn(source, read, equal);
    }
    return Object.assign(useStorage, store, { subscribe, getState: () => readStorageState(store.getState()) });
}
