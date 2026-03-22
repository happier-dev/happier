import * as React from 'react';

const SessionScreenTestIdsEnabledContext = React.createContext(true);

export const SessionScreenTestIdsProvider = React.memo((props: Readonly<{ enabled: boolean; children: React.ReactNode }>) => {
    return (
        <SessionScreenTestIdsEnabledContext.Provider value={props.enabled}>
            {props.children}
        </SessionScreenTestIdsEnabledContext.Provider>
    );
});

export function useSessionScreenTestIdsEnabled(): boolean {
    return React.useContext(SessionScreenTestIdsEnabledContext);
}

export function useOptionalSessionScreenTestId(id: string): string | undefined {
    return useSessionScreenTestIdsEnabled() ? id : undefined;
}

export function resolveOptionalSessionScreenTestId(enabled: boolean, id: string): string | undefined {
    return enabled ? id : undefined;
}
