import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

function normalizeHomeDir(
  value: string | null | undefined,
  options?: { homeDir?: string | null; platform?: 'posix' | 'win32' },
) {
  const normalizer = (protocol as Record<string, unknown>).normalizeMachineHomeDir;
  expect(typeof normalizer).toBe('function');
  return (normalizer as (
    input: string | null | undefined,
    options?: { homeDir?: string | null; platform?: 'posix' | 'win32' },
  ) => string)(value, options);
}

function compareHomeDirs(
  left: string | null | undefined,
  right: string | null | undefined,
  options?: { homeDir?: string | null; platform?: 'posix' | 'win32' },
) {
  const comparator = (protocol as Record<string, unknown>).compareMachineHomeDirs;
  expect(typeof comparator).toBe('function');
  return (comparator as (
    left: string | null | undefined,
    right: string | null | undefined,
    options?: { homeDir?: string | null; platform?: 'posix' | 'win32' },
  ) => boolean)(left, right, options);
}

function isSameLocality(input: {
  sessionHost?: string | null;
  sessionHomeDir?: string | null;
  currentHost?: string | null;
  currentHomeDir?: string | null;
  homeDir?: string | null;
  platform?: 'posix' | 'win32';
}) {
  const checker = (protocol as Record<string, unknown>).isSameMachineLocality;
  expect(typeof checker).toBe('function');
  return (checker as (input: typeof input) => boolean)(input);
}

describe('machine identity locality', () => {
  it('exports host-aware home normalization helpers from the public protocol barrel', () => {
    expect(typeof (protocol as Record<string, unknown>).normalizeMachineHomeDir).toBe('function');
    expect(typeof (protocol as Record<string, unknown>).compareMachineHomeDirs).toBe('function');
    expect(typeof (protocol as Record<string, unknown>).resolveMachineLocality).toBe('function');
    expect(typeof (protocol as Record<string, unknown>).isSameMachineLocality).toBe('function');
  });

  it('expands tilde homes, trims trailing separators, and normalizes mixed repeated separators', () => {
    expect(normalizeHomeDir('~/repo', { homeDir: '/Users/alice' })).toBe('/Users/alice/repo');
    expect(normalizeHomeDir('~\\repo', { homeDir: '/Users/alice' })).toBe('/Users/alice/repo');
    expect(normalizeHomeDir('/Users//alice\\repo///', { platform: 'posix' })).toBe('/Users/alice/repo');
    expect(normalizeHomeDir('/', { platform: 'posix' })).toBe('/');
  });

  it('compares Windows-shaped homes case-insensitively with mixed separators', () => {
    expect(normalizeHomeDir('C:/Users//Alice\\repo\\\\', { platform: 'win32' })).toBe('c:\\users\\alice\\repo');
    expect(compareHomeDirs('C:\\Users\\Alice', 'c:/users/alice/')).toBe(true);
  });

  it('rejects sibling-prefix collisions and blank or unexpandable homes', () => {
    expect(compareHomeDirs('/Users/alice', '/Users/alice2')).toBe(false);
    expect(compareHomeDirs('C:\\Users\\alice', 'C:\\Users\\alice2', { platform: 'win32' })).toBe(false);
    expect(normalizeHomeDir('~/repo')).toBe('');
    expect(compareHomeDirs('~/repo', '/Users/alice/repo')).toBe(false);
  });

  it('requires normalized host and home equality for machine locality', () => {
    expect(isSameLocality({
      sessionHost: 'LEEROY-MBP.local',
      sessionHomeDir: '~/work/',
      currentHost: 'leeroy-mbp',
      currentHomeDir: '/Users/leeroy/work',
      homeDir: '/Users/leeroy',
      platform: 'posix',
    })).toBe(true);

    expect(isSameLocality({
      sessionHost: 'LEEROY-MBP.local',
      sessionHomeDir: '/Users/leeroy/work',
      currentHost: 'imac',
      currentHomeDir: '/Users/leeroy/work',
    })).toBe(false);

    expect(isSameLocality({
      sessionHost: 'WINBOX.local',
      sessionHomeDir: 'C:/Users/Alice',
      currentHost: 'winbox',
      currentHomeDir: 'c:\\users\\alice2\\',
      platform: 'win32',
    })).toBe(false);
  });
});
