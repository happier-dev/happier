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

function resolvePublishRemote(snapshot: ScmWorkingSnapshot | null | undefined): string | null {
    const remotes = snapshot?.repo.remotes ?? [];
    if (remotes.length === 0) return null;
    const origin = remotes.find((remote) => remote.name === 'origin');
    return (origin ?? remotes[0])?.name ?? null;
}

function resolveCanPublish(input: UsePublishBranchActionInput, publishRemote: string | null): boolean {
    return Boolean(
        input.sessionId
        && input.writeEnabled === true
        && input.disabled !== true
        && input.snapshot?.capabilities?.writeRemotePublish === true
        && input.snapshot.repo.isRepo === true
        && input.snapshot.branch.detached !== true
        && input.snapshot.branch.head
        && !input.snapshot.branch.upstream
        && publishRemote,
    );
}

// Shared publish-branch action so all SCM surfaces use the same capability gate, mutation flow, and error handling.
export function usePublishBranchAction(input: UsePublishBranchActionInput): UsePublishBranchActionResult {
    const publishRemote = resolvePublishRemote(input.snapshot);
    const canPublish = resolveCanPublish(input, publishRemote);
    const [publishBusy, setPublishBusy] = React.useState(false);

    const publishBranch = React.useCallback(async (): Promise<boolean> => {
        if (!input.sessionId || !canPublish || publishBusy || !publishRemote) return false;

        setPublishBusy(true);
        try {
            const response = await sessionScmRemotePublish(input.sessionId, { remote: publishRemote });
            if (!response.success) {
                Modal.alert(t('common.error'), response.error || t('files.branchMenu.publish.failed'));
                return false;
            }
            await scmStatusSync.invalidateFromMutationAndAwait(input.sessionId);
            return true;
        } finally {
            setPublishBusy(false);
        }
    }, [canPublish, input.sessionId, publishBusy, publishRemote]);

    return React.useMemo(() => ({
        canPublish,
        publishBusy,
        publishBranch,
    }), [canPublish, publishBranch, publishBusy]);
}
