import { describe, expect, it } from 'vitest';
import { normalizeActionExecutorThrownError } from '../actions/executor/resultProjection.js';
import { ActionOperationFailureV1Schema } from '../actions/operations/v1.js';
import { readGuestCliFailureOutput } from './commandFailure.js';

describe('released guest auth stderr', () => {
  // cli-v0.2.20: auth.ts handleAuthCliCommand prints fail(error.message);
  // output/presentation.ts emits "x <message>" without terminal color.
  it.each([
    { stderr: 'x Request failed with status code 403\n', facts: { guestCliCode: 'ERR_BAD_REQUEST', guestAuthCategory: 'http_error', guestHttpStatus: 403 } },
    { stderr: 'x Request failed with status code 503\n', facts: { guestCliCode: 'ERR_BAD_RESPONSE', guestAuthCategory: 'http_error', guestHttpStatus: 503 } },
    { stderr: 'x connect ECONNREFUSED 127.0.0.1:3033\n', facts: { guestCliCode: 'ECONNREFUSED', guestAuthCategory: 'unknown' } },
    { stderr: 'x connect ECONNREFUSED ::1:3033\n', facts: { guestCliCode: 'ECONNREFUSED', guestAuthCategory: 'unknown' } },
    { stderr: 'private-token x Request failed with status code 403\n', facts: null },
    { stderr: 'x Request failed with status code 403\nprivate-token', facts: null },
    { stderr: 'x private-token\n', facts: null },
  ])('projects only a complete known released failure: $stderr', ({ stderr, facts }) => {
    expect(readGuestCliFailureOutput('', stderr)).toEqual(facts);
  });
});

describe('guest enrollment diagnostics at Action settlement', () => {
  it('retains the unavailable guest payload code in the managed operation failure', () => {
    const error = Object.assign(new Error('The local CLI payload has no executable for linux-x64.'), {
      name: 'SystemTaskExecutionError', code: 'guest_payload_missing',
    });
    const failure = normalizeActionExecutorThrownError(error, 'machines.managed.acquire');
    expect(ActionOperationFailureV1Schema.parse(failure)).toMatchObject({
      errorCode: 'guest_payload_missing',
      failureCause: { phase: 'machines.managed.acquire', errorCode: 'guest_payload_missing' },
    });
  });

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
    expect(failure).toMatchObject({
      errorCode: 'remote_command_failed',
      error: valid ? message : 'Remote command failed.',
      failureCause: { errorCode: 'remote_command_failed' },
    });
    const json = JSON.stringify(failure);
    const wire: unknown = JSON.parse(json);
    expect(ActionOperationFailureV1Schema.parse(wire)).toEqual(wire);
    expect(json).not.toContain('private_token');
  });
});
