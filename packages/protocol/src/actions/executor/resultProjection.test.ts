import { describe, expect, it } from 'vitest';
import { RpcError } from '../../rpc/errors.js';
import { createActionExecuteFailureError } from '../actionExecutionResult.js';
import { completeSpawnActionResult, normalizeActionExecutorThrownError, settleActionOutput } from './resultProjection.js';

describe('Session spawn Action settlement', () => {
  it.each([undefined, false, true])('settles a typed spawn refusal as failure and retains producer effect evidence (%s)', effectAttempted => {
    const failureCause = { phase: 'dispatch.requester_authentication', errorClass: 'RpcError' as const,
      errorCode: 'admission_unavailable', httpStatus: null };
    const refusal = { type: 'error' as const, code: 'spawn_failed' as const, retryable: true,
      launchError: { kind: 'launch_error' as const, code: 'admission_unavailable', message: 'admission_unavailable' },
      ...(effectAttempted === undefined ? {} : { failureCause, effectAttempted }) };
    const settled = settleActionOutput('session.spawn_new', completeSpawnActionResult(refusal));
    expect(settled).toMatchObject({ ok: false, errorCode: 'spawn_failed',
      details: refusal });
    if (settled.ok) throw new Error('Spawn refusal was reported as successful execution');
    expect(settled.error).toContain('admission_unavailable');
    expect(settled.effectAttempted).toBe(effectAttempted);
    expect(settled.failureCause).toEqual(effectAttempted === undefined ? undefined : failureCause);
  });

  it('keeps an accepted pending spawn successful without declaring effects', () => {
    expect(completeSpawnActionResult({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' }))
      .toEqual({ ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' } });
  });
});

describe('Action thrown-error classification', () => {
  it.each([true, false, undefined])('retains the complete typed child behind a code wrapper (effect %s)', effectAttempted => {
    const child = { ok: false as const, errorCode: 'database_transaction_timeout', error: 'database_transaction_timeout',
      requestId: 'child-request', failureCause: { phase: 'home.database.transaction', errorClass: 'HttpStatusError' as const,
        errorCode: 'database_transaction_timeout', httpStatus: 503 },
      ...(effectAttempted === undefined ? {} : { effectAttempted }) };
    const wrapper = Object.assign(createActionExecuteFailureError({ ok: false, errorCode: child.errorCode, error: child.errorCode }), { cause: child });
    expect(normalizeActionExecutorThrownError(wrapper)).toMatchObject(child);
    expect(normalizeActionExecutorThrownError(wrapper).effectAttempted).toBe(effectAttempted);
    const authored = Object.assign(createActionExecuteFailureError({ ...child, requestId: 'outer-request' }), { cause: child });
    expect(normalizeActionExecutorThrownError(authored).requestId).toBe('outer-request');
  });
  it.each(['code', 'errorCode'])('does not promote an ordinary Error %s into a domain refusal', field => {
    const failure = normalizeActionExecutorThrownError(Object.assign(new Error('Transport failed'), {
      [field]: 'role_read_only',
    }));
    expect(failure).toMatchObject({ errorCode: 'action_failed', error: 'Transport failed',
      failureCause: { errorClass: 'Error', errorCode: 'role_read_only' } });
  });

  it('preserves the same domain code when a typed RPC refusal carries it', () => {
    expect(normalizeActionExecutorThrownError(new RpcError('Role cannot be changed', 'role_read_only')))
      .toMatchObject({ errorCode: 'role_read_only', error: 'Role cannot be changed',
        failureCause: { errorClass: 'RpcError', errorCode: 'role_read_only' } });
  });
});
