import { describe, expect, it } from 'vitest';

import { mapStopReasonToAcpTurnOutcome, type AcpPromptStopReasonProjector } from './completion';

describe('ACP stop-reason projection', () => {
  it.each<readonly [string, AcpPromptStopReasonProjector]>([
    ['throwing', () => { throw new Error('plugin projection failed'); }],
    ['unmapped', () => null],
  ])('preserves the original unknown stop reason with a %s projector', (_kind, projector) => {
    expect(mapStopReasonToAcpTurnOutcome('future_stop', projector)).toEqual({
      kind: 'unknown',
      stopReason: 'future_stop',
    });
  });
});
