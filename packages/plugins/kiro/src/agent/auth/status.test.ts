import { describe, expect, it, vi } from 'vitest';

import { detectKiroCliAuthStatus } from './status.js';

describe('detectKiroCliAuthStatus', () => {
  it('detects logged-in Kiro auth status from whoami json', async () => {
    const runCommand = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({ email: 'agent@example.com' }),
      stderr: '',
      exitCode: 0,
    }));

    await expect(detectKiroCliAuthStatus({ runCommand })).resolves.toEqual({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
      accountLabel: 'agent@example.com',
    });
    expect(runCommand).toHaveBeenCalledWith(['whoami', '--format', 'json'], { timeoutMs: 2_000 });
  });

  it('uses the first non-empty Kiro account label field', async () => {
    const runCommand = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({ email: '', username: '  kiro-user  ', displayName: 'Kiro User' }),
      stderr: '',
      exitCode: 0,
    }));

    await expect(detectKiroCliAuthStatus({ runCommand })).resolves.toMatchObject({
      state: 'logged_in',
      accountLabel: 'kiro-user',
    });
  });

  it('marks command failures as logged out or unknown by exit status', async () => {
    await expect(detectKiroCliAuthStatus({
      runCommand: async () => ({ ok: false, stdout: '', stderr: '', exitCode: 1 }),
    })).resolves.toEqual({
      state: 'logged_out',
      reason: 'missing_credentials',
      source: 'command',
    });

    await expect(detectKiroCliAuthStatus({
      runCommand: async () => ({ ok: false, stdout: '', stderr: '', exitCode: null }),
    })).resolves.toEqual({
      state: 'unknown',
      reason: 'probe_failed',
      source: 'command',
    });
  });
});
