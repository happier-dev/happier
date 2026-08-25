import * as React from 'react';

import {
    captureActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

/**
 * Retire Provider screen-local authoring state when the active Account
 * lifetime retires.
 *
 * Provider routes are not Account-keyed and the app subtree stays mounted
 * across a normal Account change, so a draft, editor buffer, or queued
 * operation authored under Account A survives the switch. Nothing in the
 * request identity can refuse it afterwards: Account B can restore the same
 * server identity, machine, connection id and revision, while the Connected
 * Account references inside the draft still belong to A.
 *
 * This composes the sole active-Account lifetime rather than introducing a
 * Provider-owned epoch. `retire` must be stable across renders — the effect
 * re-registers whenever it changes.
 */
export function useRetireProviderStateOnAccountChange(retire: () => void): void {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(retire);
        return () => registration?.dispose();
    }, [accountLifetime, retire]);
}
