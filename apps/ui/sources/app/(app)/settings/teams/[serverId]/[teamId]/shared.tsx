import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { TeamSharedKindScreen } from '@/components/settings/teams/shared/TeamSharedKindScreen';
import { readTeamSharedListKind } from '@/components/settings/teams/shared/teamSharedKindPresentation';
import { firstRouteParam } from '@/components/settings/teams/teamRouteParams';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

export function TeamSharedKindRoute() {
    const params = useLocalSearchParams<{ serverId?: string | string[]; teamId?: string | string[]; kind?: string | string[] }>();
    const kind = readTeamSharedListKind(firstRouteParam(params.kind));
    return kind ? (
        <TeamSharedKindScreen serverId={firstRouteParam(params.serverId)} teamId={firstRouteParam(params.teamId)} kind={kind} />
    ) : <SurfaceStateCard testID="team-shared-kind-unknown" kind="unavailable" title={t('common.unavailable')} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { TeamSharedKindRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={TeamSharedKindRoute} />; }
