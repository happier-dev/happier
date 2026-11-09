import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    ReviewCommentBulkTransitionResponseV1,
    ReviewCommentEditResponseV1,
    ReviewCommentListResponseV1,
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
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t, usePreferredLanguage } from '@/text';
import { sync } from '@/sync/sync';
import { randomUUID } from '@/platform/randomUUID';
import type {
    PluginPermissionGrant,
    PluginPermissionPendingGrantRequest,
} from '@/sync/domains/plugins/permissions/types';
import {
    REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
    pluginPermissionGrantScopeLabel,
} from '@/sync/domains/plugins/permissions/types';
import type { PluginPermissionGrantActions } from '@/sync/domains/plugins/permissions/actions';
import { createReviewCommentsActions } from '@/sync/domains/reviews/comments/actions';
import type { ReviewCommentUiActionExecutor } from '@/sync/domains/reviews/comments/api';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    recordReviewCommentWrites,
    subscribeReviewCommentWrites,
} from '@/sync/domains/reviews/comments/reviewRunComments';
import { selectReviewComments } from '@/sync/domains/reviews/comments/selectors';
import {
    applyReviewCommentList,
    createEmptyReviewCommentsState,
    upsertReviewComment,
} from '@/sync/domains/reviews/comments/store';

import { ReviewCommentDirectWriteGrantSheet } from './ReviewCommentDirectWriteGrantSheet';
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
    buildReviewCommentDirectWriteGrantLabels,
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
    execute: ReviewCommentUiActionExecutor;
    directWriteGrants?: readonly PluginPermissionGrant[];
    pendingDirectWriteGrantRequests?: readonly PluginPermissionPendingGrantRequest[];
    permissionGrantActions?: Pick<PluginPermissionGrantActions, 'grant' | 'dismissRequest' | 'revoke'>;
    onGrantDirectWrite?: (input: Readonly<{ requestId: string }>) => void;
    onCancelDirectWriteGrant?: (input: Readonly<{ requestId: string }>) => void;
    onRevokeDirectWrite?: (input: Readonly<{ grantId: string }>) => void;
    permissionGrantStatus?: 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';
    permissionGrantError?: string | null;
    onRefreshPermissionGrants?: () => void;
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
    // A Home/Account switch retires the entire prior view, including pending reads and mutations.
    return <ScopedReviewCommentsSessionSurface key={props.scope ? serverAccountScopeKeySuffix(props.scope) : 'unscoped'} {...props} />;
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
    const directWriteGrantLabels = React.useMemo(() => buildReviewCommentDirectWriteGrantLabels(), [language]);
    const actions = React.useMemo(() => createReviewCommentsActions({ execute: props.execute }), [props.execute]);
    const [commentsState, setCommentsState] = React.useState(createEmptyReviewCommentsState);
    const [ownPanelOpen, setPanelOpen] = React.useState(props.defaultPanelOpen !== false);
    const externalHeader = props.header === 'external';
    const panelOpen = externalHeader ? props.open === true : ownPanelOpen;
    const [showHistory, setShowHistory] = React.useState(false);
    const [loadFailed, setLoadFailed] = React.useState(false);
    // The last action that failed: on the card it was taken on (null for a bulk action), with its retry.
    const [mutationFailure, setMutationFailure] = React.useState<Readonly<{ commentId: string | null; retry: () => void }> | null>(null);
    // Comments are read when the panel opens; until then the count is unknown, never "0".
    const [loaded, setLoaded] = React.useState(false);
    const [bulkTransitionResult, setBulkTransitionResult] = React.useState<ReviewCommentBulkTransitionResult | null>(null);
    const [selectedActiveStates, setSelectedActiveStates] = React.useState<readonly ReviewCommentStateV1[]>(
        ACTIVE_REVIEW_COMMENT_STATES,
    );

    const loadComments = React.useCallback(async () => {
        if (!props.projectId && !props.workspace && !props.workspaceId && !props.sessionId && !props.runId) return;
        setLoadFailed(false);
        try {
            const response = await actions.list({
                ...(props.sessionId ? { sessionId: props.sessionId }
                    : props.workspace ? { workspace: props.workspace }
                    : { projectId: props.projectId, workspaceId: props.workspaceId }),
                runId: props.runId,
                includeHistory: true,
                limit: 100,
            }) as ReviewCommentListResponseV1;
            setCommentsState((state) => applyReviewCommentList(state, response));
            setLoaded(true);
            setBulkTransitionResult(null);
        } catch {
            setLoadFailed(true);
        }
    }, [actions, props.projectId, props.runId, props.sessionId, props.workspace, props.workspaceId]);

    React.useEffect(() => {
        if (!panelOpen) return;
        void loadComments();
    }, [loadComments, panelOpen]);

    const activeComments = selectReviewComments(commentsState, { states: ACTIVE_REVIEW_COMMENT_STATES })
        .filter(isReviewCommentActiveItem);
    const activeCount = activeComments.length;
    const onUnresolvedCountChange = props.onUnresolvedCountChange;
    React.useEffect(() => { onUnresolvedCountChange?.(loaded ? activeCount : null); }, [activeCount, loaded, onUnresolvedCountChange]);
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
    const directWriteGrants = (props.directWriteGrants ?? []).filter(
        (grant) => grant.capability === REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
    );
    const pendingDirectWriteGrantRequests = (props.pendingDirectWriteGrantRequests ?? []).filter(
        (request) => request.capability === REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
    );

    const describeGrantAuthority = React.useCallback((grant: PluginPermissionGrant): string => (
        grant.authoritySource.kind === 'bundled'
            ? 'bundled'
            : `machine:${grant.authoritySource.machineId} | installation:${grant.authoritySource.installationId}`
    ), []);

    const togglePanel = React.useCallback(() => {
        setPanelOpen((open) => !open);
    }, []);

    const grantDirectWrite = React.useCallback(async (requestId: string) => {
        const input = { requestId };
        if (props.onGrantDirectWrite) {
            await props.onGrantDirectWrite(input);
            return;
        }
        await props.permissionGrantActions?.grant(input);
    }, [props.onGrantDirectWrite, props.permissionGrantActions]);

    const cancelDirectWrite = React.useCallback(async (requestId: string) => {
        const input = { requestId };
        if (props.onCancelDirectWriteGrant) {
            await props.onCancelDirectWriteGrant(input);
            return;
        }
        await props.permissionGrantActions?.dismissRequest(input);
    }, [props.onCancelDirectWriteGrant, props.permissionGrantActions]);

    const revokeDirectWrite = React.useCallback(async (grantId: string) => {
        const input = { grantId };
        if (props.onRevokeDirectWrite) {
            await props.onRevokeDirectWrite(input);
            return;
        }
        await props.permissionGrantActions?.revoke(input);
    }, [props.onRevokeDirectWrite, props.permissionGrantActions]);

    const upsertUpdatedComments = React.useCallback((comments: readonly ReviewCommentV1[]) => {
        if (comments.length === 0) return;
        setCommentsState((state) => comments.reduce(upsertReviewComment, state));
        if (props.scope) recordReviewCommentWrites(comments, props.scope);
    }, [props.scope]);

    // A comment shown here can be written elsewhere too (a review result's decision): follow the
    // newer revision of a comment this panel already holds instead of showing it stale until a reload.
    React.useEffect(() => props.scope ? subscribeReviewCommentWrites(props.scope, (comments) => {
        setCommentsState((state) => comments.reduce((next, comment) => {
            const held = next.byId[comment.id];
            return held && held.serverRevision < comment.serverRevision ? upsertReviewComment(next, comment) : next;
        }, state));
    }) : undefined, [props.scope]);

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
        const body = resolveReviewCommentBodyPromptDefault(original.body);
        if (body === undefined) throw new Error('review_comment_body_unavailable');
        {
            let comment = original;
            const transition = async (toState: ReviewCommentStateV1) => {
                const response = await actions.transition({
                    commentId: comment.id, projectId: comment.projectId, workspace: comment.workspace,
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
            await sync.submitMessage(props.sessionId, text, t('files.reviewComments.durable.headerTitle'), undefined, {
                callerSurface: 'review_comments_delegate',
            });
        }
    }, [actions, props.sessionId, upsertUpdatedComments]);

    const redactComment = React.useCallback(async (comment: ReviewCommentV1) => {
        const response = await actions.redact({
            commentId: comment.id,
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
            const key = JSON.stringify([comment.projectId, comment.workspace, comment.state]);
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
                projectId: first.projectId, workspace: first.workspace,
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
                unresolvedCount={loaded ? activeCount : null}
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
                            action={{ label: t('common.retry'), onPress: () => void loadComments() }} />
                    ) : null}
                    {/* A card's failure sits with that card; only a bulk action's failure belongs to the whole list. */}
                    {mutationFailure && mutationFailure.commentId === null ? renderMutationFailure() : null}
                    {/* Until the first read lands the list is unknown: loading, never "No review comments yet". */}
                    {!loaded && !loadFailed ? (
                        <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />
                    ) : null}
                    {!loaded ? null : showHistory ? (
                        <ScrollView style={styles.list} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                            <ReviewCommentsHistoryView
                                comments={panelComments}
                                labels={historyLabels}
                                cardActions={{
                                    onOpenFile, canOpenFile,
                                    onTransition: (input) => runCommentMutation(input.comment, (comment) => transitionComment({ ...input, comment })),
                                    renderNotice: renderCardNotice,
                                }}
                                testID={`${props.testID ?? 'review-comments'}-history`}
                            />
                        </ScrollView>
                    ) : (
                        <ReviewCommentsPanel
                            comments={panelComments}
                            labels={activeLabels}
                            selectedStates={selectedActiveStates}
                            stateOptions={ACTIVE_REVIEW_COMMENT_STATES}
                            onToggleState={toggleActiveStateFilter}
                            cardActions={{
                                onOpenFile, canOpenFile,
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
                    {directWriteGrants.map((grant) => (
                        <View
                            key={grant.id}
                            testID={`${props.testID ?? 'review-comments'}-direct-write-grant-${grant.id}`}
                            style={{ gap: theme.space.s4, paddingVertical: theme.space.s6 }}
                        >
                            <Text style={{ color: theme.colors.text.primary }}>
                                {grant.pluginId}
                            </Text>
                            <Text style={{ color: theme.colors.text.secondary }}>
                                {grant.capability}
                            </Text>
                            <Text
                                testID={`${props.testID ?? 'review-comments'}-direct-write-grant-${grant.id}-scope`}
                                style={{ color: theme.colors.text.secondary }}
                                selectable
                            >
                                {pluginPermissionGrantScopeLabel(grant.targetScope)}
                            </Text>
                            <Text
                                testID={`${props.testID ?? 'review-comments'}-direct-write-grant-${grant.id}-actor`}
                                style={{ color: theme.colors.text.secondary }}
                                selectable
                            >
                                {grant.grantedByUserId}
                            </Text>
                            <Text
                                testID={`${props.testID ?? 'review-comments'}-direct-write-grant-${grant.id}-authority`}
                                style={{ color: theme.colors.text.secondary }}
                                selectable
                            >
                                {describeGrantAuthority(grant)}
                            </Text>
                            <Text
                                testID={`${props.testID ?? 'review-comments'}-direct-write-grant-${grant.id}-created`}
                                style={{ color: theme.colors.text.secondary }}
                                selectable
                            >
                                {new Date(grant.grantedAt).toISOString()}
                            </Text>
                            <HappierPressable
                                accessibilityRole="button"
                                onPress={() => void revokeDirectWrite(grant.id)}
                                testID={`${props.testID ?? 'review-comments'}-direct-write-grant-${grant.id}-revoke`}
                                style={{ justifyContent: 'center' }}
                            >
                                <Text style={{ color: theme.colors.state.danger.foreground }}>
                                    {t('files.reviewComments.durable.directWriteGrant.revoke')}
                                </Text>
                            </HappierPressable>
                        </View>
                    ))}
                </View>
            ) : null}
            {props.permissionGrantStatus === 'error' && props.permissionGrantError ? (
                <View
                    testID={`${props.testID ?? 'review-comments'}-permission-grants-error`}
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                    style={{ gap: theme.space.s4 }}
                >
                    <Text selectable>{props.permissionGrantError}</Text>
                    {props.onRefreshPermissionGrants ? (
                        <HappierPressable
                            testID={`${props.testID ?? 'review-comments'}-permission-grants-refresh`}
                            accessibilityRole="button"
                            onPress={props.onRefreshPermissionGrants}
                            style={{ justifyContent: 'center' }}
                        >
                            <Text>{t('common.retry')}</Text>
                        </HappierPressable>
                    ) : null}
                </View>
            ) : null}
            {pendingDirectWriteGrantRequests.map((pendingRequest) => (
                <ReviewCommentDirectWriteGrantSheet
                    key={pendingRequest.id}
                    pendingRequest={pendingRequest}
                    labels={directWriteGrantLabels}
                    onGrant={() => void grantDirectWrite(pendingRequest.id)}
                    onCancel={() => void cancelDirectWrite(pendingRequest.id)}
                    testID={`${props.testID ?? 'review-comments'}-direct-write-request-${pendingRequest.id}`}
                />
            ))}
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
    list: { flexShrink: 1, minHeight: 0 },
}));
