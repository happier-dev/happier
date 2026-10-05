import type { ReviewFinding } from '@happier-dev/protocol';

import { t } from '@/text';

/** Most severe first; the order the wire gives is kept within a severity. */
export const REVIEW_SEVERITY_RANK: Readonly<Record<ReviewFinding['severity'], number>> = {
    blocker: 0,
    high: 1,
    medium: 2,
    low: 3,
    nit: 4,
};

/** Blocker and High are the findings that speak (colour, the "1 high" count); the rest stay quiet. */
export function isHighReviewSeverity(severity: ReviewFinding['severity']): boolean {
    return severity === 'blocker' || severity === 'high';
}

/**
 * The colour role of a severity where a finding sits beside code (Walkthrough lab WT5): severity colour
 * appears only on findings and their chips, never on explanation, comments or reviewed marks.
 */
export type ReviewSeverityTone = 'danger' | 'warning' | 'accent' | 'quiet';

export function reviewSeverityTone(severity: ReviewFinding['severity']): ReviewSeverityTone {
    switch (severity) {
        case 'blocker':
        case 'high': return 'danger';
        case 'medium': return 'warning';
        case 'low': return 'accent';
        case 'nit': return 'quiet';
    }
}

export function reviewSeverityLabel(severity: ReviewFinding['severity']): string {
    switch (severity) {
        case 'blocker': return t('runPage.review.severity.blocker');
        case 'high': return t('runPage.review.severity.high');
        case 'medium': return t('runPage.review.severity.medium');
        case 'low': return t('runPage.review.severity.low');
        case 'nit': return t('runPage.review.severity.nit');
    }
}

export function formatReviewFindingLocation(finding: ReviewFinding): string | null {
    if (!finding.filePath) return null;
    if (typeof finding.startLine === 'number' && typeof finding.endLine === 'number' && finding.endLine !== finding.startLine) {
        return `${finding.filePath}:${finding.startLine}-${finding.endLine}`;
    }
    if (typeof finding.startLine === 'number') return `${finding.filePath}:${finding.startLine}`;
    return finding.filePath;
}

export function formatReviewFindingThreadQuote(finding: ReviewFinding): string {
    const location = formatReviewFindingLocation(finding);
    return `${reviewSeverityLabel(finding.severity)} · ${finding.title}${location ? ` · ${location}` : ''}`;
}

export function formatReviewFindingThreadUpdate(reviewerLabel: string, previous: ReviewFinding, updated: ReviewFinding): string {
    return t('runPage.review.reviewerUpdated', { reviewer: reviewerLabel }) + (updated.severity !== previous.severity ? `: ${reviewSeverityLabel(previous.severity)} → ${reviewSeverityLabel(updated.severity)}` : '');
}

export function sortReviewFindingsBySeverity(findings: readonly ReviewFinding[]): ReviewFinding[] {
    return findings
        .map((finding, index) => ({ finding, index }))
        .sort((left, right) => (
            (REVIEW_SEVERITY_RANK[left.finding.severity] ?? 9) - (REVIEW_SEVERITY_RANK[right.finding.severity] ?? 9)
            || left.index - right.index
        ))
        .map(({ finding }) => finding);
}

export function reviewSeverityCounts(findings: readonly ReviewFinding[]) {
    const counts = new Map<ReviewFinding['severity'], number>();
    for (const finding of sortReviewFindingsBySeverity(findings)) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
    return [...counts].map(([severity, count]) => ({ severity, count, label: t('reviewWalkthrough.severityCount', { count, severity: reviewSeverityLabel(severity).toLowerCase() }) }));
}

/**
 * The review's headline counts ("4 findings · 1 high"), derived from the findings themselves; no
 * summarizer writes it.
 */
export function formatReviewFindingsHeadline(findings: readonly ReviewFinding[]): string {
    const high = findings.filter((finding) => isHighReviewSeverity(finding.severity)).length;
    const total = t('runPage.review.findingTotal', { count: findings.length });
    return high > 0 ? `${total} · ${t('runPage.review.highCount', { count: high })}` : total;
}
