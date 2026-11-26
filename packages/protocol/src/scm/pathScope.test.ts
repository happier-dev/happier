import { describe, expect, it } from 'vitest';

import {
  normalizeScmRepoRootRelativePath,
  resolveScmScopedChangedPaths,
  scmPathMatchesScopePath,
} from './pathScope.js';

describe('scmPathScope', () => {
  it('preserves host path syntax when normalizing literal repository paths', () => {
    expect(normalizeScmRepoRootRelativePath('./src/file.ts', 'posix')).toMatchObject({ ok: true, relativePath: 'src/file.ts' });
    expect(normalizeScmRepoRootRelativePath('src\\file.ts', 'posix')).toMatchObject({ ok: true, relativePath: 'src\\file.ts' });
    expect(normalizeScmRepoRootRelativePath('.\\src\\file.ts', 'win32')).toMatchObject({ ok: true, relativePath: 'src/file.ts' });
    for (const path of ['/outside.ts', '../outside.ts', ':(exclude)src/file.ts']) {
      expect(normalizeScmRepoRootRelativePath(path, 'posix')).toMatchObject({ ok: false });
      expect(normalizeScmRepoRootRelativePath(path, 'win32')).toMatchObject({ ok: false });
    }
    for (const path of ['C:\\outside.ts', '\\\\server\\share\\file.ts', '..\\outside.ts']) {
      expect(normalizeScmRepoRootRelativePath(path, 'win32')).toMatchObject({ ok: false });
    }
  });
  it('keeps filename whitespace distinct through include and exclude scopes', () => {
    expect(resolveScmScopedChangedPaths({
      changedPaths: ['', 'file', 'file ', ' ', ' dir/file'],
      include: ['file ', ' ', ' dir'], exclude: ['file'],
    })).toEqual(['file ', ' ', ' dir/file']);
    expect(scmPathMatchesScopePath({ changedPath: 'file ', scopePath: 'file' })).toBe(false);
    expect(scmPathMatchesScopePath({ changedPath: ' ', scopePath: '' })).toBe(false);
    expect(resolveScmScopedChangedPaths({ changedPaths: ['', ' '], include: ['.'] })).toEqual([' ']);
  });
  it('matches directory scopes against nested changed paths', () => {
    expect(
      scmPathMatchesScopePath({
        changedPath: 'src/features/file.ts',
        scopePath: 'src',
      }),
    ).toBe(true);
    expect(
      scmPathMatchesScopePath({
        changedPath: 'src/features/file.ts',
        scopePath: 'docs',
      }),
    ).toBe(false);
  });

  it('matches dot scope against any changed path', () => {
    expect(
      scmPathMatchesScopePath({
        changedPath: 'a/b/c.txt',
        scopePath: '.',
      }),
    ).toBe(true);
  });

  it('resolves include and exclude scopes using directory semantics', () => {
    const resolved = resolveScmScopedChangedPaths({
      changedPaths: ['src/a.ts', 'src/b.ts', 'docs/readme.md'],
      include: ['src'],
      exclude: ['src/b.ts'],
    });
    expect(resolved).toEqual(['src/a.ts']);
  });
});
