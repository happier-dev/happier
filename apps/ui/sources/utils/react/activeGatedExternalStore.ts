import * as React from 'react';

/** Whether a surface currently demands live data; a subscription, so a change renders no reader by itself. */
export type ActiveSignal = Readonly<{ get: () => boolean; subscribe: (listener: () => void) => () => void }>;

export const ALWAYS_ACTIVE: ActiveSignal = { get: () => true, subscribe: () => () => {} };

/**
 * An external store read only while `gate` is active. Inactive, the reader keeps the value it last read
 * and holds no source subscription; a reader whose first render is inactive reads once. When the gate
 * opens or closes the reader renders only if the value it would show changed, so `read` must return the
 * same value for an unchanged answer.
 */
export function useActiveGatedExternalStore<T>(
    gate: ActiveSignal,
    subscribeSource: (listener: () => void) => () => void,
    read: () => T,
): T {
    const last = React.useRef<{ value: T } | null>(null);
    const subscribe = React.useCallback((listener: () => void) => {
        let stopSource: (() => void) | null = null;
        const sync = () => {
            if (gate.get()) {
                if (!stopSource) stopSource = subscribeSource(listener);
            } else if (stopSource) {
                stopSource();
                stopSource = null;
            }
        };
        sync();
        const stopGate = gate.subscribe(() => { sync(); listener(); });
        return () => { stopGate(); stopSource?.(); };
    }, [gate, subscribeSource]);
    const getSnapshot = () => {
        if (last.current && !gate.get()) return last.current.value;
        const value = read();
        last.current = { value };
        return value;
    };
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
