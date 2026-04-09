import * as React from 'react';

import { Modal } from '@/modal';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { sessionScmRemotePublish } from '@/sync/ops';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

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

function resolveCanPublish(input: UsePublishBranchActionInput): boolean {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    return Boolean(
        sessionId
        && input.writeEnabled === true
        && input.disabled !== true
        && input.snapshot?.capabilities?.writeRemotePublish === true
        && input.snapshot.repo.isRepo === true
        && input.snapshot.branch.detached !== true
        && input.snapshot.branch.head
        && !input.snapshot.branch.upstream,
    );
}

// Shared publish-branch action so all SCM surfaces use the same capability gate, mutation flow, and error handling.
export function usePublishBranchAction(input: UsePublishBranchActionInput): UsePublishBranchActionResult {
    const sessionId = React.useMemo(() => (typeof input.sessionId === 'string' ? input.sessionId.trim() : ''), [input.sessionId]);
    const canPublish = resolveCanPublish({ ...input, sessionId });
    const [publishBusy, setPublishBusy] = React.useState(false);

    const publishBranch = React.useCallback(async (): Promise<boolean> => {
        if (!sessionId || !canPublish || publishBusy) return false;

        setPublishBusy(true);
        try {
            const response = await sessionScmRemotePublish(sessionId, {});
            if (!response.success) {
                Modal.alert(t('common.error'), response.error || t('files.branchMenu.publish.failed'));
                return false;
            }
            await scmStatusSync.invalidateFromMutationAndAwait(sessionId);
            return true;
        } finally {
            setPublishBusy(false);
        }
    }, [canPublish, publishBusy, sessionId]);

    return React.useMemo(() => ({
        canPublish,
        publishBusy,
        publishBranch,
    }), [canPublish, publishBranch, publishBusy]);
}
