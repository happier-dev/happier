import { describe, expect, it } from 'vitest';

import {
  resolveScmScopedChangedPaths,
  scmPathMatchesScopePath,
} from './scmPathScope';

describe('scmPathScope', () => {
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
