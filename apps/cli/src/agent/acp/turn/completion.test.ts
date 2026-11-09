import { describe, expect, it } from 'vitest';

import { mapStopReasonToAcpTurnOutcome } from './completion';

describe('ACP stop-reason projection', () => {
  it.each([
    ['throwing', () => { throw new Error('plugin projection failed'); }],
    ['unmapped', () => null],
  ] as const)('preserves the original unknown stop reason with a %s projector', (_kind, projector) => {
    expect(mapStopReasonToAcpTurnOutcome('future_stop', projector)).toEqual({
      kind: 'unknown',
      stopReason: 'future_stop',
    });
  });
});
