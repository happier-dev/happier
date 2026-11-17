import * as React from 'react';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { createProjectManifestActionClient } from './projectManifestActionClient';
import { createProjectSetupSharing } from './projectSetupSharing';

export type ProjectSetupSharingActionOptions = Pick<Parameters<typeof createProjectManifestActionClient>[0], 'execute' | 'onApprovalPending'>;

/** Mounting creates no reads; the share surface calls load only when the person opens it. */
export function useProjectSetupSharing(workspace: WorkspaceAddressV1, binding: ServerCredentialAccountScopeBinding | null,
    options: ProjectSetupSharingActionOptions = {}) {
    const key = JSON.stringify([buildWorkspaceCacheKey(workspace), workspace.workspaceId]);
    const execute = options.execute;
    const onApprovalPending = useEventCallback((approval: ActionApprovalRegistration) => options.onApprovalPending?.(approval));
    const [mounted, setMounted] = React.useState<Readonly<{
        key: string; binding: ServerCredentialAccountScopeBinding; model: ReturnType<typeof createProjectSetupSharing>;
    }> | null>(null);
    React.useEffect(() => {
        if (!binding?.isCurrent()) { setMounted(null); return; }
        const controller = new AbortController();
        const client = createProjectManifestActionClient({ workspace, expectedAccountId: binding.accountId,
            execute, onApprovalPending, signal: controller.signal });
        const model = createProjectSetupSharing({ client });
        setMounted({ key, binding, model });
        const dispose = () => { controller.abort(); model.dispose(); };
        const retirement = binding.onRetire(dispose);
        return () => { retirement.dispose(); dispose(); };
        // The accepted checkout identity, not address object allocation, owns this ephemeral draft.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, workspace.workspaceId, binding, execute, onApprovalPending]);
    const owner = mounted?.key === key && mounted.binding === binding && binding?.isCurrent() ? mounted.model : null;
    const subscribe = React.useCallback((listener: () => void) => owner?.subscribe(listener) ?? (() => {}), [owner]);
    const snapshot = React.useSyncExternalStore(subscribe, () => owner?.getSnapshot() ?? null, () => null);
    return React.useMemo(() => ({ snapshot, controller: owner }), [snapshot, owner]);
}
