import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import { readWorkflowResultRows, readWorkflowValueText } from './workflowResultReading';

describe('authored Workflow result JSON', () => {
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
