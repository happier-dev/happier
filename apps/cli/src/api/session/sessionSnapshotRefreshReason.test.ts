import { describe, expect, it } from 'vitest';

import { resolveSessionSnapshotRequestPurpose } from './sessionSnapshotRefreshReason';

describe('Session detail request attribution', () => {
  it('does not classify an omitted caller reason as a legacy compatibility proof', () => {
    // @ts-expect-error A detail caller must supply its reason, not undefined.
    const purpose = resolveSessionSnapshotRequestPurpose(undefined);
    expect(purpose).toBeUndefined();
  });

  it.each([
    'follow-occurrence',
    'follow-source-hydration',
    'requester-binding',
    'memory-change',
    'close-end-proof',
    'session-query',
    'session-control',
    'session-replay',
    'session-action',
    'session-notification',
    'session-content',
    'usage-query',
  ] as const)('names the %s caller without falling back to a proof label', reason => {
    expect(resolveSessionSnapshotRequestPurpose(reason)).toBe(`session-detail:${reason}`);
  });
});
