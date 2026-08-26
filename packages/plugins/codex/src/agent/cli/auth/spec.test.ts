import { describe, expect, it } from 'vitest';

import {
  CODEX_CLI_AUTH_STATUS_ARGS,
  DEFAULT_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS,
  resolveCodexCliAuthStatus,
} from './spec';

describe('Codex CLI auth spec policy', () => {
  it('declares one bounded, noninteractive Codex login-status command', () => {
    expect(CODEX_CLI_AUTH_STATUS_ARGS).toEqual(['login', 'status']);
    expect(DEFAULT_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS).toBe(6_000);
  });

  it('interprets only the host-provided bounded command result', () => {
    expect(
      resolveCodexCliAuthStatus({
        commandStatus: { ok: true, exitCode: 0 },
      }),
    ).toEqual({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
    });
    expect(
      resolveCodexCliAuthStatus({
        commandStatus: { ok: false, exitCode: 1 },
      }),
    ).toEqual({
      state: 'logged_out',
      reason: 'missing_credentials',
    });
    expect(
      resolveCodexCliAuthStatus({
        commandStatus: { ok: false, exitCode: null },
      }),
    ).toEqual({
      state: 'unknown',
      reason: 'probe_failed',
      source: 'command',
    });
  });
});
