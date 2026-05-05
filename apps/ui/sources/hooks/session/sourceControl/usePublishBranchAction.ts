import * as React from 'react';

import { useScmPublishBranchAction } from '@/hooks/sourceControl/useScmPublishBranchAction';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { sessionScmRemotePublish } from '@/sync/ops';
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
    const executePublish = React.useCallback((remote: string) => {
        return sessionScmRemotePublish(sessionId, { remote });
    }, [sessionId]);
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
