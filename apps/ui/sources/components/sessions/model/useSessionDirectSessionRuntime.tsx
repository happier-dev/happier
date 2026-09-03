import * as React from 'react';

import {
    useDirectSessionRuntime,
    type UseDirectSessionRuntimeResult,
} from './useDirectSessionRuntime';

type UseSessionDirectSessionRuntimeParams = Parameters<typeof useDirectSessionRuntime>[0];

const SessionDirectSessionRuntimeContext = React.createContext<UseDirectSessionRuntimeResult | null>(null);

export function SessionDirectSessionRuntimeProvider(props: Readonly<{
    value: UseDirectSessionRuntimeResult;
    children: React.ReactNode;
}>) {
    return (
        <SessionDirectSessionRuntimeContext.Provider value={props.value}>
            {props.children}
        </SessionDirectSessionRuntimeContext.Provider>
    );
}

export function useSessionDirectSessionRuntime(
    params: UseSessionDirectSessionRuntimeParams,
): UseDirectSessionRuntimeResult {
    const providedRuntime = React.useContext(SessionDirectSessionRuntimeContext);
    const ownedRuntime = useDirectSessionRuntime({
        ...params,
        enabled: providedRuntime === null && params.enabled !== false,
    });
    return providedRuntime ?? ownedRuntime;
}
