import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const psListMock = vi.fn();
const execFileSyncMock = vi.fn();

vi.mock('ps-list', () => ({
  default: psListMock,
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: execFileSyncMock,
}));

describe('doctor posix single-pid discovery', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    vi.resetModules();
    psListMock.mockReset();
    execFileSyncMock.mockReset();
    psListMock.mockResolvedValue([]);
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'darwin' });
    }
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('uses direct ps pid inspection and avoids ps-list fallback for Happy processes', async () => {
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      expect(command).toBe('ps');
      if (args.includes('comm=')) {
        return 'node\n';
      }
      if (args.includes('command=')) {
        return '/usr/bin/node /repo/dist/index.mjs daemon start-sync\n';
      }
      return '';
    });

    const { findHappyProcessByPid } = await import('./doctor');

    await expect(findHappyProcessByPid(12345)).resolves.toEqual({
      pid: 12345,
      command: '/usr/bin/node /repo/dist/index.mjs daemon start-sync',
      type: 'daemon',
    });
    expect(psListMock).not.toHaveBeenCalled();
  });

  it('uses direct ps pid inspection and avoids ps-list fallback for non-Happy processes', async () => {
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      expect(command).toBe('ps');
      if (args.includes('comm=')) {
        return 'node\n';
      }
      if (args.includes('command=')) {
        return '/usr/bin/node -e setInterval(() => {}, 1000)\n';
      }
      return '';
    });

    const { findHappyProcessByPid } = await import('./doctor');

    await expect(findHappyProcessByPid(67890)).resolves.toBeNull();
    expect(psListMock).not.toHaveBeenCalled();
  });
});
