import { describe, expect, it } from 'vitest';
import { normalizeActionExecutorThrownError } from '../actions/executor/resultProjection.js';
import { ActionOperationFailureV1Schema } from '../actions/operations/v1.js';

describe('guest enrollment diagnostics at Action settlement', () => {
  it.each([
    { suffix: 'category http_error; HTTP 503; attemptedCarrier https; carrierReason unavailable', valid: true },
    { suffix: 'category tls_error; attemptedCarrier https; carrierReason unavailable', valid: true },
    { suffix: 'category network_error; attemptedCarrier https; carrierReason unavailable', valid: true },
    { suffix: 'category auth_error; attemptedCarrier private_token; carrierReason unavailable', valid: false },
    { suffix: 'category private_token; HTTP 503', valid: false },
    { suffix: 'category http_error; HTTP 999', valid: false },
  ])('retains only closed guest facts ($suffix)', ({ suffix, valid }) => {
    const message = `Remote Home enrollment failed during auth request (exit 1; code AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE; ${suffix}).`;
    const failure = normalizeActionExecutorThrownError(Object.assign(new Error(message), { code: 'remote_command_failed' }));
    expect(failure).toMatchObject({ errorCode: 'remote_command_failed', error: valid ? message : 'Remote command failed.' });
    expect(ActionOperationFailureV1Schema.parse(failure)).toEqual(failure);
    expect(JSON.stringify(failure)).not.toContain('private_token');
  });
});
