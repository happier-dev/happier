import * as React from 'react';

/** The mounted admission owner supplies the single entry into the complete bootstrap lifecycle. */
export const PersonalHomeBootstrapRequestContext = React.createContext<(() => void) | null>(null);

export function useRequestPersonalHomeBootstrap(): (() => void) | null {
    return React.useContext(PersonalHomeBootstrapRequestContext);
}
