import { describe, expect, it } from 'vitest';
import { resolveWindowsRemoteSessionConsoleMode } from './windowsSessionConsoleMode';

describe('resolveWindowsRemoteSessionConsoleMode', () => {
  it('returns visible when explicitly requested on Windows', () => {
    expect(
      resolveWindowsRemoteSessionConsoleMode({
        platform: 'win32',
        requested: 'visible',
        env: {},
      }),
    ).toBe('visible');
  });

  it('returns visible when env is set on Windows', () => {
    expect(
      resolveWindowsRemoteSessionConsoleMode({
        platform: 'win32',
        requested: undefined,
        env: { HAPPIER_WINDOWS_REMOTE_SESSION_CONSOLE: 'visible' },
      }),
    ).toBe('visible');
  });

  it('prefers explicit requested mode over environment value on Windows', () => {
    expect(
      resolveWindowsRemoteSessionConsoleMode({
        platform: 'win32',
        requested: 'hidden',
        env: { HAPPIER_WINDOWS_REMOTE_SESSION_CONSOLE: 'visible' },
      }),
    ).toBe('hidden');
  });

  it('treats non-visible env values as hidden on Windows', () => {
    expect(
      resolveWindowsRemoteSessionConsoleMode({
        platform: 'win32',
        requested: undefined,
        env: { HAPPIER_WINDOWS_REMOTE_SESSION_CONSOLE: 'VISIBLE' },
      }),
    ).toBe('hidden');
  });

  it('defaults to hidden on Windows when unset', () => {
    expect(
      resolveWindowsRemoteSessionConsoleMode({
        platform: 'win32',
        requested: undefined,
        env: {},
      }),
    ).toBe('hidden');
  });

  it('always returns hidden on non-Windows', () => {
    expect(
      resolveWindowsRemoteSessionConsoleMode({
        platform: 'darwin',
        requested: 'visible',
        env: { HAPPIER_WINDOWS_REMOTE_SESSION_CONSOLE: 'visible' },
      }),
    ).toBe('hidden');
  });
});
