import * as React from 'react';

import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { retainHomeSettingsInvalidation } from '@/sync/engine/home/governance/homeSettingsEngine';

type RetainSettings = (scope: ServerAccountScope) => void;
const Context = React.createContext<RetainSettings | null>(null);

/** Keeps the first demanded registry subscribed to invalidations across pages. */
export function HomeSettingsLifetime(props: Readonly<{ serverId: string; children: React.ReactNode }>) {
    const retained = React.useRef<Readonly<{
        scope: ServerAccountScope;
        invalidation: ReturnType<typeof retainHomeSettingsInvalidation>;
    }> | null>(null);
    const release = React.useCallback(() => {
        retained.current?.invalidation.release();
        retained.current = null;
    }, []);
    const retain = React.useCallback<RetainSettings>((scope) => {
        if (retained.current?.invalidation.isRetained() && areServerAccountScopesEqual(retained.current.scope, scope)) return;
        release();
        retained.current = { scope, invalidation: retainHomeSettingsInvalidation(scope) };
    }, [release]);

    React.useEffect(() => {
        if (retained.current && !areServerProfileIdentifiersEquivalent(retained.current.scope.serverId, props.serverId)) release();
    }, [props.serverId, release]);
    React.useEffect(() => release, [release]);

    return <Context.Provider value={retain}>{props.children}</Context.Provider>;
}

export function useHomeSettingsLifetime(): RetainSettings | null {
    return React.useContext(Context);
}
