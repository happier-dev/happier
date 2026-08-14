import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { readProcessInfoByPidMock } = vi.hoisted(() => ({
  readProcessInfoByPidMock: vi.fn(),
}));

vi.mock('@/daemon/doctor', () => ({
  readProcessInfoByPid: readProcessInfoByPidMock,
}));

import {
  getOpenCodeServerProcessInfoBestEffort,
  isOpenCodeServerPidAlive,
} from './openCodeServerProcessState';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('isOpenCodeServerPidAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(execFileSync).mockReset();
  });

  it('returns false when ps marks the pid as zombie', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.mocked(execFileSync).mockReturnValue('Zs opencode opencode serve --port 1234\n');

    expect(isOpenCodeServerPidAlive(1234, { platform: 'darwin' })).toBe(false);
  });

  it('returns true when the pid is alive and ps shows a non-zombie state', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.mocked(execFileSync).mockReturnValue('Ss opencode opencode serve --port 1234\n');

    expect(isOpenCodeServerPidAlive(1234, { platform: 'darwin' })).toBe(true);
  });

  it('returns true when ps inspection is unavailable but the pid still exists', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('ps unavailable');
    });

    expect(isOpenCodeServerPidAlive(1234, { platform: 'darwin' })).toBe(true);
  });

  it('returns false when the pid does not exist', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    expect(isOpenCodeServerPidAlive(1234, { platform: 'darwin' })).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('getOpenCodeServerProcessInfoBestEffort', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    readProcessInfoByPidMock.mockReset();
  });

  it('returns parsed process info including stat when macOS ps succeeds', async () => {
    readProcessInfoByPidMock.mockResolvedValue({
      pid: 1234,
      stat: 'Ss',
      name: 'opencode',
      cmd: 'opencode serve --port 1234',
    });

    await expect(getOpenCodeServerProcessInfoBestEffort(1234)).resolves.toEqual({
      stat: 'Ss',
      name: 'opencode',
      cmd: 'opencode serve --port 1234',
    });
  });

  it('returns null when macOS ps does not provide a row', async () => {
    readProcessInfoByPidMock.mockResolvedValue(null);

    await expect(getOpenCodeServerProcessInfoBestEffort(1234)).resolves.toBeNull();
  });
});
