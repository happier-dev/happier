import * as React from 'react';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { useIsFocused, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { readProjectRouteStringParam } from '@/components/projects/detail/projectRouteState';
import { ProjectDeploymentsBody } from '@/components/projects/deployments/ProjectDeploymentsBody';
import { useDeploymentPresentationDemand } from '@/components/projects/deployments/useDeploymentPresentationDemand';
import { ProjectSourceShellHeaderHost } from '@/components/projects/shell/ProjectShellHeaderHost';
import { DetailsPaneSlotHost } from '@/components/appShell/panes/details/DetailsPaneSlot';

export function WorkspaceRouteBody() {
    const params = useLocalSearchParams<Record<string, string | string[] | undefined>>();
    const isFocused = useIsFocused();
    const serverId = readProjectRouteStringParam(params.serverId);
    const projectSourceId = readProjectRouteStringParam(params.projectSourceId);
    const demand = useDeploymentPresentationDemand(isFocused);
    // The page's details slot: an Environment's companion (Logs) docks beside it here as on the Project page (P11).
    return <DetailsPaneSlotHost testID="project-deployments.details">
        {/* The Project header stands above the page unless the Environment page stands beside the Services column. */}
        <ProjectDeploymentsBody serverId={serverId} projectSourceId={projectSourceId} isFocused={isFocused}
            header={<ProjectSourceShellHeaderHost serverId={serverId} sourceId={projectSourceId} presented={demand.visible} />} />
    </DetailsPaneSlotHost>;
}

export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
