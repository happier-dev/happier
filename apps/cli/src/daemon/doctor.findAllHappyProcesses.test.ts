import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, psListMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(() => ''),
  psListMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock('ps-list', () => ({
  default: psListMock,
}));

describe('findAllHappyProcesses', () => {
  afterEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
    psListMock.mockReset();
  });

  it('coalesces concurrent process snapshots so callers share one full process scan', async () => {
    let resolveProcessSnapshot!: (processes: unknown[]) => void;
    psListMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveProcessSnapshot = resolve;
      }),
    );

    const { findAllHappyProcesses } = await import('./doctor');
    const first = findAllHappyProcesses();
    const second = findAllHappyProcesses();

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
    await expect(findAllHappyProcesses()).resolves.toEqual([]);
    expect(psListMock).toHaveBeenCalledTimes(2);
  });
});
