import { expect, it } from 'vitest';
import { readDeploymentChildResult } from './deploymentChild';
import { readFiniteActionOutcome, finiteActionExitCode } from '@/cli/actions/finiteOutcome';

const pending = { ok: true, environmentId: 'environment', revision: 3,
    kind: 'pending', actionOperationId: 'operation' };

it('refuses pending storage acceptance as a native child receipt while preserving real child receipts and failures', () => {
    expect(readDeploymentChildResult(pending)).toEqual({ ok: false,
        errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' });
    for (const state of ['queued', 'running', 'succeeded']) {
        const receipt = { ok: true, environmentId: 'environment', revision: 3,
            deploymentId: 'receipt', deploymentRevision: 2, state };
        expect(readDeploymentChildResult(receipt)).toEqual(receipt);
    }
    const failure = { ok: false, error: 'deployment_access_denied' };
    expect(readDeploymentChildResult(failure)).toEqual({ ...failure, errorCode: failure.error, details: failure });
    const quota = { ok: false, error: 'quota_exceeded', budget: 'document', limitBytes: 1, usedBytes: 2 };
    expect(readDeploymentChildResult(quota)).toEqual({ ok: false, error: 'quota_exceeded',
        errorCode: 'quota_exceeded', details: quota });
    const projected = readDeploymentChildResult(quota);
    expect(readDeploymentChildResult(projected)).toEqual(projected);
});

it('keeps pending admission out of finite CLI success without inventing a receipt', () => {
    try {
        readFiniteActionOutcome({ actionId: 'deployments.deploy', input: {}, result: pending });
        throw new Error('Pending cannot be a finite success');
    } catch (error) {
        expect(error).toMatchObject({ code: 'outcome_unknown', details: pending });
        expect(finiteActionExitCode('outcome_unknown')).toBe(5);
    }
});
