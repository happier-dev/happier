import * as React from 'react';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

const SessionViewerSourceAccountScope = React.createContext<ServerAccountScopeLifetime | null>(null);

/** Borrow the Session shell's admitted Home/Account authority; never resolve another one. */
export function SessionViewerSourceAccountScopeProvider(props: React.PropsWithChildren<Readonly<{
    accountLifetime: ServerAccountScopeLifetime | null;
}>>): React.ReactElement {
    return <SessionViewerSourceAccountScope.Provider value={props.accountLifetime}>
        {props.children}
    </SessionViewerSourceAccountScope.Provider>;
}

export function useSessionViewerSourceAccountLifetime(): ServerAccountScopeLifetime | null {
    return React.useContext(SessionViewerSourceAccountScope);
}
