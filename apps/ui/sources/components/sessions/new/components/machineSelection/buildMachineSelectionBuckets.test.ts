import { afterEach, describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit';
import { publishMachineActivityForTest } from '@/dev/testkit/harness/machinePresence';
import {
  clearMachineRequestReachabilityForTest,
  recordMachineRequestFailed,
} from '@/sync/domains/machines/reachability/machineReachability';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';

import { buildMachineSelectionBuckets } from './buildMachineSelectionBuckets';

afterEach(() => clearMachineRequestReachabilityForTest());

describe('buildMachineSelectionBuckets', () => {
  it('omits deleted machines from pinned recent rows', () => {
    const current = createMachineFixture({ id: 'current' });
    const deleted = createMachineFixture({ id: 'deleted' });
    expect(buildMachineSelectionBuckets({ machines: [current], recentMachines: [deleted], disableOfflineMachines: false })
      .buckets.flatMap(bucket => bucket.machines).map(machine => machine.id)).toEqual(['current']);
  });

  it('sorts a machine this Home cannot reach after reachable ones, by the same fact its row label reads (DRA D14)', () => {
    const scope = { serverId: 'home', accountId: 'account-a' };
    const now = Date.now();
    // Both daemons are alive (fresh heartbeats); this Home's last request to the first one failed.
    const unreachable = createMachineFixture({
      id: 'unreachable',
      active: true,
      activeAt: now - 1_000,
    });
    const reachable = createMachineFixture({
      id: 'reachable',
      active: true,
      activeAt: now - 1_000,
    });
    publishMachineActivityForTest([unreachable, reachable]);
    recordMachineRequestFailed({
      ...scope,
      machineId: 'unreachable',
      observedAtMs: now,
    });

    const { allMachines } = buildMachineSelectionBuckets({
      scope,
      machines: [unreachable, reachable],
    });

    expect(allMachines.map((machine) => machine.id)).toEqual([
      'reachable',
      'unreachable',
    ]);
    // The row label agrees with the order: the trailing row is the one that reads unreachable.
    expect(
      describeMachinePresenceLine(unreachable, now, null, scope).online,
    ).toBe(false);
    expect(
      describeMachinePresenceLine(reachable, now, null, scope).online,
    ).toBe(true);
  });
});
