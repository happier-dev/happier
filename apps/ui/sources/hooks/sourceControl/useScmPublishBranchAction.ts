import * as React from 'react';

import { Modal } from '@/modal';
import { resolvePublishRemoteFromSnapshot } from '@/scm/operations/remoteTarget';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

type PublishBranchResponse = Readonly<{
    success: boolean;
    error?: string | null;
    stderr?: string | null;
}>;

type UseScmPublishBranchActionInput = Readonly<{
    actionTargetId?: string | null;
    snapshot?: ScmWorkingSnapshot | null;
    writeEnabled?: boolean;
    disabled?: boolean;
    executePublish: (remote: string) => Promise<PublishBranchResponse>;
    refreshAfterPublish: () => Promise<void>;
}>;

type UseScmPublishBranchActionResult = Readonly<{
    canPublish: boolean;
    publishBusy: boolean;
    publishBranch: () => Promise<boolean>;
}>;

export function resolveScmPublishBranchAvailability(input: Readonly<{
    actionTargetId?: string | null;
    snapshot?: ScmWorkingSnapshot | null;
    writeEnabled?: boolean;
    disabled?: boolean;
}>): Readonly<{ canPublish: boolean; publishRemote: string | null }> {
    const actionTargetId = typeof input.actionTargetId === 'string' ? input.actionTargetId.trim() : '';
    const publishRemote = resolvePublishRemoteFromSnapshot(input.snapshot);
    const canPublish = Boolean(
        actionTargetId
        && input.writeEnabled === true
        && input.disabled !== true
        && input.snapshot?.capabilities?.writeRemotePublish === true
        && input.snapshot.repo.isRepo === true
        && input.snapshot.branch.detached !== true
        && input.snapshot.branch.head
        && !input.snapshot.branch.upstream
        && publishRemote,
    );
    return { canPublish, publishRemote };
}

export function useScmPublishBranchAction(input: UseScmPublishBranchActionInput): UseScmPublishBranchActionResult {
    const actionTargetId = typeof input.actionTargetId === 'string' ? input.actionTargetId.trim() : '';
    const executePublish = input.executePublish;
    const refreshAfterPublish = input.refreshAfterPublish;
    const { canPublish, publishRemote } = resolveScmPublishBranchAvailability({
        actionTargetId,
        snapshot: input.snapshot,
        writeEnabled: input.writeEnabled,
        disabled: input.disabled,
    });
    const [publishBusy, setPublishBusy] = React.useState(false);

    const publishBranch = React.useCallback(async (): Promise<boolean> => {
        if (!actionTargetId || !canPublish || publishBusy || !publishRemote) return false;

        setPublishBusy(true);
        try {
            const response = await executePublish(publishRemote);
            if (!response.success) {
                Modal.alert(t('common.error'), response.error || response.stderr || t('files.branchMenu.publish.failed'));
                return false;
            }
            await refreshAfterPublish();
            return true;
        } finally {
            setPublishBusy(false);
        }
    }, [actionTargetId, canPublish, executePublish, publishBusy, publishRemote, refreshAfterPublish]);

    return React.useMemo(() => ({
        canPublish,
        publishBusy,
        publishBranch,
    }), [canPublish, publishBranch, publishBusy]);
}
