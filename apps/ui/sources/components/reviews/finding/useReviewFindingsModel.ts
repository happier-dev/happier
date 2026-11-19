import * as React from 'react';
import { Platform } from 'react-native';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';

import { ReviewFollowUpFailureCodeSchema } from '@happier-dev/protocol/execution/runs/index';
import type { ReviewFindingsV2 } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import type { ReviewQuestion } from '@happier-dev/protocol/reviews/ReviewQuestion';
import type { ReviewTriageStatus } from '@happier-dev/protocol/reviews/reviewTriageStatus';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { ReviewFindingsApplyResultV1Schema } from '@happier-dev/protocol/reviews/reviewApplyV1';
import { projectReviewFindingRoundStatusV1, reviewCommentFindingScopeV1,
    type ReviewFindingRoundContextV1 } from '@happier-dev/protocol/reviews/comments/findingIdentity';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ReviewFindingDecision } from '@/components/sessions/reviews/findings/ReviewFindingRow';
import { readReviewFindingDecision } from '@/components/sessions/reviews/findings/reviewFindingComment';
import type { ReviewFindingAskContext, ReviewFindingThreadEntryView } from '@/components/sessions/reviews/findings/ReviewFindingThread';
import type { ReviewFollowUpRecipient } from '@/components/sessions/reviews/findings/ReviewFollowUpComposer';
import {
    formatReviewerSet, mergeReviewFindings, sortReviewFindingRows,
    type ReviewFindingRowModel, type ReviewFindingSource, type ReviewMember,
} from '@/components/sessions/reviews/findings/reviewFindingsMerge';
import { describeReviewFollowUpFailure, type ReviewFollowUpAvailability } from '@/components/sessions/reviews/findings/reviewFollowUpAvailability';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { openSessionAuthoringAction } from '@/sync/ops/actions/sessionAuthoringActions';
import { beginClipboardWriteFromUi } from '@/utils/ui/clipboard';

export type ReviewFindingsMember = ReviewMember & Readonly<{
    /** The producing Session, when admitted for reviewer follow-up. */
    sessionId: string | null;
    followUp: ReviewFollowUpAvailability;
    threadRefsByFindingId: Readonly<Record<string, readonly string[]>>;
    questions: readonly ReviewQuestion[];
    assumptions: readonly ReviewFindingsV2['assumptions'][number][];
}>;

const EMPTY_THREAD: readonly ReviewFindingThreadEntryView[] = Object.freeze([]);
const EMPTY_COMMENTS: readonly ReviewCommentV1[] = Object.freeze([]);

export type ReviewFindingDecisionTarget = Readonly<{ comment: ReviewCommentV1; runId?: string }>;

/** Tasks stores canonical comment references, never an engine's local finding id or body. */
function taskOriginOf(comments: readonly ReviewCommentV1[]) {
    const reviewId = comments[0]?.reviewId;
    return reviewId && comments.every(comment => comment.reviewId === reviewId)
        ? { reviewId, findingIds: [...new Set(comments.map(comment => comment.id))] }
        : null;
}

/** The Review's durable roots and their sealed finding payloads, shared by opened and summary views. */
export function projectReviewFindingRoots(reviewId: string, comments: readonly ReviewCommentV1[]): Readonly<{
    roots: readonly ReviewCommentV1[];
    rows: readonly Readonly<{ rowId: string; finding: NonNullable<ReviewCommentV1['finding']>; comment: ReviewCommentV1 }>[];
    unavailableFindings: readonly ReviewCommentV1[];
}> {
    const roots = comments.filter(comment => {
        const identity = reviewCommentFindingScopeV1(comment);
        return identity?.[0] === 'review' && identity[1] === reviewId;
    });
    return {
        roots,
        rows: sortReviewFindingRows(roots.flatMap(comment => comment.finding
            ? [{ rowId: comment.id, finding: comment.finding, comment }] : [])),
        unavailableFindings: roots.filter(comment => !comment.finding),
    };
}


function sourceDecision(source: ReviewFindingSource, pending: Readonly<Record<string, ReviewTriageStatus>>): ReviewFindingDecision | 'undecided' {
    if (!source.comment) return 'undecided';
    return readReviewFindingDecision(source.comment.reviewTriageStatus, source.comment.state, pending[source.comment.id]);
}

/** A merged row's decision is its sources' decision when they agree; otherwise none is shown. */
function rowDecision(row: ReviewFindingRowModel, pending: Readonly<Record<string, ReviewTriageStatus>>): ReviewFindingDecision | 'undecided' {
    const decided = row.sources.filter((source) => source.comment !== null);
    if (decided.length === 0) return 'undecided';
    const first = sourceDecision(decided[0]!, pending);
    return decided.every((source) => sourceDecision(source, pending) === first) ? first : 'undecided';
}

const FOLLOW_UP_AVAILABLE: ReviewFollowUpAvailability = Object.freeze({ available: true });

/** Questions go to every reviewer named, so any of them that can't take one decides. */
export function followUpOf(members: readonly ReviewFindingsMember[]): ReviewFollowUpAvailability {
    return members.find((member) => !member.followUp.available)?.followUp ?? FOLLOW_UP_AVAILABLE;
}

export function recipientOf(members: readonly ReviewFindingsMember[]): ReviewFollowUpRecipient {
    const labels = members.map((member) => member.reviewerLabel);
    return {
        label: formatReviewerSet(labels),
        accessibilityLabel: labels.length === 1
            ? t('runPage.review.toReviewer', { reviewer: labels[0]! })
            : t('runPage.review.followUpsGoToAll', { count: labels.length }),
        backendIds: members.map((member) => member.backendId),
    };
}

function waitingLabelOf(members: readonly ReviewFindingsMember[]): string {
    return members.length === 1
        ? t('runPage.review.waitingForAnswer', { reviewer: members[0]!.reviewerLabel })
        : t('runPage.review.waitingForAnswers');
}

/** One decision, reviewer conversation, and verify-and-fix model for the Run and Review surfaces. */
export function useReviewFindingsModel<const Member extends ReviewFindingsMember>(params: Readonly<{
    members: readonly Member[];
    /** The Review resource supplies sealed findings; it supplies no Session follow-up authority. */
    record?: Readonly<{ round: ReviewFindingRoundContextV1; comments: readonly ReviewCommentV1[] }>;
    reviewerCount: number;
    scope: ServerAccountScope | null;
    accountLifetime: ServerAccountScopeLifetime | null;
    serverId: string | null;
    /** The selected fix Session; this may differ from the finding's producing Session. */
    sessionId: string | null;
    draftRunId?: string;
    reviewId?: string;
    canAct: boolean;
    pending: Readonly<Record<string, ReviewTriageStatus>>;
    onDecideComment: (target: ReviewFindingDecisionTarget, decision: ReviewFindingDecision) => Promise<boolean>;
}>) {
    const { members, record, reviewerCount, scope, accountLifetime, serverId, sessionId, draftRunId, canAct, pending, onDecideComment } = params;
    const reviewId = params.reviewId ?? record?.round.reviewId;
    const recordReviewId = record?.round.reviewId;
    const followUpExecution = useMountedActionExecution(scope);
    const canActRef = React.useRef(canAct);
    React.useLayoutEffect(() => {
        canActRef.current = canAct;
    }, [canAct]);
    const memberByRunId = React.useMemo(() => new Map(members.map((member) => [member.runId, member] as const)), [members]);
    const rows = React.useMemo(() => sortReviewFindingRows(mergeReviewFindings(members)), [members]);
    const rowById = React.useMemo(() => new Map(rows.map((row) => [row.rowId, row] as const)), [rows]);
    const native = React.useMemo(() => projectReviewFindingRoots(recordReviewId ?? '', record?.comments ?? EMPTY_COMMENTS),
        [record?.comments, recordReviewId]);
    const { rows: sealedRows, unavailableFindings } = native;
    const rootById = React.useMemo(() => new Map(sealedRows.map(row => [row.rowId, row.comment] as const)), [sealedRows]);
    const acceptedRows = React.useMemo(
        () => rows.filter((row) => rowDecision(row, pending) === 'accept'),
        [pending, rows],
    );
    const acceptedCount = record ? sealedRows.filter(row => readReviewFindingDecision(row.comment.reviewTriageStatus, row.comment.state, pending[row.rowId]) === 'accept').length
        : acceptedRows.length;
    const hasPendingDecisions = Object.keys(pending).length > 0;

    const [pendingQuestionByRowId, setPendingQuestionByRowId] = React.useState<Readonly<Record<string, string>>>({});
    const [replyToQuestion, setReplyToQuestion] = React.useState<Readonly<{ member: Member; question: ReviewQuestion }> | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [isApplying, setIsApplying] = React.useState(false);
    const threadEntriesByRowId = React.useMemo(() => {
        const entriesByRowId = new Map<string, ReviewFindingThreadEntryView[]>();
        if (record) {
            const rowByThreadId = new Map(sealedRows.map(row => [row.comment.threadId, row]));
            for (const comment of record.comments) {
                if (!comment.parentCommentId) continue;
                const row = rowByThreadId.get(comment.threadId);
                if (!row) continue;
                const entries = entriesByRowId.get(row.rowId) ?? [];
                entries.push({ kind: 'comment', threadId: comment.threadId, generatedAtMs: comment.createdAt, comment });
                entriesByRowId.set(row.rowId, entries);
            }
            for (const entries of entriesByRowId.values()) entries.sort((left, right) => left.generatedAtMs - right.generatedAtMs);
            return entriesByRowId;
        }
        for (const row of rows) {
            const entries = row.sources.flatMap((source) => (source.member.threadsByFindingId[source.finding.id] ?? [])
                .map((entry) => ({ ...entry, reviewerLabel: source.member.reviewerLabel })));
            if (entries.length > 0) entriesByRowId.set(row.rowId, entries.sort((left, right) => left.generatedAtMs - right.generatedAtMs));
        }
        return entriesByRowId;
    }, [record, rows, sealedRows]);

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
        if (!canActRef.current) return;
        const root = rootById.get(rowId);
        if (root) {
            if (readReviewFindingDecision(root.reviewTriageStatus, root.state, pending[root.id]) === decision) return;
            setError(null);
            fireAndForget(onDecideComment({ comment: root }, decision).then(saved => {
                if (!saved) setError(t('runPage.review.couldNotSaveChoice'));
            }), { tag: 'useReviewFindingsModel.decide' });
            return;
        }
        const row = rowById.get(rowId);
        if (!row) return;
        setError(null);
        // A merged row's decision is recorded on every reviewer's comment for it.
        const decidedIds = new Set<string>();
        for (const source of row.sources) {
            if (!source.comment || sourceDecision(source, pending) === decision) continue;
            if (decidedIds.has(source.comment.id)) continue;
            decidedIds.add(source.comment.id);
            fireAndForget(
                onDecideComment({ comment: source.comment, runId: source.member.runId }, decision).then((saved) => {
                    if (!saved) setError(t('runPage.review.couldNotSaveChoice'));
                }),
                { tag: 'useReviewFindingsModel.decide' },
            );
        }
    }, [onDecideComment, pending, rootById, rowById]);

    const sendFollowUp = React.useCallback(async (params: Readonly<{
        sessionId: string | null;
        runId: string;
        findingIds: readonly string[];
        messageMarkdown: string;
        threadId?: string;
        replyToQuestionId?: string;
    }>): Promise<boolean> => {
        if (!params.sessionId || !scope || !accountLifetime?.isCurrent()) return false;
        try {
            // The question goes to the review run that reported the finding.
            const result = await followUpExecution.execute('execution.run.action', {
                sessionId: params.sessionId,
                runId: params.runId,
                actionId: 'review.follow_up',
                input: {
                    findingIds: [...params.findingIds],
                    ...(params.threadId ? { threadId: params.threadId } : {}),
                    ...(params.replyToQuestionId ? { replyToQuestionId: params.replyToQuestionId } : {}),
                    messageMarkdown: params.messageMarkdown,
                },
            }, { retainEffectResult: true });
            // Preserve the admission receipt; the draft owner settles its captured
            // fields against the Account lifetime even after this view closes.
            if (result.ok) return true;
            if (!accountLifetime.isCurrent() || !followUpExecution.isCurrent()) return false;
            const code = ReviewFollowUpFailureCodeSchema.safeParse('errorCode' in result ? result.errorCode : undefined);
            setError(describeReviewFollowUpFailure(code.success ? code.data : undefined));
            return false;
        } catch {
            if (!accountLifetime.isCurrent() || !followUpExecution.isCurrent()) return false;
            setError(describeReviewFollowUpFailure(undefined));
            return false;
        }
    }, [accountLifetime, followUpExecution.execute, followUpExecution.isCurrent, scope]);

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
            return { sessionId: memberByRunId.get(source.member.runId)?.sessionId ?? null, runId: source.member.runId, findingIds: [source.finding.id], messageMarkdown, ...(threadId ? { threadId } : {}) };
        }));
        if (sent) setPendingQuestionByRowId((current) => ({ ...current, [rowId]: messageMarkdown }));
        return sent;
    }, [memberByRunId, rowById, sendToEach]);

    const askReviewers = React.useCallback(async (messageMarkdown: string) => {
        const targets = replyToQuestion
            ? [{
                sessionId: replyToQuestion.member.sessionId,
                runId: replyToQuestion.member.runId,
                findingIds: replyToQuestion.question.findingIds ?? [],
                messageMarkdown,
                replyToQuestionId: replyToQuestion.question.id,
            }]
            : members.map((member) => ({ sessionId: member.sessionId, runId: member.runId, findingIds: [], messageMarkdown }));
        const sent = await sendToEach(targets);
        if (sent) setReplyToQuestion(null);
        return sent;
    }, [members, replyToQuestion, sendToEach]);

    const implementFixes = React.useCallback((sessionId: string | null) => {
        const capturedLifetime = accountLifetime;
        if (!canActRef.current || !scope || !sessionId || !capturedLifetime?.isCurrent() || hasPendingDecisions || acceptedCount === 0) return;
        fireAndForget((async () => {
            setError(null);
            setIsApplying(true);
            try {
                if (!canActRef.current || !capturedLifetime.isCurrent()) return;
                const reviewIds = reviewId ? [reviewId] : [...new Set(members.flatMap(member => [...member.commentByFindingId.values()]
                    .map(comment => comment.reviewId).filter((reviewId): reviewId is string => Boolean(reviewId))))];
                if (reviewIds.length > 0) {
                    await Promise.all(reviewIds.map(reviewId => followUpExecution.executeValue('review.apply',
                        { sessionId, reviewId }, { sessionMessageDisplayText: t('session.reviewFindings.actions.applyAcceptedFindings') })));
                } else {
                    // Legacy unbound runs have no Review resource yet; retain their admitted
                    // run-scoped input until the producer materializes a Review identity.
                    await followUpExecution.executeValue('review.apply', { sessionId, reviews: members.map(member => ({
                        runId: member.runId,
                        findings: member.findings.map(finding => {
                            const comment = member.commentByFindingId.get(finding.id);
                            return { ...finding,
                                ...(comment ? { comment: { id: comment.id, state: comment.state, serverRevision: comment.serverRevision,
                                    ...(comment.projectId ? { projectId: comment.projectId } : {}),
                                    ...(comment.workspace ? { workspace: comment.workspace } : {}),
                                    ...(comment.sessionId ? { sessionId: comment.sessionId } : {}),
                                    ...(comment.runId ? { runId: comment.runId } : {}),
                                } } : {}),
                                threadRefs: member.threadRefsByFindingId[finding.id] ?? [],
                            };
                        }),
                    })) }, { sessionMessageDisplayText: t('session.reviewFindings.actions.applyAcceptedFindings') });
                }
            } catch (e) {
                setError(e instanceof Error ? e.message : t('session.reviewFindings.errors.applyAcceptedFailed'));
            } finally {
                setIsApplying(false);
            }
        })(), { tag: 'useReviewFindingsModel.implementFixes' });
    }, [acceptedCount, accountLifetime, followUpExecution.executeValue, hasPendingDecisions, members, reviewId, scope]);

    /** The Review Action prepares one fresh prompt; each destination keeps its own admission and approval. */
    const applyPreparedPrompt = React.useCallback(async (destination: 'newSession' | 'clipboard'): Promise<boolean> => {
        const capturedLifetime = accountLifetime;
        if ((destination === 'newSession' && !canActRef.current) || !reviewId || !scope || !capturedLifetime?.isCurrent()
            || hasPendingDecisions || acceptedCount === 0) return false;
        // Like remote-viewer copy, WebKit takes the pending Blob in this gesture;
        // the admitted Review Action supplies its content after its read settles.
        const webWrite = destination === 'clipboard' && Platform.OS === 'web' ? beginClipboardWriteFromUi('text/plain') : null;
        setError(null);
        setIsApplying(true);
        try {
            const result = ReviewFindingsApplyResultV1Schema.parse(await followUpExecution.executeValue('review.apply',
                { reviewId, destination: 'prompt' }));
            if (result.status !== 'prepared') return false;
            if (destination === 'newSession') {
                const opened = await openSessionAuthoringAction({ seed: { prompt: result.prompt } }, capturedLifetime,
                    { executeAction: followUpExecution.execute, isCurrent: followUpExecution.isCurrent });
                return opened.kind === 'opened';
            }
            if (webWrite) {
                const copied = await webWrite.write(new Blob([result.prompt], { type: 'text/plain' }));
                if (!copied) setError(t('errors.operationFailed'));
                return copied;
            }
            await followUpExecution.executeValue('clipboard.write', { text: result.prompt });
            return true;
        } catch (error) {
            if (followUpExecution.isCurrent()) setError(resolveActionExecutionErrorMessage(error,
                t('session.reviewFindings.errors.applyAcceptedFailed')));
            return false;
        } finally {
            await webWrite?.refuse();
            setIsApplying(false);
        }
    }, [acceptedCount, accountLifetime, followUpExecution.execute, followUpExecution.executeValue,
        followUpExecution.isCurrent, hasPendingDecisions, reviewId, scope]);

    const questions = React.useMemo(() => members.flatMap(member => member.questions
        .filter(question => question.status !== 'superseded').map(question => ({ member, question }))), [members]);
    const assumptions = React.useMemo(() => members.flatMap(member => member.assumptions
        .map(assumption => ({ member, assumption }))), [members]);
    const dockMembers = React.useMemo(() => replyToQuestion ? [replyToQuestion.member] : members, [members, replyToQuestion]);
    const followUp = React.useMemo(() => followUpOf(dockMembers), [dockMembers]);
    const dockRecipient = React.useMemo(() => recipientOf(dockMembers), [dockMembers]);
    const rowViews = React.useMemo(() => record ? sealedRows.map(row => {
        const appearances = row.comment.appearances?.filter(appearance => appearance.roundOrdinal === record.round.roundOrdinal) ?? [];
        const reviewers = appearances.map(appearance => {
            const member = memberByRunId.get(appearance.runId);
            return { label: member?.reviewerLabel ?? appearance.reviewerId, backendId: member?.backendId ?? '' };
        });
        return {
            rowId: row.rowId, finding: row.finding,
            currentBodyMarkdown: typeof row.comment.body === 'string' ? row.comment.body : undefined,
            taskOrigin: taskOriginOf([row.comment]),
            decision: readReviewFindingDecision(row.comment.reviewTriageStatus, row.comment.state, pending[row.rowId]),
            decidable: true, reviewers,
            attribution: reviewers.length > 1 ? { label: formatReviewerSet(reviewers.map(reviewer => reviewer.label)),
                backendIds: reviewers.map(reviewer => reviewer.backendId).filter(Boolean) } : null,
            original: null, followUp: null, threadEntries: threadEntriesByRowId.get(row.rowId) ?? EMPTY_THREAD, askContext: null,
            appearance: projectReviewFindingRoundStatusV1(row.comment, record.round),
        };
    }) : rows.map(row => {
        const rowMembers = row.sources.map(source => memberByRunId.get(source.member.runId)!);
        const rowSessionId = rowMembers[0]?.sessionId ?? null;
        return {
            rowId: row.rowId,
            finding: row.finding,
            currentBodyMarkdown: undefined,
            taskOrigin: taskOriginOf(row.sources.flatMap(source => source.comment ? [source.comment] : [])),
            decision: rowDecision(row, pending),
            decidable: row.sources.some(source => source.comment !== null),
            reviewers: rowMembers.map(member => ({ label: member.reviewerLabel, backendId: member.backendId })),
            attribution: reviewerCount > 1 ? {
                label: formatReviewerSet(rowMembers.map(member => member.reviewerLabel)),
                backendIds: rowMembers.map(member => member.backendId),
            } : null,
            original: row.sources.find(source => source.finding === row.finding)?.member.originalByFindingId[row.finding.id] ?? null,
            followUp: followUpOf(rowMembers),
            threadEntries: threadEntriesByRowId.get(row.rowId) ?? EMPTY_THREAD,
            askContext: rowSessionId ? {
                sessionId: rowSessionId,
                serverId,
                accountLifetime,
                draftRunId: draftRunId ?? rowMembers[0]!.runId,
                recipient: recipientOf(rowMembers),
                waitingLabel: waitingLabelOf(rowMembers),
            } satisfies ReviewFindingAskContext : null,
            appearance: null,
        };
    }), [accountLifetime, draftRunId, memberByRunId, pending, record, reviewerCount, rows, sealedRows, serverId, threadEntriesByRowId]);

    const createTask = React.useCallback(async (rowIds: readonly string[]): Promise<boolean> => {
        if (!canActRef.current) return false;
        const selected = new Set(rowIds);
        const origins = rowViews.filter(row => selected.has(row.rowId)).map(row => row.taskOrigin);
        const reviewId = origins[0]?.reviewId;
        if (!reviewId || origins.length !== selected.size || origins.some(origin => !origin || origin.reviewId !== reviewId)) return false;
        const findingIds = [...new Set(origins.flatMap(origin => origin?.findingIds ?? []))];
        setError(null);
        try {
            const result = await followUpExecution.execute('action.invoke', {
                action: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: 'tasks/open-create-v1' },
                input: { originReview: { reviewId, findingIds } },
            }, { retainEffectResult: true });
            if (result.ok && result.result && typeof result.result === 'object' && 'status' in result.result
                && result.result.status === 'applied') return true;
            if (!followUpExecution.isCurrent()) return false;
            setError(resolveActionExecutionErrorMessage(result, t('common.error')));
        } catch (error) {
            if (followUpExecution.isCurrent()) setError(resolveActionExecutionErrorMessage(error, t('common.error')));
        }
        return false;
    }, [followUpExecution.execute, followUpExecution.isCurrent, rowViews]);

    const createTaskForRow = React.useCallback(async (rowId: string) => { await createTask([rowId]); }, [createTask]);

    return {
        rows: rowViews,
        unavailableFindings,
        questions,
        assumptions,
        followUp,
        pendingQuestionByRowId,
        onDecide: decide,
        onAsk: askAboutRow,
        createTask,
        onCreateTask: createTaskForRow,
        dockMembers,
        dockRecipient,
        askReviewers,
        setReplyToQuestion,
        implement: {
            count: acceptedCount,
            run: () => implementFixes(sessionId),
            runInSession: (sessionId: string) => implementFixes(sessionId),
            runInNewSession: () => applyPreparedPrompt('newSession'),
            copyPrompt: () => applyPreparedPrompt('clipboard'),
            busy: isApplying,
            disabled: !sessionId || acceptedCount === 0 || hasPendingDecisions || isApplying,
            destinationDisabled: acceptedCount === 0 || hasPendingDecisions || isApplying,
        },
        approval: followUpExecution.approval,
        error,
    };
}
