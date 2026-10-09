import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { MemoryDocumentScreen } from '@/components/memory/MemoryDocumentScreen';

export function MemoryDocumentPage() {
  const { id, serverId, topic } = useLocalSearchParams<{ id: string; serverId?: string; topic?: string }>();
  if (!id) return null;
  return <MemoryDocumentScreen artifactId={id} serverId={serverId} topic={topic} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { MemoryDocumentPage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={MemoryDocumentPage} />; }
