import { describe, expect, it } from 'vitest';

import { SessionIndexedIdentifierMaxLengthV1, SidechainIdSchema } from './idsV1.js';

describe('SidechainIdSchema', () => {
  it('shares the indexed session identifier boundary', () => {
    expect(SidechainIdSchema.safeParse('s'.repeat(SessionIndexedIdentifierMaxLengthV1)).success).toBe(true);
    expect(SidechainIdSchema.safeParse('s'.repeat(SessionIndexedIdentifierMaxLengthV1 + 1)).success).toBe(false);
  });
});
