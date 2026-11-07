import type { TriageEntryLocatorV1, TriageEntryRefV1, TriagePullRequestStatusV1, TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';
import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import { projectTriageEntryDisplay } from '../../ui/window/entryDisplay.js';
import { readTriageSelectedObservationV1 } from '../../ui/window/selectedObservation.js';
import type { TriageEntryDetailInputSourceV1 } from '../../ui/detail/useTriageEntryDetail.js';

export type TriageSessionLinkedEntrySummaryV1 = Readonly<{
    kind: TriageSourceWorkflowSubjectV1;
    number: string | null;
    repository: string | null;
    title: string;
    lifecycle: 'open' | 'draft' | 'merged' | 'closed' | 'done' | 'notPlanned' | 'suppressed' | 'unknown';
    stateLabel: string;
    comments: number | null;
    author: Readonly<{ name: string; avatarUrl: string | null }> | null;
    updatedAtMs: number | null;
    webUrl: string | null;
    checks: Readonly<{ passed: number; failed: number; pending: number; total: number; firstFailingName: string | null }> | null;
    review: Readonly<{ decision: 'approved' | 'changesRequested' | 'reviewRequired' }> | null;
    entryRef: TriageEntryRefV1;
    sourceInstanceId: string | null;
    /** The existing durable detail owner consumes this exact selected observation. */
    detailSource: TriageEntryDetailInputSourceV1 | null;
    /** Passed whole to the canonical link writer; display text is never routing. */
    locator: TriageEntryLocatorV1;
    scopeLabel: string;
}>;

/** The mounted reader retains only its current admitted window's membership. */
export type TriageSessionLinkedEntrySummaryBaselineV1 = Map<string, Readonly<{
    row: TriageListRowV1;
    subject: TriageSourceWorkflowSubjectV1 | null;
    summary: TriageSessionLinkedEntrySummaryV1 | null;
}>>;

export function projectTriageSessionLinkedEntrySummaries(
    rows: readonly TriageListRowV1[],
    workflowSubject: (ref: TriageEntryRefV1) => TriageSourceWorkflowSubjectV1 | null,
    baseline?: TriageSessionLinkedEntrySummaryBaselineV1,
): ReadonlyMap<string, TriageSessionLinkedEntrySummaryV1 | null> {
    const summaries = new Map<string, TriageSessionLinkedEntrySummaryV1 | null>();
    for (const row of rows) {
        const key = triageEntryRowKey(row.entryRef);
        const subject = workflowSubject(row.entryRef);
        const retained = baseline?.get(key);
        const summary = retained?.row === row && retained.subject === subject
            ? retained.summary : projectTriageSessionLinkedEntrySummary(row, subject);
        summaries.set(key, summary);
        if (retained === undefined || retained.summary !== summary || retained.row !== row || retained.subject !== subject) {
            baseline?.set(key, { row, subject, summary });
        }
    }
    if (baseline !== undefined) {
        for (const key of baseline.keys()) if (!summaries.has(key)) baseline.delete(key);
    }
    return summaries;
}

export function projectTriageSessionLinkedEntrySummary(
    row: TriageListRowV1,
    workflowSubject: TriageSourceWorkflowSubjectV1 | null,
): TriageSessionLinkedEntrySummaryV1 | null {
    const content = row.content;
    if (content === null || workflowSubject === null) return null;
    const display = projectTriageEntryDisplay(row);
    const snapshot = content.outcome.snapshot;
    const facts = snapshot.facts;
    const fact = (id: string) => facts.find((candidate) => candidate.id === id)?.value;
    const number = fact('github/number');
    const comments = fact('github/comments');
    const author = fact('github/author');
    const selected = readTriageSelectedObservationV1(row);
    const kind = workflowSubject;
    const label = display.lifecycleLabel ?? '';
    const lifecycle = kind === 'pullRequest' && label === 'Draft' ? 'draft'
        : kind === 'pullRequest' && label === 'Merged' ? 'merged'
        : kind === 'issue' && snapshot.state.completionReason === 'canceled' ? 'notPlanned'
        : snapshot.state.presentation === 'resolved' ? (kind === 'pullRequest' ? 'merged' : 'done')
        : snapshot.state.presentation === 'closed' ? 'closed'
        : snapshot.state.presentation === 'suppressed' ? 'suppressed'
        : snapshot.state.presentation === 'active' ? 'open' : 'unknown';
    const review = fact('github/review-decision');
    const decision: NonNullable<TriageSessionLinkedEntrySummaryV1['review']>['decision'] | null = kind !== 'pullRequest' || review?.kind !== 'status' ? null
        : review.value === 'Approved' ? 'approved'
        : review.value === 'Changes requested' ? 'changesRequested'
        : review.value === 'Review required' ? 'reviewRequired' : null;
    return Object.freeze<TriageSessionLinkedEntrySummaryV1>({
        kind, number: number?.kind === 'text' ? number.value.replace(/^#/u, '') : null,
        repository: snapshot.scopeLabel.split('/').at(-1) ?? null,
        title: display.title, lifecycle, stateLabel: label,
        comments: comments?.kind === 'number' ? comments.value : null,
        author: author?.kind === 'actor' ? { name: author.value, avatarUrl: null } : null,
        updatedAtMs: display.activityAtMs, webUrl: content.outcome.locator.webUrl ?? null,
        checks: null, review: decision === null ? null : { decision },
        entryRef: row.entryRef, sourceInstanceId: selected?.sourceInstanceId ?? null,
        detailSource: selected === null ? null : {
            selection: { entryRef: row.entryRef, sourceInstanceId: selected.sourceInstanceId },
            observation: selected.observation,
        },
        locator: content.outcome.locator, scopeLabel: snapshot.scopeLabel,
    });
}

/** Fill the incumbent summary slots without turning unknown totals into zero or omission into failure. */
export function applyTriageSessionPullRequestStatus(
    entry: TriageSessionLinkedEntrySummaryV1,
    status: TriagePullRequestStatusV1,
): TriageSessionLinkedEntrySummaryV1 {
    if (entry.kind !== 'pullRequest') return entry;
    const checks = status.checks;
    const decision = status.review?.decision;
    return Object.freeze({
        ...entry,
        checks: checks !== null && checks.passed !== null && checks.failed !== null && checks.pending !== null && checks.total !== null
            ? { passed: checks.passed, failed: checks.failed, pending: checks.pending, total: checks.total,
                firstFailingName: checks.rows.find((row) => row.state === 'failed')?.name ?? null }
            : null,
        review: status.review === null ? entry.review : decision === null || decision === undefined ? null : { decision },
    });
}
