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
    expect(resolveHappierHomeDirComparableKey('/home/Alice/.happier/')).toBe('/home/Alice/.happier');
    expect(resolveHappierHomeDirComparableKey('/home/Alice/.happier////')).toBe('/home/Alice/.happier');
  });

  it('normalizes Windows drive paths as case-insensitive and slash-insensitive', () => {
    expect(resolveHappierHomeDirComparableKey('C:\\Users\\Alice\\.happier\\')).toBe('c:/users/alice/.happier');
    expect(resolveHappierHomeDirComparableKey('c:/Users/Alice/.happier')).toBe('c:/users/alice/.happier');
    expect(resolveHappierHomeDirComparableKey('C:/Users/Alice/.happier\\\\')).toBe('c:/users/alice/.happier');
  });

  it('normalizes Windows UNC paths as case-insensitive and slash-insensitive', () => {
    expect(resolveHappierHomeDirComparableKey('\\\\Server\\Share\\.happier\\')).toBe('//server/share/.happier');
    expect(resolveHappierHomeDirComparableKey('//SERVER/Share/.happier/')).toBe('//server/share/.happier');
  });
});
