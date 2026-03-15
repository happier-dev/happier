import { describe, expect, it } from 'vitest';

import { resolveRunningExecutionRunsFromListResult } from './useSessionRunningExecutionRuns';

describe('resolveRunningExecutionRunsFromListResult', () => {
    it('returns only execution runs with status=running', () => {
        const out = resolveRunningExecutionRunsFromListResult({
            runs: [
                { runId: 'run_1', status: 'running' } as any,
                { runId: 'run_2', status: 'failed' } as any,
                { runId: 'run_3', status: 'completed' } as any,
            ],
        } as any);

        expect(out.map((run) => run.runId)).toEqual(['run_1']);
    });

    it('returns empty array for ok:false responses', () => {
        const out = resolveRunningExecutionRunsFromListResult({
            ok: false,
            error: 'RPC failed',
        } as any);
        expect(out).toEqual([]);
    });
});
