import { describe, expect, it } from 'vitest';

import { resolveMachineBrowseRoots } from './resolveMachineBrowseRoots';

describe('resolveMachineBrowseRoots', () => {
  it('returns the POSIX machine root on non-windows platforms by default', async () => {
    const roots = await resolveMachineBrowseRoots({
      platform: 'darwin',
      workingDirectory: '/Users/alice',
    });

    expect(roots).toEqual([{ id: '/', label: '/', path: '/' }]);
  });

  it('returns the Windows drive root on windows platforms by default', async () => {
    const roots = await resolveMachineBrowseRoots({
      platform: 'win32',
      workingDirectory: 'C:\\Users\\Alice',
    });

    expect(roots).toEqual([{ id: 'C:\\', label: 'C:\\', path: 'C:\\' }]);
  });

  it('returns configured roots in restricted mode', async () => {
    const roots = await resolveMachineBrowseRoots({
      platform: 'darwin',
      workingDirectory: '/Users/alice',
      accessPolicy: { kind: 'restrictedRoots', roots: ['/srv/app', '/mnt/work'] },
    });

    expect(roots).toEqual([
      { id: '/srv/app', label: '/srv/app', path: '/srv/app' },
      { id: '/mnt/work', label: '/mnt/work', path: '/mnt/work' },
    ]);
  });
});
