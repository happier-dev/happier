import * as React from 'react';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { formatScmTimelineWhen } from '@/scm/history/historyPresentation';
import { runSessionScmMutation } from '@/scm/operations/runSessionScmMutation';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { resolveScmStashIdentity } from '@/scm/stash/stashIdentity';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { sessionScmStashPop } from '@/sync/ops';
import { t } from '@/text';
import { selectKeptAsideStash } from './keptAside';
import { useSessionScmStashes } from './useSessionScmStashes';

export type GitKeptAsideNoticeProps = Readonly<{
    sessionId: string;
    serverId?: string;
    snapshot: ScmWorkingSnapshot | null;
    /** Another write is running, or the session cannot act: Restore waits, Look first still works. */
    disabled?: boolean;
    /** Opens the kept-aside changes in Details (the pane's existing stash destination). */
    onOpenStashDetails?: () => void;
}>;

/**
 * Coming back to a branch, the Git pane anticipates (lab SZ): "You kept changes aside on v0.3 · Restore / Look
 * first". It speaks only for the stash Happier kept for *this* branch when you switched away. Restore runs through
 * the project SCM operation owner, so progress and the result show in the outcome line. Undo after a restore is
 * not offered: it needs a re-stash operation that does not exist yet.
 */
export function GitKeptAsideNotice(props: GitKeptAsideNoticeProps): React.ReactElement | null {
    const snapshot = props.snapshot;
    const branch = snapshot?.repo.isRepo && !snapshot.branch.detached ? snapshot.branch.head : null;
    const enabled = Boolean(branch) && snapshot?.capabilities?.readStash === true;
    const stashes = useSessionScmStashes({
        sessionId: props.sessionId,
        serverId: props.serverId,
        enabled,
        refreshKey: `${branch ?? ''}\u0000${snapshot?.stashCount ?? 0}`,
    });
    const kept = selectKeptAsideStash(stashes, branch);
    const [dismissedRef, setDismissedRef] = React.useState<string | null>(null);
    const [restoring, setRestoring] = React.useState(false);
    const canRestore = snapshot?.capabilities?.writeStash === true && props.disabled !== true && !restoring;

    const stashRef = kept ? resolveScmStashIdentity(kept) : null;
    const hasCapturedObject = Boolean(kept?.stashOid);
    const { sessionId, serverId } = props;
    const restore = React.useCallback(async () => {
        if (!stashRef || !hasCapturedObject) return;
        setRestoring(true);
        try {
            await runSessionScmMutation({
                state: storage.getState(),
                sessionId,
                ...(serverId === undefined ? {} : { serverId }),
                operation: 'stash_restore',
                cwd: snapshot?.repo.rootPath ?? null,
                fallbackError: t('sessionGitBranches.notice.restoreFailed'),
                run: () => sessionScmStashPop(sessionId, { stashRef }, serverId),
                refreshAfterMutation: () => scmStatusSync.invalidateFromMutationAndAwait(sessionId, serverId),
            });
        } finally {
            setRestoring(false);
        }
    }, [hasCapturedObject, serverId, sessionId, snapshot?.repo.rootPath, stashRef]);

    if (!kept || !branch || dismissedRef === stashRef) return null;
    const when = typeof kept.createdAt === 'number' ? formatScmTimelineWhen(kept.createdAt) : '';

    return (
        <AttentionBanner
            testID="git-kept-aside-notice"
            tone="neutral"
            title={t('sessionGitBranches.notice.title', { branch })}
            description={when ? t('sessionGitBranches.notice.reason', { when }) : t('sessionGitBranches.notice.reasonUndated')}
            action={snapshot?.capabilities?.writeStash === true && hasCapturedObject
                ? { label: t('sessionGitBranches.notice.restore'), onPress: () => { void restore(); }, disabled: !canRestore, loading: restoring }
                : null}
            secondaryAction={props.onOpenStashDetails
                ? { label: t('sessionGitBranches.notice.lookFirst'), onPress: props.onOpenStashDetails }
                : null}
            onDismiss={() => setDismissedRef(stashRef)}
        />
    );
}
