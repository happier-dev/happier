import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useSetting } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

export function useWorkspaceRefById(workspaceRefId: string): WorkspaceRefV1 | null {
    const activeServer = useActiveServerSnapshot();
    const workspaceRefsV1 = useSetting('workspaceRefsV1');

    return React.useMemo(() => {
        const id = String(workspaceRefId ?? '').trim();
        if (!id) return null;
        const serverId = String(activeServer.serverId ?? '').trim();
        const refs = Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [];
        return refs.find((ref) => ref.id === id && String(ref.serverId ?? '').trim() === serverId) ?? null;
    }, [activeServer.serverId, workspaceRefId, workspaceRefsV1]);
}
