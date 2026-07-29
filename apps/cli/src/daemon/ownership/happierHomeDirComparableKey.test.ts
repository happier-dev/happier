import { describe, expect, it } from 'vitest';

import { resolveHappierHomeDirComparableKey } from './happierHomeDirComparableKey';

describe('resolveHappierHomeDirComparableKey', () => {
  it('returns null for empty inputs', () => {
    expect(resolveHappierHomeDirComparableKey('')).toBeNull();
    expect(resolveHappierHomeDirComparableKey('   ')).toBeNull();
    expect(resolveHappierHomeDirComparableKey(null)).toBeNull();
    expect(resolveHappierHomeDirComparableKey(undefined)).toBeNull();
  });

  it('trims and strips trailing separators for POSIX paths without changing case', () => {
    expect(resolveHappierHomeDirComparableKey('/home/Alice/.happier/', 'linux')).toBe('/home/Alice/.happier');
    expect(resolveHappierHomeDirComparableKey('/home/Alice/.happier////', 'linux')).toBe('/home/Alice/.happier');
    expect(resolveHappierHomeDirComparableKey('/c/Work/.happier', 'linux')).toBe('/c/Work/.happier');
    expect(resolveHappierHomeDirComparableKey('/C/Work/.happier', 'darwin')).toBe('/C/Work/.happier');
    expect(resolveHappierHomeDirComparableKey('//Server/Share/.happier', 'linux')).toBe('//Server/Share/.happier');
    expect(resolveHappierHomeDirComparableKey('/home/Alice\\Work/.happier', 'linux'))
      .toBe('/home/Alice\\Work/.happier');
  });

  it('normalizes Windows drive paths as case-insensitive and slash-insensitive', () => {
    expect(resolveHappierHomeDirComparableKey('C:\\Users\\Alice\\.happier\\', 'win32')).toBe('c:/users/alice/.happier');
    expect(resolveHappierHomeDirComparableKey('c:/Users/Alice/.happier', 'win32')).toBe('c:/users/alice/.happier');
    expect(resolveHappierHomeDirComparableKey('C:/Users/Alice/.happier\\\\', 'win32')).toBe('c:/users/alice/.happier');
    expect(resolveHappierHomeDirComparableKey('/c/Users/Alice/.happier', 'win32')).toBe('c:/users/alice/.happier');
  });

  it('normalizes Windows UNC paths as case-insensitive and slash-insensitive', () => {
    expect(resolveHappierHomeDirComparableKey('\\\\Server\\Share\\.happier\\', 'win32')).toBe('//server/share/.happier');
    expect(resolveHappierHomeDirComparableKey('//SERVER/Share/.happier/', 'win32')).toBe('//server/share/.happier');
  });
});
