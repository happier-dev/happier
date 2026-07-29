import { describe, expect, it, vi } from 'vitest';

import { createExecutionRunSnapshotLease } from './contributionSnapshotLease';

describe('execution-run contribution snapshot lease', () => {
  it('keeps generation A leased through its runtimes while generation B can complete independently', async () => {
    const releaseA = vi.fn(async () => undefined);
    const releaseB = vi.fn(async () => undefined);
    const snapshotA = createExecutionRunSnapshotLease(releaseA);
    const releaseRuntimeA1 = snapshotA.retain();
    const releaseRuntimeA2 = snapshotA.retain();

    await snapshotA.releaseOwner();
    expect(releaseA).not.toHaveBeenCalled();

    const snapshotB = createExecutionRunSnapshotLease(releaseB);
    const releaseRuntimeB = snapshotB.retain();
    await snapshotB.releaseOwner();
    await releaseRuntimeB();

    expect(releaseB).toHaveBeenCalledTimes(1);
    expect(releaseA).not.toHaveBeenCalled();

    await releaseRuntimeA1();
    expect(releaseA).not.toHaveBeenCalled();

    await releaseRuntimeA2();
    await releaseRuntimeA2();

    expect(releaseA).toHaveBeenCalledTimes(1);
    expect(() => snapshotA.retain()).toThrowError(
      expect.objectContaining({
        code: 'execution_run_contribution_snapshot_unavailable',
      }),
    );
  });
});
