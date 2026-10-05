import type { ReviewFinding, ReviewFindingsV1, ReviewFindingsV2, ReviewQuestion } from '@happier-dev/protocol';
import type { Message } from '@happier-dev/session-core/messages';
import { formatReviewFindingLocation, formatReviewFindingThreadQuote, formatReviewFindingThreadUpdate, reviewSeverityCounts, reviewSeverityLabel, sortReviewFindingsBySeverity } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { resolveReviewFollowUpAvailability } from '@/components/sessions/reviews/findings/reviewFollowUpAvailability';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import type { StructuredFindTextBlock } from '@/components/sessions/transcript/structured/structuredFindText';
import { resolveEffectiveReviewFindings } from './resolveEffectiveReviewFindings';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { t } from '@/text';
import type { ReviewRunCommentsSnapshot } from '@/sync/domains/reviews/comments/reviewRunComments';
import { findCommentForFinding, readReviewFindingDecision } from '@/components/sessions/reviews/findings/reviewFindingComment';

export const REVIEW_CARD_VISIBLE_FINDINGS = 3;
export type ReviewFindingsMessageDisplayOptions = Readonly<{
    canNavigate?: boolean;
    canSendMessages?: boolean;
    hasWorkspacePath?: boolean;
    sessionMessages?: readonly Message[];
    acceptedFindingsCount?: number;
    reviewComments?: Pick<ReviewRunCommentsSnapshot, 'status' | 'comments'>;
}>;

export type NormalizedReviewFindingsMessagePayload = Readonly<{
    runRef: ReviewFindingsV2['runRef'];
    comparisonId: string | null;
    fileCount: number | null;
    summary: string;
    overviewMarkdown: string;
    findings: readonly ReviewFinding[];
    questions: readonly ReviewQuestion[];
    assumptions: ReviewFindingsV2['assumptions'];
}>;
const EMPTY_QUESTIONS: ReviewFindingsV2['questions'] = [];
const EMPTY_ASSUMPTIONS: ReviewFindingsV2['assumptions'] = [];

export function normalizeReviewFindingsMessagePayload(payload: ReviewFindingsV1 | ReviewFindingsV2): NormalizedReviewFindingsMessagePayload {
    const candidateOverviewMarkdown = 'overviewMarkdown' in payload ? payload.overviewMarkdown : undefined;
    const version2 = typeof candidateOverviewMarkdown === 'string';
    return {
        runRef: payload.runRef,
        comparisonId: version2 && 'comparisonId' in payload && typeof payload.comparisonId === 'string' ? payload.comparisonId : null,
        fileCount: version2 && 'fileCount' in payload && typeof payload.fileCount === 'number' ? payload.fileCount : null,
        summary: payload.summary,
        overviewMarkdown: version2 ? candidateOverviewMarkdown : payload.summary,
        findings: payload.findings ?? [],
        questions: version2 && 'questions' in payload && Array.isArray(payload.questions) ? payload.questions : EMPTY_QUESTIONS,
        assumptions: version2 && 'assumptions' in payload && Array.isArray(payload.assumptions) ? payload.assumptions : EMPTY_ASSUMPTIONS,
    };
}

export function buildReviewFindingsMessageDisplay(payload: ReviewFindingsV1 | ReviewFindingsV2, options: ReviewFindingsMessageDisplayOptions = {}, preparedEffective?: ReturnType<typeof resolveEffectiveReviewFindings>) {
    const normalized = normalizeReviewFindingsMessagePayload(payload);
    const effective = preparedEffective ?? resolveEffectiveReviewFindings({ runRef: payload.runRef, initialFindings: normalized.findings, messages: options.sessionMessages ?? [] });
    const findings = sortReviewFindingsBySeverity(effective.findings);
    const reviewer = resolveExecutionRunBackendLabel(payload.runRef.backendTarget ?? { kind: 'backend', backendId: payload.runRef.backendId }) ?? payload.runRef.backendId;
    const block = (id: string, text: string): StructuredFindTextBlock => ({ id, text });
    const compact = options.canNavigate === true;
    const visibleFindings = compact ? findings.slice(0, REVIEW_CARD_VISIBLE_FINDINGS) : findings;
    const followUp = resolveReviewFollowUpAvailability(payload.runRef);
    const acceptedFindingsCount = options.acceptedFindingsCount ?? findings.filter((finding) => readReviewFindingDecision(findCommentForFinding(options.reviewComments?.comments ?? [], finding, payload.runRef.runId)?.reviewTriageStatus) === 'accept').length;
    const finishedAt = payload.generatedAtMs > 0 ? formatAsOfTime(payload.generatedAtMs) : null;
    const severitySummary = reviewSeverityCounts(findings).map(({ severity, label }) => block(`structured-review:count:${severity}`, label));
    const findingDisplays = visibleFindings.map((finding) => {
        const prefix = `structured-review-finding:${finding.id}`;
        const location = formatReviewFindingLocation(finding);
        return {
            finding,
            prefix,
            title: block(`${prefix}:title`, finding.title),
            severity: block(`${prefix}:severity`, reviewSeverityLabel(finding.severity)),
            reviewer: block(`${prefix}:reviewer`, reviewer),
            location: location ? block(`${prefix}:location`, location) : null,
            original: effective.originalByFindingId[finding.id] ?? null,
            entries: effective.threadsByFindingId[finding.id] ?? [],
            decisionNote: options.reviewComments?.status === 'loaded' && !findCommentForFinding(options.reviewComments.comments, finding, payload.runRef.runId)
                ? block(`${prefix}:decision-note`, t('runPage.review.notSaved')) : null,
        };
    });
    return {
        compact, findings, findingDisplays, severitySummary,
        summary: block('structured-review:summary', normalized.summary),
        started: normalized.fileCount !== null ? block('structured-review:started', t('reviewWalkthrough.started.transcript', { engineCount: 1, fileCount: normalized.fileCount })) : null,
        finished: block('structured-review:finished', t('reviewWalkthrough.finished.title')),
        meta: block('structured-review:meta', [reviewer, finishedAt].filter(Boolean).map((part) => ` · ${part}`).join('')),
        count: block('structured-review:total', t('runPage.review.findingTotal', { count: findings.length })),
        more: findings.length > REVIEW_CARD_VISIBLE_FINDINGS ? block('structured-review:more', compact
            ? t('reviewWalkthrough.finished.andMore', { count: findings.length - REVIEW_CARD_VISIBLE_FINDINGS })
            : t('runPage.review.moreFindings', { count: findings.length - REVIEW_CARD_VISIBLE_FINDINGS })) : null,
        open: compact ? block('structured-review:open', t('reviewWalkthrough.finished.openFindings')) : null,
        walk: options.canSendMessages && options.canNavigate && options.hasWorkspacePath ? block('structured-review:walk', t('reviewWalkthrough.finished.walkMeThrough')) : null,
        hint: options.canSendMessages && (compact || findings.length > 0) ? block('structured-review:hint', followUp.available
            ? t('reviewWalkthrough.finished.continues')
            : t('reviewWalkthrough.finished.narrates', { count: findings.length })) : null,
        implement: !compact && options.canSendMessages && findings.length > 0 ? block('structured-review:implement', t('runPage.review.implementFixes', { count: acceptedFindingsCount })) : null,
        unavailable: !compact && options.canSendMessages && findings.length > 0 && !followUp.available ? block('structured-review:unavailable', followUp.reason) : null,
        followUp,
    };
}

export function projectReviewFindingsFindText(payload: ReviewFindingsV1 | ReviewFindingsV2, options: ReviewFindingsMessageDisplayOptions = {}): readonly StructuredFindTextBlock[] {
    const display = buildReviewFindingsMessageDisplay(payload, options);
    const blocks: StructuredFindTextBlock[] = display.compact
        ? [...(display.started ? [display.started] : []), display.finished, display.meta, ...(display.findings.length ? [display.count] : [])]
        : [display.summary];
    blocks.push(...display.severitySummary);
    for (const item of display.findingDisplays) {
        blocks.push(item.severity, item.title);
        if (display.compact) blocks.push(item.reviewer);
        else {
            if (item.location) blocks.push(item.location);
            if (item.original) {
                blocks.push({ id: `${item.prefix}:updated`, text: t('runPage.review.updatedAfterQuestion') });
                if (item.original.severity !== item.finding.severity) blocks.push({ id: `${item.prefix}:updated-severity`, text: `${reviewSeverityLabel(item.original.severity)} → ${reviewSeverityLabel(item.finding.severity)}` });
            }
            if (options.canSendMessages) {
                if (item.decisionNote) blocks.push(item.decisionNote);
                if (item.entries.length) {
                    if (display.followUp.available) blocks.push({ id: `${item.prefix}:quote`, text: formatReviewFindingThreadQuote(item.finding) });
                    item.entries.forEach((entry, index) => {
                        const entryPrefix = `${item.prefix}:thread:${entry.threadId}:${entry.generatedAtMs}:${index}`;
                        blocks.push({ id: `${entryPrefix}:request`, text: entry.requestMarkdown, format: display.followUp.available ? 'markdown' : 'plain' },
                            { id: `${entryPrefix}:reviewer`, text: item.reviewer.text },
                            { id: `${entryPrefix}:answer`, text: entry.answerMarkdown, format: display.followUp.available ? 'markdown' : 'plain' });
                        if (display.followUp.available && entry.updatedFinding && entry.previousFinding) blocks.push({ id: `${entryPrefix}:updated`, text: formatReviewFindingThreadUpdate(item.reviewer.text, entry.previousFinding, entry.updatedFinding) });
                    });
                }
            }
        }
    }
    if (!display.compact && display.findings.length) blocks.push(display.count);
    if (!display.compact && display.findings.length && options.canSendMessages && options.reviewComments?.status === 'failed') blocks.push({ id: 'structured-review:decisions-unavailable', text: t('runPage.review.decisionsUnavailable') });
    if (display.unavailable) blocks.push(display.unavailable);
    return blocks;
}
