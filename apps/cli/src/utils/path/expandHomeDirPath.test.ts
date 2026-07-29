import { describe, expect, it } from 'vitest';

import {
  canonicalAbsolutePathsEqual,
  expandHomeDirPath,
  resolveCanonicalAbsolutePath,
} from './expandHomeDirPath';

describe('CLI path canonicalization', () => {
  it('expands both home separator spellings and normalizes mixed Windows separators', () => {
    const env = { USERPROFILE: 'C:\\Users\\Alice' };

    expect(expandHomeDirPath('~/projects/acme', env, 'win32'))
      .toBe('C:\\Users\\Alice\\projects\\acme');
    expect(expandHomeDirPath('~\\projects/acme', env, 'win32'))
      .toBe('C:\\Users\\Alice\\projects\\acme');
    expect(resolveCanonicalAbsolutePath('~\\projects/mixed/../acme', { env, platform: 'win32' }))
      .toEqual({
        path: 'C:\\Users\\Alice\\projects\\acme',
        comparisonKey: 'c:\\users\\alice\\projects\\acme',
      });
  });

  it('does not confuse a home-like sibling or sibling-prefix path with the canonical home', () => {
    const env = { USERPROFILE: 'C:\\Users\\Alice' };
    const home = resolveCanonicalAbsolutePath('~', { env, platform: 'win32' });
    const sibling = resolveCanonicalAbsolutePath('C:\\Users\\Alice2', { env, platform: 'win32' });

    expect(expandHomeDirPath('~alice\\projects', env, 'win32')).toBe('~alice\\projects');
    expect(home?.comparisonKey).not.toBe(sibling?.comparisonKey);
    expect(canonicalAbsolutePathsEqual(
      'C:\\Users\\Alice\\projects\\acme',
      'c:\\users\\alice\\PROJECTS\\ACME',
    )).toBe(true);
    expect(canonicalAbsolutePathsEqual(
      'C:\\Users\\Alice\\projects\\acme',
      'C:\\Users\\Alice\\projects\\acme2',
    )).toBe(false);
  });

  it('normalizes equivalent Windows drive and UNC identities before comparison', () => {
    expect(canonicalAbsolutePathsEqual(
      'C:\\Users\\Alice\\happier\\managed\\staging\\..\\runtime',
      'c:/users/alice/HAPPIER/managed/runtime/',
    )).toBe(true);
    expect(canonicalAbsolutePathsEqual(
      '\\\\Server\\Share\\happier\\managed\\staging\\..\\runtime',
      '//server/share/HAPPIER/managed/runtime/',
    )).toBe(true);
  });

  it('preserves POSIX case-sensitive identity while normalizing separator input', () => {
    const upper = resolveCanonicalAbsolutePath('/Users/Alice\\projects/../acme', { platform: 'linux' });
    const lower = resolveCanonicalAbsolutePath('/users/alice/acme', { platform: 'linux' });

    expect(upper).toEqual({
      path: '/Users/Alice/acme',
      comparisonKey: '/Users/Alice/acme',
    });
    expect(upper?.comparisonKey).not.toBe(lower?.comparisonKey);
    expect(canonicalAbsolutePathsEqual('/Users/Alice/acme', '/users/alice/acme')).toBe(false);
  });
});
