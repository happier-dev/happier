import { ArtifactTeamResourceKindV1Schema, type ArtifactTeamResourceKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import type { TeamErrorCodeV1 } from '@happier-dev/protocol/teams/errors';
import { TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1, type TeamShareableResourceKindV1,
    type TeamSharedResourceSummaryRowV1, type TeamSharedResourcesSummaryV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';
import type { Tx } from '@/storage/inTx';
import { countScopedTeamMachinesInTx } from '@/app/machines/machineAccess';
import { countScopedTeamMachinePoolsInTx } from '@/app/machines/pools/machinePoolService';
import { countScopedTeamMachinePresetsInTx } from '@/app/machines/managed/machinePresetService';
import { countScopedTeamSessionsInTx } from '@/app/session/listing/service';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { countScopedTeamProjectSourcesInTx } from '@/app/projects/sources/projectSourceQuery';
import { countTeamSharedArtifactsInTx } from '@/app/artifacts/artifactAccessService';
import { countDiscussionsInTx } from '@/app/discussions/queries';
import { countSavedSecretResourcesInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { countTeamSharedCollectionsInTx } from '@/app/plugins/data/collections/sharingResourceService';
import { countTeamCredentialResourcesInTx } from './credentials/resourceRead';
import { resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from './actorContext';

type Count = Readonly<{ ok: true; count: number }> | Readonly<{ ok: false; error: string }>;
type NamedKind = Exclude<TeamShareableResourceKindV1, ArtifactTeamResourceKindV1 | typeof TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1>;

/** A demanded summary invokes each count owner once; it never opens resource bodies. */
export async function readTeamSharedResourcesSummaryInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; teamId: string; authentication: TeamOperationAuthenticationContext;
    sessionAuthentication: SessionAccessAuthentication;
}>): Promise<Readonly<{ ok: true; summary: TeamSharedResourcesSummaryV1 }> | Readonly<{ ok: false; error: TeamErrorCodeV1 }>> {
    const actor = await resolveTeamActorContextInTx(tx, input);
    if (!actor?.capabilities.viewTeam) return { ok: false, error: 'team_not_found' };
    const scoped = { actorAccountId: input.actorAccountId, sharedWithTeamId: input.teamId,
        authentication: input.authentication, admittedTeamActor: actor };
    const sessionScoped = { ...scoped, authentication: input.sessionAuthentication };
    const counts = {
        sessions: countScopedTeamSessionsInTx(tx, sessionScoped),
        machines: countScopedTeamMachinesInTx(tx, scoped),
        machinePools: countScopedTeamMachinePoolsInTx(tx, scoped),
        machinePresets: countScopedTeamMachinePresetsInTx(tx, scoped),
        projectSources: countScopedTeamProjectSourcesInTx(tx, scoped),
        discussions: countDiscussionsInTx(tx, sessionScoped),
        savedSecrets: countSavedSecretResourcesInTx(tx, scoped),
        credentials: countTeamCredentialResourcesInTx(tx, { ...input, admittedTeamActor: actor }),
    } satisfies Record<NamedKind, Promise<Count>>;
    const [named, artifacts, collections] = await Promise.all([
        Promise.all(Object.entries(counts).map(async ([kind, pending]): Promise<TeamSharedResourceSummaryRowV1> => {
            const result = await pending;
            return result.ok ? { kind: kind as NamedKind, status: 'available', count: result.count }
                : { kind: kind as NamedKind, status: 'unavailable', count: null, reason: result.error };
        })),
        countTeamSharedArtifactsInTx(tx, scoped),
        countTeamSharedCollectionsInTx(tx, scoped),
    ]);
    const artifactRows: TeamSharedResourceSummaryRowV1[] = ArtifactTeamResourceKindV1Schema.options.map(kind => artifacts.ok
        ? { kind, status: 'available', count: artifacts.counts[kind] }
        : { kind, status: 'unavailable', count: null, reason: artifacts.error });
    const collectionRows: TeamSharedResourceSummaryRowV1[] = collections.collections.map(row => ({
        kind: TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1, collection: row.collection, status: 'available', count: row.count,
    }));
    return { ok: true, summary: { teamId: input.teamId, kinds: [...named, ...artifactRows, ...collectionRows] } };
}
