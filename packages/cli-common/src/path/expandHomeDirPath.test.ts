import { describe, expect, it } from 'vitest';

import {
  expandHomeDirPath,
  resolveHomeDirFromEnvironment,
} from './expandHomeDirPath.js';

describe('expandHomeDirPath', () => {
  it.each([
    {
      label: 'Windows forward-slash prefix and mixed separators',
      value: '~/projects\\happier/src',
      env: { USERPROFILE: 'C:\\Users\\alice' },
      platform: 'win32',
      expected: 'C:\\Users\\alice\\projects\\happier\\src',
    },
    {
      label: 'Windows backslash prefix and repeated separators',
      value: '~\\projects//happier\\\\src',
      env: { USERPROFILE: 'C:\\Users\\alice' },
      platform: 'win32',
      expected: 'C:\\Users\\alice\\projects\\happier\\src',
    },
    {
      label: 'POSIX forward-slash prefix and mixed separators',
      value: '~/projects\\happier/src',
      env: { HOME: '/Users/alice' },
      platform: 'darwin',
      expected: '/Users/alice/projects/happier/src',
    },
  ] as const)('$label', ({ value, env, platform, expected }) => {
    expect(expandHomeDirPath(value, env, platform)).toBe(expected);
  });

  it('prefers USERPROFILE on Windows and HOME on POSIX', () => {
    const env = {
      HOME: '/home/alice',
      USERPROFILE: 'C:\\Users\\alice',
    };

    expect(resolveHomeDirFromEnvironment(env, 'win32')).toBe('C:\\Users\\alice');
    expect(resolveHomeDirFromEnvironment(env, 'linux')).toBe('/home/alice');
  });

  it('leaves paths without a home prefix unchanged', () => {
    expect(expandHomeDirPath('C:\\Users\\alice2\\project', {}, 'win32')).toBe(
      'C:\\Users\\alice2\\project',
    );
  });
});
