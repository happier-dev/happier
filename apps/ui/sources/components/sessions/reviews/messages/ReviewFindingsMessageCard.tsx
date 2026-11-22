import React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import type {
    ReviewCommentV1} from '@happier-dev/protocol/reviews/comments/v1';
import type {
    ReviewFindingsV1} from '@happier-dev/protocol/messages/structured/reviewFindingsV1';
import type {
    ReviewFindingsV2} from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import type {
    ReviewTriageStatus,
} from '@happier-dev/protocol/reviews/reviewTriageStatus';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';
import { ReviewFindingRow, type ReviewFindingDecision } from '@/components/sessions/reviews/findings/ReviewFindingRow';
import { ReviewQuestions, ReviewFollowUpDock } from '@/components/reviews/finding/ReviewQuestions';
import {
    formatReviewFindingLocation,
    formatReviewFindingsHeadline,
    isHighReviewSeverity,
} from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { resolveReviewFollowUpAvailability } from '@/components/sessions/reviews/findings/reviewFollowUpAvailability';
import { useReviewFindingsModel, type ReviewFindingsMember, type ReviewFindingDecisionTarget } from '@/components/reviews/finding/useReviewFindingsModel';
import { ReviewSummary } from '@/components/reviews/summary/ReviewSummary';
import { ReviewSummaryHost } from '@/components/reviews/summary/ReviewSummaryHost';
import { artifactResourceRoute } from '@/utils/url/resourceRoute';
import { useReviewGroupSiblings } from '@/components/sessions/reviews/findings/useReviewGroupSiblings';
import { useReviewRunsComments } from '@/components/sessions/reviews/findings/useReviewRunComments';
import { resolveEffectiveReviewFindings } from '@/components/sessions/reviews/messages/resolveEffectiveReviewFindings';
import { findCommentForFinding } from '@/components/sessions/reviews/findings/reviewFindingComment';
import { REVIEW_SEVERITY_COLUMN_WIDTH_PX, ReviewSeveritySummary } from '@/components/sessions/reviews/findings/ReviewSeverity';
import { ReviewWalkMeThroughButton, ReviewWalkthroughEntryHint } from '@/components/sessions/reviews/walkthrough/ReviewWalkthroughEntry';
import {
    ExecutionRunResultLayout,
    type ExecutionRunResultPresentation,
} from '@/components/sessions/runs/ExecutionRunResultLayout';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { useOptionalSessionTranscriptSource, useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSessionMessages } from '@/sync/domains/state/storage';
import {
    reviewRunCommentsTargetFromFindings,
} from '@/sync/domains/reviews/comments/reviewRunComments';
import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding, useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { t } from '@/text';
import { SessionRunWorkNotifications } from '@/components/sessions/work/RunWorkNotifications';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { StructuredFindText, useStructuredFindState } from '@/components/sessions/transcript/structured/structuredFindText';
import { useTranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { buildReviewFindingsMessageDisplay, normalizeReviewFindingsMessagePayload, REVIEW_CARD_VISIBLE_FINDINGS } from './reviewFindingsMessageDisplay';
import type { Message } from '@happier-dev/session-core/messages';
import type { SessionTranscriptSource } from '@/components/sessions/transcript/source/types';
export { projectReviewFindingsFindText } from './reviewFindingsMessageDisplay';

type ReviewFindingsCardPayload = ReviewFindingsV1 | ReviewFindingsV2;

type NormalizedReviewPayload = ReturnType<typeof normalizeReviewFindingsMessagePayload>;

/** The transcript card shows this many findings before "N more findings" (lab R2 `card`). */
const CARD_VISIBLE_FINDINGS = REVIEW_CARD_VISIBLE_FINDINGS;
/** A reviewer run that stopped in one of these has no result: it didn't finish its review. */
const UNFINISHED_RUN_STATUSES: ReadonlySet<string> = new Set(['failed', 'cancelled', 'timeout']);

const normalizePayload = normalizeReviewFindingsMessagePayload;

/**
 * The exact Home and Account a review is open under: its comments are read and decided there, never
 * on whichever Home happens to be focused. `null` until the Home's credentials resolve.
 */
function useReviewAccountLifetime(sessionId: string, serverId: string | null): ServerAccountScopeLifetime | null {
    const preferredServerId = usePreferredServerIdForSession({ serverId, sessionId });
    const serverIds = React.useMemo(() => [preferredServerId], [preferredServerId]);
    const bindings = useServerCredentialAccountScopeBindings(serverIds);
    return [...bindings.values()][0] ?? null;
}

/** A reviewer of this result as the card shows it: its run, latest findings, decisions and threads. */
type CardMember = ReviewFindingsMember & Readonly<{
    normalized: NormalizedReviewPayload;
}>;

/**
 * A review's result, result first (lab R1/R2): the summary, who reviewed, the findings most severe
 * first with where they are, what changed after a question, a decision under each (Implement fix ·
 * Ignore · Decide later) and a thread for questions (Ask about this), then one primary that
 * implements exactly the chosen fixes, verified first.
 *
 * One component, every place a review result shows: the run pane mounts it as the page (`page`),
 * the transcript as a card (`message`). A finding's decision lives in its durable `ReviewComment`,
 * so the same decision shows wherever the review is open.
 *
 * A review started on several engines at once is one result on the page: the reviewers sharing the
 * run's `groupId` are merged into one findings list, a finding they both reported (the same
 * `ReviewComment.findingIdentity`) is one "Both" row, and the headline is derived from them all.
 */
type ReviewFindingsMessageCardProps = {
    payload: ReviewFindingsCardPayload;
    sessionId: string;
    canSendMessages: boolean;
    presentation?: ExecutionRunResultPresentation;
    /** Page only: what closes the result's body (the Run's steps disclosure). */
    after?: React.ReactNode;
    /** The server scope: used to open the result in its run pane, and to reach its reviewers. */
    serverId?: string | null;
    /** Page only: the review's group (`display.groupId`) when several reviewers ran it. */
    groupId?: string | null;
};

export function ReviewFindingsMessageCard(props: ReviewFindingsMessageCardProps) {
    const source = useOptionalSessionTranscriptSource();
    // These are separate mounted roles. The source provider owns transcript identity/remounts;
    // a standalone Run page resolves its own authenticated Home rather than borrowing a transcript.
    return source ? <TranscriptReviewFindingsCard {...props} source={source} /> : <PageReviewFindingsCard {...props} />;
}

function TranscriptReviewFindingsCard(props: ReviewFindingsMessageCardProps & Readonly<{ source: SessionTranscriptSource }>) {
    const ids = props.source.useMessageIdsOldestFirst();
    const sourceMessages = props.source.useMessagesByIds(ids);
    const sessionMessages = React.useMemo(() => sourceMessages.filter((message): message is Message => message !== null), [sourceMessages]);
    const { viewerScope } = props.source.useAuthorship();
    const { binding } = useServerCredentialAccountScopeBinding(viewerScope?.serverId);
    const accountLifetime = binding && areServerAccountScopesEqual(binding.scope, viewerScope) ? binding : null;
    const workspacePath = props.source.useWorkspacePath();
    return <ReviewFindingsCardContent {...props} transcriptSource={props.source} scope={viewerScope} accountLifetime={accountLifetime} sessionMessages={sessionMessages} workspacePath={workspacePath} />;
}

function PageReviewFindingsCard(props: ReviewFindingsMessageCardProps) {
    const accountLifetime = useReviewAccountLifetime(props.sessionId, props.serverId ?? null);
    const scope = accountLifetime?.scope ?? null;
    // Finding state reads structured follow-up meta, never streamed text.
    const { messages } = useSessionMessages(props.sessionId, { textUpdates: false });
    return <ReviewFindingsCardContent {...props} transcriptSource={null} scope={scope} accountLifetime={accountLifetime} sessionMessages={messages} workspacePath={null} />;
}

function ReviewFindingsCardContent(props: ReviewFindingsMessageCardProps & Readonly<{
    transcriptSource: SessionTranscriptSource | null;
    scope: ServerAccountScope | null;
    accountLifetime: ServerAccountScopeLifetime | null;
    sessionMessages: readonly Message[];
    workspacePath: string | null;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const presentation = props.presentation ?? 'message';
    const isPage = presentation === 'page';
    const { transcriptSource, scope, accountLifetime, sessionMessages, workspacePath } = props;
    const router = useRouter();
    const find = useStructuredFindState();
    const notifyLayout = useTranscriptRowLayoutMutation();
    const openFindingsHref = buildSessionExecutionRunRouteHref({ sessionId: props.sessionId, runId: props.payload.runRef.runId, serverId: props.serverId ?? null });
    const compact = !isPage && Boolean(transcriptSource?.navigate && openFindingsHref);
    const sessionId = props.sessionId;
    const serverId = props.serverId ?? null;
    const canAct = props.canSendMessages === true;
    const normalized = React.useMemo(() => normalizePayload(props.payload), [props.payload]);
    const runId = normalized.runRef.runId;
    const siblings = useReviewGroupSiblings({ sessionId, scope, groupId: isPage ? props.groupId ?? null : null, selfRunId: runId });
    const resultMembers = React.useMemo(() => [
        normalized,
        ...siblings.flatMap((sibling) => (sibling.payload ? [normalizePayload(sibling.payload)] : [])),
    ], [normalized, siblings]);
    const waitingSiblings = React.useMemo(() => siblings.filter((sibling) => sibling.payload === null), [siblings]);
    const memberRunIds = React.useMemo(() => resultMembers.map((member) => member.runRef.runId), [resultMembers]);
    const reviewIdsByRunId = React.useMemo(() => Object.fromEntries(resultMembers.map(member => {
        const target = reviewRunCommentsTargetFromFindings(member);
        return [target.runId, target.reviewId];
    })), [resultMembers]);
    const commentIdsByRunId = React.useMemo(() => Object.fromEntries(resultMembers.map((member) => [
        member.runRef.runId, member.findings.flatMap((finding) => finding.comment ? [finding.comment.id] : []),
    ])), [resultMembers]);
    const hasFindings = resultMembers.some((member) => member.findings.length > 0);

    // Read-only viewers need the same canonical finding identity for the merged result.
    const commentSnapshots = useReviewRunsComments({ scope, sessionId, runIds: memberRunIds, reviewIdsByRunId, commentIdsByRunId, enabled: hasFindings, refresh: isPage });
    const allComments = React.useMemo(() => commentSnapshots.flatMap((snapshot) => snapshot.comments), [commentSnapshots]);
    const allPending = React.useMemo(() => Object.assign({}, ...commentSnapshots.map((snapshot) => snapshot.pending)) as Readonly<Record<string, ReviewTriageStatus>>, [commentSnapshots]);
    const members = React.useMemo<readonly CardMember[]>(() => resultMembers.map((member) => {
        const effective = resolveEffectiveReviewFindings({
            runRef: member.runRef,
            initialFindings: member.findings,
            messages: sessionMessages,
        });
        const commentByFindingId = new Map<string, ReviewCommentV1>();
        for (const finding of effective.findings) {
            const comment = findCommentForFinding(allComments, finding, member.runRef.runId);
            if (comment) commentByFindingId.set(finding.id, comment);
        }
        return {
            runId: member.runRef.runId,
            backendId: member.runRef.backendId,
            reviewerLabel: resolveExecutionRunBackendLabel(member.runRef.backendTarget ?? { kind: 'backend', backendId: member.runRef.backendId }) ?? member.runRef.backendId,
            findings: effective.findings,
            commentByFindingId,
            originalByFindingId: effective.originalByFindingId,
            threadsByFindingId: effective.threadsByFindingId,
            threadRefsByFindingId: effective.threadRefsByFindingId,
            sessionId,
            questions: member.questions,
            assumptions: member.assumptions,
            normalized: member,
            followUp: resolveReviewFollowUpAvailability(member.runRef),
        };
    }), [allComments, resultMembers, sessionId, sessionMessages]);
    const reviewerCount = members.length + waitingSiblings.length;
    const multiReviewer = reviewerCount > 1;
    const onDecideComment = React.useCallback((source: ReviewFindingDecisionTarget, decision: ReviewFindingDecision) => {
        if (!source.runId) return Promise.resolve(false);
        return commentSnapshots[memberRunIds.indexOf(source.runId)]?.decide(source.comment.id, decision) ?? Promise.resolve(false);
    }, [commentSnapshots, memberRunIds]);
    const model = useReviewFindingsModel({
        members, reviewerCount, scope, accountLifetime, serverId, sessionId, draftRunId: runId,
        canAct, pending: allPending, onDecideComment,
    });
    const { rows, followUp, implement, dockMembers, dockRecipient, error, approval } = model;
    const rowFindings = React.useMemo(() => rows.map((row) => row.finding), [rows]);
    const headline = React.useMemo(() => formatReviewFindingsHeadline(rowFindings), [rowFindings]);
    const highCount = React.useMemo(() => rowFindings.filter((finding) => isHighReviewSeverity(finding.severity)).length, [rowFindings]);
    const commentsComplete = commentSnapshots.length > 0
        && commentSnapshots.every(snapshot => snapshot.status === 'loaded' && snapshot.cursor === null);
    const decisionsFailed = commentSnapshots.some((snapshot) => snapshot.status === 'failed');
    const continuingComments = commentSnapshots.filter(snapshot => snapshot.cursor !== null);
    const [showAllFindings, setShowAllFindings] = React.useState(false);
    const [openThreadRowId, setOpenThreadRowId] = React.useState<string | null>(null);
    const findDisplay = React.useMemo(() => buildReviewFindingsMessageDisplay(props.payload, {
        canNavigate: compact, canSendMessages: canAct, hasWorkspacePath: Boolean(workspacePath), sessionMessages,
        acceptedFindingsCount: implement.count,
    }, members[0]), [props.payload, compact, canAct, workspacePath, sessionMessages, implement.count, members]);
    React.useLayoutEffect(() => {
        if (isPage || compact || !find.revealBlockId?.startsWith('structured-review-finding:')) return;
        const row = [...rows].sort((left, right) => right.rowId.length - left.rowId.length)
            .find((candidate) => find.revealBlockId?.startsWith(`structured-review-finding:${candidate.rowId}:`));
        if (!row) return;
        const hidden = rows.findIndex(candidate => candidate.rowId === row.rowId) >= CARD_VISIBLE_FINDINGS && !showAllFindings;
        const revealThread = find.revealBlockId.startsWith(`structured-review-finding:${row.rowId}:thread:`) || find.revealBlockId === `structured-review-finding:${row.rowId}:quote`;
        if (hidden || (revealThread && openThreadRowId !== row.rowId)) notifyLayout({ reason: 'expand', sourceId: 'review-findings' });
        if (hidden) setShowAllFindings(true);
        if (revealThread) setOpenThreadRowId(row.rowId);
    }, [compact, find.revealBlockId, find.revealRequestId, isPage, notifyLayout, openThreadRowId, rows, showAllFindings]);

    const toggleThread = React.useCallback((rowId: string) => {
        setOpenThreadRowId((current) => (current === rowId ? null : rowId));
    }, []);

    const visibleRows = !isPage && !showAllFindings ? rows.slice(0, CARD_VISIBLE_FINDINGS) : rows;
    const hiddenCount = rows.length - visibleRows.length;
    const implementButton = canAct && rows.length > 0 ? (
        <RoundButton
            testID="review-findings-publish-accepted"
            size="small"
            display={isPage ? 'default' : 'secondary'}
            title={isPage ? t('runPage.review.implementFixes', { count: implement.count }) : <StructuredFindText blockId="structured-review:implement" text={findDisplay.implement?.text ?? t('runPage.review.implementFixes', { count: implement.count })} useDefaultTypography={false} />}
            titleNumberOfLines={find.revealBlockId === 'structured-review:implement' ? 'complete' : 1}
            disabled={implement.disabled}
            loading={implement.busy}
            onPress={implement.run}
        />
    ) : null;

    const dock = isPage && canAct && openThreadRowId === null ? (
        <ReviewFollowUpDock sessionId={sessionId} serverId={serverId} accountLifetime={accountLifetime}
            draftRunId={runId} members={dockMembers} recipient={dockRecipient} followUp={followUp} onSend={model.askReviewers} />
    ) : null;

    const groupHeadline = multiReviewer
        ? [t('runPage.review.reviewerCount', { count: reviewerCount }), headline].join(' · ')
        : null;

    // A finished review in the transcript is a compact summary (lab WT5-R8) whenever its own page is one
    // press away: decisions, questions and Implement fixes live there. Without that page, the full card stays.
    if (compact) {
        const compactRows = rows.slice(0, CARD_VISIBLE_FINDINGS);
        const reviewId = reviewRunCommentsTargetFromFindings(normalized).reviewId;
        const href = reviewId ? artifactResourceRoute({ kind: 'artifact', artifactId: reviewId }, serverId ?? undefined) : openFindingsHref;
        const open = () => { if (href) transcriptSource?.navigate?.(href); };
        const summaryProps = {
            subject: null,
            rows: compactRows.map(row => ({ rowId: row.rowId, severity: row.finding.severity, title: row.finding.title,
                findBlockPrefix: `structured-review-finding:${row.rowId}`, location: formatReviewFindingLocation(row.finding),
                decision: row.decision,
                reviewer: row.reviewers.map(reviewer => reviewer.label).join(t('reviewWalkthrough.and')) })),
            more: rows.length > compactRows.length ? { label: findDisplay.more?.text ?? '', onPress: open } : null,
            reviewers: members.map(member => ({ label: member.reviewerLabel, backendId: member.backendId })),
            onOpenReview: open,
            // The walkthrough is one more way on from the Review, so it sits in the card's footer beside Open review.
            footerAction: canAct ? <ReviewWalkMeThroughButton presentation="link" sessionId={sessionId} serverId={serverId} runId={runId}
                reviewRunIds={memberRunIds} comparisonId={normalized.comparisonId} /> : null,
        };
        return (
            <>
            {normalized.fileCount !== null ? (
                <StructuredFindText blockId="structured-review:started" text={findDisplay.started?.text ?? ''} testID="review-findings-started" style={styles.startedReview} />
            ) : null}
            <ExecutionRunResultLayout
                presentation="message"
                testID="review-findings"
            >
                {reviewId ? <ReviewSummaryHost {...summaryProps} reviewId={reviewId} scope={scope} />
                    : <ReviewSummary {...summaryProps} glance={{ sentence: headline, tone: highCount > 0 ? 'attention' : 'quiet', facts: [] }} />}
            </ExecutionRunResultLayout>
            </>
        );
    }

    return (
        <ExecutionRunResultLayout
            presentation={presentation}
            testID="review-findings"
            after={props.after}
            footNote={isPage
                ? (canAct && rows.length > 0
                    ? (implement.count > 0
                        ? t('runPage.review.fixesToImplement', { count: implement.count })
                        : t('runPage.review.noFixesSelected'))
                    : null)
                : (rows.length > 0 ? <StructuredFindText blockId={findDisplay.count.id} text={findDisplay.count.text} useDefaultTypography={false} /> : null)}
            footDetail={isPage && canAct && implement.count > 0 ? t('runPage.review.verifiedFirst') : null}
            footActions={isPage ? implementButton : (
                rows.length > 0 || canAct ? (
                    <>
                        {rows.length > 0 ? <ReviewOpenResultButton sessionId={sessionId} runId={runId} serverId={serverId} /> : null}
                        {canAct ? (
                            <ReviewWalkMeThroughButton
                                sessionId={sessionId}
                                serverId={serverId}
                                runId={runId}
                                reviewRunIds={memberRunIds}
                                comparisonId={normalized.comparisonId}
                            />
                        ) : null}
                        {implementButton}
                    </>
                ) : null
            )}
            footHint={!isPage && canAct ? (
                <ReviewWalkthroughEntryHint continues={members.some((member) => member.followUp.available)} findingsCount={rows.length} />
            ) : null}
            dock={dock}
        >
            {groupHeadline
                ? <Text testID="review-findings-headline" style={styles.lead}>{groupHeadline}</Text>
                : isPage
                    ? <MarkdownView markdown={normalized.overviewMarkdown} textStyle={styles.lead} agentTexMath />
                    : <StructuredFindText blockId={findDisplay.summary.id} text={findDisplay.summary.text} selectable style={styles.lead} />}
            {!isPage && rows.length > 0 ? <ReviewSeveritySummary testID="review-findings-severity-summary" findings={rowFindings} findBlockPrefix="structured-review:count" /> : null}

            {isPage ? (
                <View style={styles.section}>
                    <Text accessibilityRole="header" style={styles.sectionTitle}>{t('runPage.review.reviewers')}</Text>
                    <View testID="review-reviewers" style={styles.sheet}>
                        {members.map((member, index) => (
                            <View key={member.runId} testID={`review-reviewer:${member.runId}`} style={[styles.reviewer, index > 0 ? styles.reviewerDivided : null]}>
                                <View style={styles.reviewerHead}>
                                    {hasAgentIconMark(member.backendId, theme) ? <AgentIcon agentId={member.backendId} size={ICON_SIZE.sm} /> : null}
                                    <Text style={styles.reviewerName}>{member.reviewerLabel}</Text>
                                    <Text style={styles.reviewerMeta}>{formatReviewFindingsHeadline(member.findings)}</Text>
                                </View>
                                {multiReviewer ? <Text selectable style={styles.quiet}>{member.normalized.summary}</Text> : null}
                            </View>
                        ))}
                        {waitingSiblings.map((sibling) => {
                            const agentId = sibling.backendTarget.kind === 'builtInAgent' ? sibling.backendTarget.agentId : sibling.backendTarget.backendId;
                            const meta = UNFINISHED_RUN_STATUSES.has(sibling.status)
                                ? t('runPage.review.reviewerDidNotFinish')
                                : sibling.status === 'running' ? t('runPage.review.stillReviewing') : null;
                            return (
                                <View key={sibling.runId} testID={`review-reviewer:${sibling.runId}`} style={[styles.reviewer, styles.reviewerDivided]}>
                                    <View style={styles.reviewerHead}>
                                        {hasAgentIconMark(agentId, theme) ? <AgentIcon agentId={agentId} size={ICON_SIZE.sm} /> : null}
                                        <Text style={styles.reviewerName}>{resolveExecutionRunBackendLabel(sibling.backendTarget) ?? agentId}</Text>
                                        {meta ? <Text style={styles.reviewerMeta}>{meta}</Text> : null}
                                    </View>
                                    {sibling.status === 'running' ? <SessionRunWorkNotifications sessionId={sessionId} runId={sibling.runId} serverId={serverId} /> : null}
                                </View>
                            );
                        })}
                    </View>
                </View>
            ) : null}

            {rows.length > 0 ? (
                <View style={styles.section}>
                    {isPage ? (
                        <View style={styles.sectionTitleRow}>
                            <Text accessibilityRole="header" style={styles.sectionTitle}>{t('runPage.review.findings')}</Text>
                            <Text style={styles.sectionCount}>
                                {highCount > 0
                                    ? `${t('runPage.review.findingsCount', { count: rows.length })} · ${t('runPage.review.highCount', { count: highCount })}`
                                    : t('runPage.review.findingsCount', { count: rows.length })}
                            </Text>
                        </View>
                    ) : null}
                    <View style={isPage ? styles.sheet : null}>
                        {visibleRows.map((row, index) => {
                            return (
                                <ReviewFindingRow
                                    key={row.rowId}
                                    rowId={row.rowId}
                                    finding={row.finding}
                                    currentBodyMarkdown={row.currentBodyMarkdown}
                                    attribution={row.attribution}
                                    reviewers={row.reviewers}
                                    original={row.original}
                                    density={isPage ? 'page' : 'card'}
                                    findBlockPrefix={isPage ? undefined : `structured-review-finding:${row.rowId}`}
                                    divided={index > 0}
                                    decision={row.decision}
                                    decisionEditable={row.decisionEditable}
                                    decisionDisabled={!row.decidable}
                                    decisionNote={commentsComplete && !row.decidable ? t('runPage.review.notSaved') : null}
                                    onDecide={model.onDecide}
                                    followUp={canAct ? row.followUp : null}
                                    threadEntries={row.threadEntries}
                                    pendingQuestion={model.pendingQuestionByRowId[row.rowId] ?? null}
                                    expanded={openThreadRowId === row.rowId}
                                    onToggleExpanded={toggleThread}
                                    askContext={row.askContext!}
                                    onAsk={model.onAsk}
                                    onCreateTask={canAct && row.taskOrigin ? model.onCreateTask : undefined}
                                    taskScope={scope}
                                />
                            );
                        })}
                        {hiddenCount > 0 ? (
                            <Pressable
                                testID="review-findings-show-more"
                                accessibilityRole="button"
                                onPress={() => setShowAllFindings(true)}
                                style={styles.more}
                            >
                                <StructuredFindText blockId="structured-review:more" text={t('runPage.review.moreFindings', { count: hiddenCount })} style={styles.moreText} />
                            </Pressable>
                        ) : null}
                    </View>
                    {canAct && decisionsFailed ? (
                        <View style={styles.notice}>
                            <StructuredFindText blockId="structured-review:decisions-unavailable" text={t('runPage.review.decisionsUnavailable')} style={styles.caption} />
                            <Pressable
                                testID="review-findings-reload-decisions"
                                accessibilityRole="button"
                                onPress={() => {
                                    for (const snapshot of commentSnapshots) {
                                        fireAndForget(snapshot.refresh(), { tag: 'ReviewFindingsMessageCard.reload' });
                                    }
                                }}
                            >
                                <StructuredFindText blockId="structured-review:retry" text={t('common.retry')} style={styles.inlineLinkText} />
                            </Pressable>
                        </View>
                    ) : null}
                    {canAct && !followUp.available && !isPage ? (
                        <StructuredFindText blockId="structured-review:unavailable" text={followUp.reason} testID="review-findings-follow-up-unavailable" style={styles.caption} />
                    ) : null}
                </View>
            ) : null}

            {continuingComments.length > 0 ? (
                <RoundButton testID="review-findings-load-more-comments" size="small" display="secondary"
                    title={continuingComments.some(snapshot => snapshot.loadMoreFailed) ? t('common.retry') : t('files.reviewComments.durable.showMore')}
                    loading={continuingComments.some(snapshot => snapshot.loadingMore)}
                    disabled={continuingComments.some(snapshot => snapshot.loadingMore)}
                    onPress={() => { fireAndForget(Promise.all(continuingComments.map(snapshot => snapshot.loadMore())),
                        { tag: 'ReviewFindingsMessageCard.loadMore' }); }} />
            ) : null}

            {isPage ? <ReviewQuestions questions={model.questions} multiReviewer={multiReviewer}
                canAct={canAct} onAnswer={model.setReplyToQuestion} /> : null}

            {isPage ? members.filter((member) => member.normalized.assumptions.length > 0).map((member) => (
                <View key={`assumptions:${member.runId}`} style={styles.section}>
                    <Text accessibilityRole="header" style={styles.sectionTitle}>
                        {multiReviewer
                            ? `${t('session.reviewFindings.assumptionsTitle')} · ${member.reviewerLabel}`
                            : t('session.reviewFindings.assumptionsTitle')}
                    </Text>
                    {member.normalized.assumptions.map((assumption) => (
                        <Text selectable key={assumption.id} style={styles.quiet}>{assumption.text}</Text>
                    ))}
                </View>
            )) : null}

            {approval.approvalPending && approval.approvalId && scope ? (
                <ActionApprovalPendingNotice testID="review-findings-follow-up-approval"
                    message={t('approvals.title')}
                    onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} />
            ) : null}
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </ExecutionRunResultLayout>
    );
}

/** The card's way into the full result: the review's run pane. */
function ReviewOpenResultButton(props: Readonly<{ sessionId: string; runId: string; serverId: string | null }>) {
    const source = useSessionTranscriptSource();
    const find = useStructuredFindState();
    const href = buildSessionExecutionRunRouteHref({ sessionId: props.sessionId, runId: props.runId, serverId: props.serverId });
    if (!source.navigate || !href) return null;
    return (
        <RoundButton
            testID="review-findings-open-result"
            size="small"
            display="secondary"
            title={<StructuredFindText blockId="structured-review:open" text={t('reviewWalkthrough.finished.openFindings')} useDefaultTypography={false} />}
            titleNumberOfLines={find.revealBlockId === 'structured-review:open' ? 'complete' : 1}
            onPress={() => source.navigate?.(href)}
        />
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    startedReview: {  color: theme.colors.text.tertiary, ...Typography.variant('body'),  marginBottom: theme.space.s8 },
    grow: { flex: 1 },
    lead: {
        ...Typography.default(),
        color: theme.colors.text.primary,
        fontSize: 15,
        lineHeight: 22,
    },
    section: {
        gap: theme.space.s10,
    },
    sectionTitleRow: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.space.s8,
    },
    sectionTitle: {
        color: theme.colors.text.primary,
        ...Typography.variant('heading'),
    },
    sectionCount: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
        fontVariant: ['tabular-nums'],
    },
    sheet: {
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 14,
    },
    reviewer: {
        gap: theme.space.s4,
        paddingVertical: theme.space.s12,
    },
    reviewerDivided: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    reviewerHead: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
    reviewerName: {
        color: theme.colors.text.primary,
        ...Typography.variant('label', 'semiBold'),
    },
    reviewerMeta: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
        fontVariant: ['tabular-nums'],
    },
    more: {
        alignSelf: 'flex-start',
        paddingVertical: theme.space.s8,
        paddingLeft: REVIEW_SEVERITY_COLUMN_WIDTH_PX + 12,
    },
    moreText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
    },
    notice: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
    quiet: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
    },
    inlineLinkText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
    caption: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
    errorText: {
        color: theme.colors.state.danger.textForeground,
        ...Typography.variant('body'),
    },
}));
