import { describe, expect, it, vi } from 'vitest';

import { readExecutionRunLinkV1 } from '@happier-dev/protocol';

import { createExecutionRunChildReporter } from './executionRunChildReporter';

const link = { v: 1 as const, parentSessionId: 'lead', runId: 'run_1', turnEpoch: 0 };

function harness(responses: Array<'accepted' | 'throw' | 'run_terminal'>) {
  let metadata: Record<string, unknown> = { executionRunLinkV1: link };
  const calls: Array<{ parentSessionId: string; request: Record<string, unknown> }> = [];
  const reporter = createExecutionRunChildReporter({
    sessionId: 'child_1',
    readMetadata: () => metadata,
    updateMetadata: async (updater) => {
      metadata = updater(metadata);
    },
    reportToParent: async (parentSessionId, request) => {
      calls.push({ parentSessionId, request: request as Record<string, unknown> });
      const next = responses.shift() ?? 'accepted';
      if (next === 'throw') throw new Error('relay unavailable');
      return next === 'accepted' ? { ok: true, accepted: true } : { ok: true, accepted: false, reason: 'run_terminal' };
    },
    getNowMs: () => 50,
    retryDelaysMs: [0, 0],
  });
  return { reporter, calls, metadata: () => metadata, setMetadata: (next: Record<string, unknown>) => { metadata = next; } };
}

describe('createExecutionRunChildReporter', () => {
  it('sends the linked handshake once per link and nothing for an unlinked session', async () => {
    const t = harness([]);
    await t.reporter.onMetadataObserved();
    await t.reporter.onMetadataObserved();
    expect(t.calls).toEqual([{ parentSessionId: 'lead', request: { runId: 'run_1', linkedSessionId: 'child_1', turnEpoch: 0, kind: 'linked' } }]);
    const unlinked = harness([]);
    unlinked.setMetadata({});
    await unlinked.reporter.onMetadataObserved();
    await unlinked.reporter.onTurnCompleted();
    expect(unlinked.calls).toHaveLength(0);
  });

  it('reports each completed turn with a monotonic epoch and records the accepted ack from the RPC outcome', async () => {
    const t = harness([]);
    await t.reporter.onMetadataObserved();
    await t.reporter.onTurnCompleted();
    await t.reporter.onTurnCompleted();
    expect(t.calls.slice(1).map((call) => call.request.turnEpoch)).toEqual([1, 2]);
    expect(readExecutionRunLinkV1(t.metadata())?.report).toEqual({ turnEpoch: 2, reportedAt: 50, ack: 'accepted', attempts: 1 });
  });

  it('retries a failed report with backoff and records a failed ack when every attempt fails', async () => {
    const t = harness(['accepted', 'throw', 'throw', 'throw']);
    await t.reporter.onMetadataObserved();
    await t.reporter.onTurnCompleted();
    expect(t.calls).toHaveLength(4);
    expect(readExecutionRunLinkV1(t.metadata())?.report).toEqual({ turnEpoch: 1, reportedAt: 50, ack: 'failed', attempts: 3 });
  });

  it('records a pending ack while retrying and accepted once a retry lands', async () => {
    const t = harness(['accepted', 'throw', 'accepted']);
    await t.reporter.onMetadataObserved();
    await t.reporter.onTurnCompleted();
    expect(readExecutionRunLinkV1(t.metadata())?.report).toEqual({ turnEpoch: 1, reportedAt: 50, ack: 'accepted', attempts: 2 });
  });

  it('leaves the record unchanged when the parent no longer accepts turns for the run', async () => {
    const t = harness(['accepted', 'accepted', 'run_terminal']);
    await t.reporter.onMetadataObserved();
    await t.reporter.onTurnCompleted();
    await t.reporter.onTurnCompleted();
    expect(readExecutionRunLinkV1(t.metadata())?.report).toEqual({ turnEpoch: 1, reportedAt: 50, ack: 'accepted', attempts: 1 });
  });

  it('resumes its epoch from its own report record after a restart so a live parent accepts the next turn', async () => {
    const t = harness([]);
    t.setMetadata({ executionRunLinkV1: { ...link, turnEpoch: 2, report: { turnEpoch: 5, reportedAt: 40, ack: 'accepted', attempts: 1 } } });
    await t.reporter.onMetadataObserved();
    await t.reporter.onTurnCompleted();
    expect(t.calls.map((call) => [call.request.kind, call.request.turnEpoch])).toEqual([['linked', 5], ['turn_completed', 6]]);
  });

  it('reports a failed child turn with its status, and a completed turn without one', async () => {
    const t = harness([]);
    await t.reporter.onMetadataObserved();
    await t.reporter.onTurnCompleted({ turnStatus: 'failed' });
    await t.reporter.onTurnCompleted();
    expect(t.calls.slice(1).map((call) => call.request)).toEqual([
      { runId: 'run_1', linkedSessionId: 'child_1', turnEpoch: 1, kind: 'turn_completed', turnStatus: 'failed' },
      { runId: 'run_1', linkedSessionId: 'child_1', turnEpoch: 2, kind: 'turn_completed' },
    ]);
  });

  it('abandons a waiting retry when a newer turn completes, so the newer report goes out at once', async () => {
    let metadata: Record<string, unknown> = { executionRunLinkV1: link };
    const calls: Array<Record<string, unknown>> = [];
    const responses: Array<'accepted' | 'throw'> = ['accepted', 'throw', 'accepted'];
    const reporter = createExecutionRunChildReporter({
      sessionId: 'child_1',
      readMetadata: () => metadata,
      updateMetadata: async (updater) => { metadata = updater(metadata); },
      reportToParent: async (_parent, request) => {
        calls.push(request as Record<string, unknown>);
        if (responses.shift() === 'throw') throw new Error('relay unavailable');
        return { ok: true, accepted: true };
      },
      getNowMs: () => 50,
      retryDelaysMs: [60_000],
    });
    await reporter.onMetadataObserved();
    void reporter.onTurnCompleted();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await reporter.onTurnCompleted();
    expect(calls.map((call) => call.turnEpoch)).toEqual([0, 1, 2]);
    expect(readExecutionRunLinkV1(metadata)?.report).toEqual({ turnEpoch: 2, reportedAt: 50, ack: 'accepted', attempts: 1 });
  });

  it('starts a new epoch count and handshake when a new run links the same child', async () => {
    const t = harness([]);
    await t.reporter.onMetadataObserved();
    await t.reporter.onTurnCompleted();
    t.setMetadata({ executionRunLinkV1: { ...link, runId: 'run_2' } });
    await t.reporter.onMetadataObserved();
    await t.reporter.onTurnCompleted();
    expect(t.calls.map((call) => [call.request.runId, call.request.kind, call.request.turnEpoch])).toEqual([
      ['run_1', 'linked', 0], ['run_1', 'turn_completed', 1], ['run_2', 'linked', 0], ['run_2', 'turn_completed', 1],
    ]);
  });
});
