import { describe, expect, it, vi } from 'vitest';

import {
  ExecutionRunStartResponseSchema,
  ExecutionRunWaitResultSchema,
} from './responseSchemas.js';
import { waitForExecutionRunTerminal } from './waitForTerminal.js';

describe('waitForExecutionRunTerminal', () => {
  it('times out observation rather than claiming initial terminal success while custody is pending', async () => {
    vi.useFakeTimers();
    try {
      const wait = waitForExecutionRunTerminal({ runId: 'run_1', timeoutMs: 50,
        readRun: async () => ({ ok: true as const, data: { run: { status: 'succeeded' } } }),
        waitForTerminal: async (_id, signal) => await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })),
      });
      await vi.advanceTimersByTimeAsync(50);
      await expect(wait).resolves.toMatchObject({ disposition: 'observation_timeout' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('parks on wire-equivalent snapshots despite property reordering and omitted undefined fields', async () => {
    vi.useFakeTimers();
    try {
      const data = { run: { status: 'running', attention: undefined, note: { first: 1, second: 2 } } };
      const wait = waitForExecutionRunTerminal({ runId: 'run_1', timeoutMs: 50, condition: 'change',
        after: { run: { note: { second: 2, first: 1 }, status: 'running' } },
        readRun: async () => ({ ok: true as const, data }), waitForTerminal: async () => {},
        waitForChange: async (_id, signal) => await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })),
      });
      await vi.advanceTimersByTimeAsync(50);
      await expect(wait).resolves.toMatchObject({ disposition: 'observation_timeout' });
    } finally { vi.useRealTimers(); }
  });
  it('keeps combined terminal resolution behind the existing terminal owner barrier', async () => {
    vi.useFakeTimers();
    let releaseTerminal = () => {};
    try {
      let status = 'running';
      const terminal = new Promise<void>((resolve) => { releaseTerminal = resolve; });
      let resolved = false;
      const wait = waitForExecutionRunTerminal({ runId: 'run_1', timeoutMs: null,
        condition: 'terminal_or_needs_attention', readRun: async () => ({ ok: true as const, data: { run: { status } } }),
        waitForTerminal: async () => await terminal,
        waitForChange: async (_id, signal) => {
          status = 'succeeded';
          await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
        },
      }).then((result) => { resolved = true; return result; });
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);
      releaseTerminal();
      await expect(wait).resolves.toMatchObject({ status: 'succeeded', result: { run: { status: 'succeeded' } } });
    } finally { releaseTerminal(); vi.useRealTimers(); }
  });
  it('reports the actual terminal snapshot when an attention-only condition expires unmatched', async () => {
    vi.useFakeTimers();
    try {
      const data = { run: { status: 'succeeded' } };
      const wait = waitForExecutionRunTerminal({ runId: 'run_1', timeoutMs: 50,
        condition: 'needs_attention', readRun: async () => ({ ok: true as const, data }),
        waitForTerminal: async () => {}, waitForChange: async (_id, signal) =>
          await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) });
      await vi.advanceTimersByTimeAsync(50);
      await expect(wait).resolves.toMatchObject({ status: 'succeeded', disposition: 'observation_timeout', result: data });
    } finally { vi.useRealTimers(); }
  });
  it.each(['permission_required', 'user_action_required'] as const)('matches %s from the same change source', async (kind) => {
    vi.useFakeTimers();
    try {
      let data = { run: { status: 'running', attention: undefined as undefined | { kind: typeof kind; requestIds: string[] } } };
      const listeners = new Set<() => void>();
      const waitForChange = (_id: string, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal?.reason); };
        const cleanup = () => { listeners.delete(wake); signal?.removeEventListener('abort', abort); };
        listeners.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
      });
      const readRun = async () => ({ ok: true as const, data });
      const waitForTerminal = async () => { throw new Error('attention must use changes'); };
      const attention = waitForExecutionRunTerminal({ runId: 'run_1', timeoutMs: 50,
        condition: 'needs_attention', readRun, waitForChange, waitForTerminal });
      await vi.advanceTimersByTimeAsync(0);
      data = { run: { status: 'running', attention: { kind, requestIds: ['request_1'] } } };
      for (const wake of [...listeners]) wake();
      await vi.advanceTimersByTimeAsync(50);
      await expect(attention).resolves.toMatchObject({ status: 'running', disposition: 'needs_attention', result: data });
      expect(listeners.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('returns initial and changed snapshots and closes the read/subscribe race without polling', async () => {
    vi.useFakeTimers();
    try {
      let status = 'running';
      const readRun = vi.fn(async () => ({ ok: true as const, data: { run: { status } } }));
      const waitForTerminal = async () => { throw new Error('snapshot must use changes'); };
      const initial = await waitForExecutionRunTerminal({ runId: 'run_1', timeoutMs: null,
        condition: 'change', readRun, waitForTerminal, waitForChange: async () => {} });
      expect(initial).toMatchObject({ disposition: 'snapshot', result: { run: { status: 'running' } } });
      const waitForChange = vi.fn(async (_id: string, signal?: AbortSignal) => {
        status = 'succeeded'; // Changed while arming, with no retained wake.
        await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      });
      const changed = await waitForExecutionRunTerminal({ runId: 'run_1', timeoutMs: null,
        condition: 'change', after: { run: { status: 'running' } }, readRun, waitForTerminal, waitForChange });
      expect(changed).toMatchObject({ disposition: 'snapshot', result: { run: { status: 'succeeded' } } });
      expect(waitForChange).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('re-arms a 30-day observation deadline at the Node timer boundary without timing out early', async () => {
    vi.useFakeTimers();
    try {
      const durationMs = 30 * 24 * 60 * 60 * 1000;
      const readRun = vi.fn(async () => ({ ok: true as const, data: { run: { status: 'running' } } }));
      let settled = false;
      const wait = waitForExecutionRunTerminal({ runId: 'run_1', timeoutMs: durationMs, readRun,
        waitForTerminal: async () => await new Promise<void>(() => {}) }).then((value) => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(durationMs - 1);
      expect(settled).toBe(false);
      expect(readRun).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(wait).resolves.toMatchObject({ disposition: 'observation_timeout', timeoutMs: durationMs });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each(['permission_required', 'user_action_required'] as const)('parses public %s wait results', (kind) => {
    const run = {
      runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1', intent: 'plan',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: 1,
    };
    const attention = { ok: true, status: 'running', disposition: 'needs_attention',
      result: { run: { ...run, attention: { kind, requestIds: ['request_1'] } } } };
    expect(ExecutionRunWaitResultSchema.safeParse(attention).success).toBe(true);
    expect(ExecutionRunWaitResultSchema.safeParse({ ...attention, result: { run } }).success).toBe(false);
    expect(ExecutionRunWaitResultSchema.safeParse({ ...attention, result: { run: { ...attention.result.run, status: 'succeeded' } } }).success).toBe(false);
    const snapshot = { ok: true, status: 'running', disposition: 'snapshot', result: { run } };
    expect(ExecutionRunWaitResultSchema.safeParse(snapshot).success).toBe(true);
    expect(ExecutionRunWaitResultSchema.safeParse({ ...snapshot, status: 'failed' }).success).toBe(false);
    const unmatched = { ok: true, status: 'succeeded', disposition: 'observation_timeout', runId: run.runId,
      timeoutMs: 50, observedAtMs: 51, deadlineAtMs: 51, result: { run: { ...run, status: 'succeeded' } } };
    expect(ExecutionRunWaitResultSchema.safeParse(unmatched).success).toBe(true);
    expect(ExecutionRunWaitResultSchema.safeParse({ ...unmatched, result: { run } }).success).toBe(false);
    expect(ExecutionRunStartResponseSchema.safeParse({
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      wait: {
        ok: true,
        status: 'succeeded',
        result: { notTheCanonicalWaitResult: true },
      },
    }).success).toBe(false);
    expect(ExecutionRunWaitResultSchema.safeParse({
      ok: true,
      status: 'succeeded',
      result: { run: { runId: 'run_1', status: 'running' } },
    }).success).toBe(false);
  });

  it('observes the same run until its terminal result without controlling it', async () => {
    const readRun = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, data: { run: { status: 'running' } } })
      .mockResolvedValueOnce({ ok: true as const, data: { run: { status: 'succeeded', result: { ok: true } } } });
    const waitForTerminal = vi.fn(async () => undefined);

    await expect(waitForExecutionRunTerminal({
      runId: 'run_1',
      timeoutMs: null,
      readRun,
      waitForTerminal,
    })).resolves.toEqual({
      ok: true,
      status: 'succeeded',
      result: { run: { status: 'succeeded', result: { ok: true } } },
    });

    expect(readRun).toHaveBeenNthCalledWith(1, { runId: 'run_1' });
    expect(readRun).toHaveBeenNthCalledWith(2, { runId: 'run_1' });
    expect(waitForTerminal).toHaveBeenCalledOnce();
    expect(waitForTerminal).toHaveBeenCalledWith('run_1', expect.any(AbortSignal));
  });

  it('uses an observation timer without polling while the terminal event is pending', async () => {
    vi.useFakeTimers();
    let now = 0;
    const readRun = vi.fn(async () => ({ ok: true as const, data: { run: { status: 'running' } } }));
    const waitForTerminal = vi.fn(async (_runId: string, _signal?: AbortSignal) => await new Promise<void>(() => {}));

    const wait = waitForExecutionRunTerminal({
      runId: 'run_1',
      timeoutMs: 1_000,
      readRun,
      waitForTerminal,
      now: () => now,
    });
    now = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(wait).resolves.toMatchObject({ status: 'running', disposition: 'observation_timeout' });
    expect(readRun).toHaveBeenCalledTimes(2);
    expect(waitForTerminal).toHaveBeenCalledOnce();
    expect(waitForTerminal.mock.calls[0]?.[1]?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('ends only its observation at timeout and preserves typed read failures', async () => {
    let now = 0;
    const runningRead = vi.fn(async () => ({ ok: true as const, data: { run: { status: 'running' } } }));
    const waitForTerminal = vi.fn(async () => await new Promise<void>(() => {}));

    vi.useFakeTimers();
    const wait = waitForExecutionRunTerminal({
      runId: 'run_1',
      timeoutMs: 50,
      readRun: runningRead,
      waitForTerminal,
      now: () => now,
    });
    now = 51;
    await vi.advanceTimersByTimeAsync(50);
    await expect(wait).resolves.toEqual({
      ok: true,
      status: 'running',
      disposition: 'observation_timeout',
      runId: 'run_1',
      timeoutMs: 50,
      observedAtMs: 51,
      deadlineAtMs: 50,
    });
    expect(runningRead).toHaveBeenCalledTimes(2);
    vi.useRealTimers();

    expect(ExecutionRunWaitResultSchema.safeParse({
      ok: true,
      status: 'running',
      disposition: 'observation_timeout',
      runId: 'run_1',
      timeoutMs: 50,
      observedAtMs: 51,
      deadlineAtMs: 50,
    }).success).toBe(true);

    const failedRead = vi.fn(async () => ({
      ok: false as const,
      code: 'execution_run_target_unavailable',
      message: 'machine disconnected',
    }));
    await expect(waitForExecutionRunTerminal({
      runId: 'run_1',
      timeoutMs: null,
      readRun: failedRead,
      waitForTerminal,
    })).resolves.toEqual({
      ok: false,
      code: 'execution_run_target_unavailable',
      message: 'machine disconnected',
    });
  });

  it('does not miss cancellation that happens while reading the initial snapshot', async () => {
    const controller = new AbortController();
    const readRun = vi.fn(async () => {
      controller.abort();
      return { ok: true as const, data: { run: { status: 'running' } } };
    });
    const waitForTerminal = vi.fn(async () => await new Promise<void>(() => {}));

    await expect(waitForExecutionRunTerminal({
      runId: 'run_1',
      timeoutMs: null,
      signal: controller.signal,
      readRun,
      waitForTerminal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(readRun).toHaveBeenCalledOnce();
    expect(waitForTerminal).not.toHaveBeenCalled();
  });
});
