import * as React from 'react';
import { View } from 'react-native';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import type { ScmOperationState } from '@happier-dev/protocol';

type ScmRepositoryOperationKind = ScmOperationState['kind'];
import { t } from '@/text';

/**
 * Git lab CF: when a merge or rebase stops, the pane says so first — how many files changed on both sides —
 * and offers the ways forward the system really has: hand the conflicts to the session's agent as a composer
 * draft (nothing is sent), continue once every file is resolved, or abort (confirmed). Pure presentation over
 * the snapshot's operation state and `selectScmConflictFiles`; writes go through the pane's mutation owner.
 */
export const GitConflictNotice = React.memo(function GitConflictNotice(props: Readonly<{
    sessionId: string;
    serverId?: string;
    agentName?: string | null;
    /** The repository's in-progress operation, as the Git owner derives it (kind, Continue/Abort availability). */
    operation: ScmOperationState | null;
    conflictPaths: readonly string[];
    busy: boolean;
    onContinue: (operation: ScmRepositoryOperationKind) => void;
    onAbort: (operation: ScmRepositoryOperationKind) => void;
    /** Skip the commit being replayed (rebase / cherry-pick), when the Git owner allows it. */
    onSkip?: (operation: ScmRepositoryOperationKind) => void;
    /** The backend can skip a replayed commit (`writeBranchOperationSkip`). */
    canSkipOperation?: boolean;
    onAskedAgent?: () => void;
    onAskFailed?: () => void;
}>) {
    const count = props.operation?.unresolvedCount ?? props.conflictPaths.length;
    const kind = props.operation?.kind ?? null;
    // Orchestrator decision 3: resolution is an ordinary agent task, seeded with the exact conflict context and
    // sent through the session's one send owner. The agent may edit and stage, then stops for review; Continue
    // stays the person's separate, approved step. Nothing auto-aborts, cleans, pushes or picks a side.
    const [asking, setAsking] = React.useState(false);
    const askAgent = React.useCallback(() => {
        if (asking || !kind) return;
        setAsking(true);
        const request = t('sessionGitPane.flow.conflicts.askAgentTask', {
            operation: operationName(kind),
            files: props.conflictPaths.join(', '),
        });
        void sync.submitMessage(props.sessionId, request, request, undefined, {
            ...(props.serverId ? { serverId: props.serverId } : {}),
            callerSurface: 'scm_conflict_resolution',
        }).then(() => props.onAskedAgent?.(), () => props.onAskFailed?.()).finally(() => setAsking(false));
    }, [asking, kind, props]);
    const abort = React.useCallback(async () => {
        if (!kind) return;
        const confirmed = await Modal.confirm(
            t('sessionGitPane.flow.conflicts.abortTitle', { operation: operationName(kind) }),
            t('sessionGitPane.flow.conflicts.abortBody'),
            { confirmText: t('sessionGitPane.flow.conflicts.abort', { operation: operationName(kind) }), cancelText: t('common.cancel'), destructive: true },
        );
        if (confirmed) props.onAbort(kind);
    }, [kind, props]);

    if (!kind && count === 0) return null;
    const title = kind
        ? count > 0
            ? t('sessionGitPane.flow.conflicts.stopped', { operation: operationName(kind), count, formatted: formatExactCount(count) })
            : t('sessionGitPane.flow.conflicts.readyToContinue', { operation: operationName(kind) })
        : t('sessionGitPane.flow.conflicts.filesInConflict', { count, formatted: formatExactCount(count) });
    const description = count > 0
        ? `${props.agentName ? t('sessionGitPane.fidelity.conflictBody', { agent: props.agentName }) : t('sessionGitPane.flow.conflicts.body')} ${props.operation?.canAbort ? t('sessionGitPane.fidelity.conflictReassurance') : t('sessionGitPane.flow.conflicts.continueBody')}`
        : t('sessionGitPane.flow.conflicts.continueBody');
    // Continue and Abort are offered exactly when the Git owner says they can run (never while files are unresolved).
    const canContinue = props.operation?.canContinue === true;
    const canAbort = props.operation?.canAbort === true;
    const primary = count > 0
        ? (kind ? { label: props.agentName ? t('sessionGitPane.fidelity.askAgent', { agent: props.agentName }) : t('sessionGitPane.flow.conflicts.askAgent'), onPress: askAgent, disabled: asking || props.busy, loading: asking, testID: 'session-git-conflicts-ask-agent' } : null)
        : kind && canContinue
            ? { label: t('sessionGitPane.flow.conflicts.continue', { operation: operationName(kind) }), onPress: () => props.onContinue(kind), disabled: props.busy, testID: 'session-git-conflicts-continue' }
            : null;
    const canSkip = kind !== null && props.operation?.canSkip === true && props.canSkipOperation === true && Boolean(props.onSkip);
    const secondary = kind && canAbort
        ? { label: t('sessionGitPane.flow.conflicts.abort', { operation: operationName(kind) }), onPress: () => void abort(), disabled: props.busy, testID: 'session-git-conflicts-abort' }
        : null;
    const skip = kind && canSkip
        ? [{ label: t('sessionGitPane.flow.conflicts.skip'), onPress: () => props.onSkip?.(kind), disabled: props.busy, testID: 'session-git-conflicts-skip' }]
        : undefined;
    return (
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 6 }}>
            <AttentionBanner
                placement="inline"
                testID="session-git-conflicts"
                title={title}
                description={description}
                action={primary ? { ...primary, display: 'default' } : null}
                secondaryAction={secondary}
                moreActions={skip}
                announce="alert"
            />
        </View>
    );
});

function operationName(operation: ScmRepositoryOperationKind): string {
    switch (operation) {
        case 'merge': return t('sessionGitPane.flow.conflicts.merge');
        case 'rebase': return t('sessionGitPane.flow.conflicts.rebase');
        case 'revert': return t('sessionGitPane.flow.conflicts.revert');
        case 'cherry_pick': return t('sessionGitPane.flow.conflicts.cherryPick');
    }
}
