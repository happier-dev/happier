import * as React from 'react';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { createProjectManifestActionClient } from './projectManifestActionClient';
import { createProjectSharedSetupReview } from './projectSharedSetupReview';
import type { ProjectSetupSharingActionOptions } from './useProjectSetupSharing';

type ReviewSelection = Pick<Parameters<typeof createProjectSharedSetupReview>[0], 'projectRef' | 'expectedRevision' | 'sourceId'>;
/** Existing checkout only: callers pass its accepted Project row and delegate request decisions to Scripts. */
export function useProjectSharedSetupReview(workspace: WorkspaceAddressV1, binding: ServerCredentialAccountScopeBinding | null,
    selection: ReviewSelection, options: ProjectSetupSharingActionOptions = {}) {
    const key = JSON.stringify([buildWorkspaceCacheKey(workspace), workspace.workspaceId, selection.projectRef, selection.expectedRevision, selection.sourceId]);
    const execute = options.execute;
    const onApprovalPending = useEventCallback((approval: ActionApprovalRegistration) => options.onApprovalPending?.(approval));
    const { projectRef, expectedRevision, sourceId } = selection;
    const [mounted, setMounted] = React.useState<Readonly<{
        key: string; binding: ServerCredentialAccountScopeBinding; model: ReturnType<typeof createProjectSharedSetupReview>;
    }> | null>(null);
    React.useEffect(() => {
        if (!binding?.isCurrent()) { setMounted(null); return; }
        const controller = new AbortController();
        const client = createProjectManifestActionClient({ workspace, expectedAccountId: binding.accountId,
            execute, onApprovalPending, signal: controller.signal });
        const model = createProjectSharedSetupReview({ client, projectRef, expectedRevision, sourceId });
        setMounted({ key, binding, model });
        const dispose = () => { controller.abort(); model.dispose(); };
        const retirement = binding.onRetire(dispose);
        return () => { retirement.dispose(); dispose(); };
        // Explicit qualified selection owns review; no ambient Account, Source inventory, or polling.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, binding, execute, onApprovalPending]);
    const owner = mounted?.key === key && mounted.binding === binding && binding?.isCurrent() ? mounted.model : null;
    const subscribe = React.useCallback((listener: () => void) => owner?.subscribe(listener) ?? (() => {}), [owner]);
    const snapshot = React.useSyncExternalStore(subscribe, () => owner?.getSnapshot() ?? null, () => null);
    return React.useMemo(() => ({ snapshot, controller: owner }), [snapshot, owner]);
}
