import * as React from 'react';
import { ScrollView } from 'react-native';

import { useDetailsTabChrome } from '@/components/appShell/panes/details/workspace/detailsTabChrome';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useSessionScmDraft } from '@/hooks/session/sourceControl/useSessionScmDraft';
import { useSessionProjectScmSnapshot } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { GitPullRequestCard } from './GitPullRequestCard';
import { GitPullRequestForm, type GitPullRequestCreated } from './GitPullRequestForm';
import { resolveGitPullRequestCardModel } from './gitPullRequestCardModel';
import {
    closeGitPullRequestForm,
    moveGitPullRequestForm,
    readGitPullRequestFormState,
} from './gitPullRequestFormState';

/**
 * The "New pull request" Details destination (Git lab PRD): the same form as the sidebar with room to write,
 * reading the same session draft. The tab carries the unsaved dot while a draft is written; closing the tab keeps
 * the draft; "Move back to the sidebar" returns the form to the Git pane.
 */
export function SessionScmPullRequestDetailsView(props: Readonly<{
    sessionId: string;
    serverId?: string;
    /** Closes this Details tab. */
    onCloseTab: () => void;
}>) {
    const snapshot = useSessionProjectScmSnapshot(props.sessionId, props.serverId);
    const { machineReachable } = useSessionMachineReachability(props.sessionId, props.serverId);
    const scmDraft = useSessionScmDraft({ sessionId: props.sessionId, serverId: props.serverId });
    const chrome = useDetailsTabChrome();
    const pullRequestDraft = scmDraft.draft.pullRequest;
    const unsaved = Boolean(pullRequestDraft && (pullRequestDraft.title.trim() || pullRequestDraft.body.trim()));
    React.useEffect(() => {
        chrome.setUnsaved(unsaved);
    }, [chrome, unsaved]);
    React.useEffect(() => () => chrome.setUnsaved(false), [chrome]);

    // This destination is where the form lives while it is open (a deep link or reload included); leaving it
    // closes the form but keeps the draft.
    React.useEffect(() => {
        moveGitPullRequestForm(props.sessionId, props.serverId, 'details');
        return () => {
            if (readGitPullRequestFormState(props.sessionId, props.serverId).placement === 'details') {
                closeGitPullRequestForm(props.sessionId, props.serverId);
            }
        };
    }, [props.serverId, props.sessionId]);

    const [created, setCreated] = React.useState<GitPullRequestCreated | null>(null);
    const onCreated = React.useCallback((next: GitPullRequestCreated) => {
        setCreated(next);
        closeGitPullRequestForm(props.sessionId, props.serverId);
    }, [props.serverId, props.sessionId]);
    const onMoveBack = React.useCallback(() => {
        moveGitPullRequestForm(props.sessionId, props.serverId, 'sidebar');
        props.onCloseTab();
    }, [props]);
    const onClose = React.useCallback(() => {
        closeGitPullRequestForm(props.sessionId, props.serverId);
        props.onCloseTab();
    }, [props]);

    if (!snapshot) {
        return <SurfaceStateCard testID="git-pull-request-details-loading" kind="loading" title={t('common.loading')} />;
    }
    const card = created ? resolveGitPullRequestCardModel(snapshot, created) : null;
    return (
        <ScrollView testID="git-pull-request-details" keyboardShouldPersistTaps="handled">
            {card ? (
                <GitPullRequestCard model={card.model} animateIn={card.source === 'just-created'} />
            ) : (
                <GitPullRequestForm
                    sessionId={props.sessionId}
                    serverId={props.serverId}
                    snapshot={snapshot}
                    machineReachable={machineReachable}
                    placement="details"
                    onMoveBack={onMoveBack}
                    onClose={onClose}
                    onCreated={onCreated}
                />
            )}
        </ScrollView>
    );
}
