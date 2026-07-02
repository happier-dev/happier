import { describe, expect, it, vi } from 'vitest';

const runEphemeralExecutionRunTextPromptMock = vi.fn();

vi.mock('@/agent/runtime/bridges/executionRun/runtime/textPrompt', () => ({
  runEphemeralExecutionRunTextPrompt: (...args: unknown[]) => runEphemeralExecutionRunTextPromptMock(...args),
}));

import { runEphemeralExecutionRunTextPromptWithRunnerConfig } from './textPromptWithRunnerConfig';

describe('runEphemeralExecutionRunTextPromptWithRunnerConfig', () => {
  it('passes the configured backend id through to custom backends instead of manufacturing customAcp', async () => {
    const backend = {};
    const createRuntime = vi.fn(() => backend as never);
    runEphemeralExecutionRunTextPromptMock.mockResolvedValue('ok');

    await runEphemeralExecutionRunTextPromptWithRunnerConfig({
      cwd: '/tmp/workspace',
      sessionId: 'sess-1',
      runner: {
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      },
      intent: 'replay_summary',
      prompt: 'Return OK',
      createRuntime,
    });

    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'review-bot',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
    }));
    expect(runEphemeralExecutionRunTextPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'review-bot',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
    }));
  });
});
