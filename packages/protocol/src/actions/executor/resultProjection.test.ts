import { describe, expect, it } from 'vitest';
import { RpcError } from '../../rpc/errors.js';
import { normalizeActionExecutorThrownError } from './resultProjection.js';

describe('Action thrown-error classification', () => {
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
