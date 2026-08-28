import { describe, expect, it } from 'vitest';

import { isSpentTriageLinkedSessionCursorV1 } from './useTriageEntryDetail.js';

describe('the mounted linked-Session cursor walk', () => {
  it('settles a longer cursor cycle rather than walking A to B to A forever', () => {
    const spent = new Set(['cursor-a', 'cursor-b']);

    expect(isSpentTriageLinkedSessionCursorV1(spent, 'cursor-a')).toBe(true);
    expect(isSpentTriageLinkedSessionCursorV1(spent, 'cursor-c')).toBe(false);
    expect(isSpentTriageLinkedSessionCursorV1(spent, undefined)).toBe(false);
  });
});
