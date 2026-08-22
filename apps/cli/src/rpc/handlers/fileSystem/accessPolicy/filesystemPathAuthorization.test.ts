import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { authorizeFilesystemPath, prepareFilesystemPathAuthorizer } from './filesystemPathAuthorization';

const createdPaths = new Set<string>();

function createTempRoot(name: string): string {
  const root = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  createdPaths.add(root);
  return root;
}

afterEach(() => {
  for (const path of createdPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  createdPaths.clear();
});

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

  it('rejects missing descendants nested under a symlink that escapes a restricted root', () => {
    const allowed = createTempRoot('happier-fs-policy-allowed');
    const outside = createTempRoot('happier-fs-policy-outside');
    const link = join(allowed, 'link');
    symlinkSync(outside, link);

    expect(authorizeFilesystemPath({
      targetPath: join(link, 'missing', 'secret.txt'),
      defaultDirectory: allowed,
      accessPolicy: { kind: 'restrictedRoots', roots: [allowed] },
    })).toMatchObject({ valid: false });
  });

  it('allows a missing descendant through a symlink-aliased restricted root', () => {
    const container = createTempRoot('happier-fs-policy-alias');
    const realRoot = join(container, 'real-root');
    const aliasRoot = join(container, 'alias-root');
    mkdirSync(realRoot, { recursive: true });
    symlinkSync(realRoot, aliasRoot);
    const targetPath = join(aliasRoot, '.happier', 'uploads', 'generated');

    expect(authorizeFilesystemPath({
      targetPath,
      defaultDirectory: aliasRoot,
      accessPolicy: { kind: 'restrictedRoots', roots: [aliasRoot] },
    })).toEqual({ valid: true, resolvedPath: targetPath });
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

describe('prepareFilesystemPathAuthorizer', () => {
  it('preserves os-user path resolution without filesystem canonicalization', async () => {
    const authorizePath = await prepareFilesystemPathAuthorizer({
      defaultDirectory: '/home/alice',
      accessPolicy: { kind: 'osUser' },
    });

    await expect(authorizePath('notes/todo.txt')).resolves.toEqual({
      valid: true,
      resolvedPath: resolve('/home/alice/notes/todo.txt'),
    });
  });

  it('rejects missing descendants nested under a symlink that escapes a restricted root', async () => {
    const allowed = createTempRoot('happier-fs-policy-async-allowed');
    const outside = createTempRoot('happier-fs-policy-async-outside');
    const link = join(allowed, 'link');
    symlinkSync(outside, link);

    const authorizePath = await prepareFilesystemPathAuthorizer({
      defaultDirectory: allowed,
      accessPolicy: { kind: 'restrictedRoots', roots: [allowed] },
    });

    await expect(authorizePath(join(link, 'missing', 'secret.txt'))).resolves.toMatchObject({ valid: false });
  });

  it('allows a missing descendant through a symlink-aliased restricted root', async () => {
    const container = createTempRoot('happier-fs-policy-async-alias');
    const realRoot = join(container, 'real-root');
    const aliasRoot = join(container, 'alias-root');
    mkdirSync(realRoot, { recursive: true });
    symlinkSync(realRoot, aliasRoot);
    const targetPath = join(aliasRoot, '.happier', 'uploads', 'generated');

    const authorizePath = await prepareFilesystemPathAuthorizer({
      defaultDirectory: aliasRoot,
      accessPolicy: { kind: 'restrictedRoots', roots: [aliasRoot] },
    });

    await expect(authorizePath(targetPath)).resolves.toEqual({ valid: true, resolvedPath: targetPath });
  });

  it('handles Windows drive, UNC, mixed-separator, and sibling-prefix boundaries', async () => {
    const authorizeDrivePath = await prepareFilesystemPathAuthorizer({
      defaultDirectory: 'C:\\Users\\alice',
      accessPolicy: { kind: 'restrictedRoots', roots: ['C:\\Users\\alice\\work'] },
      platform: 'win32',
    });
    await expect(authorizeDrivePath('C:/Users/alice/work\\repo/file.txt')).resolves.toEqual({
      valid: true,
      resolvedPath: 'C:\\Users\\alice\\work\\repo\\file.txt',
    });
    await expect(authorizeDrivePath('C:\\Users\\alice2\\work\\repo\\file.txt')).resolves.toMatchObject({ valid: false });
    await expect(authorizeDrivePath('D:\\Users\\alice\\work\\repo\\file.txt')).resolves.toMatchObject({ valid: false });

    const authorizeUncPath = await prepareFilesystemPathAuthorizer({
      defaultDirectory: '\\\\server\\share\\workspace',
      accessPolicy: { kind: 'restrictedRoots', roots: ['\\\\SERVER\\SHARE\\WORKSPACE'] },
      platform: 'win32',
    });
    await expect(authorizeUncPath('\\\\server\\share\\workspace\\nested/file.txt')).resolves.toMatchObject({ valid: true });
    await expect(authorizeUncPath('\\\\server\\other-share\\workspace\\file.txt')).resolves.toMatchObject({ valid: false });
  });
});
