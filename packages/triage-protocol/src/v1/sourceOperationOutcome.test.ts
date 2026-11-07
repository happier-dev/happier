import { describe, expect, it } from 'vitest';
import { readTriageSourceOperationOutcomeV1, TriageSourceOperationOutcomeV1Schema } from './index.js';

describe('source operation outcome admission', () => {
    it('admits source-owned uncertainty without interpreting the native envelope or host approval', () => {
        const outcome = { kind: 'uncertain', failure: null, presentation: {
            title: 'Outcome unknown', description: 'Refresh the current entry before another write.', tone: 'warning',
        } };
        expect(readTriageSourceOperationOutcomeV1({ kind: 'provider-specific', outcome })).toEqual(outcome);
        for (const result of [null, { kind: 'applied' }, { approvalRequest: {} }, { outcome: { ...outcome, retry: true } },
            { outcome: { ...outcome, presentation: { ...outcome.presentation, execute: 'again' } } }]) {
            expect(readTriageSourceOperationOutcomeV1(result)).toBeNull();
        }
        expect(TriageSourceOperationOutcomeV1Schema.safeParse({ ...outcome, kind: 'approved' }).success).toBe(false);
    });
});
