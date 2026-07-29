import { describe, expect, it } from 'vitest';

import {
  clearProcessSnapshotCacheForTests,
  listProcessSnapshot,
  type ProcessSnapshotEntry,
} from './processSnapshotCache';

describe('listProcessSnapshot', () => {
  it('coalesces concurrent process-list scans', async () => {
    clearProcessSnapshotCacheForTests();
    let resolveScan: (value: readonly ProcessSnapshotEntry[]) => void = () => {
      throw new Error('process scan was not started');
    };
    let calls = 0;
    const psListImpl = async () => {
      calls += 1;
      return await new Promise<readonly ProcessSnapshotEntry[]>((resolve) => {
        resolveScan = resolve;
      });
    };

    const first = listProcessSnapshot({ psListImpl, nowMs: () => 1000 });
    const second = listProcessSnapshot({ psListImpl, nowMs: () => 1000 });

    await Promise.resolve();
    expect(calls).toBe(1);
    resolveScan([{ pid: 123, ppid: 1, name: 'node' }]);

    await expect(first).resolves.toEqual([{ pid: 123, ppid: 1, name: 'node' }]);
    await expect(second).resolves.toEqual([{ pid: 123, ppid: 1, name: 'node' }]);
  });

  it('reuses a fresh cached snapshot within the ttl', async () => {
    clearProcessSnapshotCacheForTests();
    let calls = 0;
    const psListImpl = async () => {
      calls += 1;
      return [{ pid: calls, ppid: 1, name: 'node' }];
    };

    await expect(listProcessSnapshot({ psListImpl, nowMs: () => 1000, ttlMs: 500 })).resolves.toEqual([
      { pid: 1, ppid: 1, name: 'node' },
    ]);
    await expect(listProcessSnapshot({ psListImpl, nowMs: () => 1200, ttlMs: 500 })).resolves.toEqual([
      { pid: 1, ppid: 1, name: 'node' },
    ]);
    await expect(listProcessSnapshot({ psListImpl, nowMs: () => 1601, ttlMs: 500 })).resolves.toEqual([
      { pid: 2, ppid: 1, name: 'node' },
    ]);

    expect(calls).toBe(2);
  });
});
