import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
import type { WindowsProtectedLocalStateAclBoundary } from '@/utils/fs/protectedLocalState';

describe('writeSecureMcpRuntimeConfigFile', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('publishes config files with an atomic rename', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'happier-mcp-config-fallback-'));

    try {
      const configPath = await writeSecureMcpRuntimeConfigFile({
        prefix: 'happier-mcp-runtime-config',
        tmpDir: join(tmpRoot, 'secured'),
        payload: { token: 'secret-token' },
      });

      await expect(readFile(configPath, 'utf8')).resolves.toBe('{"token":"secret-token"}');
      expect(renameMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('fails closed unless Windows directory and file ACLs are applied and verified before returning', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'happier-mcp-config-windows-acl-'));
    const securedRoot = join(tmpRoot, 'secured');
    let protectedFileWasEmpty = false;
    const windowsAclBoundary: WindowsProtectedLocalStateAclBoundary = {
      applyAndVerify: vi.fn(async ({ path, kind }) => {
        if (kind === 'file') {
          protectedFileWasEmpty = (await readFile(path, 'utf8')) === '';
        }
      }),
      verify: vi.fn(async () => undefined),
    };

    try {
      const configPath = await writeSecureMcpRuntimeConfigFile({
        prefix: 'happier-mcp-runtime-config',
        tmpDir: securedRoot,
        payload: { token: 'synthetic-windows-acl-marker' },
      }, {
        protectedLocalStateOptions: { platform: 'win32', windowsAclBoundary },
      });

      expect(protectedFileWasEmpty).toBe(true);
      expect(windowsAclBoundary.applyAndVerify).toHaveBeenCalledWith({ path: securedRoot, kind: 'directory' });
      expect(windowsAclBoundary.applyAndVerify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'file' }));
      expect(windowsAclBoundary.verify).toHaveBeenCalledWith({ path: configPath, kind: 'file' });
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }

    const rejectingRoot = await mkdtemp(join(tmpdir(), 'happier-mcp-config-windows-reject-'));
    try {
      await expect(writeSecureMcpRuntimeConfigFile({
        prefix: 'happier-mcp-runtime-config',
        tmpDir: join(rejectingRoot, 'secured'),
        payload: { token: 'synthetic-rejected-acl-marker' },
      }, {
        protectedLocalStateOptions: {
          platform: 'win32',
          windowsAclBoundary: {
            async applyAndVerify() { throw new Error('synthetic ACL rejection'); },
            async verify() {},
          },
        },
      })).rejects.toThrow('synthetic ACL rejection');
      await expect(readdir(join(rejectingRoot, 'secured'))).resolves.toEqual([]);
    } finally {
      await rm(rejectingRoot, { recursive: true, force: true });
    }
  });
});
