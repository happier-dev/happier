import * as React from 'react';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { ProjectDestinationBody } from '@/components/projects/detail/ProjectDestinationBody';

export { ProjectDestinationBody as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ProjectDestinationBody} />; }
