import { describe, expect, it } from 'vitest';

import {
  PendingLocalIdSchema,
  isPendingLocalId,
  readPendingLocalId,
} from './pendingLocalId.js';

describe('Pending localId identity', () => {
  it.each([undefined, null, 0, '', ' ', '\t\n', '\u00a0'])('rejects blank or non-string input %#', (value) => {
    expect(isPendingLocalId(value)).toBe(false);
    expect(readPendingLocalId(value)).toBeNull();
    expect(PendingLocalIdSchema.safeParse(value).success).toBe(false);
  });

  it.each(['opaque', ' opaque ', '\topaque\n', 'a/b:c'])('preserves every code unit of accepted input %#', (value) => {
    expect(isPendingLocalId(value)).toBe(true);
    expect(readPendingLocalId(value)).toBe(value);
    expect(PendingLocalIdSchema.parse(value)).toBe(value);
  });
});
