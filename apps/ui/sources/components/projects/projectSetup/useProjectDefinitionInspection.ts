import * as React from 'react';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';

import { createProjectManifestActionClient } from './projectManifestActionClient';

export type ProjectDefinitionInspection = Awaited<ReturnType<ReturnType<typeof createProjectManifestActionClient>['inspect']>>;
export type ProjectDefinitionInspectionRead =
    | Readonly<{ key: string; value: ProjectDefinitionInspection }>
    | Readonly<{ key: string; error: string }>;

/** One exact checkout's identity for the inspection it belongs to. */
export function projectDefinitionInspectionKey(workspace: WorkspaceAddressV1): string {
    return `${buildWorkspaceCacheKey(workspace)}:${workspace.workspaceId}`;
}

/**
 * One exact checkout's project definition and what reading its files found (`projects.inspect`, plan
 * 20's passive owner); nothing here executes. A read for another checkout is never shown as this one's.
 */
export function useProjectDefinitionInspection(workspace: WorkspaceAddressV1 | null, binding: ServerCredentialAccountScopeBinding | null): Readonly<{
    read: ProjectDefinitionInspectionRead | null;
    retry: () => void;
}> {
    const accountId = binding?.isCurrent() ? binding.accountId : null;
    const key = workspace ? projectDefinitionInspectionKey(workspace) : null;
    const scopeKey = accountId && key ? JSON.stringify([binding?.serverId, accountId, key]) : null;
    const [read, setRead] = React.useState<Readonly<{ scopeKey: string; read: ProjectDefinitionInspectionRead }> | null>(null);
    const [refresh, setRefresh] = React.useState(0);
    const workspaceRef = React.useRef(workspace);
    workspaceRef.current = workspace;
    React.useEffect(() => {
        const current = workspaceRef.current;
        if (!accountId || !key || !scopeKey || !current || !binding?.isCurrent()) return;
        const controller = new AbortController();
        const retirement = binding.onRetire(() => { controller.abort(); setRead(null); });
        const client = createProjectManifestActionClient({ workspace: current, expectedAccountId: accountId, signal: controller.signal });
        void client.inspect().then(value => {
            if (!controller.signal.aborted && binding.isCurrent()) setRead({ scopeKey, read: { key, value } });
        }).catch((error: unknown) => {
            if (!controller.signal.aborted && binding.isCurrent()) setRead({ scopeKey, read: { key, error: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                ? error.code : 'project_definition_inspection_failed' } });
        });
        return () => { retirement.dispose(); controller.abort(); };
    }, [accountId, binding, key, scopeKey, refresh]);
    const retry = React.useCallback(() => setRefresh(value => value + 1), []);
    return { read: binding?.isCurrent() && read?.scopeKey === scopeKey ? read.read : null, retry };
}
