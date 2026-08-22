import { describe, expect, it } from 'vitest';

import {
  canonicalAbsolutePathsEqual,
  expandHomeDirPath,
  isCanonicalAbsolutePathInsideRoot,
  resolveCanonicalAbsolutePath,
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

  it('keeps dot-prefixed child names and home-like sibling prefixes distinct', () => {
    const env = { HOME: '/Users/alice' };

    expect(expandHomeDirPath('~/..build/projects', env, 'linux')).toBe(
      '/Users/alice/..build/projects',
    );
    expect(expandHomeDirPath('~alice/projects', env, 'linux')).toBe('~alice/projects');
  });

  it('contains mixed-separator Windows children without rejecting dot-prefixed names or accepting siblings', () => {
    const root = 'C:\\Users\\Alice\\project';

    expect(isCanonicalAbsolutePathInsideRoot(
      root,
      'c:/users/alice/project\\build/output.js',
    )).toBe(true);
    expect(isCanonicalAbsolutePathInsideRoot(
      root,
      'C:\\Users\\Alice\\project\\..build\\output.js',
    )).toBe(true);
    expect(isCanonicalAbsolutePathInsideRoot(
      root,
      'C:\\Users\\Alice\\project-other\\output.js',
    )).toBe(false);
  });

  it('normalizes Windows identity without weakening POSIX case-sensitive identity', () => {
    expect(resolveCanonicalAbsolutePath(
      '~\\projects/mixed/../acme',
      { env: { USERPROFILE: 'C:\\Users\\Alice' }, platform: 'win32' },
    )).toEqual({
      path: 'C:\\Users\\Alice\\projects\\acme',
      comparisonKey: 'c:\\users\\alice\\projects\\acme',
    });
    expect(canonicalAbsolutePathsEqual(
      'C:\\Users\\Alice\\projects\\acme',
      'c:/users/alice/PROJECTS/ACME',
    )).toBe(true);
    expect(canonicalAbsolutePathsEqual('/Users/Alice/acme', '/users/alice/acme')).toBe(false);
  });
});
