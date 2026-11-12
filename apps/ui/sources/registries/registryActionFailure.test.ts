import { expect, it } from 'vitest';
import { RegistryActionFailure } from './registryActionFailure';

it('retains the failed next-page Action and registry recovery status for presentation', () => {
    const result = { ok: false, errorCode: 'registry_auth_failed', error: 'Reconnect the catalog', requestId: 'registry-refusal',
        effectAttempted: false, failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: null, httpStatus: null }, details: { registryStatus: { state: 'auth_failed' } } } as const;
    const failure = new RegistryActionFailure(result);
    expect(failure.result).toBe(result);
    expect(failure.status).toMatchObject({ state: 'auth_failed' });
    expect(failure.message).toContain(result.error);
    expect(failure.presentation.technicalDetails)
        .toEqual(expect.arrayContaining([expect.objectContaining({ key: 'requestId', value: result.requestId }), expect.objectContaining({ key: 'causePhase', value: 'execution_authorization' }), expect.objectContaining({ key: 'effectAttempted', value: 'false' })]));
});
