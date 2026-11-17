import type { PluginCollectionContractRefV1 } from '@happier-dev/protocol/plugins/data/collectionContractRefV1';
import { PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1 as ids } from '@happier-dev/protocol/plugins/data/collectionSharingActionIdsV1';
import { PluginCollectionSharingActionOutputSchemasV1 } from '@happier-dev/protocol/plugins/data/collectionSharingActionsV1';

import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { runTeamAction } from '@/sync/ops/teams/teamActionClient';

import { useTeamPagedList, type TeamPagedList } from './useTeamPagedList';

export type TeamSharedCollectionRow = ReturnType<typeof PluginCollectionSharingActionOutputSchemasV1[typeof ids.list]['parse']>['rows'][number];

export function useTeamSharedCollections(input: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    collectionRef: PluginCollectionContractRefV1 | null;
    enabled: boolean;
    pageSize: number;
}>): TeamPagedList<TeamSharedCollectionRow> {
    const { scope, address, collectionRef, pageSize } = input;
    const serverId = scope?.serverId ?? '';
    const { binding } = useServerCredentialAccountScopeBinding(input.enabled ? serverId : null);
    const enabled = input.enabled && scope !== null && address !== null && collectionRef !== null && serverId === address.serverId
        && binding !== null && binding.isCurrent() && areServerAccountScopesEqual(binding.scope, scope);
    return useTeamPagedList<TeamSharedCollectionRow>({
        key: JSON.stringify([serverId, scope?.accountId, address?.teamId, collectionRef, pageSize, binding?.credentialKey]),
        enabled,
        accountChange: { serverId, affects: event => event.teamSharedResourcesAffect !== false },
        loadPage: async (cursor, signal) => {
            if (!scope || !address || !collectionRef) return null;
            const result = await runTeamAction({
                scope, actionId: ids.list, signal,
                input: { collectionRef, sharedWithTeamId: address.teamId, limit: pageSize, ...(cursor === null ? {} : { cursor }) },
                parse: value => PluginCollectionSharingActionOutputSchemasV1[ids.list].parse(value),
            });
            return result.kind === 'failed' ? result : {
                kind: 'succeeded', value: { items: result.value.rows, nextCursor: result.value.nextCursor ?? null },
            };
        },
    });
}
