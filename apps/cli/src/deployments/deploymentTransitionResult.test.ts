import { describe, expect, it } from 'vitest';
import { projectDeploymentTransitionOutcomeUnknownForHost } from './deploymentTransitionResult';

describe('issued deployment transition diagnostics', () => {
    it.each([false, true])('retains the typed Home outage without claiming a settled effect (thrown: %s)', thrown => {
        const response = { status: 503, data: { error: 'database_transaction_conflict_exhausted',
            message: 'PRIVATE_MESSAGE', token: 'PRIVATE_TOKEN' } };
        const error = thrown ? Object.assign(new Error('PRIVATE_EXCEPTION'), { code: 'ERR_BAD_RESPONSE', response }) : { response };
        const result = projectDeploymentTransitionOutcomeUnknownForHost(error);
        expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown', failureCause: {
            phase: 'deployment.transition', errorCode: 'database_transaction_conflict_exhausted', httpStatus: 503,
        } });
        expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
    });

    it('keeps an unrecognized response private', () => {
        const result = projectDeploymentTransitionOutcomeUnknownForHost({ response: {
            status: 503, data: { error: 'PRIVATE_ERROR', message: 'PRIVATE_MESSAGE' },
        } });
        expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown',
            failureCause: { phase: 'deployment.transition', errorCode: null, httpStatus: 503 } });
        expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
    });
});
