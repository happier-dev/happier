import * as React from 'react';

import { MonitoringScreen } from '@/components/monitoring/MonitoringScreen';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

/** The Monitoring destination: whether everything the Account runs is up (MONITOR-LAB-1115 B). */
function MonitoringRoute(): React.ReactElement {
    return <MonitoringScreen />;
}

export { MonitoringRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={MonitoringRoute} />; }
