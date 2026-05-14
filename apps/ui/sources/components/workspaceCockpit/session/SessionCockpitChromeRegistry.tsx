import * as React from 'react';

import type { SessionMobileSurface } from './sessionCockpitState';

export type SessionCockpitChromeRegistration = Readonly<{
    sessionId: string;
    activeSurface: SessionMobileSurface;
    terminalTabAvailable: boolean;
    switchSurface: (surface: SessionMobileSurface) => void;
    closeCockpit: () => void;
}>;

type SessionCockpitChromeRegistryContextValue = Readonly<{
    registration: SessionCockpitChromeRegistration | null;
    register: (registration: SessionCockpitChromeRegistration) => () => void;
}>;

const SessionCockpitChromeRegistryContext = React.createContext<SessionCockpitChromeRegistryContextValue | null>(null);

export function SessionCockpitChromeRegistryProvider(props: Readonly<{ children: React.ReactNode }>) {
    const [registration, setRegistration] = React.useState<SessionCockpitChromeRegistration | null>(null);
    const latestRegistrationRef = React.useRef<SessionCockpitChromeRegistration | null>(null);
    const latestRegistrationTokenRef = React.useRef(0);
    const mountedRef = React.useRef(true);

    React.useEffect(() => () => {
        mountedRef.current = false;
    }, []);

    const register = React.useCallback((nextRegistration: SessionCockpitChromeRegistration) => {
        const registrationToken = latestRegistrationTokenRef.current + 1;
        latestRegistrationTokenRef.current = registrationToken;
        latestRegistrationRef.current = nextRegistration;

        setRegistration((currentRegistration) => {
            if (
                currentRegistration?.sessionId === nextRegistration.sessionId
                && currentRegistration.activeSurface === nextRegistration.activeSurface
                && currentRegistration.terminalTabAvailable === nextRegistration.terminalTabAvailable
            ) {
                return currentRegistration;
            }

            return {
                sessionId: nextRegistration.sessionId,
                activeSurface: nextRegistration.activeSurface,
                terminalTabAvailable: nextRegistration.terminalTabAvailable,
                switchSurface: (surface) => {
                    latestRegistrationRef.current?.switchSurface(surface);
                },
                closeCockpit: () => {
                    latestRegistrationRef.current?.closeCockpit();
                },
            };
        });

        return () => {
            queueMicrotask(() => {
                if (!mountedRef.current) return;
                if (latestRegistrationTokenRef.current !== registrationToken) return;

                latestRegistrationRef.current = null;
                setRegistration((currentRegistration) => (
                    currentRegistration?.sessionId === nextRegistration.sessionId
                        ? null
                        : currentRegistration
                ));
            });
        };
    }, []);

    const value = React.useMemo(() => ({
        registration,
        register,
    }), [register, registration]);

    return (
        <SessionCockpitChromeRegistryContext.Provider value={value}>
            {props.children}
        </SessionCockpitChromeRegistryContext.Provider>
    );
}

export function useSessionCockpitChromeRegistration(): SessionCockpitChromeRegistration | null {
    return React.useContext(SessionCockpitChromeRegistryContext)?.registration ?? null;
}

export function useSessionCockpitChromeRegister(): ((registration: SessionCockpitChromeRegistration) => () => void) {
    const context = React.useContext(SessionCockpitChromeRegistryContext);
    return context?.register ?? (() => () => {});
}
