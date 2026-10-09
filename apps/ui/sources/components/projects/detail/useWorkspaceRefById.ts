import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import * as React from 'react';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';

/** Deep links retain qualified candidates for the incumbent choose/repair surface. */
export function useWorkspaceRefResolutionById(workspaceRefId: string, explicitServerId?: string | null) {
    const workspaceRefsV1 = useWorkspaceRefs();

    return React.useMemo(() => {
        const id = String(workspaceRefId ?? '').trim();
        const refs = Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [];
        return resolveWorkspaceRefById(refs, id, explicitServerId ?? undefined);
    }, [explicitServerId, workspaceRefId, workspaceRefsV1]);
}

export function useWorkspaceRefById(workspaceRefId: string, explicitServerId?: string | null): WorkspaceRefV1 | null {
    const result = useWorkspaceRefResolutionById(workspaceRefId, explicitServerId);
    return result.kind === 'resolved' ? result.ref : null;
}
