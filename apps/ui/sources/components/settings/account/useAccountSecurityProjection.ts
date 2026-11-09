import * as React from 'react';
import type { AccountSecurityGetResponseV1 } from '@happier-dev/protocol/auth/accountSecurity';

import { useAuth } from '@/auth/context/AuthContext';
import {
    captureActiveServerAccountScopeCurrentness,
    getActiveServerAccountScope,
} from '@/sync/domains/scope/activeServerAccountScope';

import { createAccountSecurityActionClient } from './accountSecurityActionClient';
import {
    accountSecurityProjectionScopeKey,
    getLastKnownAccountSecurityProjection,
    readAccountSecurityProjection,
} from './accountSecurityProjectionStore';

export type AccountSecurityProjectionState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{ kind: 'ready'; projection: AccountSecurityGetResponseV1 }>;

/** Shared presentation state for readers and surfaces fed by an already-mounted reader. */
export function useScopedAccountSecurityProjection(scopeKey: string | null) {
    const [snapshot, setSnapshot] = React.useState<Readonly<{
        scopeKey: string | null;
        value: AccountSecurityProjectionState;
    }> | null>(null);
    const publishProjection = React.useCallback((projection: AccountSecurityGetResponseV1 | null) => {
        const known = projection ?? (scopeKey ? getLastKnownAccountSecurityProjection(scopeKey) : null);
        setSnapshot((previous) => {
            if (previous?.scopeKey === scopeKey && previous.value.kind === 'ready'
                && previous.value.projection === known) return previous;
            if (previous?.scopeKey === scopeKey && previous.value.kind === 'unavailable' && !known) return previous;
            return { scopeKey, value: known ? { kind: 'ready', projection: known } : { kind: 'unavailable' } };
        });
    }, [scopeKey]);
    let state: AccountSecurityProjectionState;
    if (!scopeKey) state = { kind: 'unavailable' };
    else if (snapshot?.scopeKey === scopeKey) state = snapshot.value;
    else {
        const known = getLastKnownAccountSecurityProjection(scopeKey);
        state = known ? { kind: 'ready', projection: known } : { kind: 'loading' };
    }
    return { state, publishProjection };
}

/**
 * The current Home's Account Security facts (encryption mode, sign-in email, password enrollment) for
 * the Account overview, through the shared projection owner (one request per scope, last-known answer
 * first), bound to the active Account and Home: a projection read for one scope is never shown for
 * another. `Account.encryptionMode` here is the authority for "End-to-end encrypted"; key presence is not.
 */
export function useAccountSecurityProjection(): AccountSecurityProjectionState {
    return useAccountSecurityProjectionReader().state;
}

/**
 * The same read, for a surface that also changes a projected fact (the CLI and daemon approvals
 * switch on the API Tokens page) and publishes the stored value the server returned.
 */
export function useAccountSecurityProjectionReader() {
    const auth = useAuth();
    const activeScope = auth.credentials ? getActiveServerAccountScope() : null;
    const scopeKey = activeScope
        ? accountSecurityProjectionScopeKey(activeScope.serverId, activeScope.accountId)
        : null;
    const { state, publishProjection } = useScopedAccountSecurityProjection(scopeKey);

    React.useEffect(() => {
        if (!scopeKey) return;
        const client = createAccountSecurityActionClient();
        const lifetime = captureActiveServerAccountScopeCurrentness();
        let current = true;
        const retirement = lifetime.onRetire(() => { current = false; });
        void readAccountSecurityProjection(scopeKey, () => client.read()).then((projection) => {
            if (!current || !lifetime.isCurrent()) return;
            publishProjection(projection);
        }).catch(() => {
            if (!current || !lifetime.isCurrent()) return;
            // A failed refresh keeps the last-known answer rather than withdrawing rows it showed.
            publishProjection(null);
        }).finally(() => retirement.dispose());
        return () => {
            current = false;
            retirement.dispose();
        };
    }, [publishProjection, scopeKey]);

    return { state, publishProjection };
}
