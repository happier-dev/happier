import { describe, expect, it, vi } from 'vitest';

import { runEphemeralExecutionRunTextPrompt } from './textPrompt';

describe('runEphemeralExecutionRunTextPrompt', () => {
  it('carries the Action refusal and terminal Run error to the calling helper', async () => {
    const prompt = {
      sessionId: 'sess-typed-failure',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'no_tools',
      intent: 'task',
      prompt: 'Return OK',
    } as const;
    const refusal = {
      ok: false, errorCode: 'provider_endpoint_auth_required', error: 'The endpoint requires sign-in',
      requestId: 'helper-start-request',
    } as const;
    await expect(runEphemeralExecutionRunTextPrompt({
      ...prompt,
      executeStart: async () => refusal,
    })).rejects.toMatchObject({ ...refusal, code: refusal.errorCode });

    await expect(runEphemeralExecutionRunTextPrompt({
      ...prompt,
      executeStart: async () => ({
        ok: true,
        result: {
          wait: { ok: true, status: 'failed', result: {
            run: { error: { code: 'usage_limit', message: 'The provider quota is exhausted' } },
          } },
        },
      }),
    })).rejects.toMatchObject({ code: 'usage_limit', message: 'The provider quota is exhausted' });
  });

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
