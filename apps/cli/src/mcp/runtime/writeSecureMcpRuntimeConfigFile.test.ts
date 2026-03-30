import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { linkMock, renameMock } = vi.hoisted(() => ({
  linkMock: vi.fn(),
  renameMock: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  linkMock.mockImplementation(actual.link);
  renameMock.mockImplementation(actual.rename);
  return {
    ...actual,
    link: (...args: Parameters<typeof actual.link>) => linkMock(...args),
    rename: (...args: Parameters<typeof actual.rename>) => renameMock(...args),
  };
});

import { writeSecureMcpRuntimeConfigFile } from './writeSecureMcpRuntimeConfigFile';

describe('writeSecureMcpRuntimeConfigFile', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('publishes config files with an atomic rename', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'happier-mcp-config-fallback-'));

    try {
      const configPath = await writeSecureMcpRuntimeConfigFile({
        prefix: 'happier-mcp-runtime-config',
        tmpDir: tmpRoot,
        payload: { token: 'secret-token' },
      });

      await expect(readFile(configPath, 'utf8')).resolves.toBe('{"token":"secret-token"}');
      expect(renameMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
