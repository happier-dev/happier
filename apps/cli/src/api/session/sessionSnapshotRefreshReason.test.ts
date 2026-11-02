import { describe, expect, it } from 'vitest';

import { resolveSessionSnapshotRequestPurpose } from './sessionSnapshotRefreshReason';

describe('Session detail request attribution', () => {
  it.each([
    'requester-binding',
  ] as const)('names the %s caller without falling back to a proof label', reason => {
    expect(resolveSessionSnapshotRequestPurpose(reason)).toBe(`session-detail:${reason}`);
  });
});
