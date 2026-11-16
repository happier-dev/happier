import { describe, expect, it } from 'vitest';
import { RpcError } from '../../rpc/errors.js';
import { createActionExecuteFailureError } from '../actionExecutionResult.js';
import { normalizeActionExecutorThrownError } from './resultProjection.js';

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
