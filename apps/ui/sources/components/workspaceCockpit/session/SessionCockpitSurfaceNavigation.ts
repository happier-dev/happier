import * as React from 'react';

import type { SessionMobileSurface } from './sessionCockpitState';

type SessionCockpitSurfaceNavigation = Readonly<{
    switchSurface: (surface: SessionMobileSurface) => void;
}>;

const SessionCockpitSurfaceNavigationContext = React.createContext<SessionCockpitSurfaceNavigation | null>(null);

export const SessionCockpitSurfaceNavigationProvider = SessionCockpitSurfaceNavigationContext.Provider;

export function useSessionCockpitSurfaceNavigation(): SessionCockpitSurfaceNavigation | null {
    return React.useContext(SessionCockpitSurfaceNavigationContext);
}
