import type { ManagedIdentityProviderV1 } from '@happier-dev/protocol/identity/providers';

import type { ManagedIdentityProviderSettledResult } from './managedIdentityProviderClient';

export type ManagedIdentityProviderState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable'; failure: Readonly<{ code: string; retryable: boolean }> }>
    | Readonly<{
        kind: 'ready';
        items: readonly ManagedIdentityProviderV1[];
        unreadableCount: number;
        refreshing: boolean;
        stale: boolean;
        failure: Readonly<{ code: string; retryable: boolean }> | null;
    }>;

export const INITIAL_MANAGED_IDENTITY_PROVIDER_STATE: ManagedIdentityProviderState = Object.freeze({
    kind: 'loading' as const,
});

export function beginManagedIdentityProviderRefresh(
    state: ManagedIdentityProviderState,
): ManagedIdentityProviderState {
    return state.kind === 'ready'
        ? Object.freeze({ ...state, refreshing: true })
        : INITIAL_MANAGED_IDENTITY_PROVIDER_STATE;
}

export function settleManagedIdentityProviderRefresh(
    state: ManagedIdentityProviderState,
    result: ManagedIdentityProviderSettledResult<Readonly<{
        items: readonly ManagedIdentityProviderV1[];
        unreadableCount: number;
    }>>,
): ManagedIdentityProviderState {
    if (result.kind !== 'succeeded') {
        const failure = result.failure;
        return state.kind === 'ready' && !failure.withdrawsObservation
            ? Object.freeze({ ...state, refreshing: false, stale: true, failure })
            : Object.freeze({ kind: 'unavailable' as const, failure });
    }
    return Object.freeze({
        kind: 'ready' as const,
        items: Object.freeze([...result.value.items].sort((left, right) => (
            left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id)
        ))),
        unreadableCount: result.value.unreadableCount,
        refreshing: false,
        stale: false,
        failure: null,
    });
}
