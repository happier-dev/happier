import { describe, expect, it } from 'vitest';

import { resolveMachineBrowseRoots } from './resolveMachineBrowseRoots';

describe('resolveMachineBrowseRoots', () => {
  it('returns the machine working directory root on non-windows platforms', async () => {
    const roots = await resolveMachineBrowseRoots({
      platform: 'darwin',
      workingDirectory: '/Users/alice',
    });

    expect(roots).toEqual([{ id: '/Users/alice', label: '/Users/alice', path: '/Users/alice' }]);
  });

  it('returns the machine working directory root on windows platforms', async () => {
    const roots = await resolveMachineBrowseRoots({
      platform: 'win32',
      workingDirectory: 'C:\\Users\\Alice',
    });

    expect(roots).toEqual([{ id: 'C:\\Users\\Alice', label: 'C:\\Users\\Alice', path: 'C:\\Users\\Alice' }]);
  });
});
