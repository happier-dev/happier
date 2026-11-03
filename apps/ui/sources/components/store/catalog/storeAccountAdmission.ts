import * as React from 'react';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeResolution,
    type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { StoreInstalledInput } from './storeKinds';

export type StoreScopeFailure = 'scope-retired' | Exclude<ServerCredentialAccountScopeResolution, { kind: 'bound' }>;
export type InstalledScopeAdmission = Readonly<{
    scope: ServerAccountScope | null;
    failure: StoreScopeFailure | null;
    coverage: 'loading' | 'available' | Readonly<{ unavailable: StoreScopeFailure }>;
    binding: ServerCredentialAccountScopeBinding | null;
}>;

/** One Account admission for a Store composition; null never means the ambient Account. */
export function useInstalledScope(input: Pick<StoreInstalledInput, 'scope' | 'machine'>): InstalledScopeAdmission {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(input.scope?.serverId ?? null);
    const machineMatchesScope = !input.machine || Boolean(input.scope
        && areServerProfileIdentifiersEquivalent(input.machine.serverIdentityId, input.scope.serverId));
    const scope = machineMatchesScope && binding?.isCurrent() && input.scope && binding.scope.accountId === input.scope.accountId
        && areServerProfileIdentifiersEquivalent(binding.scope.serverId, input.scope.serverId) ? input.scope : null;
    const failure: StoreScopeFailure | null = scope ? null
        : !input.scope || !machineMatchesScope || binding || resolution.kind === 'bound' ? 'scope-retired' : resolution;
    return React.useMemo(() => ({ scope, failure, binding: scope ? binding : null,
        coverage: scope ? 'available' : failure && typeof failure !== 'string' && failure.kind === 'resolving'
            ? 'loading' : { unavailable: failure! },
    }), [scope, failure, binding]);
}
