import * as React from 'react';

import { ALWAYS_ACTIVE, type ActiveSignal } from '@/utils/react/activeGatedExternalStore';

const SessionListSurfaceDataActiveContext = React.createContext<ActiveSignal>(ALWAYS_ACTIVE);

/**
 * The list surface's data demand (`surfaceOwnership.dataActive`) as one stable signal for its rows. Rows
 * keep their last content while it is off; a cover or a Back reaches only the rows whose content changed,
 * never every mounted row through props or the list's `extraData`.
 */
export function SessionListSurfaceDataActiveProvider(props: React.PropsWithChildren<Readonly<{ dataActive: boolean }>>) {
    const [owner] = React.useState(() => {
        let current = props.dataActive;
        const listeners = new Set<() => void>();
        return {
            signal: {
                get: () => current,
                subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            } satisfies ActiveSignal,
            set: (next: boolean) => {
                if (next === current) return;
                current = next;
                for (const listener of [...listeners]) listener();
            },
        };
    });
    React.useLayoutEffect(() => { owner.set(props.dataActive); }, [owner, props.dataActive]);
    return <SessionListSurfaceDataActiveContext.Provider value={owner.signal}>{props.children}</SessionListSurfaceDataActiveContext.Provider>;
}

/** The enclosing list surface's data demand; outside a list, always active. */
export function useSessionListSurfaceDataActiveSignal(): ActiveSignal {
    return React.useContext(SessionListSurfaceDataActiveContext);
}
