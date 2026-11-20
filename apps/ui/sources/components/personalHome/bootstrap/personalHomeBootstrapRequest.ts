import * as React from 'react';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';

/** The mounted admission owner supplies the single entry into the complete bootstrap lifecycle. */
type RequestPersonalHomeBootstrap = (entry?: 'first-run') => void;
export const PersonalHomeBootstrapRequestContext = React.createContext<RequestPersonalHomeBootstrap | null>(null);

export function useRequestPersonalHomeBootstrap(): RequestPersonalHomeBootstrap | null {
    return React.useContext(PersonalHomeBootstrapRequestContext);
}

/** The verified result survives the bootstrap's mounting boundary until the wizard opens it. */
export const FirstRunPersonalHomeContext = React.createContext<Readonly<{
    profile: ServerProfile | null;
    finish: () => void;
}> | null>(null);

export function useFirstRunPersonalHome() {
    return React.useContext(FirstRunPersonalHomeContext);
}
