import { describe, expect, it } from 'vitest';

import {
  SESSION_RPC_METHODS,
  isDelegatedSessionApprovalRpcMethod,
} from './rpc.js';
import {
  PUBLIC_RPC_HANDLER_ERROR_CODES,
  PublicRpcHandlerError,
  toSocketRpcTargetFailureV1,
} from './rpcErrors.js';

describe('structured-question RPC contract', () => {
  it('classifies only legacy and v1 approval methods as delegated approvals', () => {
    expect(isDelegatedSessionApprovalRpcMethod(SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_LEGACY)).toBe(true);
    expect(isDelegatedSessionApprovalRpcMethod(SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1)).toBe(true);
    expect(isDelegatedSessionApprovalRpcMethod(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)).toBe(false);
    expect(isDelegatedSessionApprovalRpcMethod('permission.extra')).toBe(false);
  });

  it('exports only allowlisted public failures without the private message or stack', () => {
    const error = new PublicRpcHandlerError(
      PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_AMBIGUOUS,
      'private payload A, B, C',
    );
    const failure = toSocketRpcTargetFailureV1(error);

    expect(failure).toEqual({
      type: 'socket-rpc-target-failure-v1',
      errorCode: 'STRUCTURED_QUESTION_LEGACY_AMBIGUOUS',
      error: 'This answer could not be handled safely. Update or reconnect Happier, then try again.',
    });
    expect(JSON.stringify(failure)).not.toContain('A, B, C');
    expect(JSON.stringify(failure)).not.toContain('stack');
  });
});
