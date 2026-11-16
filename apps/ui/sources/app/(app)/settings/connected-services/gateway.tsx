import * as React from 'react';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { ConnectedServiceGatewayPage } from '@/components/settings/connectedServices/ConnectedServiceGatewayPage';

export { ConnectedServiceGatewayPage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ConnectedServiceGatewayPage} />; }
