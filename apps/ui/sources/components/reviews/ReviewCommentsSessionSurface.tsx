import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type {
    ReviewCommentBulkTransitionResponseV1,
    ReviewCommentEditResponseV1,
    ReviewCommentListResponseV1,
    ReviewCommentRedactResponseV1,
    ReviewCommentReplyResponseV1,
    ReviewCommentStateV1,
    ReviewCommentTransitionResponseV1,
    ReviewCommentV1,
    ReviewCommentScopeV1,
} from '@happier-dev/protocol';
import { REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1, renderReviewFindingsForVerifyV1 } from '@happier-dev/protocol/reviews/reviewFindingsApplyInputV1';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';
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
    const labels = React.useMemo(() => buildReviewCommentLabels(), []);
    const headerLabels = React.useMemo(() => buildReviewCommentsHeaderLabels(), []);
    const directWriteGrantLabels = React.useMemo(() => buildReviewCommentDirectWriteGrantLabels(), []);
    const actions = React.useMemo(() => createReviewCommentsActions({ execute: props.execute }), [props.execute]);
    const [commentsState, setCommentsState] = React.useState(createEmptyReviewCommentsState);
    const [panelOpen, setPanelOpen] = React.useState(props.defaultPanelOpen !== false);
    const [showHistory, setShowHistory] = React.useState(false);
    const [isRefreshing, setIsRefreshing] = React.useState(false);
    const [loadFailed, setLoadFailed] = React.useState(false);
    const [bulkTransitionResult, setBulkTransitionResult] = React.useState<ReviewCommentBulkTransitionResult | null>(null);
    const [selectedActiveStates, setSelectedActiveStates] = React.useState<readonly ReviewCommentStateV1[]>(
        ACTIVE_REVIEW_COMMENT_STATES,
    );

    const loadComments = React.useCallback(async () => {
        if (!props.projectId && !props.workspace && !props.workspaceId && !props.sessionId && !props.runId) return;
        setIsRefreshing(true);
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
            setBulkTransitionResult(null);
        } catch {
            setLoadFailed(true);
        } finally {
            setIsRefreshing(false);
        }
    }, [actions, props.projectId, props.runId, props.sessionId, props.workspace, props.workspaceId]);

    React.useEffect(() => {
        if (!panelOpen) return;
        void loadComments();
    }, [loadComments, panelOpen]);

    const activeComments = selectReviewComments(commentsState, { states: ACTIVE_REVIEW_COMMENT_STATES })
        .filter(isReviewCommentActiveItem);
    const activeCount = activeComments.length;
    const filteredActiveComments = selectedActiveStates.length === 0
        ? []
        : selectReviewComments(commentsState, { states: selectedActiveStates }).filter(isReviewCommentActiveItem);
    const historyComments = selectReviewComments(commentsState).filter(isReviewCommentHistoryItem);
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

    const openPanel = React.useCallback(() => {
        setPanelOpen(true);
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
        if (body === undefined) {
            setLoadFailed(true);
            return;
        }
        try {
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
        } catch {
            setLoadFailed(true);
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

    return (
        <View
            testID={props.testID}
            style={{
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.base,
            }}
        >
            <ReviewCommentsHeaderButton
                labels={headerLabels}
                unresolvedCount={activeCount}
                onPress={openPanel}
                testID={`${props.testID ?? 'review-comments'}-header`}
            />
            {panelOpen ? (
                <View style={{ gap: 8, paddingHorizontal: 12, paddingBottom: 12 }}>
                    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                        <Pressable
                            onPress={() => setShowHistory(false)}
                            testID={`${props.testID ?? 'review-comments'}-show-active`}
                            accessibilityRole="button"
                            style={{
                                borderWidth: 1,
                                borderColor: showHistory ? theme.colors.border.default : theme.colors.button.primary.background,
                                paddingHorizontal: 10,
                                paddingVertical: 6,
                            }}
                        >
                            <Text style={{ color: theme.colors.text.primary }}>
                                {t('files.reviewComments.durable.showActive')}
                            </Text>
                        </Pressable>
                        <Pressable
                            onPress={() => setShowHistory(true)}
                            testID={`${props.testID ?? 'review-comments'}-show-history`}
                            accessibilityRole="button"
                            style={{
                                borderWidth: 1,
                                borderColor: showHistory ? theme.colors.button.primary.background : theme.colors.border.default,
                                paddingHorizontal: 10,
                                paddingVertical: 6,
                            }}
                        >
                            <Text style={{ color: theme.colors.text.primary }}>
                                {t('files.reviewComments.durable.showHistory')}
                            </Text>
                        </Pressable>
                        <Pressable
                            onPress={() => void loadComments()}
                            testID={`${props.testID ?? 'review-comments'}-refresh`}
                            accessibilityRole="button"
                            style={{
                                borderWidth: 1,
                                borderColor: theme.colors.border.default,
                                paddingHorizontal: 10,
                                paddingVertical: 6,
                            }}
                        >
                            <Text style={{ color: theme.colors.text.primary }}>
                                {t('files.reviewComments.durable.refresh')}
                            </Text>
                        </Pressable>
                    </View>
                    {loadFailed ? (
                        <Text style={{ color: theme.colors.state.danger.foreground }}>
                            {t('files.reviewComments.durable.loadFailed')}
                        </Text>
                    ) : null}
                    {isRefreshing && panelComments.length === 0 ? (
                        <Text style={{ color: theme.colors.text.secondary }}>
                            {t('common.loading')}
                        </Text>
                    ) : null}
                    {showHistory ? (
                        <ReviewCommentsHistoryView
                            comments={panelComments}
                            labels={labels}
                            testID={`${props.testID ?? 'review-comments'}-history`}
                        />
                    ) : (
                        <ReviewCommentsPanel
                            comments={panelComments}
                            labels={labels}
                            selectedStates={selectedActiveStates}
                            stateOptions={ACTIVE_REVIEW_COMMENT_STATES}
                            onToggleState={toggleActiveStateFilter}
                            cardActions={{
                                onEdit: (comment) => void editComment(comment),
                                onTransition: (input) => void transitionComment(input),
                                onRedact: (comment) => void redactComment(comment),
                                ...(props.sessionId ? { onDelegate: (comment: ReviewCommentV1) => void delegateComment(comment) } : {}),
                            }}
                            onReply={(input) => void replyToComment(input)}
                            onBulkTransition={(input) => void bulkTransition(input)}
                            bulkTransitionResult={bulkTransitionResult}
                            testID={`${props.testID ?? 'review-comments'}-panel`}
                        />
                    )}
                    {directWriteGrants.map((grant) => (
                        <View
                            key={grant.id}
                            testID={`${props.testID ?? 'review-comments'}-direct-write-grant-${grant.id}`}
                            style={{ gap: 4, paddingVertical: 6 }}
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
                            <Pressable
                                accessibilityRole="button"
                                onPress={() => void revokeDirectWrite(grant.id)}
                                testID={`${props.testID ?? 'review-comments'}-direct-write-grant-${grant.id}-revoke`}
                                style={{ minHeight: 44, justifyContent: 'center' }}
                            >
                                <Text style={{ color: theme.colors.state.danger.foreground }}>
                                    {t('files.reviewComments.durable.directWriteGrant.revoke')}
                                </Text>
                            </Pressable>
                        </View>
                    ))}
                </View>
            ) : null}
            {props.permissionGrantStatus === 'error' && props.permissionGrantError ? (
                <View
                    testID={`${props.testID ?? 'review-comments'}-permission-grants-error`}
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                    style={{ gap: 4 }}
                >
                    <Text selectable>{props.permissionGrantError}</Text>
                    {props.onRefreshPermissionGrants ? (
                        <Pressable
                            testID={`${props.testID ?? 'review-comments'}-permission-grants-refresh`}
                            accessibilityRole="button"
                            onPress={props.onRefreshPermissionGrants}
                            style={{ minHeight: 44, justifyContent: 'center' }}
                        >
                            <Text>{t('common.retry')}</Text>
                        </Pressable>
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
