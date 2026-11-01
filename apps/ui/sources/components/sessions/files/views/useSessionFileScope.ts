import * as React from 'react';

import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

/** File navigation may retain an SCM-produced base independent of the Session's current cwd. */
export function useSessionFileScope(sessionId: string, serverId?: string | null, rootPath?: string): WorkspaceScopeBase | null {
    const sessionScope = useWorkspaceScopeForSession(sessionId, serverId);
    return React.useMemo(() => sessionScope && rootPath
        ? { serverId: sessionScope.serverId, machineId: sessionScope.machineId, rootPath }
        : sessionScope, [sessionScope, rootPath]);
}
