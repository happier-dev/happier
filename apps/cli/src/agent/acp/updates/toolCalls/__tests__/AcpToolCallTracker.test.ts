import { describe, expect, it, vi } from 'vitest';

import { createAcpToolCallTracker } from '../AcpToolCallTracker';

describe('createAcpToolCallTracker', () => {
  it('publishes fully merged revisions and terminalizes a result-bearing call exactly once', () => {
    const calls: unknown[] = [];
    const results: unknown[] = [];
    const tracker = createAcpToolCallTracker({
      now: () => 100,
      determineToolName: ({ currentName, snapshot }) => snapshot.kind === 'edit' ? 'Edit' : currentName,
      publishCall: (publication) => calls.push(publication),
      publishResult: (publication) => results.push(publication),
    });

    tracker.observe({ toolCallId: 'call-1', title: 'Editing', kind: 'other', status: 'pending' });
    tracker.observe({ toolCallId: 'call-1', kind: 'edit', status: 'in_progress', rawInput: { path: 'a.ts' } });
    tracker.observe(
      { toolCallId: 'call-1', status: 'completed', rawOutput: { ok: true } },
      { terminalResult: { value: { ok: true }, isError: false } },
    );
    tracker.observe(
      { toolCallId: 'call-1', status: 'completed', rawOutput: { ok: false } },
      { terminalResult: { value: { ok: false }, isError: true } },
    );

    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatchObject({
      revision: 2,
      toolName: 'Edit',
      snapshot: {
        title: 'Editing',
        kind: 'edit',
        rawInput: { path: 'a.ts' },
      },
    });
    expect(results).toHaveLength(1);
    expect(tracker.activeSize).toBe(0);
    expect(tracker.isFinalized('call-1')).toBe(true);
  });

  it('does not let a generic provider-hook answer mask a specific standard ACP kind', () => {
    const calls: Array<{ toolName: string }> = [];
    const tracker = createAcpToolCallTracker({
      determineToolName: () => 'other',
      publishCall: (call) => calls.push(call),
      publishResult: () => undefined,
    });

    tracker.observe({ toolCallId: 'call-1', title: 'Preparing', kind: 'other', status: 'pending' });
    tracker.observe({ toolCallId: 'call-1', title: 'Edit', kind: 'edit', status: 'in_progress' });

    expect(calls.at(-1)?.toolName).toBe('edit');
  });

  it('seeds terminal-only calls through the same call publication before the result', () => {
    const order: string[] = [];
    const tracker = createAcpToolCallTracker({
      publishCall: () => order.push('call'),
      publishResult: () => order.push('result'),
    });

    tracker.observe(
      { toolCallId: 'terminal-only', title: 'Read', kind: 'read', status: 'completed' },
      { terminalResult: { value: 'done' } },
    );

    expect(order).toEqual(['call', 'result']);
    expect(tracker.activeSize).toBe(0);
  });

  it('emits one canonical synthetic terminal result for a cancelled call', () => {
    const calls = vi.fn();
    const results = vi.fn();
    const tracker = createAcpToolCallTracker({ publishCall: calls, publishResult: results });

    tracker.observe({ toolCallId: 'cancelled', title: 'Plan', status: 'pending' });
    tracker.observe({ toolCallId: 'cancelled', status: 'cancelled' });

    expect(calls).toHaveBeenCalledTimes(2);
    expect(results).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      callId: 'cancelled',
      isError: true,
      value: { status: 'cancelled' },
    }));
    expect(tracker.activeSize).toBe(0);
  });

  it('re-arms liveness timeout without revising or publishing an identical snapshot', () => {
    const calls = vi.fn();
    const scheduled: Array<() => void> = [];
    const cleared: number[] = [];
    const tracker = createAcpToolCallTracker<number>({
      publishCall: calls,
      publishResult: () => undefined,
      resolveTimeoutMs: () => 100,
      scheduleTimer: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      clearTimer: (timer) => cleared.push(timer),
    });

    expect(tracker.observe({
      toolCallId: 'live',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'a.ts' },
    })).toBe(true);
    expect(tracker.observe({
      toolCallId: 'live',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'a.ts' },
    })).toBe(false);

    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 1 }));
    expect(scheduled).toHaveLength(2);
    expect(cleared).toEqual([1]);
  });

  it('keeps permission-pending calls timeout-free, arms on running, and cleans timeout on terminalization', () => {
    const timers = new Map<number, () => void>();
    const cleared: number[] = [];
    let nextTimer = 1;
    const results = vi.fn();
    const tracker = createAcpToolCallTracker<number>({
      publishCall: () => undefined,
      publishResult: results,
      resolveTimeoutMs: () => 100,
      scheduleTimer: (callback) => {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      clearTimer: (id) => cleared.push(id),
    });

    tracker.observe({ toolCallId: 'permission', title: 'Edit', status: 'pending' });
    expect(timers.size).toBe(0);
    tracker.markRunning('permission');
    expect(timers.size).toBe(1);
    tracker.observe({ toolCallId: 'permission', status: 'completed' }, { terminalResult: { value: 'ok' } });
    expect(cleared).toEqual([1]);

    timers.get(1)?.();
    expect(results).toHaveBeenCalledTimes(1);
  });

  it('merges progress enrichment without leaving an explicit permission wait', () => {
    const timers: Array<() => void> = [];
    const calls: Array<{ snapshot: { status?: unknown; rawInput?: unknown } }> = [];
    const tracker = createAcpToolCallTracker<number>({
      publishCall: (call) => calls.push(call),
      publishResult: () => undefined,
      resolveTimeoutMs: () => 100,
      scheduleTimer: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimer: () => undefined,
    });

    tracker.observe({ toolCallId: 'permission', kind: 'other', status: 'pending' });
    tracker.markWaitingForPermission('permission');
    tracker.observe({
      toolCallId: 'permission',
      kind: 'edit',
      status: 'in_progress',
      rawInput: { path: 'a.ts' },
    });

    expect(calls.at(-1)?.snapshot).toMatchObject({
      status: 'pending',
      rawInput: { path: 'a.ts' },
    });
    expect(timers).toHaveLength(0);

    tracker.markRunning('permission');
    expect(calls.at(-1)?.snapshot.status).toBe('in_progress');
    expect(timers).toHaveLength(1);
  });

  it('times out a stalled running call exactly once and clears all state', () => {
    let timer: (() => void) | null = null;
    const order: string[] = [];
    const calls: unknown[] = [];
    const results = vi.fn();
    const tracker = createAcpToolCallTracker<number>({
      publishCall: (publication) => {
        calls.push(publication);
        order.push('call');
      },
      publishResult: (publication) => {
        results(publication);
        order.push('result');
      },
      resolveTimeoutMs: () => 10,
      scheduleTimer: (callback) => {
        timer = callback;
        return 1;
      },
      clearTimer: () => undefined,
    });
    tracker.observe({ toolCallId: 'stalled', title: 'Read', kind: 'read', status: 'in_progress' });

    const runTimer = timer as (() => void) | null;
    runTimer?.();
    runTimer?.();

    expect(order).toEqual(['call', 'call', 'result']);
    expect(calls.at(-1)).toMatchObject({
      revision: 2,
      snapshot: { status: 'failed' },
    });
    expect(results).toHaveBeenCalledTimes(1);
    expect(results).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'stalled',
      isError: true,
      snapshot: expect.objectContaining({ status: 'failed' }),
      value: expect.objectContaining({ status: 'timeout' }),
    }));
    expect(tracker.activeSize).toBe(0);
  });

  it('bounds finalized tombstones and disposes active timers/state', () => {
    const cleared: number[] = [];
    const tracker = createAcpToolCallTracker<number>({
      publishCall: () => undefined,
      publishResult: () => undefined,
      maxFinalizedCalls: 2,
      resolveTimeoutMs: () => 10,
      scheduleTimer: () => 7,
      clearTimer: (timer) => cleared.push(timer),
    });
    for (const id of ['one', 'two', 'three']) {
      tracker.observe({ toolCallId: id, title: id, status: 'completed' });
    }
    tracker.observe({ toolCallId: 'active', title: 'active', status: 'in_progress' });

    expect(tracker.finalizedSize).toBe(2);
    expect(tracker.isFinalized('one')).toBe(false);
    tracker.dispose();
    expect(cleared).toContain(7);
    expect(tracker.activeSize).toBe(0);
    expect(tracker.finalizedSize).toBe(0);
  });

  it('abandons unresolved turn calls with canonical results, retains late-update tombstones, and resets for a new session', () => {
    const results = vi.fn();
    const calls = vi.fn();
    const tracker = createAcpToolCallTracker({
      publishCall: calls,
      publishResult: results,
    });
    tracker.observe({ toolCallId: 'pending-plan', title: 'Create Plan', status: 'pending' });
    tracker.observe({ toolCallId: 'running-read', title: 'Read', status: 'in_progress' });

    expect(tracker.abandonTurn()).toEqual(['pending-plan', 'running-read']);
    expect(tracker.activeSize).toBe(0);
    expect(tracker.isFinalized('pending-plan')).toBe(true);
    expect(tracker.observe({ toolCallId: 'pending-plan', status: 'completed' })).toBe(false);
    expect(results.mock.calls.map(([result]) => result)).toEqual([
      expect.objectContaining({ callId: 'pending-plan', isError: true, value: { status: 'abandoned' } }),
      expect.objectContaining({ callId: 'running-read', isError: true, value: { status: 'abandoned' } }),
    ]);

    tracker.reset();
    expect(tracker.finalizedSize).toBe(0);
    expect(tracker.observe({ toolCallId: 'pending-plan', title: 'New turn', status: 'pending' })).toBe(true);
  });

  it('cancels every active call with canonical results and exposes stable active ids', () => {
    const calls: Array<{ callId: string; snapshot: { status?: unknown } }> = [];
    const tracker = createAcpToolCallTracker({
      publishCall: (call) => calls.push(call),
      publishResult: () => undefined,
    });
    tracker.observe({ toolCallId: 'first', title: 'First', status: 'pending' });
    tracker.observe({ toolCallId: 'second', title: 'Second', status: 'in_progress' });
    expect(tracker.activeCallIds()).toEqual(['first', 'second']);

    expect(tracker.cancelAll()).toEqual(['first', 'second']);

    expect(tracker.activeCallIds()).toEqual([]);
    expect(calls.slice(-2)).toEqual([
      expect.objectContaining({ callId: 'first', snapshot: expect.objectContaining({ status: 'cancelled' }) }),
      expect.objectContaining({ callId: 'second', snapshot: expect.objectContaining({ status: 'cancelled' }) }),
    ]);
  });

  it('reports closure only after removing the record so orchestration observes the final active count', () => {
    const closed: Array<{ callId: string; reason: string; activeSize: number }> = [];
    let tracker: ReturnType<typeof createAcpToolCallTracker>;
    tracker = createAcpToolCallTracker({
      publishCall: () => undefined,
      publishResult: () => undefined,
      onCallClosed: ({ callId, reason }) => {
        closed.push({ callId, reason, activeSize: tracker.activeSize });
      },
    });

    tracker.observe({ toolCallId: 'done', status: 'completed' });
    tracker.observe({ toolCallId: 'cancelled', status: 'in_progress' });
    tracker.cancel('cancelled');
    tracker.observe({ toolCallId: 'abandoned', status: 'pending' });
    expect(tracker.abandonTurn()).toEqual(['abandoned']);

    expect(closed).toEqual([
      { callId: 'done', reason: 'terminal', activeSize: 0 },
      { callId: 'cancelled', reason: 'cancelled', activeSize: 0 },
      { callId: 'abandoned', reason: 'abandoned', activeSize: 0 },
    ]);
  });

  it('revises active and bounded finalized calls from provider-neutral enrichment without reopening or duplicating results', () => {
    const calls: Array<{
      callId: string;
      toolName: string;
      revision: number;
      snapshot: { status?: unknown; title?: unknown; rawInput?: unknown; _meta?: unknown };
    }> = [];
    const results = vi.fn();
    const tracker = createAcpToolCallTracker({
      determineToolName: ({ currentName }) => currentName,
      publishCall: (call) => calls.push(call),
      publishResult: results,
    });

    tracker.observe({ toolCallId: 'opaque\n task ID ', kind: 'other', status: 'in_progress' });
    expect(tracker.enrich('opaque\n task ID ', {
      toolName: 'Task',
      title: 'Explore repository',
      rawInput: { description: 'Explore repository' },
      metadata: { providerObservation: { completionOnly: true } },
    })).toBe('applied');

    tracker.observe({ toolCallId: 'opaque\n task ID ', status: 'completed' });
    expect(results).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'opaque\n task ID ',
      isError: false,
      value: { status: 'completed' },
    }));
    expect(calls.at(-1)).toMatchObject({
      callId: 'opaque\n task ID ',
      toolName: 'Task',
      revision: 3,
      snapshot: {
        status: 'completed',
        title: 'Explore repository',
        rawInput: { description: 'Explore repository' },
        _meta: { providerObservation: { completionOnly: true } },
      },
    });

    expect(tracker.enrich('opaque\n task ID ', {
      toolName: 'Task',
      title: 'Explore repository (completed)',
      rawInput: { description: 'Explore repository (completed)' },
      metadata: { providerObservation: { completionOnly: true, durationMs: 42 } },
    })).toBe('applied');
    expect(calls.at(-1)).toMatchObject({
      callId: 'opaque\n task ID ',
      toolName: 'Task',
      revision: 4,
      snapshot: {
        status: 'completed',
        title: 'Explore repository (completed)',
      },
    });
    expect(tracker.activeSize).toBe(0);
    expect(tracker.isFinalized('opaque\n task ID ')).toBe(true);
    expect(results).toHaveBeenCalledTimes(1);
  });

  it('queues out-of-order enrichment until a terminal-only call establishes correlation and dedupes repeated delivery', () => {
    const calls = vi.fn();
    const results = vi.fn();
    const tracker = createAcpToolCallTracker({
      publishCall: calls,
      publishResult: results,
      maxPendingEnrichments: 2,
    });
    const enrichment = {
      toolName: 'Task',
      title: 'Completion-only task',
      rawInput: { description: 'Completion-only task' },
      metadata: { providerObservation: { completionOnly: true } },
    } as const;

    expect(tracker.enrich('task-before-terminal', enrichment)).toBe('queued');
    expect(tracker.enrich('task-before-terminal', enrichment)).toBe('duplicate');
    expect(tracker.pendingEnrichmentSize).toBe(1);
    expect(calls).not.toHaveBeenCalled();

    tracker.observe({ toolCallId: 'task-before-terminal', kind: 'other', status: 'completed' });

    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'task-before-terminal',
      toolName: 'Task',
      snapshot: expect.objectContaining({
        status: 'completed',
        title: 'Completion-only task',
        rawInput: { description: 'Completion-only task' },
      }),
    }));
    expect(results).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'task-before-terminal',
      isError: false,
      value: { status: 'completed' },
    }));
    expect(tracker.pendingEnrichmentSize).toBe(0);

    expect(tracker.enrich('task-before-terminal', enrichment)).toBe('duplicate');
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('bounds and clears uncorrelated enrichment without publishing calls across eviction, reset, or disposal', () => {
    const calls = vi.fn();
    const tracker = createAcpToolCallTracker({
      publishCall: calls,
      publishResult: () => undefined,
      maxPendingEnrichments: 2,
    });
    const enrichment = (description: string) => ({
      toolName: 'Task',
      rawInput: { description },
    });

    expect(tracker.enrich('one', enrichment('one'))).toBe('queued');
    expect(tracker.enrich('two', enrichment('two'))).toBe('queued');
    expect(tracker.enrich('three', enrichment('three'))).toBe('queued');
    expect(tracker.pendingEnrichmentSize).toBe(2);
    expect(calls).not.toHaveBeenCalled();

    tracker.observe({ toolCallId: 'one', status: 'completed' });
    expect(calls).toHaveBeenLastCalledWith(expect.objectContaining({
      callId: 'one',
      toolName: 'unknown',
    }));

    tracker.reset();
    expect(tracker.pendingEnrichmentSize).toBe(0);
    expect(tracker.enrich('after-reset', enrichment('after-reset'))).toBe('queued');
    tracker.dispose();
    expect(tracker.pendingEnrichmentSize).toBe(0);
    expect(tracker.enrich('after-dispose', enrichment('after-dispose'))).toBe('ignored');
  });
});
