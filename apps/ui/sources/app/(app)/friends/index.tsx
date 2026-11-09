import * as React from 'react';

import { FriendsView } from '@/components/navigation/shell/FriendsView';
import { useRequireFriendsEnabled } from '@/hooks/friends/useRequireFriendsEnabled';

/** People (owner ruling Q6): friends and teammates on one page, headed by its own page header. */
export function FriendsPage() {
  const enabled = useRequireFriendsEnabled();
  if (!enabled) return null;
  return <FriendsView />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { FriendsPage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={FriendsPage} />; }
