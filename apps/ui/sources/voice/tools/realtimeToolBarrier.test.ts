import { describe, expect, it, vi } from 'vitest';
import type { VoiceRealtimeToolCallV1, VoiceRealtimeToolResultV1 } from '@happier-dev/protocol';

import { createRealtimeToolBarrier, RealtimeToolExecutionError } from './realtimeToolBarrier';

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
      authorizeCall: async () => ({ status: 'allowed' as const }),
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

  it('returns safe terminal results for mixed allow, deny, error, and timeout outcomes', async () => {
    const barrier = createRealtimeToolBarrier({
      timeoutMs: 10,
      authorizeCall: async (input) => input.callId === 'denied'
        ? { status: 'denied' as const, code: 'permission_denied' }
        : { status: 'allowed' as const },
      executeCall: async (input, signal) => {
        if (input.callId === 'error') throw new Error('/secret/path raw failure');
        if (input.callId === 'timeout') return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('late secret')), { once: true }));
        return { ok: true };
      },
      redactResult: (value) => value,
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });

    const result = await barrier.run({
      responseId: 'response-1',
      calls: [call('success', 0), call('denied', 1), call('error', 2), call('timeout', 3)],
    });
    expect(result.results.map(({ status, errorCode }) => ({ status, errorCode }))).toEqual([
      { status: 'success', errorCode: undefined },
      { status: 'denied', errorCode: 'permission_denied' },
      { status: 'error', errorCode: 'tool_failed' },
      { status: 'timeout', errorCode: 'tool_timeout' },
    ]);
    expect(JSON.stringify(result)).not.toContain('/secret/path');
    expect(JSON.stringify(result)).not.toContain('late secret');
  });

  it('redacts before submission and never retains or submits raw private output', async () => {
    const submitResults = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({
      authorizeCall: async () => ({ status: 'allowed' as const }),
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
      authorizeCall: async () => ({ status: 'allowed' as const }),
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
    expect(submitResults.mock.calls[0]?.[1]).toBe(result.results);
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
      authorizeCall: async () => ({ status: 'allowed' as const }),
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

  it('does not authorize or execute tools when the response signal is already aborted', async () => {
    const authorizeCall = vi.fn(async () => ({ status: 'allowed' as const }));
    const executeCall = vi.fn(async () => ({ raw: 'must not run' }));
    const submitResults = vi.fn(async () => undefined);
    const continueResponse = vi.fn(async () => undefined);
    const controller = new AbortController();
    controller.abort();
    const barrier = createRealtimeToolBarrier({
      authorizeCall,
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
    expect(authorizeCall).not.toHaveBeenCalled();
    expect(executeCall).not.toHaveBeenCalled();
    expect(submitResults).not.toHaveBeenCalled();
    expect(continueResponse).not.toHaveBeenCalled();
  });

  it('aborts provider submission and never continues when cancellation arrives after tools settle', async () => {
    const submissionStarted = vi.fn();
    const continueResponse = vi.fn(async () => undefined);
    const controller = new AbortController();
    const barrier = createRealtimeToolBarrier({
      authorizeCall: async () => ({ status: 'allowed' as const }),
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

  it('detaches provider delivery without cancelling a settled mutation and redelivers its retained result once', async () => {
    const deliveryStarted = vi.fn();
    const executeCall = vi.fn(async () => ({ ok: true, receipt: 'effect-receipt' }));
    const submitResults = vi.fn()
      .mockImplementationOnce(async (
        _responseId: string,
        _results: readonly VoiceRealtimeToolResultV1[],
        signal: AbortSignal,
      ) => {
        deliveryStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('transport detached')), { once: true });
        });
      })
      .mockResolvedValueOnce(undefined);
    const continueResponse = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',
      authorizeCall: async () => ({ status: 'allowed' as const }),
      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });
    const input = { responseId: 'response-1', calls: [call('detached-effect', 0)] };

    const first = barrier.run(input);
    await vi.waitFor(() => expect(deliveryStarted).toHaveBeenCalledTimes(1));
    barrier.detach('response-1');

    await expect(first).resolves.toMatchObject({
      status: 'detached',
      results: [expect.objectContaining({
        callId: 'detached-effect',
        status: 'success',
        output: { ok: true, receipt: 'effect-receipt' },
      })],
    });
    await expect(barrier.run(input)).resolves.toMatchObject({ status: 'submitted' });

    expect(executeCall).toHaveBeenCalledTimes(1);
    expect(submitResults).toHaveBeenCalledTimes(2);
    expect(continueResponse).toHaveBeenCalledTimes(1);
  });

  it('retains a detached read result and redelivers it without rerunning the read', async () => {
    const deliveryStarted = vi.fn();
    let executions = 0;
    const executeCall = vi.fn(async () => ({ execution: ++executions }));
    const submitResults = vi.fn()
      .mockImplementationOnce(async (
        _responseId: string,
        _results: readonly VoiceRealtimeToolResultV1[],
        signal: AbortSignal,
      ) => {
        deliveryStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('transport detached')), { once: true });
        });
      })
      .mockResolvedValueOnce(undefined);
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'read_only',
      authorizeCall: async () => ({ status: 'allowed' as const }),
      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse: async () => undefined,
    });
    const input = { responseId: 'response-1', calls: [call('detached-read', 0)] };

    const first = barrier.run(input);
    await vi.waitFor(() => expect(deliveryStarted).toHaveBeenCalledOnce());
    barrier.detach('response-1');

    await expect(first).resolves.toMatchObject({
      status: 'detached',
      results: [expect.objectContaining({ output: { execution: 1 } })],
    });
    await expect(barrier.run(input)).resolves.toMatchObject({
      status: 'submitted',
      results: [expect.objectContaining({ output: { execution: 1 } })],
    });
    expect(executeCall).toHaveBeenCalledOnce();
    expect(submitResults).toHaveBeenCalledTimes(2);
  });

  it('dedupes response replay and rejects conflicting duplicate call ids', async () => {
    const executeCall = vi.fn(async () => ({ ok: true }));
    const submitResults = vi.fn(async () => undefined);
    const continueResponse = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({
      authorizeCall: async () => ({ status: 'allowed' as const }),
      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });
    const first = await barrier.run({ responseId: 'response-1', calls: [call('a', 0)] });
    const replay = await barrier.run({ responseId: 'response-1', calls: [call('a', 0)] });
    expect(replay).toBe(first);
    expect(executeCall).toHaveBeenCalledTimes(1);
    expect(submitResults).toHaveBeenCalledTimes(1);
    expect(continueResponse).toHaveBeenCalledTimes(1);

    await expect(barrier.run({ responseId: 'response-2', calls: [
      { ...call('same', 0), responseId: 'response-2' },
      { ...call('same', 1), responseId: 'response-2', toolName: 'different' },
    ] })).rejects.toMatchObject({ code: 'duplicate_call_id' });
  });

  it('rejects rather than normalizes whitespace around the response identity', async () => {
    const barrier = createRealtimeToolBarrier({
      authorizeCall: async () => ({ status: 'allowed' as const }),
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

  it('sanitizes untrusted authorization and execution error codes into bounded terminal results', async () => {
    const unsafeCode = `private_path_${'x'.repeat(200)}`;
    const barrier = createRealtimeToolBarrier({
      authorizeCall: async (input) => input.callId === 'denied'
        ? { status: 'denied' as const, code: unsafeCode }
        : { status: 'allowed' as const },
      executeCall: async () => {
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

  it('rejects an invalid voice action before authorization or execution', async () => {
    const authorizeCall = vi.fn(async () => ({ status: 'allowed' as const }));
    const executeCall = vi.fn(async () => ({ ok: true }));
    const barrier = createRealtimeToolBarrier({
      validateCall: () => ({ status: 'rejected' as const, code: 'invalid_tool_call' }),
      authorizeCall,
      executeCall,
      redactResult: (value) => value,
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
    });

    const result = await barrier.run({ responseId: 'response-1', calls: [call('invalid', 0)] });
    expect(result.results).toEqual([
      expect.objectContaining({ status: 'error', errorCode: 'invalid_tool_call' }),
    ]);
    expect(authorizeCall).not.toHaveBeenCalled();
    expect(executeCall).not.toHaveBeenCalled();
  });

  it('submits and continues exactly once for a response with zero tool calls', async () => {
    const submitResults = vi.fn(async () => undefined);
    const continueResponse = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({
      authorizeCall: async () => ({ status: 'allowed' as const }),
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
      authorizeCall: async () => ({ status: 'allowed' as const }),
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

  it('reapplies current redaction to a retained read result after failed delivery without rerunning it', async () => {
    let executions = 0;
    let shareDeviceInventory = true;
    const executeCall = vi.fn(async () => ({ execution: ++executions, machineId: 'MACHINE_SECRET' }));
    const submitResults = vi.fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce(undefined);
    const continueResponse = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'read_only',
      authorizeCall: async () => ({ status: 'allowed' as const }),
      executeCall,
      redactResult: (value, input) => input.toolName === 'listMachines' && !shareDeviceInventory
        ? {
          ok: false,
          errorCode: 'privacy_disabled',
          errorMessage: 'privacy_disabled',
        }
        : value,
      submitResults,
      continueResponse,
    });
    const input = { responseId: 'response-1', calls: [call('read-once', 0)] };

    const first = await barrier.run(input);
    shareDeviceInventory = false;
    const replay = await barrier.run(input);

    const expectedRedactedOutput = {
      ok: false,
      errorCode: 'privacy_disabled',
      errorMessage: 'privacy_disabled',
    };
    expect(first.status).toBe('failed');
    expect(replay).toMatchObject({
      status: 'submitted',
      results: [expect.objectContaining({ output: expectedRedactedOutput })],
    });
    expect(executeCall).toHaveBeenCalledTimes(1);
    expect(submitResults.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({ output: expectedRedactedOutput }),
    ]);
    expect(JSON.stringify(submitResults.mock.calls[1]?.[1])).not.toContain('MACHINE_SECRET');
    expect(continueResponse).toHaveBeenCalledTimes(1);
  });

  it('retains outcome_unknown when cancellation precedes mutation settlement and never retries the effect', async () => {
    let release!: (value: unknown) => void;
    const executeCall = vi.fn(async () => await new Promise((resolve) => { release = resolve; }));
    const submitResults = vi.fn(async () => undefined);
    const continueResponse = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',
      authorizeCall: async () => ({ status: 'allowed' as const }),
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
      results: [expect.objectContaining({
        callId: 'mutation-1',
        status: 'error',
        errorCode: 'outcome_unknown',
      })],
    });
    release({ ok: true, receipt: 'receipt-1' });

    await expect(barrier.run(input)).resolves.toMatchObject({
      status: 'submitted',
      results: [expect.objectContaining({
        callId: 'mutation-1',
        status: 'error',
        errorCode: 'outcome_unknown',
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
      authorizeCall: async () => ({ status: 'allowed' as const }),
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
    const executeCall = vi.fn(async () => await new Promise<never>(() => {}));
    const submitResults = vi.fn(async () => undefined);
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'external',
      authorizeCall: async () => ({ status: 'allowed' as const }),
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
    await expect(first).resolves.toEqual({
      status: 'cancelled',
      results: [expect.objectContaining({
        callId: 'external-1',
        status: 'error',
        errorCode: 'outcome_unknown',
      })],
    });

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

  it('reports outcome_unknown when a timed-out mutation ignores abort and commits late', async () => {
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
      timeoutMs: 10,
      classifyCall: () => 'mutation',
      authorizeCall: async () => ({ status: 'allowed' as const }),
      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse: async () => undefined,
    });
    const input = { responseId: 'response-1', calls: [call('late-mutation', 0)] };

    await expect(barrier.run(input)).resolves.toMatchObject({
      status: 'submitted',
      results: [expect.objectContaining({
        callId: 'late-mutation',
        status: 'error',
        errorCode: 'outcome_unknown',
      })],
    });
    expect(committed).toBe(false);

    commitLate();
    await Promise.resolve();
    expect(committed).toBe(true);
    await expect(barrier.run(input)).resolves.toMatchObject({
      status: 'submitted',
      results: [expect.objectContaining({
        callId: 'late-mutation',
        status: 'error',
        errorCode: 'outcome_unknown',
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
      authorizeCall: async () => ({ status: 'allowed' as const }),
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
      authorizeCall: async () => ({ status: 'allowed' as const }),
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

  it('bounds calls per response before authorization or execution', async () => {
    const authorizeCall = vi.fn(async () => ({ status: 'allowed' as const }));
    const executeCall = vi.fn(async () => ({ ok: true }));
    const barrier = createRealtimeToolBarrier({
      authorizeCall,
      executeCall,
      redactResult: (value) => value,
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
      maxCallsPerResponse: 2,
    });

    await expect(barrier.run({
      responseId: 'response-1',
      calls: [call('one', 0), call('two', 1), call('three', 2)],
    })).rejects.toMatchObject({ code: 'too_many_calls' });
    expect(authorizeCall).not.toHaveBeenCalled();
    expect(executeCall).not.toHaveBeenCalled();
  });

  it('retains more than 8,192 distinct mutating effect outcomes for their attempt', async () => {
    const executeCall = vi.fn(async (input: VoiceRealtimeToolCallV1) => ({ receipt: input.callId }));
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',
      authorizeCall: async () => ({ status: 'allowed' as const }),
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

  it('bounds concurrently active responses instead of growing past the replay cache limit', async () => {
    let release!: (value: unknown) => void;
    const barrier = createRealtimeToolBarrier({
      authorizeCall: async () => ({ status: 'allowed' as const }),
      executeCall: async () => await new Promise((resolve) => { release = resolve; }),
      redactResult: (value) => value,
      submitResults: async () => undefined,
      continueResponse: async () => undefined,
      maxResponses: 1,
    });
    const first = barrier.run({ responseId: 'response-1', calls: [call('one', 0)] });
    await expect(barrier.run({
      responseId: 'response-2',
      calls: [{ ...call('two', 0), responseId: 'response-2' }],
    })).rejects.toMatchObject({ code: 'capacity_exceeded' });
    release({ ok: true });
    await expect(first).resolves.toMatchObject({ status: 'submitted' });
  });
});
