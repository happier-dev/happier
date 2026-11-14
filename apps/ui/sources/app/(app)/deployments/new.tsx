import * as React from 'react';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { readProjectRouteStringParam } from '@/components/projects/detail/projectRouteState';
import { DeploymentDefinitionDraftPage } from '@/components/projects/deployments/DeploymentDefinitionDraftPage';

export function WorkspaceRouteBody() {
  const params = useLocalSearchParams<Record<string, string | string[] | undefined>>();
  const kind = readProjectRouteStringParam(params.newDefinition);
  return <DeploymentDefinitionDraftPage serverId={readProjectRouteStringParam(params.serverId)} definitionKind={kind === 'image' ? 'image' : 'compose'}
    initialMachineId={readProjectRouteStringParam(params.deployMachine)} />;
}

export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
