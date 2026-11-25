import { describe, expect, it } from 'vitest';
import { projectTriageSourceWriteSettlementV1 } from './sourceWrites.js';

describe('native source write settlement', () => {
  it.each(['outcome_uncertain', 'RPC_OUTCOME_UNKNOWN'])('keeps %s uncertain without effect metadata', (errorCode) => {
    expect(projectTriageSourceWriteSettlementV1({
      ok: false,
      errorCode,
      error: 'The provider acknowledgement was lost',
    })).toEqual({ kind: 'uncertain', transportFailure: { code: errorCode } });
  });

  it('keeps a definite provider refusal distinct from an uncertain outcome', () => {
    expect(projectTriageSourceWriteSettlementV1({
      ok: false,
      errorCode: 'permission_denied',
      error: 'The provider refused this write',
      requestId: 'write-refusal-request',
    })).toEqual({
      kind: 'failed', message: 'The provider refused this write',
      transportFailure: { code: 'permission_denied', requestId: 'write-refusal-request' },
    });
  });

  it('retains the same transport evidence from an assignment hook with a lost acknowledgement', () => {
    expect(projectTriageSourceWriteSettlementV1({
      status: 'outcomeUnknown', code: 'timeout', message: 'The acknowledgement did not arrive',
      requestId: 'assignment-request',
    })).toEqual({ kind: 'uncertain', transportFailure: { code: 'timeout', requestId: 'assignment-request' } });
  });
});
