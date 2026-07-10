import { describe, expect, it } from 'vitest';

import {
  buildSessionRollbackRangesV1,
  readSessionRollbackRangesV1FromMetadata,
  SessionRollbackRangesV1Schema,
} from './sessionRollbackRangesV1.js';

describe('sessionRollbackRangesV1', () => {
  it('parses latest-turn rollback transcript ranges from metadata', () => {
    const built = buildSessionRollbackRangesV1({
      updatedAt: 123,
      ranges: [
        {
          target: { type: 'latest_turn' },
          startSeqInclusive: 7,
          endSeqInclusive: 11,
          rolledBackAt: 122,
        },
      ],
    });

    const parsed = SessionRollbackRangesV1Schema.parse({ ...built, extra: 'ok' });
    expect(parsed).toMatchObject({
      v: 1,
      updatedAt: 123,
      ranges: [
        {
          target: { type: 'latest_turn' },
          startSeqInclusive: 7,
          endSeqInclusive: 11,
          rolledBackAt: 122,
        },
      ],
      extra: 'ok',
    });
  });

  it('reads rollback ranges from session metadata safely', () => {
    expect(
      readSessionRollbackRangesV1FromMetadata({
        sessionRollbackRangesV1: {
          v: 1,
          updatedAt: 123,
          ranges: [
            {
              target: { type: 'latest_turn' },
              startSeqInclusive: 7,
              endSeqInclusive: 11,
              rolledBackAt: 122,
            },
          ],
        },
      }),
    ).toMatchObject({
      ranges: [expect.objectContaining({ startSeqInclusive: 7, endSeqInclusive: 11 })],
    });
    expect(readSessionRollbackRangesV1FromMetadata(null)).toBeNull();
    expect(readSessionRollbackRangesV1FromMetadata({ sessionRollbackRangesV1: { v: 1, ranges: [] } })).toBeNull();
  });
});
