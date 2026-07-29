import { dirname } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scriptPath: '',
  writeFile: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: mocks.writeFile,
  };
});

describe('prepareTmuxWindowLaunch construction cleanup', () => {
  beforeEach(() => {
    mocks.scriptPath = '';
    mocks.writeFile.mockReset();
  });

  it('removes the private directory when a partial launcher write rejects', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    mocks.writeFile.mockImplementationOnce(async (path, data, options) => {
      mocks.scriptPath = String(path);
      await actualFs.writeFile(path, String(data).slice(0, 24), options);
      throw new Error('simulated partial write failure');
    });
    const { prepareTmuxWindowLaunch } = await import('./windowLaunchScript');

    await expect(prepareTmuxWindowLaunch({
      args: ['echo', 'never'],
      env: { PROVIDER_SECRET: 'provider-secret' },
      unsetEnvKeys: [],
      readySignal: 'ready-write-failure-test',
    })).rejects.toThrow('simulated partial write failure');

    expect(mocks.scriptPath).not.toBe('');
    await expect(actualFs.access(dirname(mocks.scriptPath))).rejects.toBeDefined();
  });
});
