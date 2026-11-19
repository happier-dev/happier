import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    ReviewCommentBulkTransitionResponseV1,
    ReviewCommentEditResponseV1,
    ReviewCommentRedactResponseV1,
    ReviewCommentReplyResponseV1,
    ReviewCommentTransitionResponseV1} from '@happier-dev/protocol/reviews/comments/actions';
import type {
    ReviewCommentStateV1,
    ReviewCommentV1,
    ReviewCommentScopeV1,
} from '@happier-dev/protocol/reviews/comments/v1';
import { REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1, renderReviewFindingsForVerifyV1 } from '@happier-dev/protocol/reviews/reviewFindingsApplyInputV1';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t, usePreferredLanguage } from '@/text';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useReviewCommentsWindow } from '@/components/sessions/reviews/findings/useReviewRunComments';
import type { ReviewRunCommentsTarget } from '@/sync/domains/reviews/comments/reviewRunComments';
import { randomUUID } from '@/platform/randomUUID';
import { createReviewCommentsActions } from '@/sync/domains/reviews/comments/actions';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    recordReviewCommentWrites,
} from '@/sync/domains/reviews/comments/reviewRunComments';
import { selectReviewComments } from '@/sync/domains/reviews/comments/selectors';
import {
    applyReviewCommentList,
    createEmptyReviewCommentsState,
} from '@/sync/domains/reviews/comments/store';

import { ReviewCommentsHeaderButton } from './ReviewCommentsHeaderButton';
import { ReviewCommentsHistoryView } from './ReviewCommentsHistoryView';
import { resolveReviewCommentBodyPromptDefault, resolveReviewCommentSnapshot } from './content';
import { resolveReviewCommentFileOpen } from './reviewCommentFileTarget';
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';
import {
    ReviewCommentsPanel,
    type ReviewCommentBulkTransitionInput,
    type ReviewCommentBulkTransitionResult,
} from './ReviewCommentsPanel';
import {
    buildReviewCommentLabels,
    buildReviewCommentsHeaderLabels,
} from './sessionSurfaceLabels';

const ACTIVE_REVIEW_COMMENT_STATES: readonly ReviewCommentStateV1[] = [
    'proposed',
    'open',
    'delegated',
    'pending_review',
];

const HISTORY_REVIEW_COMMENT_STATES: readonly ReviewCommentStateV1[] = [
    'resolved',
    'dismissed',
];

const REVIEW_COMMENT_UI_MUTATION_PREFIX = 'review-comment-ui';

export type ReviewCommentsSessionSurfaceProps = Readonly<{
    /** The exact Home/Account owning this panel's executor and confirmed writes. */
    scope?: ServerAccountScope;
    projectId?: string;
    workspace?: ReviewCommentScopeV1['workspace'];
    workspaceId?: string;
    runId?: string;
    sessionId?: string;
    execute: (actionId: ActionId, input: unknown, options?: UiActionOperation) => Promise<unknown>;
    defaultPanelOpen?: boolean;
    /**
     * `external`: the host draws the disclosure itself (`ReviewCommentsHeaderButton compact` in its bar)
     * and owns `open`; this surface renders only the opened panel and reports its unresolved count.
     */
    header?: 'inline' | 'external';
    open?: boolean;
    onUnresolvedCountChange?: (count: number | null) => void;
    testID?: string;
}>;

function createReviewCommentClientMutationId(operation: string): string {
    return `${REVIEW_COMMENT_UI_MUTATION_PREFIX}:${operation}:${randomUUID()}`;
}

function trimPromptValue(value: string | null): string | null {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
}

function isReviewCommentHistoryItem(comment: ReviewCommentV1): boolean {
    return HISTORY_REVIEW_COMMENT_STATES.includes(comment.state)
        || comment.flags.redacted === true
        || Boolean(comment.tombstone);
}

function isReviewCommentActiveItem(comment: ReviewCommentV1): boolean {
    return !isReviewCommentHistoryItem(comment);
}

export function ReviewCommentsSessionSurface(props: ReviewCommentsSessionSurfaceProps) {
    // Retire reads, continuation and rows together when the addressed comment scope changes.
    const key = JSON.stringify([props.scope ? serverAccountScopeKeySuffix(props.scope) : null,
        props.projectId, props.workspace?.machineId, props.workspace?.path,
        props.workspaceId, props.sessionId, props.runId]);
    return <ScopedReviewCommentsSessionSurface key={key} {...props} />;
}

function ScopedReviewCommentsSessionSurface(props: ReviewCommentsSessionSurfaceProps) {
    const { theme } = useUnistyles();
    const { open: openWorkspaceFile, canOpen: canOpenWorkspaceFile } = useWorkspaceFileOpener();
    const resolveFileOpen = React.useCallback((comment: ReviewCommentV1) => resolveReviewCommentFileOpen(comment, {
        serverId: props.scope?.serverId, sessionId: props.sessionId, workspaceRefId: props.workspaceId, workspace: props.workspace,
    }), [props.scope?.serverId, props.sessionId, props.workspace, props.workspaceId]);
    const canOpenFile = React.useCallback((comment: ReviewCommentV1) => canOpenWorkspaceFile && resolveFileOpen(comment) !== null,
        [canOpenWorkspaceFile, resolveFileOpen]);
    const onOpenFile = React.useCallback((comment: ReviewCommentV1) => {
        const file = resolveFileOpen(comment);
        if (file) void openWorkspaceFile(file.target, file.options);
    }, [openWorkspaceFile, resolveFileOpen]);
    const language = usePreferredLanguage();
    const labels = React.useMemo(() => buildReviewCommentLabels(), [language]);
    const headerLabels = React.useMemo(() => buildReviewCommentsHeaderLabels(), [language]);
    const actions = React.useMemo(() => createReviewCommentsActions({ execute: props.execute }), [props.execute]);
    const [ownPanelOpen, setPanelOpen] = React.useState(props.defaultPanelOpen !== false);
    const externalHeader = props.header === 'external';
    const panelOpen = externalHeader ? props.open === true : ownPanelOpen;
    const [showHistory, setShowHistory] = React.useState(false);
    // The last action that failed: on the card it was taken on (null for a bulk action), with its retry.
    const [mutationFailure, setMutationFailure] = React.useState<Readonly<{ commentId: string | null; retry: () => void }> | null>(null);
    // Comments are read when the panel opens; until then the count is unknown, never "0".
    const [bulkTransitionResult, setBulkTransitionResult] = React.useState<ReviewCommentBulkTransitionResult | null>(null);
    const [selectedActiveStates, setSelectedActiveStates] = React.useState<readonly ReviewCommentStateV1[]>(
        ACTIVE_REVIEW_COMMENT_STATES,
    );
    const workspaceMachineId = props.workspace?.machineId;
    const workspacePath = props.workspace?.path;

    const serverId = props.scope?.serverId;
    const accountId = props.scope?.accountId;
    const target = React.useMemo<ReviewRunCommentsTarget | null>(() => {
        if (!serverId || !accountId) return null;
        const scope = { serverId, accountId };
        const run = props.runId ? { runId: props.runId } : {};
        if (props.sessionId) return { scope, sessionId: props.sessionId, ...run };
        if (workspaceMachineId && workspacePath) return { scope, workspace: { machineId: workspaceMachineId, path: workspacePath }, ...run };
        if (props.projectId) return { scope, projectId: props.projectId, ...(props.workspaceId ? { workspaceId: props.workspaceId } : {}), ...run };
        return props.workspaceId ? { scope, workspaceId: props.workspaceId, ...run } : null;
    }, [serverId, accountId, props.runId, props.sessionId, workspaceMachineId, workspacePath, props.projectId, props.workspaceId]);
    const comments = useReviewCommentsWindow({ target, enabled: panelOpen, execute: props.execute });
    const commentsState = React.useMemo(() => applyReviewCommentList(createEmptyReviewCommentsState(), {
        items: [...comments.comments], cursor: comments.cursor,
    }), [comments.comments, comments.cursor]);
    const loaded = comments.status === 'loaded' || comments.comments.length > 0;
    const loading = comments.status === 'loading' || comments.loadingMore;
    const loadFailed = !target || comments.status === 'failed' || comments.loadMoreFailed
        ? { cursor: comments.loadMoreFailed ? comments.cursor ?? undefined : undefined } : null;
    const loadComments = React.useCallback(async (cursor?: string) => {
        try {
            await (cursor ? comments.loadMore() : comments.refresh());
            setBulkTransitionResult(null);
        } catch { /* The shared owner retains rows and the failed page for explicit Retry. */ }
    }, [comments.loadMore, comments.refresh]);

    const activeComments = selectReviewComments(commentsState, { states: ACTIVE_REVIEW_COMMENT_STATES })
        .filter(isReviewCommentActiveItem);
    const activeCount = activeComments.length;
    const unresolvedCount = loaded && !commentsState.cursor ? activeCount : null;
    const onUnresolvedCountChange = props.onUnresolvedCountChange;
    React.useEffect(() => { onUnresolvedCountChange?.(unresolvedCount); }, [unresolvedCount, onUnresolvedCountChange]);
    const filteredActiveComments = selectedActiveStates.length === 0
        ? []
        : selectReviewComments(commentsState, { states: selectedActiveStates }).filter(isReviewCommentActiveItem);
    const historyComments = selectReviewComments(commentsState).filter(isReviewCommentHistoryItem);
    // One empty sentence per cause: nothing yet, nothing closed yet, or the filters hide what there is.
    const activeLabels = activeCount > 0 && filteredActiveComments.length === 0
        ? { ...labels, empty: t('files.reviewComments.durable.filteredEmpty') } : labels;
    const historyLabels = activeCount > 0 ? { ...labels, empty: t('files.reviewComments.durable.historyEmpty') } : labels;
    const panelComments = showHistory
        ? historyComments
        : filteredActiveComments;
    const togglePanel = React.useCallback(() => {
        setPanelOpen((open) => !open);
    }, []);

    const upsertUpdatedComments = React.useCallback((updated: readonly ReviewCommentV1[]) => {
        if (props.scope) recordReviewCommentWrites(updated, props.scope);
    }, [props.scope]);

    const toggleActiveStateFilter = React.useCallback((state: ReviewCommentStateV1) => {
        setSelectedActiveStates((current) => current.includes(state)
            ? current.filter((item) => item !== state)
            : [...current, state]);
    }, []);

    const editComment = React.useCallback(async (comment: ReviewCommentV1) => {
        const nextBody = trimPromptValue(await Modal.prompt(
            t('files.reviewComments.durable.editPromptTitle'),
            t('files.reviewComments.durable.editPromptBody'),
            {
                defaultValue: resolveReviewCommentBodyPromptDefault(comment.body),
                confirmText: t('files.reviewComments.durable.edit'),
                cancelText: t('common.cancel'),
            },
        ));
        if (!nextBody) return;
        const response = await actions.edit({
            commentId: comment.id,
            reviewId: comment.reviewId,
            projectId: comment.projectId,
            workspace: comment.workspace,
            nextBody,
            expectedBodyVersion: comment.bodyVersion,
            expectedServerRevision: comment.serverRevision,
            clientMutationId: createReviewCommentClientMutationId('edit'),
        }) as ReviewCommentEditResponseV1;
        upsertUpdatedComments([response.comment]);
    }, [actions, upsertUpdatedComments]);

    const transitionComment = React.useCallback(async (input: Readonly<{
        comment: ReviewCommentV1;
        toState: ReviewCommentStateV1;
    }>) => {
        const response = await actions.transition({
            commentId: input.comment.id,
            reviewId: input.comment.reviewId,
            projectId: input.comment.projectId,
            workspace: input.comment.workspace,
            toState: input.toState,
            reason: t('files.reviewComments.durable.transitionReason'),
            expectedState: input.comment.state,
            expectedServerRevision: input.comment.serverRevision,
            clientMutationId: createReviewCommentClientMutationId('transition'),
        }) as ReviewCommentTransitionResponseV1;
        upsertUpdatedComments([response.comment]);
    }, [actions, upsertUpdatedComments]);

    const delegateComment = React.useCallback(async (original: ReviewCommentV1) => {
        if (!props.sessionId) return;
        const operation = { sessionMessageDisplayText: t('files.reviewComments.durable.headerTitle') };
        if (original.finding && (original.reviewId || original.runId)) {
            if (!await comments.decide(original.id, 'accept')) throw new Error(t('runPage.review.couldNotSaveChoice'));
            await props.execute('review.apply', original.reviewId
                ? { sessionId: props.sessionId, reviewId: original.reviewId }
                : { sessionId: props.sessionId, reviews: [{ runId: original.runId!, findings: [{ ...original.finding,
                    comment: { id: original.id, state: original.state, serverRevision: original.serverRevision,
                        projectId: original.projectId, workspace: original.workspace, sessionId: original.sessionId, runId: original.runId } }] }] }, operation);
            return;
        }
        const body = resolveReviewCommentBodyPromptDefault(original.body);
        if (body === undefined) throw new Error('review_comment_body_unavailable');
        {
            let comment = original;
            const transition = async (toState: ReviewCommentStateV1) => {
                const response = await actions.transition({
                    commentId: comment.id, reviewId: comment.reviewId, projectId: comment.projectId, workspace: comment.workspace,
                    toState, expectedState: comment.state, expectedServerRevision: comment.serverRevision,
                    reason: t('files.reviewComments.durable.transitionReason'),
                    clientMutationId: createReviewCommentClientMutationId('delegate'),
                }) as ReviewCommentTransitionResponseV1;
                comment = response.comment;
                upsertUpdatedComments([comment]);
            };
            if (comment.state === 'proposed' || comment.state === 'pending_review') await transition('open');
            if (comment.state !== 'delegated') await transition('delegated');
            const snapshot = resolveReviewCommentSnapshot(comment.snapshot);
            const text = `${REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1}\n\n${renderReviewFindingsForVerifyV1([{
                id: comment.findingId ?? comment.id,
                title: 'filePath' in comment.anchor ? comment.anchor.filePath : comment.id,
                summary: body,
                anchor: comment.anchor,
                ...(snapshot ? { snapshot } : {}),
                engineId: comment.engineId, flags: comment.flags, comment,
            }])}`;
            await props.execute('session.message.send', { sessionId: props.sessionId, message: text }, operation);
        }
    }, [actions, comments.decide, props.execute, props.sessionId, upsertUpdatedComments]);

    const redactComment = React.useCallback(async (comment: ReviewCommentV1) => {
        const response = await actions.redact({
            commentId: comment.id,
            reviewId: comment.reviewId,
            projectId: comment.projectId,
            workspace: comment.workspace,
            expectedServerRevision: comment.serverRevision,
            redactBody: true,
            clientMutationId: createReviewCommentClientMutationId('redact'),
        }) as ReviewCommentRedactResponseV1;
        upsertUpdatedComments([response.comment]);
    }, [actions, upsertUpdatedComments]);

    const replyToComment = React.useCallback(async (input: Readonly<{ parentCommentId: string }>) => {
        const parent = commentsState.byId[input.parentCommentId];
        if (!parent) return;
        const body = trimPromptValue(await Modal.prompt(
            t('files.reviewComments.durable.replyPromptTitle'),
            t('files.reviewComments.durable.replyPromptBody'),
            {
                confirmText: t('files.reviewComments.durable.reply'),
                cancelText: t('common.cancel'),
            },
        ));
        if (!body) return;
        const response = await actions.reply({
            parentCommentId: input.parentCommentId,
            reviewId: parent.reviewId,
            projectId: parent.projectId,
            workspace: parent.workspace,
            expectedParentServerRevision: parent.serverRevision,
            body,
            clientMutationId: createReviewCommentClientMutationId('reply'),
        }) as ReviewCommentReplyResponseV1;
        upsertUpdatedComments([response.parent, response.comment]);
    }, [actions, commentsState.byId, upsertUpdatedComments]);

    const bulkTransition = React.useCallback(async (input: ReviewCommentBulkTransitionInput) => {
        const groups = new Map<string, ReviewCommentV1[]>();
        for (const id of input.commentIds) {
            const comment = commentsState.byId[id];
            if (!comment) continue;
            const key = JSON.stringify([comment.reviewId, comment.projectId, comment.workspace, comment.state]);
            const group = groups.get(key) ?? [];
            group.push(comment);
            groups.set(key, group);
        }
        const failed: ReviewCommentBulkTransitionResult['failed'][number][] = [];
        let bulkActionId: string | undefined;
        for (const group of groups.values()) {
            const first = group[0];
            if (!first) continue;
            const response = await actions.bulkTransition({
                reviewId: first.reviewId, projectId: first.projectId, workspace: first.workspace,
                commentIds: group.map((comment) => comment.id),
                expectedState: first.state,
                expectedServerRevisions: Object.fromEntries(group.map((comment) => [comment.id, comment.serverRevision])),
                toState: input.toState,
                reason: t('files.reviewComments.durable.bulkTransitionReason'),
                clientMutationId: createReviewCommentClientMutationId('bulk-transition'),
            }) as ReviewCommentBulkTransitionResponseV1;
            upsertUpdatedComments(response.updated);
            bulkActionId = response.bulkActionId;
            failed.push(...response.failed.map((failure) => ({ commentId: failure.commentId, errorCode: failure.errorCode })));
        }
        if (bulkActionId) setBulkTransitionResult({ bulkActionId, failed });
    }, [actions, commentsState.byId, upsertUpdatedComments]);

    const commentsById = React.useRef(commentsState.byId);
    commentsById.current = commentsState.byId;
    const runMutation = async (operation: () => Promise<void>, commentId: string | null = null) => {
        setMutationFailure(null);
        try {
            await operation();
        } catch {
            setMutationFailure({ commentId, retry: () => void runMutation(operation, commentId) });
        }
    };
    /** A card's action runs on the comment as currently held, so a retry after a refresh uses its new revision. */
    const runCommentMutation = (comment: ReviewCommentV1, operation: (current: ReviewCommentV1) => Promise<void>) => runMutation(
        () => operation(commentsById.current[comment.id] ?? comment),
        comment.id,
    );
    const failureTestID = `${props.testID ?? 'review-comments'}-mutation-error`;
    const renderMutationFailure = () => mutationFailure ? (
        <View testID={failureTestID} accessibilityRole="alert">
            <SurfaceStateCard
                size="line"
                kind="error"
                title={mutationFailure.commentId ? t('files.reviewComments.durable.actionFailed') : t('errors.operationFailed')}
                action={{ label: t('common.retry'), onPress: mutationFailure.retry, testID: `${failureTestID}-retry` }}
                secondaryAction={{ label: t('files.reviewComments.durable.refresh'), onPress: () => { setMutationFailure(null); void loadComments(); },
                    testID: `${failureTestID}-refresh` }}
            />
        </View>
    ) : null;
    const renderCardNotice = (comment: ReviewCommentV1) => mutationFailure?.commentId === comment.id ? renderMutationFailure() : null;
    const listFooter = commentsState.cursor ? <TextLinkButton
        testID={`${props.testID ?? 'review-comments'}-load-more`}
        label={t('common.more')}
        disabled={loading}
        onPress={() => loadComments(commentsState.cursor ?? undefined)}
    /> : null;

    // A host that draws the disclosure in its own bar shows nothing here until the panel is opened.
    if (externalHeader && !panelOpen) return null;
    return (
        <View
            testID={props.testID}
            style={[styles.root, {
                borderBottomColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.base,
            }]}
        >
            {externalHeader ? null : <ReviewCommentsHeaderButton
                labels={headerLabels}
                unresolvedCount={unresolvedCount}
                expanded={panelOpen}
                onPress={togglePanel}
                testID={`${props.testID ?? 'review-comments'}-header`}
            />}
            {panelOpen ? (
                <View style={styles.panel}>
                    <View style={styles.bar}>
                        <View style={styles.tabs}>
                            <SegmentedTabBar
                                compact
                                segmentSizing="content"
                                tabs={[
                                    { id: 'active', label: t('files.reviewComments.durable.showActive'), testID: `${props.testID ?? 'review-comments'}-show-active` },
                                    { id: 'history', label: t('files.reviewComments.durable.showHistory'), testID: `${props.testID ?? 'review-comments'}-show-history` },
                                ]}
                                activeTabId={showHistory ? 'history' : 'active'}
                                onSelectTab={(tab) => setShowHistory(tab === 'history')}
                            />
                        </View>
                        <IconButton
                            testID={`${props.testID ?? 'review-comments'}-refresh`}
                            variant="plain"
                            iconName="arrows-clockwise"
                            iconSize={ICON_SIZE.sm}
                            accessibilityLabel={t('files.reviewComments.durable.refresh')}
                            // A returned promise is the button's own busy state while the read runs.
                            onPress={() => loadComments()}
                        />
                    </View>
                    {loadFailed ? (
                        <SurfaceStateCard size="line" kind="error" title={t('files.reviewComments.durable.loadFailed')}
                            action={{ label: t('common.retry'), onPress: () => void loadComments(loadFailed.cursor) }} />
                    ) : null}
                    {/* A card's failure sits with that card; only a bulk action's failure belongs to the whole list. */}
                    {mutationFailure && mutationFailure.commentId === null ? renderMutationFailure() : null}
                    {/* Until the first read lands the list is unknown: loading, never "No review comments yet". */}
                    {!loaded && !loadFailed ? (
                        <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />
                    ) : null}
                    {!loaded ? null : showHistory ? (
                            <ReviewCommentsHistoryView
                                comments={panelComments}
                                listFooter={listFooter}
                                labels={historyLabels}
                                serverId={props.scope?.serverId}
                                cardActions={{
                                    onOpenFile, canOpenFile,
                                    pendingDecision: (comment) => comments.pending[comment.id],
                                    onDecide: (comment, decision) => runCommentMutation(comment, async current => {
                                        if (!await comments.decide(current.id, decision)) throw new Error(t('runPage.review.couldNotSaveChoice'));
                                    }),
                                    onTransition: (input) => runCommentMutation(input.comment, (comment) => transitionComment({ ...input, comment })),
                                    renderNotice: renderCardNotice,
                                }}
                                testID={`${props.testID ?? 'review-comments'}-history`}
                            />
                    ) : (
                        <ReviewCommentsPanel
                            comments={panelComments}
                            listFooter={listFooter}
                            labels={activeLabels}
                            selectedStates={selectedActiveStates}
                            stateOptions={ACTIVE_REVIEW_COMMENT_STATES}
                            onToggleState={toggleActiveStateFilter}
                            serverId={props.scope?.serverId}
                            cardActions={{
                                onOpenFile, canOpenFile,
                                pendingDecision: (comment) => comments.pending[comment.id],
                                onDecide: (comment, decision) => runCommentMutation(comment, async current => {
                                    if (!await comments.decide(current.id, decision)) throw new Error(t('runPage.review.couldNotSaveChoice'));
                                }),
                                onEdit: (comment) => runCommentMutation(comment, editComment),
                                onTransition: (input) => runCommentMutation(input.comment, (comment) => transitionComment({ ...input, comment })),
                                onRedact: (comment) => runCommentMutation(comment, redactComment),
                                ...(props.sessionId ? { onDelegate: (comment: ReviewCommentV1) => runCommentMutation(comment, delegateComment) } : {}),
                                renderNotice: renderCardNotice,
                            }}
                            onReply={(input) => runMutation(() => replyToComment(input), input.parentCommentId)}
                            onBulkTransition={(input) => runMutation(() => bulkTransition(input))}
                            bulkTransitionResult={bulkTransitionResult}
                            testID={`${props.testID ?? 'review-comments'}-panel`}
                        />
                    )}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // Under the Files bar the comments share the pane with the files: they size to what they hold and
    // give way past half the pane, so the comparison they are about always stays in view.
    root: { borderBottomWidth: 1, flexShrink: 1, minHeight: 0, maxHeight: '50%' },
    panel: { flexShrink: 1, minHeight: 0, gap: theme.space.s8, paddingHorizontal: theme.space.s16, paddingTop: theme.space.s8, paddingBottom: theme.space.s12 },
    bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.s8 },
    tabs: { flexShrink: 1, minWidth: 0 },
}));
