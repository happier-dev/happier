import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  createFiniteExecutionRunHostRuntime,
  type AgentExecutionRunEvent,
  type AgentExecutionRunOpenRequest,
  type AgentFiniteExecutionRunProgressEvent,
} from './executionRun.js';

expectTypeOf<
  Readonly<{ kind: 'run-start' }> extends AgentFiniteExecutionRunProgressEvent ? false : true
>().toEqualTypeOf<true>();
expectTypeOf<
  Readonly<{ kind: 'run-complete' }> extends AgentFiniteExecutionRunProgressEvent ? false : true
>().toEqualTypeOf<true>();

function createRequest(runId = 'finite-run'): Extract<AgentExecutionRunOpenRequest, { kind: 'create' }> {
  return {
    kind: 'create',
    runId,
    cwd: '/repo',
    profile: { pluginId: 'happier.review.test', localId: 'review' },
    input: { text: 'Review this.' },
  };
}

describe('createFiniteExecutionRunHostRuntime', () => {
  it('owns start, progress, sequence, replay, unsupported follow-up, and one terminal result', async () => {
    let finish!: () => void;
    const runtime = createFiniteExecutionRunHostRuntime({
      request: createRequest(),
      execute: async ({ emit }) => {
        emit({ kind: 'run-progress' });
        emit({ kind: 'output-delta', channel: 'assistant', text: 'Review result' });
        await new Promise<void>((resolve) => { finish = resolve; });
        return { status: 'complete' };
      },
      mapFailure: () => ({ code: 'review_failed', severity: 'error' }),
      unsupportedSendDiagnostic: { code: 'follow_up_unsupported', severity: 'error' },
    });
    const events: AgentExecutionRunEvent[] = [];
    runtime.watch((event) => events.push(event));

    await expect(runtime.send({ text: 'Again' })).resolves.toEqual({
      status: 'unsupported',
      diagnostic: { code: 'follow_up_unsupported', severity: 'error' },
    });
    finish();
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe('run-complete'));

    expect(events.map((event) => event.kind)).toEqual([
      'run-start',
      'run-progress',
      'output-delta',
      'run-complete',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    const replay: AgentExecutionRunEvent[] = [];
    runtime.watch((event) => replay.push(event));
    expect(replay).toEqual(events);
    await expect(runtime.stop()).resolves.toEqual({ status: 'notRunning' });
  });

  it('maps execution failure once and disposes without replacing the terminal result', async () => {
    const runtime = createFiniteExecutionRunHostRuntime({
      request: createRequest('failed-run'),
      execute: async () => { throw new Error('native failure'); },
      mapFailure: (error) => ({
        code: 'native_review_failed',
        severity: 'error',
        message: error instanceof Error ? error.message : 'failed',
      }),
      unsupportedSendDiagnostic: { code: 'follow_up_unsupported', severity: 'error' },
    });
    const events: AgentExecutionRunEvent[] = [];
    runtime.watch((event) => events.push(event));

    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe('run-failed'));
    await runtime.dispose();
    await runtime.dispose();

    expect(events.map((event) => event.kind)).toEqual(['run-start', 'run-failed']);
    expect(events.at(-1)).toMatchObject({
      diagnostic: { code: 'native_review_failed', message: 'native failure' },
    });
  });

  it('terminalizes a requested stop only after the finite executor confirms cancellation', async () => {
    let observedAbort = false;
    let confirmCancellation!: () => void;
    const cancellationConfirmed = new Promise<void>((resolve) => {
      confirmCancellation = resolve;
    });
    const runtime = createFiniteExecutionRunHostRuntime({
      request: createRequest('cancelled-run'),
      execute: async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
          observedAbort = true;
          resolve();
        }, { once: true }));
        await cancellationConfirmed;
        return { status: 'cancelled' };
      },
      mapFailure: () => ({ code: 'review_failed', severity: 'error' }),
      unsupportedSendDiagnostic: { code: 'follow_up_unsupported', severity: 'error' },
    });
    const events: AgentExecutionRunEvent[] = [];
    runtime.watch((event) => events.push(event));

    await expect(runtime.stop()).resolves.toEqual({ status: 'requested' });
    expect(events.map((event) => event.kind)).toEqual(['run-start']);
    confirmCancellation();
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe('run-cancelled'));
    await runtime.dispose();

    expect(observedAbort).toBe(true);
    expect(events.filter((event) => event.kind === 'run-cancelled')).toHaveLength(1);
  });

  it('uses host retirement as terminal truth without awaiting a noncooperative executor', async () => {
    const runtime = createFiniteExecutionRunHostRuntime({
      request: createRequest('noncooperative-run'),
      execute: async () => await new Promise<never>(() => {}),
      mapFailure: () => ({ code: 'review_failed', severity: 'error' }),
      unsupportedSendDiagnostic: { code: 'follow_up_unsupported', severity: 'error' },
    });
    const events: AgentExecutionRunEvent[] = [];
    runtime.watch((event) => events.push(event));

    await expect(runtime.stop()).resolves.toEqual({ status: 'requested' });
    expect(events.map((event) => event.kind)).toEqual(['run-start']);
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(events.map((event) => event.kind)).toEqual(['run-start', 'run-cancelled']);
  });
});
