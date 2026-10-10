import React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import type {
    ReviewCommentV1,
    ReviewFindingsV1,
    ReviewFindingsV2,
    ReviewQuestion,
    ReviewTriageStatus,
} from '@happier-dev/protocol';
import { REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1, renderReviewFindingsForVerifyV1 } from '@happier-dev/protocol/reviews/reviewFindingsApplyInputV1';
import { ReviewFollowUpFailureCodeSchema } from '@happier-dev/protocol/execution/runs/index';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';
import { ReviewFindingRow, type ReviewFindingDecision } from '@/components/sessions/reviews/findings/ReviewFindingRow';
import type {
    ReviewFindingAskContext,
    ReviewFindingThreadEntryView,
} from '@/components/sessions/reviews/findings/ReviewFindingThread';
import {
    ReviewFollowUpComposer,
    type ReviewFollowUpRecipient,
} from '@/components/sessions/reviews/findings/ReviewFollowUpComposer';
import {
    formatReviewFindingsHeadline,
    isHighReviewSeverity,
} from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import {
    formatReviewerSet,
    mergeReviewFindings,
    sortReviewFindingRows,
    type ReviewFindingRowModel,
    type ReviewFindingSource,
    type ReviewMember,
} from '@/components/sessions/reviews/findings/reviewFindingsMerge';
import {
    describeReviewFollowUpFailure,
    resolveReviewFollowUpAvailability,
    type ReviewFollowUpAvailability,
} from '@/components/sessions/reviews/findings/reviewFollowUpAvailability';
import { useReviewGroupSiblings } from '@/components/sessions/reviews/findings/useReviewGroupSiblings';
import { useReviewRunsComments } from '@/components/sessions/reviews/findings/useReviewRunComments';
import { resolveEffectiveReviewFindings } from '@/components/sessions/reviews/messages/resolveEffectiveReviewFindings';
import { findCommentForFinding, readReviewFindingDecision } from '@/components/sessions/reviews/findings/reviewFindingComment';
import { ReviewSeverityLabel, ReviewSeveritySummary } from '@/components/sessions/reviews/walkthrough/ReviewWalkthroughParts';
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
    decideReviewRunFinding,
    loadReviewRunComments,
    readReviewRunComments,
} from '@/sync/domains/reviews/comments/reviewRunComments';
import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding, useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { sync } from '@/sync/sync';
import { t } from '@/text';
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
const EMPTY_THREAD: readonly never[] = [];
const EMPTY_PENDING: Readonly<Record<string, ReviewTriageStatus>> = Object.freeze({});
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
type CardMember = ReviewMember & Readonly<{
    runRef: ReviewFindingsV2['runRef'];
    normalized: NormalizedReviewPayload;
    followUp: ReviewFollowUpAvailability;
    threadRefsByFindingId: Readonly<Record<string, readonly string[]>>;
    pending: Readonly<Record<string, ReviewTriageStatus>>;
}>;

function reviewerLabelOf(runRef: ReviewFindingsV2['runRef']): string {
    return resolveExecutionRunBackendLabel(runRef.backendTarget ?? { kind: 'backend', backendId: runRef.backendId }) ?? runRef.backendId;
}

function sourceDecision(source: ReviewFindingSource, pending: Readonly<Record<string, ReviewTriageStatus>>): ReviewFindingDecision | 'undecided' {
    if (!source.comment) return 'undecided';
    return readReviewFindingDecision(pending[source.comment.id] ?? source.comment.reviewTriageStatus);
}

/** A merged row's decision is its sources' decision when they agree; otherwise none is shown. */
function rowDecision(row: ReviewFindingRowModel, pendingOf: (runId: string) => Readonly<Record<string, ReviewTriageStatus>>): ReviewFindingDecision | 'undecided' {
    const decided = row.sources.filter((source) => source.comment !== null);
    if (decided.length === 0) return 'undecided';
    const first = sourceDecision(decided[0]!, pendingOf(decided[0]!.member.runId));
    return decided.every((source) => sourceDecision(source, pendingOf(source.member.runId)) === first) ? first : 'undecided';
}

const FOLLOW_UP_AVAILABLE: ReviewFollowUpAvailability = Object.freeze({ available: true });

/** Questions go to every reviewer named, so any of them that can't take one decides. */
function followUpOf(members: readonly CardMember[]): ReviewFollowUpAvailability {
    return members.find((member) => !member.followUp.available)?.followUp ?? FOLLOW_UP_AVAILABLE;
}

function recipientOf(members: readonly CardMember[]): ReviewFollowUpRecipient {
    const labels = members.map((member) => member.reviewerLabel);
    return {
        label: formatReviewerSet(labels),
        accessibilityLabel: labels.length === 1
            ? t('runPage.review.toReviewer', { reviewer: labels[0]! })
            : t('runPage.review.followUpsGoToAll', { count: labels.length }),
        backendIds: members.map((member) => member.backendId),
    };
}

function waitingLabelOf(members: readonly CardMember[]): string {
    return members.length === 1
        ? t('runPage.review.waitingForAnswer', { reviewer: members[0]!.reviewerLabel })
        : t('runPage.review.waitingForAnswers');
}

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
    const { messages } = useSessionMessages(props.sessionId);
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
    const followUpExecution = useMountedActionExecution(scope);
    const find = useStructuredFindState();
    const notifyLayout = useTranscriptRowLayoutMutation();
    const openFindingsHref = buildSessionExecutionRunRouteHref({ sessionId: props.sessionId, runId: props.payload.runRef.runId, serverId: props.serverId ?? null });
    const compact = !isPage && Boolean(transcriptSource?.navigate && openFindingsHref);
    const sessionId = props.sessionId;
    const serverId = props.serverId ?? null;
    const canAct = props.canSendMessages === true;
    const canActRef = React.useRef(canAct);
    React.useLayoutEffect(() => {
        canActRef.current = canAct;
    }, [canAct]);

    const normalized = React.useMemo(() => normalizePayload(props.payload), [props.payload]);
    const runId = normalized.runRef.runId;
    const siblings = useReviewGroupSiblings({ sessionId, scope, groupId: isPage ? props.groupId ?? null : null, selfRunId: runId });
    const resultMembers = React.useMemo(() => [
        normalized,
        ...siblings.flatMap((sibling) => (sibling.payload ? [normalizePayload(sibling.payload)] : [])),
    ], [normalized, siblings]);
    const waitingSiblings = React.useMemo(() => siblings.filter((sibling) => sibling.payload === null), [siblings]);
    const memberRunIds = React.useMemo(() => resultMembers.map((member) => member.runRef.runId), [resultMembers]);
    const commentIdsByRunId = React.useMemo(() => Object.fromEntries(resultMembers.map((member) => [
        member.runRef.runId, member.findings.flatMap((finding) => finding.comment ? [finding.comment.id] : []),
    ])), [resultMembers]);
    const hasFindings = resultMembers.some((member) => member.findings.length > 0);

    // Read-only viewers need the same canonical finding identity for the merged result.
    const commentSnapshots = useReviewRunsComments({ scope, sessionId, runIds: memberRunIds, commentIdsByRunId, enabled: hasFindings, refresh: isPage });
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
            reviewerLabel: reviewerLabelOf(member.runRef),
            findings: effective.findings,
            commentByFindingId,
            originalByFindingId: effective.originalByFindingId,
            threadsByFindingId: effective.threadsByFindingId,
            threadRefsByFindingId: effective.threadRefsByFindingId,
            runRef: member.runRef,
            normalized: member,
            followUp: resolveReviewFollowUpAvailability(member.runRef),
            pending: allPending,
        };
    }), [allComments, allPending, resultMembers, sessionMessages]);
    const reviewerCount = members.length + waitingSiblings.length;
    const multiReviewer = reviewerCount > 1;
    const memberByRunId = React.useMemo(() => new Map(members.map((member) => [member.runId, member] as const)), [members]);
    const pendingOf = React.useCallback(
        (memberRunId: string) => memberByRunId.get(memberRunId)?.pending ?? EMPTY_PENDING,
        [memberByRunId],
    );
    const rows = React.useMemo(() => sortReviewFindingRows(mergeReviewFindings(members)), [members]);
    const rowById = React.useMemo(() => new Map(rows.map((row) => [row.rowId, row] as const)), [rows]);
    const rowFindings = React.useMemo(() => rows.map((row) => row.finding), [rows]);
    const headline = React.useMemo(() => formatReviewFindingsHeadline(rowFindings), [rowFindings]);
    const highCount = React.useMemo(() => rowFindings.filter((finding) => isHighReviewSeverity(finding.severity)).length, [rowFindings]);
    const commentsStatus = commentSnapshots[0]?.status ?? 'idle';
    const decisionsFailed = commentSnapshots.some((snapshot) => snapshot.status === 'failed');
    const acceptedRows = React.useMemo(
        () => rows.filter((row) => rowDecision(row, pendingOf) === 'accept'),
        [pendingOf, rows],
    );
    const followUp = React.useMemo(() => followUpOf(members), [members]);

    const [showAllFindings, setShowAllFindings] = React.useState(false);
    const [openThreadRowId, setOpenThreadRowId] = React.useState<string | null>(null);
    const [pendingQuestionByRowId, setPendingQuestionByRowId] = React.useState<Readonly<Record<string, string>>>({});
    const [replyToQuestion, setReplyToQuestion] = React.useState<Readonly<{ runId: string; question: ReviewQuestion }> | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [isApplying, setIsApplying] = React.useState(false);
    const findDisplay = React.useMemo(() => buildReviewFindingsMessageDisplay(props.payload, {
        canNavigate: compact, canSendMessages: canAct, hasWorkspacePath: Boolean(workspacePath), sessionMessages,
        acceptedFindingsCount: acceptedRows.length,
    }, members[0]), [props.payload, compact, canAct, workspacePath, sessionMessages, acceptedRows.length, members]);
    React.useLayoutEffect(() => {
        if (isPage || compact || !find.revealBlockId?.startsWith('structured-review-finding:')) return;
        const row = [...rows].sort((left, right) => right.rowId.length - left.rowId.length)
            .find((candidate) => find.revealBlockId?.startsWith(`structured-review-finding:${candidate.rowId}:`));
        if (!row) return;
        const hidden = rows.indexOf(row) >= CARD_VISIBLE_FINDINGS && !showAllFindings;
        const revealThread = find.revealBlockId.startsWith(`structured-review-finding:${row.rowId}:thread:`) || find.revealBlockId === `structured-review-finding:${row.rowId}:quote`;
        if (hidden || (revealThread && openThreadRowId !== row.rowId)) notifyLayout({ reason: 'expand', sourceId: 'review-findings' });
        if (hidden) setShowAllFindings(true);
        if (revealThread) setOpenThreadRowId(row.rowId);
    }, [compact, find.revealBlockId, find.revealRequestId, isPage, notifyLayout, openThreadRowId, rows, showAllFindings]);

    const threadEntriesByRowId = React.useMemo(() => {
        const entriesByRowId = new Map<string, readonly ReviewFindingThreadEntryView[]>();
        for (const row of rows) {
            const entries = row.sources.flatMap((source) => (source.member.threadsByFindingId[source.finding.id] ?? [])
                .map((entry) => ({ ...entry, reviewerLabel: source.member.reviewerLabel })));
            if (entries.length > 0) entriesByRowId.set(row.rowId, entries.sort((left, right) => left.generatedAtMs - right.generatedAtMs));
        }
        return entriesByRowId;
    }, [rows]);

    // A question's pending echo gives way once its answer has arrived in the thread.
    const threadCountByRowIdRef = React.useRef<Readonly<Record<string, number>>>({});
    React.useEffect(() => {
        const previous = threadCountByRowIdRef.current;
        const answered = Object.keys(pendingQuestionByRowId).filter(
            (rowId) => (threadEntriesByRowId.get(rowId)?.length ?? 0) > (previous[rowId] ?? 0),
        );
        threadCountByRowIdRef.current = Object.fromEntries(
            Array.from(threadEntriesByRowId.entries()).map(([rowId, entries]) => [rowId, entries.length]),
        );
        if (answered.length === 0) return;
        setPendingQuestionByRowId((current) => {
            const next = { ...current };
            for (const rowId of answered) delete next[rowId];
            return next;
        });
    }, [pendingQuestionByRowId, threadEntriesByRowId]);

    const decide = React.useCallback((rowId: string, decision: ReviewFindingDecision) => {
        if (!canActRef.current || !scope) return;
        const row = rowById.get(rowId);
        if (!row) return;
        setError(null);
        // A merged row's decision is recorded on every reviewer's comment for it.
        const decidedIds = new Set<string>();
        for (const source of row.sources) {
            if (!source.comment || sourceDecision(source, pendingOf(source.member.runId)) === decision) continue;
            if (decidedIds.has(source.comment.id)) continue;
            decidedIds.add(source.comment.id);
            fireAndForget(
                decideReviewRunFinding({ scope, sessionId, runId: source.member.runId, commentId: source.comment.id, decision }).then((saved) => {
                    if (!saved) setError(t('runPage.review.couldNotSaveChoice'));
                }),
                { tag: 'ReviewFindingsMessageCard.decide' },
            );
        }
    }, [pendingOf, rowById, scope, sessionId]);

    const sendFollowUp = React.useCallback(async (params: Readonly<{
        runId: string;
        findingIds: readonly string[];
        messageMarkdown: string;
        threadId?: string;
        replyToQuestionId?: string;
    }>): Promise<boolean> => {
        if (!scope || !accountLifetime?.isCurrent()) return false;
        try {
            // The question goes to the review run that reported the finding.
            const result = await followUpExecution.execute('execution.run.action', {
                sessionId,
                runId: params.runId,
                actionId: 'review.follow_up',
                input: {
                    findingIds: [...params.findingIds],
                    ...(params.threadId ? { threadId: params.threadId } : {}),
                    ...(params.replyToQuestionId ? { replyToQuestionId: params.replyToQuestionId } : {}),
                    messageMarkdown: params.messageMarkdown,
                },
            });
            if (!accountLifetime.isCurrent()) return false;
            if (!result.ok) {
                const code = ReviewFollowUpFailureCodeSchema.safeParse('errorCode' in result ? result.errorCode : undefined);
                setError(describeReviewFollowUpFailure(code.success ? code.data : undefined));
                return false;
            }
            return true;
        } catch {
            if (!accountLifetime.isCurrent()) return false;
            setError(describeReviewFollowUpFailure(undefined));
            return false;
        }
    }, [accountLifetime, followUpExecution.execute, sessionId, scope]);

    /** Sends to each target; accepted when at least one reviewer took it (the others say why not). */
    const sendToEach = React.useCallback(async (targets: readonly Parameters<typeof sendFollowUp>[0][]) => {
        if (!canActRef.current || targets.length === 0) return false;
        setError(null);
        const sent = await Promise.all(targets.map((target) => sendFollowUp(target)));
        return sent.some(Boolean);
    }, [sendFollowUp]);

    const askAboutRow = React.useCallback(async (rowId: string, messageMarkdown: string) => {
        const row = rowById.get(rowId);
        if (!row) return false;
        // One thread per finding and reviewer: a merged row asks each reviewer in its own thread.
        const sent = await sendToEach(row.sources.map((source) => {
            const threadId = source.member.threadsByFindingId[source.finding.id]?.at(-1)?.threadId;
            return { runId: source.member.runId, findingIds: [source.finding.id], messageMarkdown, ...(threadId ? { threadId } : {}) };
        }));
        if (sent) setPendingQuestionByRowId((current) => ({ ...current, [rowId]: messageMarkdown }));
        return sent;
    }, [rowById, sendToEach]);

    const askReviewers = React.useCallback(async (messageMarkdown: string) => {
        const targets = replyToQuestion
            ? [{
                runId: replyToQuestion.runId,
                findingIds: replyToQuestion.question.findingIds ?? [],
                messageMarkdown,
                replyToQuestionId: replyToQuestion.question.id,
            }]
            : members.map((member) => ({ runId: member.runId, findingIds: [], messageMarkdown }));
        const sent = await sendToEach(targets);
        if (sent) setReplyToQuestion(null);
        return sent;
    }, [members, replyToQuestion, sendToEach]);

    const toggleThread = React.useCallback((rowId: string) => {
        setOpenThreadRowId((current) => (current === rowId ? null : rowId));
    }, []);

    const implementFixes = React.useCallback(() => {
        const capturedLifetime = accountLifetime;
        if (!canActRef.current || !scope || !capturedLifetime?.isCurrent() || acceptedRows.length === 0) return;
        fireAndForget((async () => {
            setError(null);
            setIsApplying(true);
            try {
                // Read the comments' current revisions and decisions: the verify step writes each
                // verdict under CAS, and a choice changed meanwhile (here or on another surface) wins.
                await Promise.all(memberRunIds.map((memberRunId) => loadReviewRunComments({ scope, sessionId, runId: memberRunId, commentIds: commentIdsByRunId[memberRunId] })));
                const fresh = (memberRunId: string) => readReviewRunComments({ scope, sessionId, runId: memberRunId });
                const freshComments = memberRunIds.flatMap((memberRunId) => fresh(memberRunId).comments);
                const freshRows = rows.map((row) => ({
                    ...row,
                    sources: row.sources.map((source) => ({
                        ...source,
                        comment: findCommentForFinding(freshComments, source.finding, source.member.runId),
                    })),
                }));
                const accepted = freshRows.filter((row) => rowDecision(row, (memberRunId) => fresh(memberRunId).pending) === 'accept');
                if (accepted.length === 0) return;
                // Each reviewer's finding goes with its own comment, so every comment gets its verdict.
                const includedCommentIds = new Set<string>();
                const findings = accepted.flatMap((row) => row.sources.flatMap((source) => {
                    const comment = source.comment;
                    if (comment && includedCommentIds.has(comment.id)) return [];
                    if (comment) includedCommentIds.add(comment.id);
                    const member = memberByRunId.get(source.member.runId);
                    return [{
                        ...source.finding,
                        ...(comment ? { comment, flags: comment.flags, engineId: comment.engineId } : {}),
                        ...(typeof source.finding.attributionConfidence === 'string' ? { attributionConfidence: source.finding.attributionConfidence } : {}),
                        threadRefs: member?.threadRefsByFindingId[source.finding.id] ?? [],
                    }];
                }));
                const text = `${REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1}\n\n${renderReviewFindingsForVerifyV1(findings)}`;
                if (!canActRef.current || !capturedLifetime.isCurrent()) return;
                await sync.submitMessage(
                    sessionId,
                    text,
                    t('session.reviewFindings.actions.applyAcceptedFindings'),
                    undefined,
                    { serverId: scope.serverId, accountLifetime: capturedLifetime, callerSurface: 'review_findings_apply' },
                );
            } catch (e) {
                setError(e instanceof Error ? e.message : t('session.reviewFindings.errors.applyAcceptedFailed'));
            } finally {
                setIsApplying(false);
            }
        })(), { tag: 'ReviewFindingsMessageCard.implementFixes' });
    }, [acceptedRows.length, accountLifetime, commentIdsByRunId, memberByRunId, memberRunIds, rows, scope, sessionId]);

    const visibleRows = !isPage && !showAllFindings ? rows.slice(0, CARD_VISIBLE_FINDINGS) : rows;
    const hiddenCount = rows.length - visibleRows.length;
    const openQuestions = members.flatMap((member) => member.normalized.questions
        .filter((question) => question.status !== 'superseded')
        .map((question) => ({ member, question })));
    const dockMembers = replyToQuestion
        ? members.filter((member) => member.runId === replyToQuestion.runId)
        : members;
    const dockRecipient = React.useMemo(() => recipientOf(dockMembers), [dockMembers]);
    const askContextByRowId = React.useMemo(() => {
        const contexts = new Map<string, ReviewFindingAskContext>();
        for (const row of rows) {
            const rowMembers = row.sources.map((source) => memberByRunId.get(source.member.runId)!).filter(Boolean);
            contexts.set(row.rowId, {
                sessionId,
                serverId,
                draftRunId: runId,
                recipient: recipientOf(rowMembers),
                waitingLabel: waitingLabelOf(rowMembers),
            });
        }
        return contexts;
    }, [memberByRunId, rows, runId, serverId, sessionId]);
    const attributionByRowId = React.useMemo(() => {
        const attributions = new Map<string, Readonly<{ label: string; backendIds: readonly string[] }>>();
        if (!multiReviewer) return attributions;
        for (const row of rows) {
            attributions.set(row.rowId, {
                label: formatReviewerSet(row.sources.map((source) => source.member.reviewerLabel)),
                backendIds: row.sources.map((source) => source.member.backendId),
            });
        }
        return attributions;
    }, [multiReviewer, rows]);

    const implementButton = canAct && rows.length > 0 ? (
        <RoundButton
            testID="review-findings-publish-accepted"
            size="small"
            display={isPage ? 'default' : 'secondary'}
            title={isPage ? t('runPage.review.implementFixes', { count: acceptedRows.length }) : <StructuredFindText blockId="structured-review:implement" text={findDisplay.implement?.text ?? t('runPage.review.implementFixes', { count: acceptedRows.length })} useDefaultTypography={false} />}
            titleNumberOfLines={find.revealBlockId === 'structured-review:implement' ? 'complete' : 1}
            disabled={acceptedRows.length === 0 || isApplying}
            loading={isApplying}
            onPress={implementFixes}
        />
    ) : null;

    const dock = isPage && canAct && openThreadRowId === null ? (
        <View style={styles.dock}>
            {followUp.available ? (
                <>
                    <ReviewFollowUpComposer
                        testID="review-findings-follow-up"
                        sessionId={sessionId}
                        serverId={serverId}
                        draftRunId={runId}
                        placeholder={dockMembers.length > 1
                            ? t('runPage.review.askReviewersPlaceholder')
                            : t('runPage.review.askReviewerPlaceholder')}
                        recipient={dockRecipient}
                        onSend={askReviewers}
                    />
                    <Text style={styles.caption}>
                        {dockMembers.length > 1
                            ? t('runPage.review.followUpsGoToAll', { count: dockMembers.length })
                            : t('runPage.review.followUpsGoTo', { reviewer: dockMembers[0]!.reviewerLabel })}
                    </Text>
                </>
            ) : (
                <Text testID="review-findings-follow-up-unavailable" style={styles.caption}>{followUp.reason}</Text>
            )}
        </View>
    ) : null;

    const groupHeadline = multiReviewer
        ? [t('runPage.review.reviewerCount', { count: reviewerCount }), headline].join(' · ')
        : null;

    // A finished review in the transcript is a compact summary (lab WT5-R8) whenever its own page is one
    // press away: decisions, questions and Implement fixes live there. Without that page, the full card stays.
    if (compact) {
        const compactRows = rows.slice(0, CARD_VISIBLE_FINDINGS);
        return (
            <>
            {normalized.fileCount !== null ? (
                <StructuredFindText blockId="structured-review:started" text={findDisplay.started?.text ?? ''} testID="review-findings-started" style={styles.startedReview} />
            ) : null}
            <ExecutionRunResultLayout
                presentation="message"
                testID="review-findings"
                footActions={(
                    <>
                        <ReviewOpenResultButton sessionId={sessionId} runId={runId} serverId={serverId} />
                        {canAct ? (
                            <ReviewWalkMeThroughButton sessionId={sessionId} serverId={serverId} runId={runId}
                                reviewRunIds={memberRunIds} comparisonId={normalized.comparisonId} />
                        ) : null}
                    </>
                )}
                footHint={canAct ? (
                    <ReviewWalkthroughEntryHint continues={members.some((member) => member.followUp.available)} findingsCount={rows.length} />
                ) : null}
            >
                <View testID="review-findings-finished-header" style={styles.finishedHead}>
                    <Icon name="shield-check" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                    <StructuredFindText blockId={findDisplay.finished.id} text={findDisplay.finished.text} style={styles.finishedTitle} />
                    <StructuredFindText blockId={findDisplay.meta.id} text={findDisplay.meta.text} style={styles.finishedMeta} numberOfLines={1} />
                    <View style={styles.grow} />
                    {rows.length > 0 ? <StructuredFindText blockId={findDisplay.count.id} text={findDisplay.count.text} style={styles.finishedCount} /> : null}
                </View>
                {rows.length > 0 ? <ReviewSeveritySummary testID="review-findings-severity-summary" findings={rowFindings} findBlockPrefix="structured-review:count" /> : null}
                {compactRows.length > 0 ? (
                    <View style={styles.compactRows}>
                        {compactRows.map((row) => (
                            <View key={row.rowId} testID={`review-finding-compact:${row.rowId}`} style={styles.compactRow}>
                                <ReviewSeverityLabel severity={row.finding.severity} size="md" findBlockId={`structured-review-finding:${row.rowId}:severity`} />
                                <StructuredFindText blockId={`structured-review-finding:${row.rowId}:title`} text={row.finding.title} numberOfLines={1} style={styles.compactTitle} />
                                <StructuredFindText blockId={`structured-review-finding:${row.rowId}:reviewer`} text={row.sources.map((source) => source.member.reviewerLabel).join(t('reviewWalkthrough.and'))} numberOfLines={1} style={styles.compactEngine} />
                            </View>
                        ))}
                        {rows.length > compactRows.length ? (
                            <StructuredFindText blockId="structured-review:more" text={findDisplay.more?.text ?? ''} testID="review-findings-more" style={styles.compactMore} />
                        ) : null}
                    </View>
                ) : null}
                <View style={styles.compactDivider} />
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
                    ? (acceptedRows.length > 0
                        ? t('runPage.review.fixesToImplement', { count: acceptedRows.length })
                        : t('runPage.review.noFixesSelected'))
                    : null)
                : (rows.length > 0 ? <StructuredFindText blockId={findDisplay.count.id} text={findDisplay.count.text} useDefaultTypography={false} /> : null)}
            footDetail={isPage && canAct && acceptedRows.length > 0 ? t('runPage.review.verifiedFirst') : null}
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
                            const decidable = row.sources.some((source) => source.comment !== null);
                            const rowMembers = row.sources.map((source) => memberByRunId.get(source.member.runId)!);
                            return (
                                <ReviewFindingRow
                                    key={row.rowId}
                                    rowId={row.rowId}
                                    finding={row.finding}
                                    attribution={attributionByRowId.get(row.rowId) ?? null}
                                    original={row.sources.find((source) => source.finding === row.finding)?.member.originalByFindingId[row.finding.id] ?? null}
                                    density={isPage ? 'page' : 'card'}
                                    findBlockPrefix={isPage ? undefined : `structured-review-finding:${row.rowId}`}
                                    divided={index > 0}
                                    decision={canAct ? rowDecision(row, pendingOf) : null}
                                    decisionDisabled={!decidable}
                                    decisionNote={commentsStatus === 'loaded' && !decidable ? t('runPage.review.notSaved') : null}
                                    onDecide={decide}
                                    followUp={canAct ? followUpOf(rowMembers) : null}
                                    threadEntries={threadEntriesByRowId.get(row.rowId) ?? EMPTY_THREAD}
                                    pendingQuestion={pendingQuestionByRowId[row.rowId] ?? null}
                                    threadOpen={openThreadRowId === row.rowId}
                                    onToggleThread={toggleThread}
                                    askContext={askContextByRowId.get(row.rowId)!}
                                    onAsk={askAboutRow}
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
                                    for (const memberRunId of memberRunIds) {
                                        if (!scope) continue;
                                        fireAndForget(loadReviewRunComments({ scope, sessionId, runId: memberRunId }).catch(() => undefined), { tag: 'ReviewFindingsMessageCard.reload' });
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

            {isPage ? openQuestions.map(({ member, question }) => (
                <View key={`${member.runId}:${question.id}`} testID={`review-question:${question.id}`} style={styles.question}>
                    <Icon name="question" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                    <View style={styles.questionBody}>
                        <Text style={styles.questionEyebrow}>
                            {multiReviewer ? `${member.reviewerLabel} · ${t('runPage.review.reviewerAsks')}` : t('runPage.review.reviewerAsks')}
                        </Text>
                        <Text selectable style={styles.questionText}>
                            {question.text}
                            {canAct && member.followUp.available && question.status === 'open' ? (
                                <>
                                    {'  '}
                                    <Text
                                        testID={`review-question-answer:${question.id}`}
                                        accessibilityRole="button"
                                        onPress={() => setReplyToQuestion({ runId: member.runId, question })}
                                        style={styles.inlineLinkText}
                                    >
                                        {t('runPage.review.answer')}
                                    </Text>
                                </>
                            ) : null}
                        </Text>
                    </View>
                </View>
            )) : null}

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

            {followUpExecution.approval.approvalPending && followUpExecution.approval.approvalId && scope ? (
                <ActionApprovalPendingNotice testID="review-findings-follow-up-approval"
                    message={t('approvals.title')}
                    onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(followUpExecution.approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} />
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
    startedReview: { ...Typography.default(), color: theme.colors.text.tertiary, fontSize: 13, lineHeight: 19, marginBottom: 8 },
    grow: { flex: 1 },
    finishedHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    finishedTitle: { ...Typography.default('semiBold'), color: theme.colors.text.primary, fontSize: 15 },
    finishedMeta: { ...Typography.default(), flexShrink: 1, color: theme.colors.text.tertiary, fontSize: 14 },
    finishedCount: { ...Typography.default(), color: theme.colors.text.tertiary, fontSize: 14, fontVariant: ['tabular-nums'] },
    compactRows: { gap: 2 },
    compactRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 28 },
    compactTitle: { ...Typography.default(), flex: 1, minWidth: 0, color: theme.colors.text.primary, fontSize: 14 },
    compactEngine: { ...Typography.default(), flexShrink: 0, maxWidth: '30%', color: theme.colors.text.tertiary, fontSize: 13 },
    compactMore: { ...Typography.default(), paddingLeft: 2, paddingTop: 2, color: theme.colors.text.tertiary, fontSize: 13 },
    compactDivider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border.default },
    lead: {
        ...Typography.default(),
        color: theme.colors.text.primary,
        fontSize: 15,
        lineHeight: 22,
    },
    section: {
        gap: 10,
    },
    sectionTitleRow: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 8,
    },
    sectionTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 15,
    },
    sectionCount: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
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
        gap: 4,
        paddingVertical: 12,
    },
    reviewerDivided: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    reviewerHead: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
    },
    reviewerName: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 14,
    },
    reviewerMeta: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
        fontVariant: ['tabular-nums'],
    },
    more: {
        alignSelf: 'flex-start',
        paddingVertical: 8,
        paddingLeft: 84,
    },
    moreText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
    notice: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
    },
    question: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        padding: 14,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    questionBody: {
        flex: 1,
        minWidth: 0,
        gap: 4,
    },
    questionEyebrow: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
    questionText: {
        ...Typography.default(),
        color: theme.colors.text.primary,
        fontSize: 14.5,
        lineHeight: 21,
    },
    quiet: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
    inlineLinkText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
    dock: {
        gap: 6,
    },
    caption: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 12.5,
    },
    errorText: {
        ...Typography.default(),
        color: theme.colors.state.danger.foreground,
        fontSize: 13,
    },
}));
