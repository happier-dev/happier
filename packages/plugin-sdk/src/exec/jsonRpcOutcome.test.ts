import { describe, expect, it } from 'vitest';
import { classifyJsonRpcSubmissionFailure, createJsonRpcApplicationError } from './jsonRpcOutcome.js';

describe('JSON-RPC submission outcomes', () => {
  it('retains only response identity in a definite refusal', () => {
    const error = createJsonRpcApplicationError({ method: 'turn/start', code: -32602,
      message: 'PRIVATE_PROVIDER_DETAIL', data: { privateBody: 'PRIVATE_PROVIDER_DETAIL' } });
    const outcome = classifyJsonRpcSubmissionFailure(error, { method: 'turn/start', effectObserved: false });
    expect(outcome).toEqual({ kind: 'rejected_before_effect', details: {
      providerErrorCode: -32602, method: 'turn/start', messageClass: 'JsonRpcApplicationError',
    } });
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE_PROVIDER_DETAIL');
  });

  it('keeps transport loss, a different method, and observed provider effects unknown', () => {
    const response = createJsonRpcApplicationError({ method: 'turn/start', code: -32000 });
    for (const [error, method, effectObserved] of [
      [Object.assign(new Error('Connection lost'), { code: -32000, method: 'turn/start' }), 'turn/start', false],
      [response, 'turn/steer', false],
      [response, 'turn/start', true],
    ] as const) {
      expect(classifyJsonRpcSubmissionFailure(error, { method, effectObserved }))
        .toEqual({ kind: 'effect_may_have_occurred' });
    }
  });
});
