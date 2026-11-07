import * as React from 'react';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { useIsFocused, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { readProjectRouteStringParam } from '@/components/projects/detail/projectRouteState';
import { ProjectDeploymentsBody } from '@/components/projects/deployments/ProjectDeploymentsBody';

export function WorkspaceRouteBody() {
    const params = useLocalSearchParams<Record<string, string | string[] | undefined>>();
    const isFocused = useIsFocused();
    return <ProjectDeploymentsBody serverId={readProjectRouteStringParam(params.serverId)}
        projectSourceId={readProjectRouteStringParam(params.projectSourceId)} isFocused={isFocused} />;
}

export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
