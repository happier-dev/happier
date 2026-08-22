import { describe, expect, it, vi } from 'vitest';

import { runEphemeralExecutionRunTextPromptWithRunnerConfig } from './textPromptWithRunnerConfig';

describe('runEphemeralExecutionRunTextPromptWithRunnerConfig', () => {
  it('starts a configured ACP backend through the canonical action instead of constructing a local runtime', async () => {
    const executeStart = vi.fn(async () => ({
      ok: true as const,
      result: {
        runId: 'run_1',
        wait: {
          ok: true,
          status: 'succeeded',
          result: { latestToolResult: 'ok' },
        },
      },
    }));

    await expect(runEphemeralExecutionRunTextPromptWithRunnerConfig({
      cwd: '/tmp/workspace',
      sessionId: 'sess-1',
      runner: {
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      },
      intent: 'task',
      prompt: 'Return OK',
      executeStart,
    })).resolves.toBe('ok');

    expect(executeStart).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      intent: 'task',
      waitForCompletion: true,
    }), { surface: 'cli', defaultSessionId: 'sess-1' });
  });
});
