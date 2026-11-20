import * as React from 'react';

import { Redirect } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

/** `/settings/machines/presets` (a typed or shared link): the Presets index lives at `/machines/presets`. */
export const WorkspaceRouteBody = React.memo(function MachinePresetsSettingsRoute() {
    return <Redirect href={'/machines/presets' as never} />;
});
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
