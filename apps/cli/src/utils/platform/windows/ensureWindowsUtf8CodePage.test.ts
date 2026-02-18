import { describe, expect, it, vi } from 'vitest';

import { ensureWindowsUtf8CodePage } from './ensureWindowsUtf8CodePage';

describe('ensureWindowsUtf8CodePage', () => {
  it('does nothing on non-Windows platforms', () => {
    const execSync = vi.fn();
    const attempted = ensureWindowsUtf8CodePage({
      platform: 'darwin',
      env: {},
      isTTY: true,
      execSync,
    });

    expect(attempted).toBe(false);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('does nothing when not a TTY', () => {
    const execSync = vi.fn();
    const attempted = ensureWindowsUtf8CodePage({
      platform: 'win32',
      env: {},
      isTTY: false,
      execSync,
    });

    expect(attempted).toBe(false);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('does nothing when explicitly disabled', () => {
    const execSync = vi.fn();
    const attempted = ensureWindowsUtf8CodePage({
      platform: 'win32',
      env: { HAPPIER_WINDOWS_UTF8_CODEPAGE: '0' },
      isTTY: true,
      execSync,
    });

    expect(attempted).toBe(false);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('runs chcp 65001 via cmd.exe with output suppressed on Windows TTYs', () => {
    const execSync = vi.fn();
    const attempted = ensureWindowsUtf8CodePage({
      platform: 'win32',
      env: { ComSpec: 'C:\\\\Windows\\\\System32\\\\cmd.exe' },
      isTTY: true,
      execSync,
    });

    expect(attempted).toBe(true);
    expect(execSync).toHaveBeenCalledWith('chcp 65001 >NUL', {
      stdio: 'ignore',
      windowsHide: true,
      shell: 'C:\\\\Windows\\\\System32\\\\cmd.exe',
    });
  });
});

