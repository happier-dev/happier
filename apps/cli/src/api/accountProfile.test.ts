import axios from '@/api/client/credentialAxios';
import { afterEach, expect, it, vi } from 'vitest';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions';
import { normalizeCliActionThrownError } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { fetchAccountProfile } from './accountProfile';

afterEach(() => vi.restoreAllMocks());

it('retains a signed profile purpose refusal through the public Action failure projection', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 401,
        data: { error: 'invalid_token', authorizationRefusal: 'verification_purpose' } });
    let refusal: unknown;
    try {
        await fetchAccountProfile({ token: 'never-record-bearer', authorizeRequest: () => ({
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'never-record-proof',
        }) });
    } catch (error) { refusal = error; }
    const result = normalizeCliActionThrownError(refusal);
    expect(result.failure).toMatchObject({ errorCode: 'action_forbidden', details: {
        requiredFact: 'verification_purpose', remedy: expect.any(String),
    }, failureCause: { phase: 'home.authorization.verification_purpose', httpStatus: 401 } });
    expect(JSON.stringify(result)).not.toMatch(/never-record/u);
});

it.each([401, 403])('keeps ordinary bearer profile authentication recovery (%s)', async status => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status,
        data: { error: 'invalid_token', authorizationRefusal: 'verification_purpose' } });
    await expect(fetchAccountProfile({ token: 'never-record-bearer' }))
        .rejects.toMatchObject({ code: 'not_authenticated', response: { status } });
});
