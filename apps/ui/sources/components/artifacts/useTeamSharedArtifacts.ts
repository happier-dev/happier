import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { ArtifactTeamResourceKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';

import { useTeamObservedPagedList } from '@/hooks/teams/useTeamObservedPagedList';
import type { TeamPagedList } from '@/hooks/teams/useTeamPagedList';
import { readReviewList } from '@/sync/api/reviews/list';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { runTeamAction } from '@/sync/ops/teams/teamActionClient';
import type { HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { teamSharedArtifactPages, type TeamSharedArtifactRow } from '@/sync/store/teams/teamsSnapshots';

const artifactKey = (row: TeamSharedArtifactRow) => row.artifactId;
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
}>): TeamPagedList<TeamSharedArtifactRow> {
    const { scope, address, teamResourceKind, pageSize } = input;
    const serverId = scope?.serverId ?? '';
    return useTeamObservedPagedList<TeamSharedArtifactRow>({
        scope,
        observations: teamSharedArtifactPages,
        key: JSON.stringify([serverId, scope?.accountId, address?.teamId, teamResourceKind, pageSize]),
        enabled: input.enabled && address !== null && serverId === address.serverId,
        getRowKey: artifactKey,
        accountChange: { serverId, affects: affectsArtifacts },
        loadPage: async (cursor, signal) => {
            if (!scope || !address) return null;
            const result = await runTeamAction({ scope, actionId: 'artifact.list', signal,
                input: { sharedWithTeamId: address.teamId, teamResourceKind,
                    ...(pageSize === undefined ? {} : { limit: pageSize }),
                    ...(cursor === null ? {} : { cursor }) },
                parse: value => ArtifactActionOutputSchemasV1['artifact.list'].parse(value) });
            if (result.kind === 'failed') return result;
            const { items, nextCursor } = result.value;
            let rows: readonly TeamSharedArtifactRow[] = items;
            if (teamResourceKind === 'reviews' && items.length > 0) {
                // The Artifact page owns order and sharing provenance; the Review owner supplies its facts.
                const reviewIds = items.map(row => row.artifactId);
                const reviews = await readReviewList(scope, { reviewIds, limit: reviewIds.length }, signal);
                if (reviews.kind === 'completed') {
                    const byId = new Map(reviews.value.items.map(review => [review.reviewId, review]));
                    rows = items.map(row => {
                        const review = byId.get(row.artifactId);
                        return review ? { ...row, review } : row;
                    });
                }
            }
            return { kind: 'succeeded', value: { items: rows, nextCursor: nextCursor ?? null } };
        },
    });
}
