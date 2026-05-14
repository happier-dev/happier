import * as React from 'react';

import { resolveWorkspaceFavicon, type WorkspaceFaviconResult } from '@/sync/ops/workspaceFavicon';

export function useWorkspaceFavicon(params: Readonly<{
    enabled: boolean;
    serverId?: string | null;
    machineId?: string | null;
    workspacePath?: string | null;
}>): Extract<WorkspaceFaviconResult, { status: 'found' }> | null {
    const [favicon, setFavicon] = React.useState<Extract<WorkspaceFaviconResult, { status: 'found' }> | null>(null);
    const serverId = params.serverId ?? null;
    const machineId = params.machineId ?? null;
    const workspacePath = params.workspacePath ?? null;

    React.useEffect(() => {
        let cancelled = false;
        if (!params.enabled || !machineId || !workspacePath) {
            setFavicon(null);
            return () => {
                cancelled = true;
            };
        }

        setFavicon(null);
        void resolveWorkspaceFavicon({
            enabled: params.enabled,
            serverId,
            machineId,
            workspacePath,
        }).then((result) => {
            if (cancelled) return;
            setFavicon(result.status === 'found' ? result : null);
        }).catch(() => {
            if (!cancelled) setFavicon(null);
        });

        return () => {
            cancelled = true;
        };
    }, [params.enabled, serverId, machineId, workspacePath]);

    return favicon;
}
