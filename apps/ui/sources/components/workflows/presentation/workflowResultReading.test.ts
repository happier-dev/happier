import { describe, expect, it } from 'vitest';

import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { readWorkflowResultRows, readWorkflowValueText } from './workflowResultReading';

describe('authored Workflow result JSON', () => {
    it('reads a persisted Review response with dates and without internal identities', () => {
        const startedAt = 1795166538066;
        const finishedAt = 1795166746168;
        const value = {
            review: { projectSourceId: null, workflowId: null, subjectKind: 'comparison', sourceKind: 'direct',
                state: 'completed', currentRoundOrdinal: 1, startedAt, finishedAt, reviewId: 'review-id',
                createdAt: startedAt, updatedAt: finishedAt, counts: { total: 2, needsDecision: 2 } },
            human: { reviewId: 'review-id', roundOrdinal: 1, requests: [], verdicts: [],
                needsYou: { reviewId: 'review-id', roundOrdinal: 1, reason: 'review_needs_you',
                    needsYou: true, requestedVerdict: true, pendingDecisions: true, canSubmitVerdict: true } },
        };
        const rows = readWorkflowResultRows(value);
        const text = rows?.map(row => row.text).join(' ');
        expect(text).toContain(t('reviewWalkthrough.collection.stateCompleted'));
        expect(text).toContain(t('reviewWalkthrough.detail.findingsCount', { count: 2 }));
        expect(text).toContain(formatWithCachedDateTimeFormatter(finishedAt, getPreferredLanguage(), {
            dateStyle: 'medium', timeStyle: 'short',
        }));
        expect(text).not.toContain(String(startedAt));
        expect(text).not.toContain(String(finishedAt));
        expect(text).not.toContain('review-id');
    });

    it('retains authored fields that happen to resemble loop bookkeeping', () => {
        const authored = { index: 7, status: 'needs_review', results: { answer: 'ok' }, owner: 'Alice' };
        const row = readWorkflowResultRows([authored])?.[0];
        for (const value of ['7', 'needs_review', 'ok', 'Alice']) {
            expect(row?.text).toContain(value);
            expect(readWorkflowValueText({ nested: authored })).toContain(value);
        }
    });

    it('reads a loop or parallel container by its items only when its invocation says it is one', () => {
        const loop = readWorkflowResultRows([{ index: 0, status: 'completed', results: { check: 'passed' } }], undefined, 'loop');
        expect(loop?.[0]).toMatchObject({ label: t('workflows.run.resultItem', { n: 1 }), text: 'passed' });
        const parallel = readWorkflowResultRows([{ branchId: 'docs', status: 'completed', results: { write: 'done' } }], undefined, 'parallel');
        expect(parallel?.[0]?.text).toBe('done');
        expect(parallel?.[0]?.label).not.toContain('resultItem');
        // Nested values keep every field, even inside a container's entry.
        const nested = readWorkflowResultRows([{ index: 0, status: 'completed', results: { check: { index: 2, status: 'x', results: { a: 1 } } } }], undefined, 'loop');
        expect(nested?.[0]?.text).toContain('x');
    });
});
