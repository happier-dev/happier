import * as React from 'react';

export type SubscribableState<TState> = Readonly<{
    getState: () => TState;
    subscribe?: (listener: (state: TState, prevState: TState) => void) => () => void;
}>;

export function useStoreSnapshot<TState>(store: SubscribableState<TState>): TState {
    const subscribe = React.useCallback((notify: () => void) => {
        if (typeof store.subscribe !== 'function') {
            return () => {};
        }
        return store.subscribe(() => {
            notify();
        });
    }, [store]);

    const getSnapshot = React.useCallback(() => store.getState(), [store]);

    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
