import * as React from 'react';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';

import { readSourceTeamId } from './projectSourceGroups';

export type SourceTeamSetupHint = Readonly<{ address: TeamAddress; teamName: string }>;

/** Source provenance names the Team; its admitted membership supplies the manual re-entry link.
 * Home tile dismissal never removes this link, and no setup or Machine detail is demanded here. */
export function useSourceTeamSetupHint(serverId: string, source: ProjectSourceV1 | null): SourceTeamSetupHint | null {
    const teamId = source ? readSourceTeamId(source) : null;
    const serverIds = React.useMemo(() => [serverId], [serverId]);
    const directory = useTeamsDirectory({ serverIds, enabled: teamId !== null });
    const row = teamId ? directory.rows.find(candidate => candidate.team.id === teamId) : undefined;
    return React.useMemo(() => row ? { address: row.address, teamName: row.team.name } : null, [row]);
}
