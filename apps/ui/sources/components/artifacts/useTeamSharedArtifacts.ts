import * as React from 'react';
import { ArtifactActionOutputSchemasV1, type ArtifactActionResultV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { ArtifactTeamResourceKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';

import { useTeamPagedList, type TeamPagedList } from '@/hooks/teams/useTeamPagedList';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { runTeamAction } from '@/sync/ops/teams/teamActionClient';
import type { HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';

type ArtifactRow = ArtifactActionResultV1<'artifact.list'>['items'][number];
const NO_ARTIFACTS: readonly ArtifactRow[] = Object.freeze([]);
const artifactKey = (row: ArtifactRow) => row.artifactId;
// Source-reference changes can move a bucket without an Artifact write.
const affectsArtifacts = (event: HomeAccountChangeEvent) => event.teamSharedResourcesAffect !== false;

/** Demanded structural pages from the incumbent Artifact list, including locked rows. */
export function useTeamSharedArtifacts(input: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    teamResourceKind: ArtifactTeamResourceKindV1;
    enabled: boolean;
    /** Omitted pages use the Artifact owner's existing default. */
    pageSize?: number;
}>): TeamPagedList<ArtifactRow> {
    const { scope, address, teamResourceKind, pageSize } = input;
    const serverId = scope?.serverId ?? '';
    const { binding } = useServerCredentialAccountScopeBinding(input.enabled ? serverId : null);
    const enabled = input.enabled && scope !== null && address !== null && serverId === address.serverId
        && binding !== null && binding.isCurrent() && areServerAccountScopesEqual(binding.scope, scope);
    const page = useTeamPagedList<ArtifactRow>({
        key: JSON.stringify([serverId, scope?.accountId, address?.teamId, teamResourceKind, pageSize, binding?.credentialKey]),
        enabled, getRowKey: artifactKey,
        accountChange: { serverId, affects: affectsArtifacts },
        loadPage: async (cursor, signal) => {
            if (!scope || !address) return null;
            const result = await runTeamAction({ scope, actionId: 'artifact.list', signal,
                input: { sharedWithTeamId: address.teamId, teamResourceKind,
                    ...(pageSize === undefined ? {} : { limit: pageSize }),
                    ...(cursor === null ? {} : { cursor }) },
                parse: value => ArtifactActionOutputSchemasV1['artifact.list'].parse(value) });
            return result.kind === 'failed' ? result : { kind: 'succeeded', value: {
                items: result.value.items, nextCursor: result.value.nextCursor ?? null,
            } };
        },
    });
    return React.useMemo(() => ({ ...page, rows: enabled ? page.rows : NO_ARTIFACTS }), [page, enabled]);
}
