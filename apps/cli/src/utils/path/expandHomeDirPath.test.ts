import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';

import {
  canonicalAbsolutePathsEqual,
  expandHomeDirPath,
  resolveAbsolutePathFromWorkingDirectory,
  resolveCanonicalAbsolutePath,
  resolveCanonicalAbsoluteChildPathComparisonIdentity,
  resolveCanonicalAbsolutePathComparisonIdentity,
} from './expandHomeDirPath';

describe('CLI path canonicalization', () => {
  it('uses each hosted Session home and directory while preserving an explicit environment', async () => {
    await Promise.all(['first', 'second'].map(async (name) => {
      const home = join('/tmp', `path-home-${name}`);
      const directory = join(home, 'workspace');
      await runAddedHostedSession({ environment: { HOME: home, USERPROFILE: home }, workingDirectory: directory, end: () => {} }, async () => {
        await Promise.resolve();
        expect(expandHomeDirPath('~/file')).toBe(join(home, 'file'));
        expect(resolveCanonicalAbsolutePath('~/file')?.path).toBe(join(home, 'file'));
        expect(resolveCanonicalAbsolutePathComparisonIdentity('~/file'))
          .toBe(resolveCanonicalAbsolutePathComparisonIdentity(join(home, 'file')));
        expect(canonicalAbsolutePathsEqual('~/file', join(home, 'file'))).toBe(true);
        expect(resolveAbsolutePathFromWorkingDirectory('./file')).toBe(join(directory, 'file'));
        expect(expandHomeDirPath('~/file', { HOME: '/explicit-home', USERPROFILE: '/explicit-home' }))
          .toBe(join('/explicit-home', 'file'));
      });
    }));
  });

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

  it('exposes the same portable comparison identity for Windows and home aliases', () => {
    expect(resolveCanonicalAbsolutePathComparisonIdentity(
      'C:\\Users\\Alice\\happier\\managed\\staging\\..\\runtime',
    )).toBe(resolveCanonicalAbsolutePathComparisonIdentity(
      'c:/users/alice/HAPPIER/managed/runtime/',
    ));

    const env = { HOME: '/Users/Alice' };
    expect(resolveCanonicalAbsolutePathComparisonIdentity(
      '~/projects/acme/',
      { env, platform: 'darwin' },
    )).toBe(resolveCanonicalAbsolutePathComparisonIdentity(
      '/Users/Alice/projects/acme',
      { env, platform: 'darwin' },
    ));
  });

  it('keeps POSIX-root child comparison identity case-sensitive', () => {
    expect(resolveCanonicalAbsoluteChildPathComparisonIdentity(
      '/',
      '.happier/uploads/generated/session/message/File.png',
    )).not.toBe(resolveCanonicalAbsoluteChildPathComparisonIdentity(
      '/',
      '.happier/uploads/generated/session/message/file.png',
    ));
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

  it('resolves a user-supplied locator against the working directory without rewriting an absolute spelling', () => {
    expect(resolveAbsolutePathFromWorkingDirectory('./nested/plugin'))
      .toBe(join(process.cwd(), 'nested', 'plugin'));
    expect(resolveAbsolutePathFromWorkingDirectory('  .  ')).toBe(process.cwd());
    // An already-absolute locator keeps its exact spelling, including a trailing
    // separator that `resolve` would drop, so it stays the identity the daemon
    // and the plugin catalog persisted.
    expect(resolveAbsolutePathFromWorkingDirectory('/tmp/example-plugin/')).toBe('/tmp/example-plugin/');
    expect(resolveAbsolutePathFromWorkingDirectory('   ')).toBeNull();
    expect(resolveAbsolutePathFromWorkingDirectory('')).toBeNull();
  });
});
