import { describe, expect, it, vi } from 'vitest';

import { runEphemeralExecutionRunTextPrompt } from './textPrompt';

describe('runEphemeralExecutionRunTextPrompt', () => {
  it('uses the canonical start-and-wait Action with inherited Session scope instead of a local runtime loop', async () => {
    const executeStart = vi.fn(async (_input: unknown, _context: unknown) => ({
      ok: true as const,
      result: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        wait: {
          ok: true,
          status: 'succeeded',
          result: { latestToolResult: ' OK ' },
        },
      },
    }));
    const out = await runEphemeralExecutionRunTextPrompt({
      sessionId: 'sess-123',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.runtime.backend' as never },
      modelId: 'default',
      permissionMode: 'no_tools',
      intent: 'task',
      prompt: 'Return OK',
      timeoutMs: 1234,
      executeStart,
    });

    expect(out).toBe('OK');
    expect(executeStart).toHaveBeenCalledOnce();
    const [request, context] = executeStart.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      intent: 'task',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.runtime.backend' },
      modelId: 'default',
      permissionMode: 'no_tools',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      instructions: 'Return OK',
      waitForCompletion: true,
      waitTimeoutSeconds: 2,
    });
    expect(request).not.toHaveProperty('sessionId');
    expect(context).toEqual({
      surface: 'cli',
      authority: 'account_automation',
      defaultSessionId: 'sess-123',
    });
  });
});
