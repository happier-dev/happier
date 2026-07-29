import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { authorizeFilesystemPath } from './filesystemPathAuthorization';

describe('authorizeFilesystemPath', () => {
  it('allows absolute paths outside the default directory for the os-user policy', () => {
    expect(
      authorizeFilesystemPath({
        targetPath: '/outside/project/file.txt',
        defaultDirectory: '/home/alice',
        accessPolicy: { kind: 'osUser' },
      }),
    ).toEqual({ valid: true, resolvedPath: resolve('/outside/project/file.txt') });
  });

  it('rejects sibling-prefix collisions in restricted mode', () => {
    const result = authorizeFilesystemPath({
      targetPath: '/home/alice2/project/file.txt',
      defaultDirectory: '/home/alice',
      accessPolicy: { kind: 'restrictedRoots', roots: ['/home/alice'] },
    });

    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected path authorization to fail');
    expect(result.error).toContain('outside the allowed directories');
  });

  it('allows children whose basename starts with dots inside restricted roots', () => {
    expect(
      authorizeFilesystemPath({
        targetPath: '/home/alice/..project/file.txt',
        defaultDirectory: '/home/alice',
        accessPolicy: { kind: 'restrictedRoots', roots: ['/home/alice'] },
      }),
    ).toEqual({ valid: true, resolvedPath: resolve('/home/alice/..project/file.txt') });
  });

  it('handles Windows sibling-prefix collisions and mixed separators', () => {
    const allowed = authorizeFilesystemPath({
      targetPath: 'C:/Users/alice/work\\repo/file.txt',
      defaultDirectory: 'C:\\Users\\alice',
      accessPolicy: { kind: 'restrictedRoots', roots: ['C:\\Users\\alice\\work'] },
      platform: 'win32',
    });
    expect(allowed).toEqual({ valid: true, resolvedPath: 'C:\\Users\\alice\\work\\repo\\file.txt' });

    const rejected = authorizeFilesystemPath({
      targetPath: 'C:\\Users\\alice2\\work\\repo\\file.txt',
      defaultDirectory: 'C:\\Users\\alice',
      accessPolicy: { kind: 'restrictedRoots', roots: ['C:\\Users\\alice'] },
      platform: 'win32',
    });
    expect(rejected.valid).toBe(false);
  });

  it('keeps Windows drive and UNC roots bounded', () => {
    const differentDrive = authorizeFilesystemPath({
      targetPath: 'D:\\workspace\\file.txt',
      defaultDirectory: 'C:\\workspace',
      accessPolicy: { kind: 'restrictedRoots', roots: ['C:\\workspace'] },
      platform: 'win32',
    });
    expect(differentDrive.valid).toBe(false);

    const uncChild = authorizeFilesystemPath({
      targetPath: '\\\\server\\share\\workspace\\nested/file.txt',
      defaultDirectory: '\\\\server\\share\\workspace',
      accessPolicy: {
        kind: 'restrictedRoots',
        roots: ['\\\\SERVER\\SHARE\\WORKSPACE'],
      },
      platform: 'win32',
    });
    expect(uncChild).toEqual({
      valid: true,
      resolvedPath: '\\\\server\\share\\workspace\\nested\\file.txt',
    });

    for (const targetPath of [
      '\\\\server\\share\\workspace-sibling\\file.txt',
      '\\\\server\\other-share\\workspace\\file.txt',
      '\\\\other-server\\share\\workspace\\file.txt',
      'C:\\workspace\\..\\outside\\file.txt',
    ]) {
      expect(
        authorizeFilesystemPath({
          targetPath,
          defaultDirectory: '\\\\server\\share\\workspace',
          accessPolicy: {
            kind: 'restrictedRoots',
            roots: ['\\\\server\\share\\workspace'],
          },
          platform: 'win32',
        }).valid,
      ).toBe(false);
    }
  });
});
