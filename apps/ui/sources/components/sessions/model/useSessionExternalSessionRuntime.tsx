import * as React from 'react';

import {
    useExternalSessionRuntime,
    type UseExternalSessionRuntimeResult,
} from './useExternalSessionRuntime';

type UseSessionExternalSessionRuntimeParams = Parameters<typeof useExternalSessionRuntime>[0];

const SessionExternalSessionRuntimeContext = React.createContext<UseExternalSessionRuntimeResult | null>(null);

export function SessionExternalSessionRuntimeProvider(props: Readonly<{
    value: UseExternalSessionRuntimeResult;
    children: React.ReactNode;
}>) {
    return (
        <SessionExternalSessionRuntimeContext.Provider value={props.value}>
            {props.children}
        </SessionExternalSessionRuntimeContext.Provider>
    );
}

export function useSessionExternalSessionRuntime(
    params: UseSessionExternalSessionRuntimeParams,
): UseExternalSessionRuntimeResult {
    const providedRuntime = React.useContext(SessionExternalSessionRuntimeContext);
    const ownedRuntime = useExternalSessionRuntime({
        ...params,
        enabled: providedRuntime === null && params.enabled !== false,
    });
    return providedRuntime ?? ownedRuntime;
}
