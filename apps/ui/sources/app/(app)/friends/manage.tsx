import * as React from 'react';

import { Redirect } from '@/components/appShell/workspace/destinationRoute';

/** Friends management is part of the one People page now (owner ruling Q6); old links land there. */
export function FriendsManageScreen() {
    return <Redirect href="/friends" />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { FriendsManageScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={FriendsManageScreen} />; }
