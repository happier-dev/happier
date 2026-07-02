import { describe, expect, it } from 'vitest';

import {
  CODEX_CLI_AUTH_STATUS_ARGS,
  resolveCodexCliAuthProbeTimeoutMs,
  resolveCodexCliAuthStatus,
} from './spec';

describe('Codex CLI auth spec policy', () => {
  it('declares the Codex login status command and default timeout', () => {
    expect(CODEX_CLI_AUTH_STATUS_ARGS).toEqual(['login', 'status']);
    expect(resolveCodexCliAuthProbeTimeoutMs({})).toBe(6_000);
    expect(resolveCodexCliAuthProbeTimeoutMs({ HAPPIER_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS: '2500' })).toBe(2_500);
    expect(resolveCodexCliAuthProbeTimeoutMs({ HAPPIER_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS: '0' })).toBe(6_000);
  });

  it('prefers successful CLI login status and preserves environment account labels', () => {
    expect(
      resolveCodexCliAuthStatus({
        commandStatus: { ok: true, exitCode: 0 },
        environmentAuth: { method: 'credentials_file', accountLabel: 'codex@example.test' },
      }),
    ).toEqual({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
      reason: null,
      accountLabel: 'codex@example.test',
    });
  });

  it('uses env API-key auth when command status exits non-zero', () => {
    expect(
      resolveCodexCliAuthStatus({
        commandStatus: { ok: false, exitCode: 1 },
        environmentAuth: { method: 'api_key_env', accountLabel: null },
      }),
    ).toEqual({
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
    });
  });

  it('does not trust credentials-file auth unless command status is unavailable', () => {
    expect(
      resolveCodexCliAuthStatus({
        commandStatus: { ok: false, exitCode: 1 },
        environmentAuth: { method: 'credentials_file', accountLabel: 'stale@example.test' },
      }),
    ).toEqual({
      state: 'logged_out',
      reason: 'missing_credentials',
      source: null,
    });

    expect(
      resolveCodexCliAuthStatus({
        commandStatus: { ok: false, exitCode: null },
        environmentAuth: { method: 'credentials_file', accountLabel: 'offline@example.test' },
      }),
    ).toEqual({
      state: 'logged_in',
      method: 'credentials_file',
      source: 'file',
      accountLabel: 'offline@example.test',
    });
  });
});
