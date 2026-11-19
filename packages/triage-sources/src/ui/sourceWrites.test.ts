import { describe, expect, it } from 'vitest';
import { projectTriageSourceWriteSettlementV1 } from './sourceWrites.js';

describe('native source write settlement', () => {
  it.each(['outcome_uncertain', 'RPC_OUTCOME_UNKNOWN'])('keeps %s uncertain without effect metadata', (errorCode) => {
    expect(projectTriageSourceWriteSettlementV1({
      ok: false,
      errorCode,
      error: 'The provider acknowledgement was lost',
    })).toEqual({ kind: 'uncertain' });
  });

  it('keeps a definite provider refusal distinct from an uncertain outcome', () => {
    expect(projectTriageSourceWriteSettlementV1({
      ok: false,
      errorCode: 'permission_denied',
      error: 'The provider refused this write',
    })).toEqual({ kind: 'failed', message: 'The provider refused this write' });
  });
});
