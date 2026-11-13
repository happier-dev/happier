import { describe, expect, it, vi } from 'vitest';
import type { VoiceRealtimeToolCallV1, VoiceRealtimeToolResultV1 } from '@happier-dev/protocol/voice/realtime/events';

import { createRealtimeToolBarrier, RealtimeToolExecutionError } from './realtimeToolBarrier';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

function call(callId: string, order: number, toolName = 'listMachines') {
  return {
    v: 1 as const,
    responseId: 'response-1',
    callId,
    toolName,
    order,
    arguments: { limit: 50 },
  };
}

describe('realtime tool barrier', () => {
  it('retains a known PluginError after cancellation instead of replacing its identity with unknown', async () => {
    let refuse!: () => void;
    const executeCall = vi.fn(async () => await new Promise<never>((_resolve, reject) => {
      refuse = () => reject(new PluginError({ code: 'HostPlaybackFailure', details: { reason: 'speaker_unavailable' } }));
    }));
    const barrier = createRealtimeToolBarrier({ classifyCall: () => 'external',
      executeCall, redactResult: value => value,
      submitResults: async () => {}, continueResponse: async () => {},
    });
    const controller = new AbortController();
    const input = { responseId: 'response-1', calls: [call('known-failure', 0)] };
    try {
      const pending = barrier.run({ ...input, signal: controller.signal });
      await vi.waitFor(() => expect(executeCall).toHaveBeenCalledTimes(1));
      controller.abort();
      await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
      refuse();
      await expect(barrier.run(input)).resolves.toMatchObject({ status: 'submitted', results: [expect.objectContaining({
        status: 'error', errorCode: 'HostPlaybackFailure', errorDetails: { reason: 'speaker_unavailable' },
      })] });
      expect(executeCall).toHaveBeenCalledTimes(1);
    } finally { barrier.dispose(); }
  });

  it('executes allowed calls concurrently but submits deterministic all-results before one continuation', async () => {
    const releases = new Map<string, (value: unknown) => void>();
    const executeCall = vi.fn(async (input: VoiceRealtimeToolCallV1) => await new Promise((resolve) => releases.set(input.callId, resolve)));
    const events: string[] = [];
    const submitResults = vi.fn(async (_responseId: string, results: readonly VoiceRealtimeToolResultV1[]) => {
      events.push(`submit:${results.map((result) => result.callId).join(',')}`);
    });
    const continueResponse = vi.fn(async () => {
      events.push('continue');
    });
    const barrier = createRealtimeToolBarrier({

      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });

    const pending = barrier.run({ responseId: 'response-1', calls: [call('b', 2), call('a', 1)] });
    await vi.waitFor(() => expect(executeCall).toHaveBeenCalledTimes(2));
    releases.get('b')?.({ ok: true, value: 'B' });
    releases.get('a')?.({ ok: true, value: 'A' });
    const result = await pending;

    expect(result.status).toBe('submitted');
    expect(result.results.map((entry) => entry.callId)).toEqual(['a', 'b']);
    expect(events).toEqual(['submit:a,b', 'continue']);
    expect(continueResponse).toHaveBeenCalledTimes(1);
  });

  it('returns safe terminal results for mixed allow, deny, and error outcomes', async () => {
    const barrier = createRealtimeToolBarrier({
      executeCall: async (input) => {
        if (input.callId === 'denied') throw new RealtimeToolExecutionError('denied', 'permission_denied');
        if (input.callId === 'error') throw new Error('/secret/path raw failure');
        return { ok: true };
      },
      redactResult: (value) => value,
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });

    const result = await barrier.run({
      responseId: 'response-1',
      calls: [call('success', 0), call('denied', 1), call('error', 2)],
    });
    expect(result.results.map(({ status, errorCode }) => ({ status, errorCode }))).toEqual([
      { status: 'success', errorCode: undefined },
      { status: 'denied', errorCode: 'permission_denied' },
      { status: 'error', errorCode: 'tool_failed' },
    ]);
    expect(JSON.stringify(result)).not.toContain('/secret/path');
  });

  it('redacts before submission and never retains or submits raw private output', async () => {
    const submitResults = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({

      executeCall: async () => ({ path: '/Users/alice/private', secret: 'token' }),
      redactResult: () => ({ summary: 'redacted' }),
      submitResults,
      continueResponse: async () => undefined,
    });
    const result = await barrier.run({ responseId: 'response-1', calls: [call('private', 0)] });
    expect(submitResults).toHaveBeenCalledWith(
      'response-1',
      [expect.objectContaining({ output: { summary: 'redacted' } })],
      expect.anything(),
    );
    expect(JSON.stringify(result)).not.toContain('/Users/alice');
    expect(JSON.stringify(result)).not.toContain('token');
  });

  it('re-evaluates every completed result against current privacy immediately before batch submission', async () => {
    let releaseSibling!: (value: unknown) => void;
    let shareDeviceInventory = true;
    const submitResults = vi.fn(async (
      _responseId: string,
      _results: readonly VoiceRealtimeToolResultV1[],
      _signal: AbortSignal,
    ) => undefined);
    const redactResult = vi.fn((value: unknown, input: VoiceRealtimeToolCallV1) => {
      if (input.toolName === 'listMachines' && !shareDeviceInventory) {
        return {
          ok: false,
          errorCode: 'privacy_disabled',
          errorMessage: 'privacy_disabled',
        };
      }
      return value;
    });
    const barrier = createRealtimeToolBarrier({
      validateCall: () => ({ status: 'allowed' as const }),

      executeCall: async (input) => {
        if (input.callId === 'inventory') {
          return { ok: true, machineId: 'MACHINE_SECRET' };
        }
        return await new Promise((resolve) => { releaseSibling = resolve; });
      },
      redactResult,
      submitResults,
      continueResponse: async () => undefined,
    });

    const pending = barrier.run({
      responseId: 'response-1',
      calls: [
        call('inventory', 0, 'listMachines'),
        call('sibling', 1, 'getSessionActivity'),
      ],
    });
    await vi.waitFor(() => expect(redactResult).toHaveBeenCalledWith(
      { ok: true, machineId: 'MACHINE_SECRET' },
      expect.objectContaining({ callId: 'inventory', toolName: 'listMachines' }),
    ));

    shareDeviceInventory = false;
    releaseSibling({ ok: true, status: 'idle' });
    const result = await pending;

    const expectedInventoryOutput = {
      ok: false,
      errorCode: 'privacy_disabled',
      errorMessage: 'privacy_disabled',
    };
    expect(result.results[0]).toEqual(expect.objectContaining({
      callId: 'inventory',
      status: 'success',
      output: expectedInventoryOutput,
    }));
    expect(submitResults).toHaveBeenCalledWith(
      'response-1',
      result.results,
      expect.anything(),
    );
    expect(submitResults.mock.calls[0]?.[1]).toStrictEqual(result.results);
    expect(JSON.stringify(result)).not.toContain('MACHINE_SECRET');
    expect(JSON.stringify(submitResults.mock.calls)).not.toContain('MACHINE_SECRET');
  });

  it('makes cancellation terminal and ignores late tool completion', async () => {
    let release!: (value: unknown) => void;
    const submitResults = vi.fn(async () => undefined);
    const continueResponse = vi.fn(async () => undefined);
    const executeCall = vi.fn(async () => await new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const barrier = createRealtimeToolBarrier({

      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });
    const pending = barrier.run({ responseId: 'response-1', calls: [call('late', 0)], signal: controller.signal });
    await vi.waitFor(() => expect(executeCall).toHaveBeenCalledTimes(1));
    controller.abort();
    release({ raw: 'must not escape' });
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', results: [] });
    expect(submitResults).not.toHaveBeenCalled();
    expect(continueResponse).not.toHaveBeenCalled();
  });

  it('does not execute tools when the response signal is already aborted', async () => {
    const executeCall = vi.fn(async () => ({ raw: 'must not run' }));
    const submitResults = vi.fn(async () => undefined);
    const continueResponse = vi.fn(async () => undefined);
    const controller = new AbortController();
    controller.abort();
    const barrier = createRealtimeToolBarrier({
      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });

    await expect(barrier.run({
      responseId: 'response-1',
      calls: [call('pre-cancelled', 0)],
      signal: controller.signal,
    })).resolves.toEqual({ status: 'cancelled', results: [] });
    expect(executeCall).not.toHaveBeenCalled();
    expect(submitResults).not.toHaveBeenCalled();
    expect(continueResponse).not.toHaveBeenCalled();
  });

  it('aborts provider submission and never continues when cancellation arrives after tools settle', async () => {
    const submissionStarted = vi.fn();
    const continueResponse = vi.fn(async () => undefined);
    const controller = new AbortController();
    const barrier = createRealtimeToolBarrier({

      executeCall: async () => ({ ok: true }),
      redactResult: (value) => value,
      submitResults: async (_responseId, _results, signal) => {
        submissionStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('submission cancelled')), { once: true });
        });
      },
      continueResponse,
    });
    const pending = barrier.run({ responseId: 'response-1', calls: [call('settled', 0)], signal: controller.signal });
    await vi.waitFor(() => expect(submissionStarted).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).resolves.toMatchObject({ status: 'cancelled', results: [] });
    expect(continueResponse).not.toHaveBeenCalled();
  });

  it('submits one result per concurrent duplicate delivery while executing the effect once', async () => {
    let release!: (value: unknown) => void;
    const executeCall = vi.fn(async () => await new Promise((resolve) => { release = resolve; }));
    const submitResults = vi.fn(async () => {});
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',
      executeCall, redactResult: (value) => value,
      submitResults, continueResponse: async () => {},
    });
    const input = { responseId: 'response-1', calls: [call('same-call', 0)] };
    const first = barrier.run(input);
    const duplicate = barrier.run(input);
    await vi.waitFor(() => expect(executeCall).toHaveBeenCalledTimes(1));
    release({ ok: true });
    await Promise.all([first, duplicate]);
    expect(submitResults).toHaveBeenCalledTimes(2);
    expect(executeCall).toHaveBeenCalledTimes(1);
    barrier.dispose();
  });

  it('rejects rather than normalizes whitespace around the response identity', async () => {
    const barrier = createRealtimeToolBarrier({

      executeCall: async () => ({ ok: true }),
      redactResult: (value) => value,
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });

    await expect(barrier.run({
      responseId: ' response-1',
      calls: [call('call-1', 0)],
    })).rejects.toMatchObject({ code: 'response_conflict' });
  });

  it('sanitizes untrusted execution error codes into bounded terminal results', async () => {
    const unsafeCode = `private_path_${'x'.repeat(200)}`;
    const barrier = createRealtimeToolBarrier({
      executeCall: async (input) => {
        if (input.callId === 'denied') throw new RealtimeToolExecutionError('denied', unsafeCode);
        throw new RealtimeToolExecutionError('error', unsafeCode);
      },
      redactResult: (value) => value,
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });

    await expect(barrier.run({
      responseId: 'response-1',
      calls: [call('denied', 0), call('failed', 1)],
    })).resolves.toMatchObject({
      status: 'submitted',
      results: [
        { status: 'denied', errorCode: 'permission_denied' },
        { status: 'error', errorCode: 'tool_failed' },
      ],
    });
  });

  it('rejects an invalid voice action before execution', async () => {
    const executeCall = vi.fn(async () => ({ ok: true }));
    const barrier = createRealtimeToolBarrier({
      validateCall: () => ({ status: 'rejected' as const, code: 'invalid_tool_call' }),
      executeCall,
      redactResult: (value) => value,
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });

    const result = await barrier.run({ responseId: 'response-1', calls: [call('invalid', 0)] });
    expect(result.results).toEqual([
      expect.objectContaining({ status: 'error', errorCode: 'invalid_tool_call' }),
    ]);
    expect(executeCall).not.toHaveBeenCalled();
  });

  it('submits and continues exactly once for a response with zero tool calls', async () => {
    const submitResults = vi.fn(async () => undefined);
    const continueResponse = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({

      executeCall: async () => ({ ok: true }),
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });

    await expect(barrier.run({ responseId: 'response-1', calls: [] })).resolves.toEqual({
      status: 'submitted',
      results: [],
    });
    expect(submitResults).toHaveBeenCalledWith('response-1', [], expect.anything());
    expect(continueResponse).toHaveBeenCalledTimes(1);
  });

  it('redelivers the same completed result after submission failure without repeating a mutating effect', async () => {
    const executeCall = vi.fn(async () => ({ ok: true }));
    const submitResults = vi.fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce(undefined);
    const continueResponse = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',

      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });
    const input = { responseId: 'response-1', calls: [call('once', 0)] };

    const first = await barrier.run(input);
    const replay = await barrier.run(input);
    expect(first.status).toBe('failed');
    expect(replay.status).toBe('submitted');
    expect(executeCall).toHaveBeenCalledTimes(1);
    expect(submitResults).toHaveBeenCalledTimes(2);
    expect(continueResponse).toHaveBeenCalledTimes(1);
  });

  it('cancels delivery promptly while retaining the actual later mutation settlement without re-execution', async () => {
    let release!: (value: unknown) => void;
    const executeCall = vi.fn(async () => await new Promise((resolve) => { release = resolve; }));
    const submitResults = vi.fn(async () => undefined);
    const continueResponse = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',

      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });
    const controller = new AbortController();
    const input = { responseId: 'response-1', calls: [call('mutation-1', 0)] };

    const first = barrier.run({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(executeCall).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(first).resolves.toEqual({
      status: 'cancelled',
      results: [],
    });
    release({ ok: true, receipt: 'receipt-1' });

    await expect(barrier.run(input)).resolves.toMatchObject({
      status: 'submitted',
      results: [expect.objectContaining({
        callId: 'mutation-1',
        status: 'success',
        output: { ok: true, receipt: 'receipt-1' },
      })],
    });
    expect(executeCall).toHaveBeenCalledTimes(1);
    expect(submitResults).toHaveBeenCalledTimes(1);
    expect(continueResponse).toHaveBeenCalledTimes(1);
  });

  it('returns the retained mutation receipt when cancellation lands after execution completes', async () => {
    const controller = new AbortController();
    const executeCall = vi.fn(async () => ({ ok: true, receipt: 'receipt-after-completion' }));
    const submitResults = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',

      executeCall,
      redactResult: (value) => {
        controller.abort();
        return value;
      },
      submitResults,
      continueResponse: async () => undefined,
    });
    const input = { responseId: 'response-1', calls: [call('completed-mutation', 0)] };

    await expect(barrier.run({ ...input, signal: controller.signal })).resolves.toEqual({
      status: 'cancelled',
      results: [expect.objectContaining({
        callId: 'completed-mutation',
        status: 'success',
        output: { ok: true, receipt: 'receipt-after-completion' },
      })],
    });
    expect(submitResults).not.toHaveBeenCalled();

    await expect(barrier.run(input)).resolves.toMatchObject({
      status: 'submitted',
      results: [expect.objectContaining({
        callId: 'completed-mutation',
        status: 'success',
        output: { ok: true, receipt: 'receipt-after-completion' },
      })],
    });
    expect(executeCall).toHaveBeenCalledTimes(1);
    expect(submitResults).toHaveBeenCalledTimes(1);
  });

  it('reports an unknown mutating outcome after an aborting execution and never retries the effect', async () => {
    const executeCall = vi.fn(async (_call: VoiceRealtimeToolCallV1, signal: AbortSignal) => await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Effect transport aborted without a settlement')), { once: true });
    }));
    const submitResults = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'external',

      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse: async () => undefined,
    });
    const controller = new AbortController();
    const input = { responseId: 'response-1', calls: [call('external-1', 0)] };

    const first = barrier.run({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(executeCall).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(first).resolves.toMatchObject({ status: 'cancelled' });

    await expect(barrier.run(input)).resolves.toMatchObject({
      status: 'submitted',
      results: [expect.objectContaining({
        callId: 'external-1',
        status: 'error',
        errorCode: 'outcome_unknown',
      })],
    });
    expect(executeCall).toHaveBeenCalledTimes(1);
  });

  it('keeps a late committed receipt after person cancellation and stops delivery until explicitly retried', async () => {
    let commitLate!: () => void;
    let committed = false;
    const executeCall = vi.fn(async () => await new Promise((resolve) => {
      commitLate = () => {
        committed = true;
        resolve({ ok: true, receipt: 'late-mutation-receipt' });
      };
    }));
    const submitResults = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',

      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse: async () => undefined,
    });
    const input = { responseId: 'response-1', calls: [call('late-mutation', 0)] };
    const controller = new AbortController();
    const pending = barrier.run({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(executeCall).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: 'cancelled',
      results: [],
    });
    expect(committed).toBe(false);

    commitLate();
    await Promise.resolve();
    expect(committed).toBe(true);
    expect(submitResults).not.toHaveBeenCalled();
    await expect(barrier.run(input)).resolves.toMatchObject({
      status: 'submitted',
      results: [expect.objectContaining({
        callId: 'late-mutation',
        status: 'success',
        output: { ok: true, receipt: 'late-mutation-receipt' },
      })],
    });
    expect(executeCall).toHaveBeenCalledTimes(1);
  });

  it('cancels active work on dispose and rejects later runs', async () => {
    const executeCall = vi.fn(async (_input, signal) => await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const submitResults = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({

      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse: async () => undefined,
    });
    const pending = barrier.run({ responseId: 'response-1', calls: [call('active', 0)] });
    await vi.waitFor(() => expect(executeCall).toHaveBeenCalledTimes(1));
    barrier.dispose();

    await expect(pending).resolves.toMatchObject({ status: 'cancelled', results: [] });
    await expect(barrier.run({ responseId: 'later', calls: [] })).rejects.toMatchObject({ code: 'disposed' });
    expect(submitResults).not.toHaveBeenCalled();
  });

  it('fails closed when redaction throws', async () => {
    const barrier = createRealtimeToolBarrier({

      executeCall: async () => ({ private: 'raw' }),
      redactResult: () => { throw new Error('redactor failed'); },
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });
    const result = await barrier.run({ responseId: 'response-1', calls: [call('redact', 0)] });
    expect(result.results).toEqual([
      expect.objectContaining({ status: 'error', errorCode: 'redaction_failed' }),
    ]);
    expect(JSON.stringify(result)).not.toContain('raw');
  });

  it('executes all 65 valid calls in a response', async () => {
    const executeCall = vi.fn(async () => ({ ok: true }));
    const barrier = createRealtimeToolBarrier({
      executeCall,
      redactResult: (value) => value,
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });

    const result = await barrier.run({
      responseId: 'response-1',
      calls: Array.from({ length: 65 }, (_, index) => call(`call-${index}`, index)),
    });
    expect(result.status).toBe('submitted');
    expect(result.results).toHaveLength(65);
    expect(result.results.every((entry) => entry.status === 'success')).toBe(true);
    expect(executeCall).toHaveBeenCalledTimes(65);
  });

  it('retains more than 8,192 distinct mutating effect outcomes for their attempt', async () => {
    const executeCall = vi.fn(async (input: VoiceRealtimeToolCallV1) => ({ receipt: input.callId }));
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',

      executeCall,
      redactResult: (value) => value,
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });

    let finalResult: Awaited<ReturnType<typeof barrier.run>> | undefined;
    for (let index = 0; index <= 8_192; index += 1) {
      const responseId = `response-${index}`;
      finalResult = await barrier.run({
        responseId,
        calls: [{ ...call(`effect-${index}`, 0), responseId }],
      });
    }

    expect(finalResult).toMatchObject({
      status: 'submitted',
      results: [expect.objectContaining({
        callId: 'effect-8192',
        output: { receipt: 'effect-8192' },
        status: 'success',
      })],
    });
    expect(executeCall).toHaveBeenCalledTimes(8_193);
  });

  it('retains 129 failed deliveries and redelivers without repeating effects', async () => {
    const executeCall = vi.fn(async () => ({ ok: true }));
    const submitResults = vi.fn(async (): Promise<void> => { throw new Error('delivery failed'); });
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',

      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse: async () => undefined,
    });
    for (let index = 0; index < 129; index += 1) {
      const responseId = `response-${index}`;
      await expect(barrier.run({
        responseId,
        calls: [{ ...call(`effect-${index}`, 0), responseId }],
      })).resolves.toMatchObject({ status: 'failed' });
    }
    submitResults.mockImplementation(async () => undefined);
    await expect(barrier.run({
      responseId: 'response-0',
      calls: [{ ...call('effect-0', 0), responseId: 'response-0' }],
    })).resolves.toMatchObject({ status: 'submitted' });
    expect(executeCall).toHaveBeenCalledTimes(129);
    barrier.dispose();
  });
});
