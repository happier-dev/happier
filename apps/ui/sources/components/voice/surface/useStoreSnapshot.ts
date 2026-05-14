import * as React from 'react';

export type SubscribableState<TState> = Readonly<{
    getState: () => TState;
    subscribe?: (listener: (state: TState, prevState: TState) => void) => () => void;
}>;

export function useStoreSnapshot<TState, TSnapshot = TState>(
    store: SubscribableState<TState>,
    selector?: (state: TState) => TSnapshot,
): TSnapshot {
    const snapshotRef = React.useRef<{ value: TSnapshot } | null>(null);
    const selectSnapshot = React.useCallback((state: TState): TSnapshot => (
        selector ? selector(state) : (state as unknown as TSnapshot)
    ), [selector]);

    const getCachedSnapshot = React.useCallback(() => {
        const nextValue = selectSnapshot(store.getState());
        const current = snapshotRef.current;
        if (current && Object.is(current.value, nextValue)) {
            return current.value;
        }
        snapshotRef.current = { value: nextValue };
        return nextValue;
    }, [selectSnapshot, store]);

    const subscribe = React.useCallback((notify: () => void) => {
        if (typeof store.subscribe !== 'function') {
            return () => {};
        }
        return store.subscribe((state) => {
            const nextValue = selectSnapshot(state);
            const current = snapshotRef.current;
            if (current && Object.is(current.value, nextValue)) {
                return;
            }
            snapshotRef.current = { value: nextValue };
            notify();
        });
    }, [selectSnapshot, store]);

    return React.useSyncExternalStore(subscribe, getCachedSnapshot, getCachedSnapshot);
}
