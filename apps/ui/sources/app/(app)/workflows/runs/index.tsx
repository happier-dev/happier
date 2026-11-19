import * as React from 'react';

import { WorkflowsDestinationIndex } from '@/components/workflows/library/WorkflowsDestinationIndex';

/**
 * The Runs deep link is the destination with its column on Runs: beside the column, main holds the Runs
 * table (scene 8 D2, superseding DESIGN-16 D9); without it, the column-as-page opens on Runs.
 */
export function WorkflowsRunsRoute(): React.ReactElement {
    return <WorkflowsDestinationIndex view="runs" />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { WorkflowsRunsRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkflowsRunsRoute} />; }
