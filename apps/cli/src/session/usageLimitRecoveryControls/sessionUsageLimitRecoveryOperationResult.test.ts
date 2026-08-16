import { describe, expect, it } from 'vitest';

import type { SessionUsageLimitRecoveryOperationResultV1 } from '@happier-dev/protocol';

import {
  attachCliSessionUsageLimitRecoveryOperationMetadata,
  resolveExplicitUserPromptRecoveryDecision,
} from './sessionUsageLimitRecoveryOperationResult';

const readyResult: SessionUsageLimitRecoveryOperationResultV1 = {
  ok: true,
  status: 'ready',
  sessionId: 'sess_123',
};

describe('attachCliSessionUsageLimitRecoveryOperationMetadata', () => {
  // RD-REC-17: metadata must survive JSON/structured-clone boundaries — it is part
  // of the typed result contract, not a non-enumerable smuggled property.
  it('attaches metadata as an enumerable typed field that survives serialization', () => {
    const result = attachCliSessionUsageLimitRecoveryOperationMetadata(
      readyResult,
      { usageLimitRecoveryV1: { status: 'waiting' } },
    );
    expect(result.metadata).toEqual({ usageLimitRecoveryV1: { status: 'waiting' } });
    expect(Object.keys(result)).toContain('metadata');
    expect(JSON.parse(JSON.stringify(result)).metadata).toEqual({
      usageLimitRecoveryV1: { status: 'waiting' },
    });
  });

  it('returns the result unchanged when there is no metadata', () => {
    const result = attachCliSessionUsageLimitRecoveryOperationMetadata(readyResult, null);
    expect(result).toEqual({ ok: true, status: 'ready', sessionId: 'sess_123' });
    expect('metadata' in result).toBe(false);
  });
});

describe('resolveExplicitUserPromptRecoveryDecision', () => {
  it('treats a runtime that does not exist yet as ready only when no recovery wait is stored', () => {
    const result = {
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.usageLimit.checkNow',
    };

    expect(resolveExplicitUserPromptRecoveryDecision({
      sessionId: 'fresh-session',
      result,
      hasBlockingRecoveryEvidence: false,
    })).toEqual({ status: 'ready' });
    expect(resolveExplicitUserPromptRecoveryDecision({
      sessionId: 'recovering-session',
      result,
      hasBlockingRecoveryEvidence: true,
    })).toEqual({
      status: 'action_required',
      errorCode: 'unsupported_session_runtime_method',
    });
  });
});
