import type { SavedSecretCatalogResultV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SharedSavedSecretListOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';

import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { runTeamAction } from '@/sync/ops/teams/teamActionClient';
import { homeAccountChangeAffectsSavedSecretCatalog } from '@/sync/runtime/orchestration/changesPlanner';

import { useTeamPagedList, type TeamPagedList } from './useTeamPagedList';

/** Team discovery reads value-free metadata without changing the Account-wide credential catalog. */
export function useTeamSharedSavedSecrets(input: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    enabled: boolean;
    /** Supplied by the consuming list; the resource owner has no default page ceiling. */
    pageSize: number;
}>): TeamPagedList<SavedSecretCatalogResultV1> {
    const { scope, address, pageSize } = input;
    const serverId = scope?.serverId ?? '';
    const teamId = address?.teamId ?? '';
    const { binding } = useServerCredentialAccountScopeBinding(input.enabled ? serverId : null);
    const enabled = input.enabled && scope !== null && address !== null && serverId === address.serverId
        && binding !== null && binding.isCurrent() && areServerAccountScopesEqual(binding.scope, scope);
    return useTeamPagedList<SavedSecretCatalogResultV1>({
        key: JSON.stringify([serverId, scope?.accountId, teamId, pageSize, binding?.credentialKey]),
        enabled,
        accountChange: { serverId, affects: homeAccountChangeAffectsSavedSecretCatalog },
        loadPage: async (cursor, signal) => {
            if (!scope || !address) return null;
            const result = await runTeamAction({
                scope, actionId: 'secrets.shared.list', signal,
                input: { sharedWithTeamId: address.teamId, limit: pageSize, ...(cursor === null ? {} : { cursor }) },
                parse: value => SharedSavedSecretListOutputV1Schema.parse(value),
            });
            return result.kind === 'failed' ? result : {
                kind: 'succeeded', value: { items: result.value.resources, nextCursor: result.value.nextCursor ?? null },
            };
        },
    });
}
