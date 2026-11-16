import { afterEach, describe, expect, it } from 'vitest';

import { resolveTmuxCommandTimeoutMs } from './index';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { resolveTmuxPromptSubmitDelayMs, resolveTmuxSendKeysChunkSize } from './env';

describe('resolveTmuxCommandTimeoutMs', () => {
  it('reads independent tmux settings from concurrent Sessions', async () => {
    const values = await Promise.all(['17', '29'].map(value => runAddedHostedSession({
      environment: {
        NODE_ENV: 'test',
        HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS: value,
        HAPPIER_CLI_TMUX_PROMPT_SUBMIT_DELAY_MS: value,
        HAPPIER_CLI_TMUX_SEND_KEYS_CHUNK_SIZE: value,
      },
      workingDirectory: '/workspace', end: () => {},
    }, async () => {
      await Promise.resolve();
      return [resolveTmuxCommandTimeoutMs(), resolveTmuxPromptSubmitDelayMs(), resolveTmuxSendKeysChunkSize()];
    })));
    expect(values).toEqual([[17, 17, 17], [29, 29, 29]]);
  });

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
