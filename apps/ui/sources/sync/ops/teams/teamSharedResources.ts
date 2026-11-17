import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { TeamSharedResourcesSummaryV1Schema, type TeamSharedResourcesSummaryV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { runTeamAction, type TeamActionOutcome } from './teamActionClient';

/** The declared Action owns transport, schemas, scope and read admission. */
export function readTeamSharedResourcesSummary(input: Readonly<{
    scope: ServerAccountScope; address: TeamAddress; signal?: AbortSignal;
}>): Promise<TeamActionOutcome<TeamSharedResourcesSummaryV1>> {
    return runTeamAction({ scope: input.scope, actionId: TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1,
        input: { v: 1, teamId: input.address.teamId }, signal: input.signal,
        parse: value => TeamSharedResourcesSummaryV1Schema.parse(value) });
}
