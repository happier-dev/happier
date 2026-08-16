import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from '@/testkit/logger/captureOutput';

import { handleAutomationCommand } from './automation';

describe('handleAutomationCommand', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('runs an automation through the canonical API with an optional idempotency key', async () => {
    const runAutomationNowFn = vi.fn(async () => ({ id: 'run-1', automationId: 'automation-1', state: 'queued' as const }));
    const output = captureStdout();
    try {
      await handleAutomationCommand(
        ['run', 'automation-1', '--idempotency-key', 'ci-build-42', '--json'],
        {
          readCredentialsFn: async () => ({ token: 'token-1' } as never),
          runAutomationNowFn,
        },
      );

      expect(runAutomationNowFn).toHaveBeenCalledWith({
        token: 'token-1',
        automationId: 'automation-1',
        idempotencyKey: 'ci-build-42',
      });
      expect(JSON.parse(output.text())).toEqual({
        v: 1,
        ok: true,
        kind: 'automation_run',
        data: { run: { id: 'run-1', automationId: 'automation-1', state: 'queued' } },
      });
    } finally {
      output.restore();
    }
  });

  it('rejects malformed run arguments before reading credentials', async () => {
    const readCredentialsFn = vi.fn();

    await expect(handleAutomationCommand(
      ['run', 'automation-1', '--idempotency-key'],
      {
        readCredentialsFn,
        runAutomationNowFn: vi.fn(),
      },
    )).rejects.toThrow(/idempotency-key/i);

    expect(readCredentialsFn).not.toHaveBeenCalled();
  });
});
