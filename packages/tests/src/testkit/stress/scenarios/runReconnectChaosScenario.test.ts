import { describe, expect, it } from 'vitest';

import * as reconnectChaos from './runReconnectChaosScenario';

const assertReconnectChaosTranscriptConvergence =
  reconnectChaos.assertReconnectChaosTranscriptConvergence as
    | ((params: {
        transcript: readonly { seq: number; localId: string | null }[];
        expectedSeqs: readonly number[];
        expectedLocalIds: readonly string[];
      }) => void)
    | undefined;

describe('assertReconnectChaosTranscriptConvergence', () => {
  it('fails when an acknowledged sequence never appears in the transcript', () => {
    expect(assertReconnectChaosTranscriptConvergence).toBeTypeOf('function');
    expect(() =>
      assertReconnectChaosTranscriptConvergence?.({
        transcript: [
          { seq: 1, localId: 'msg-1' },
          { seq: 3, localId: 'msg-3' },
        ],
        expectedSeqs: [1, 2, 3],
        expectedLocalIds: ['msg-1', 'msg-3'],
      }),
    ).toThrow('Missing acknowledged transcript sequence 2 after reconnect chaos');
  });

  it('fails when an acknowledged localId never appears in the transcript', () => {
    expect(assertReconnectChaosTranscriptConvergence).toBeTypeOf('function');
    expect(() =>
      assertReconnectChaosTranscriptConvergence?.({
        transcript: [
          { seq: 1, localId: 'msg-1' },
          { seq: 2, localId: null },
          { seq: 3, localId: 'msg-3' },
        ],
        expectedSeqs: [1, 2, 3],
        expectedLocalIds: ['msg-1', 'msg-2', 'msg-3'],
      }),
    ).toThrow('Missing acknowledged localId msg-2 after reconnect chaos');
  });

  it('passes when every acknowledged seq and localId converges into the transcript', () => {
    expect(assertReconnectChaosTranscriptConvergence).toBeTypeOf('function');
    expect(() =>
      assertReconnectChaosTranscriptConvergence?.({
        transcript: [
          { seq: 1, localId: 'msg-1' },
          { seq: 2, localId: 'msg-2' },
          { seq: 3, localId: 'msg-3' },
        ],
        expectedSeqs: [1, 2, 3],
        expectedLocalIds: ['msg-1', 'msg-2', 'msg-3'],
      }),
    ).not.toThrow();
  });
});
