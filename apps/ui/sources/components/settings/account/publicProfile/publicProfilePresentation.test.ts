import { describe, expect, it } from 'vitest';
import type { PublicProfileSnapshotV1 } from '@happier-dev/protocol/account/publicProfile';
import type { PublicProfileContextV1 } from '@happier-dev/protocol/account/publicProfilePublication';

import { formatUsageCalendarPeriod } from '@/sync/domains/usage/usageCalendarPresentation';
import { publicProfilePageLabels } from './publicProfilePresentation';

const context: PublicProfileContextV1 = {
  handle: 'ada',
  identity: { name: 'Ada' },
  service: null,
  urls: null,
};
const snapshot = {
  v: 1,
  computedAtMs: Date.UTC(2026, 9, 30),
  coverage: { status: 'complete_for_supplied_facts', method: 'runtime' },
  period: {
    startMs: Date.UTC(2026, 8, 30),
    endMs: Date.UTC(2026, 9, 30),
    timeZoneOffsetMinutes: 0,
  },
  fieldCoverage: {},
  facts: {},
} as const satisfies PublicProfileSnapshotV1;

describe('publicProfilePageLabels', () => {
  it('leaves the handle in the title alone when no display name is shared', () => {
    expect(publicProfilePageLabels({ ...context, identity: {} }, snapshot, null, '90days').identityLine).toBe('');
    expect(publicProfilePageLabels(context, snapshot, null, '90days').identityLine).toBe('@ada');
  });
  it('names the period the owner chose, not a fixed one', () => {
    expect(
      publicProfilePageLabels(context, snapshot, null, '30days').periodTitle,
    ).toBe(formatUsageCalendarPeriod({ relative: '30days' }));
    expect(
      publicProfilePageLabels(context, snapshot, null, 'year').periodTitle,
    ).toBe(formatUsageCalendarPeriod({ relative: 'year' }));
  });

  it('says on the period line that the page is still being prepared until its snapshot exists', () => {
    expect(publicProfilePageLabels(context, null, null, '90days', 'Preparing your page…').periodDetail).toBe('Preparing your page…');
    expect(publicProfilePageLabels(context, snapshot, null, '90days', 'Preparing your page…').periodDetail)
      .not.toContain('Preparing');
  });
});
