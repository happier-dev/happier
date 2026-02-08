import { afterEach, describe, expect, it } from 'vitest';

import { resolveTmuxCommandTimeoutMs } from './index';

describe('resolveTmuxCommandTimeoutMs', () => {
  const original = process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS;

  afterEach(() => {
    if (typeof original === 'undefined') {
      delete process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS;
    } else {
      process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS = original;
    }
  });

  it('defaults to 15000ms', () => {
    delete process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS;
    expect(resolveTmuxCommandTimeoutMs()).toBe(15_000);
  });

  it('uses positive integer env override', () => {
    process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS = '22000';
    expect(resolveTmuxCommandTimeoutMs()).toBe(22_000);
  });

  it('falls back for invalid override', () => {
    process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS = '0';
    expect(resolveTmuxCommandTimeoutMs()).toBe(15_000);
  });
});
