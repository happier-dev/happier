import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

describe('happier session run start arguments', () => {
  it('returns a stable invalid_arguments error for an unsupported intent before reading credentials', async () => {
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    const readCredentialsFn = vi.fn(async () => null);

    try {
      await handleSessionCommand(
        ['run', 'start', 'sess-1', '--intent', 'qa_cli_run', '--backend', 'agent:codex', '--json'],
        { readCredentialsFn },
      );

      expect(output.json()).toEqual({
        v: 1,
        ok: false,
        kind: 'session_run_start',
        error: {
          code: 'invalid_arguments',
          message: 'Invalid --intent "qa_cli_run". Expected one of: review, plan, delegate, task, voice_agent, memory_hints, scm_commit_message, scm_diff_summary.',
        },
      });
      expect(readCredentialsFn).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it.each([
    ['--retention', 'durable', 'ephemeral, resumable'],
    ['--run-class', 'interactive', 'bounded, long_lived'],
    ['--io-mode', 'batch', 'request_response, streaming'],
  ] as const)('rejects an unsupported %s value before reading credentials', async (flag, value, expectedValues) => {
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    const readCredentialsFn = vi.fn(async () => null);

    try {
      await handleSessionCommand(
        [
          'run',
          'start',
          'sess-1',
          '--intent',
          'review',
          '--backend',
          'agent:codex',
          flag,
          value,
          '--json',
        ],
        { readCredentialsFn },
      );

      expect(output.json()).toEqual({
        v: 1,
        ok: false,
        kind: 'session_run_start',
        error: {
          code: 'invalid_arguments',
          message: `Invalid ${flag} "${value}". Expected one of: ${expectedValues}.`,
        },
      });
      expect(readCredentialsFn).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it.each([
    ['--retention', 'ephemeral, resumable'],
    ['--run-class', 'bounded, long_lived'],
    ['--io-mode', 'request_response, streaming'],
  ] as const)('rejects %s without a value before reading credentials', async (flag, expectedValues) => {
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    const readCredentialsFn = vi.fn(async () => null);

    try {
      await handleSessionCommand(
        [
          'run',
          'start',
          'sess-1',
          '--intent',
          'review',
          '--backend',
          'agent:codex',
          '--json',
          flag,
        ],
        { readCredentialsFn },
      );

      expect(output.json()).toEqual({
        v: 1,
        ok: false,
        kind: 'session_run_start',
        error: {
          code: 'invalid_arguments',
          message: `Invalid ${flag} "". Expected one of: ${expectedValues}.`,
        },
      });
      expect(readCredentialsFn).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });
});
