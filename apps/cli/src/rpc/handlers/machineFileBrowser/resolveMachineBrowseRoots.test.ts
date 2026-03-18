import { describe, expect, it } from 'vitest';

import { resolveMachineBrowseRoots } from './resolveMachineBrowseRoots';

describe('resolveMachineBrowseRoots', () => {
  it('returns a single posix root on non-windows platforms', async () => {
    const roots = await resolveMachineBrowseRoots({
      platform: 'darwin',
    });

    expect(roots).toEqual([{ id: '/', label: '/', path: '/' }]);
  });

  it('returns accessible windows drive roots', async () => {
    const roots = await resolveMachineBrowseRoots({
      platform: 'win32',
      driveLetters: ['C', 'D', 'E'],
      canAccessRoot: async (root) => root !== 'D:\\',
    });

    expect(roots).toEqual([
      { id: 'C:\\', label: 'C:', path: 'C:\\' },
      { id: 'E:\\', label: 'E:', path: 'E:\\' },
    ]);
  });
});
