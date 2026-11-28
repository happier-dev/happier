import * as React from 'react';

import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

/**
 * The Automations deep link borrows the Session detail route's exact address and hydration.
 */
export function SessionTriggersRoute(): React.ReactElement | null {
    const params = useLocalSearchParams<Record<string, string | string[]>>();
    const sessionId = typeof params.id === 'string' ? params.id : null;
    if (sessionId === null) return null;
    const forwarded: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
        if (key !== 'id' && typeof value === 'string') forwarded[key] = value;
    }
    return <Redirect href={{ pathname: '/session/[id]/info', params: { ...forwarded, id: sessionId, section: 'automations' } } as never} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { SessionTriggersRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionTriggersRoute} />; }
