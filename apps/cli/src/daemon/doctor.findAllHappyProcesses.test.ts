import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, psListMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(() => ''),
  psListMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: execFileSyncMock,
}));

vi.mock('ps-list', () => ({
  default: psListMock,
}));

describe('findAllHappyProcesses', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    // This test controls the ps-list OS boundary; Darwin has its own ps boundary.
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
  });
  afterEach(async () => {
    const { clearProcessSnapshotCacheForTests } = await import('./processSnapshotCache');
    clearProcessSnapshotCacheForTests();
    vi.resetModules();
    execFileSyncMock.mockReset();
    psListMock.mockReset();
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('coalesces concurrent classified process snapshots and reuses the fresh raw snapshot cache', async () => {
    let resolveProcessSnapshot!: (processes: unknown[]) => void;
    psListMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveProcessSnapshot = resolve;
      }),
    );

    const { findAllHappyProcesses } = await import('./doctor');
    const first = findAllHappyProcesses();
    const second = findAllHappyProcesses();

    await Promise.resolve();
    expect(psListMock).toHaveBeenCalledTimes(1);

    resolveProcessSnapshot([
      {
        pid: 123,
        name: 'node',
        cmd: '/usr/bin/node /repo/dist/index.mjs daemon start-sync',
      },
    ]);

    const expected = [{
      pid: 123,
      command: '/usr/bin/node /repo/dist/index.mjs daemon start-sync',
      type: 'daemon',
    }];
    await expect(Promise.all([first, second])).resolves.toEqual([expected, expected]);

    psListMock.mockResolvedValueOnce([]);
    await expect(findAllHappyProcesses()).resolves.toEqual(expected);
    expect(psListMock).toHaveBeenCalledTimes(1);

    const { clearProcessSnapshotCacheForTests } = await import('./processSnapshotCache');
    clearProcessSnapshotCacheForTests();
    await expect(findAllHappyProcesses()).resolves.toEqual([]);
    expect(psListMock).toHaveBeenCalledTimes(2);
  });
});
