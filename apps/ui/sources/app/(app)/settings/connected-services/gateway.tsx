import * as React from 'react';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { ConnectedServiceGatewayPage } from '@/components/settings/connectedServices/ConnectedServiceGatewayPage';

export const WorkspaceRouteBody = ConnectedServiceGatewayPage;
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
