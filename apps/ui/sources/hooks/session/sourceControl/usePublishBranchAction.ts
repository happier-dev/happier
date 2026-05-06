import * as React from 'react';

import { useScmPublishBranchAction } from '@/hooks/sourceControl/useScmPublishBranchAction';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { runScmOperationWithGitIndexLockRecovery } from '@/scm/operations/gitIndexLockRecovery';
import { sessionScmRemotePublish, sessionScmRepositoryRemoveIndexLock } from '@/sync/ops';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

type UsePublishBranchActionInput = Readonly<{
    sessionId?: string;
    snapshot?: ScmWorkingSnapshot | null;
    writeEnabled?: boolean;
    disabled?: boolean;
}>;

type UsePublishBranchActionResult = Readonly<{
    canPublish: boolean;
    publishBusy: boolean;
    publishBranch: () => Promise<boolean>;
}>;

// Shared publish-branch action so all SCM surfaces use the same capability gate, mutation flow, and error handling.
export function usePublishBranchAction(input: UsePublishBranchActionInput): UsePublishBranchActionResult {
    const sessionId = React.useMemo(() => (typeof input.sessionId === 'string' ? input.sessionId.trim() : ''), [input.sessionId]);
    const repoPath = typeof input.snapshot?.repo.rootPath === 'string' && input.snapshot.repo.rootPath.trim().length > 0
        ? input.snapshot.repo.rootPath
        : null;
    const executePublish = React.useCallback((remote: string) => {
        const publish = () => sessionScmRemotePublish(sessionId, { remote });
        return publish().then(async (response) => {
            if (response.success || !repoPath) return response;
            return await runScmOperationWithGitIndexLockRecovery({
                cwd: repoPath,
                failedResponse: response,
                removeIndexLock: (request) => sessionScmRepositoryRemoveIndexLock(sessionId, request),
                retryOriginalOperation: publish,
            });
        });
    }, [repoPath, sessionId]);
    const refreshAfterPublish = React.useCallback(() => {
        return scmStatusSync.invalidateFromMutationAndAwait(sessionId);
    }, [sessionId]);

    return useScmPublishBranchAction({
        actionTargetId: sessionId,
        snapshot: input.snapshot,
        writeEnabled: input.writeEnabled,
        disabled: input.disabled,
        executePublish,
        refreshAfterPublish,
    });
}
