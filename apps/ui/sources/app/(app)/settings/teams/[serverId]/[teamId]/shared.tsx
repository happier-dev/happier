import * as React from 'react';
import {
    TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1,
    TeamSharedResourceCollectionRefV1Schema,
} from '@happier-dev/protocol/teams/teamShareableResourceKindV1';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { TeamSharedKindScreen } from '@/components/settings/teams/shared/TeamSharedKindScreen';
import { readTeamSharedListKind } from '@/components/settings/teams/shared/teamSharedKindPresentation';
import { firstRouteParam } from '@/components/settings/teams/teamRouteParams';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

export function TeamSharedKindRoute() {
    const params = useLocalSearchParams<{
        serverId?: string | string[];
        teamId?: string | string[];
        kind?: string | string[];
        collectionPluginId?: string | string[];
        collectionId?: string | string[];
    }>();
    const serverId = firstRouteParam(params.serverId);
    const teamId = firstRouteParam(params.teamId);
    const rawKind = firstRouteParam(params.kind);
    if (rawKind === TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1) {
        const collection = TeamSharedResourceCollectionRefV1Schema.safeParse({
            pluginId: firstRouteParam(params.collectionPluginId),
            collectionId: firstRouteParam(params.collectionId),
        });
        if (collection.success) {
            return <TeamSharedKindScreen serverId={serverId} teamId={teamId} kind={rawKind} collection={collection.data} />;
        }
    }
    const kind = readTeamSharedListKind(rawKind);
    return kind ? (
        <TeamSharedKindScreen serverId={serverId} teamId={teamId} kind={kind} />
    ) : <SurfaceStateCard testID="team-shared-kind-unknown" kind="unavailable" title={t('common.unavailable')} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { TeamSharedKindRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={TeamSharedKindRoute} />; }
