import { describe, expect, it } from 'vitest';

import { resolveWindowsRemoteSessionLaunchMode } from './windowsSessionConsoleMode';

describe('resolveWindowsRemoteSessionLaunchMode', () => {
  it('defaults to hidden on non-Windows platforms', () => {
    expect(resolveWindowsRemoteSessionLaunchMode({
      platform: 'darwin',
      env: {},
    })).toBe('hidden');
  });

  it('returns the requested mode when explicitly provided', () => {
    expect(resolveWindowsRemoteSessionLaunchMode({
      platform: 'win32',
      requested: 'windows_terminal',
      env: {},
    })).toBe('windows_terminal');
  });

  it('maps the legacy visible request to console', () => {
    expect(resolveWindowsRemoteSessionLaunchMode({
      platform: 'win32',
      requested: 'visible',
      env: {},
    } as any)).toBe('console');
  });

  it('uses the canonical env override when present', () => {
    expect(resolveWindowsRemoteSessionLaunchMode({
      platform: 'win32',
      env: {
        HAPPIER_WINDOWS_REMOTE_SESSION_LAUNCH_MODE: 'windows_terminal',
      },
    })).toBe('windows_terminal');
  });

  it('maps the legacy env override to console', () => {
    expect(resolveWindowsRemoteSessionLaunchMode({
      platform: 'win32',
      env: {
        HAPPIER_WINDOWS_REMOTE_SESSION_CONSOLE: 'visible',
      },
    })).toBe('console');
  });
});
