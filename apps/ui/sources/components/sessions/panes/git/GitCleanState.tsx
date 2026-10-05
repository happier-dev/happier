import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ScmLogEntry } from '@happier-dev/protocol';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { SourceControlOperationsHistoryTimelineRow } from '@/components/workspaces/scm/SourceControlOperationsHistoryTimelineRow';
import { formatScmTimelineWhen } from '@/scm/history/historyPresentation';
import { t } from '@/text';

/**
 * Git lab ST "Clean and up to date" / SX "All clean": an empty change list is a finished state, not an
 * apology. It says what is true (everything committed; pushed when origin matches), and offers one next step
 * the system can back: create a pull request, or open the one that exists.
 */
export const GitCleanState = React.memo(function GitCleanState(props: Readonly<{
    branch: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
    lastCommitAt: number | null;
    lastCommit?: ScmLogEntry | null;
    onOpenCommit?: (sha: string) => void;
    lastPushedAt?: number | null;
    justCompleted?: boolean;
    phone?: boolean;
    onCreatePullRequest: (() => void) | null;
    onOpenPullRequest: (() => void) | null;
    pullRequestNumber: number | null;
}>) {
    const { theme } = useUnistyles();
    const upToDate = Boolean(props.upstream) && props.ahead === 0 && props.behind === 0;
    const title = upToDate && props.justCompleted ? t('sessionGitPane.fidelity.allClean') : upToDate ? t('sessionGitPane.flow.clean.titleUpToDate') : t('sessionGitPane.flow.clean.titleCommitted');
    const reason = upToDate && props.branch && props.upstream
        ? t('sessionGitPane.flow.clean.bodyUpToDate', { branch: props.branch, upstream: props.upstream })
        : t('sessionGitPane.flow.clean.body');
    const action = props.onOpenPullRequest && props.pullRequestNumber
        ? { label: t('sessionGitPane.flow.clean.openPullRequest', { number: String(props.pullRequestNumber) }), onPress: props.onOpenPullRequest }
        : props.onCreatePullRequest
            ? { label: t('sessionGitPane.flow.clean.createPullRequest'), onPress: props.onCreatePullRequest }
            : undefined;
    const body = props.lastCommit && props.onOpenCommit ? <SourceControlOperationsHistoryTimelineRow theme={theme} entry={props.lastCommit} isHead showTrailingLine={false} layout="summary" whenFormat="elapsed" onOpenCommit={props.onOpenCommit} /> : undefined;
    const state = (
        <SurfaceStateCard
            testID="session-git-clean"
            size={props.phone ? 'phone' : 'pane'}
            layout="inline"
            kind="success"
            title={title}
            reason={reason}
            body={body}
            actionCaption={action ? t('sessionGitPane.fidelity.suggestedNext') : undefined}
            {...(action ? { action } : {})}
            {...(props.lastPushedAt ? { live: { text: t('sessionGitPane.fidelity.lastPushed', { when: formatScmTimelineWhen(props.lastPushedAt) }) } } : props.lastCommitAt ? { live: { text: t('sessionGitPane.flow.clean.lastCommit', { when: formatScmTimelineWhen(props.lastCommitAt) }) } } : {})}
        />
    );
    return <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}><SurfaceCard padding="sm" style={{ backgroundColor: theme.colors.state.success.background, borderColor: theme.colors.state.success.border }}>{state}</SurfaceCard></View>;
});
