import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRuntimeActivitySnapshotRequestSchema } from '@happier-dev/protocol/sessions/runtime/activity/transport';

import { updateSessionRuntimeActivityProjectionWithAck } from './stateUpdates';

describe('runtime activity projection acknowledgements', () => {
  afterEach(() => vi.useRealTimers());

  function startWrite(socket: { emitWithAck: (event: string, payload: unknown) => Promise<unknown> }, signal?: AbortSignal) {
    return updateSessionRuntimeActivityProjectionWithAck({ socket, signal, sessionId: 's1',
      mutationId: 'runtime-activity-snapshot:s1', state: 'active', runtimeActivityActiveCount: 1 });
  }

  it('keeps publication pending until the containing server operation acknowledges', async () => {
    vi.useFakeTimers();
    let acknowledge!: (response: unknown) => void;
    const socket = { emitWithAck: vi.fn(() => new Promise<unknown>((resolve) => { acknowledge = resolve; })) };
    let settled = false;
    const result = startWrite(socket).then(value => { settled = true; return value; }, error => { settled = true; throw error; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    // A shorter transport timer must not retry a write the server still owns.
    expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
    acknowledge({ status: 'applied', sessionId: 's1', mutationId: 'runtime-activity-snapshot:s1',
      projection: { state: 'active', activeCount: 1, observedAt: 1_000, revision: 1 } });
    await expect(result).resolves.toMatchObject({ disposition: 'applied' });
  });

  it('cancels publication at Session disposal without retrying it', async () => {
    vi.useFakeTimers();
    const cancellation = new AbortController();
    const socket = { emitWithAck: vi.fn(() => new Promise<unknown>(() => {})) };
    let rejection: unknown;
    const result = startWrite(socket, cancellation.signal).catch(error => { rejection = error; });
    await vi.advanceTimersByTimeAsync(0);
    cancellation.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(rejection).toMatchObject({ name: 'SocketAckAbortError', retryable: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
    await result;
  });

  it('sends runtime activity through its public projection socket mutation only', async () => {
    const emitWithAck = vi.fn(async (_event: string, rawPayload: unknown) => {
      const payload = SessionRuntimeActivitySnapshotRequestSchema.parse(rawPayload);
      return {
        status: 'applied',
        sessionId: payload.sessionId,
        mutationId: payload.mutationId,
        projection: {
          state: payload.snapshot.state,
          activeCount: payload.snapshot.activeCount,
          observedAt: 1_000,
          revision: 1,
        },
      };
    });

    const result = await updateSessionRuntimeActivityProjectionWithAck({
      socket: { emitWithAck },
      sessionId: 's1',
      mutationId: 'runtime-activity-snapshot:s1',
      state: 'active',
      runtimeActivityActiveCount: 1,
    });

    expect(result).toEqual({ disposition: 'applied', projection: {
      runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000, runtimeActivityRevision: 1,
    } });
    expect(emitWithAck).toHaveBeenCalledWith('session-runtime-activity-snapshot', {
      sessionId: 's1',
      mutationId: 'runtime-activity-snapshot:s1',
      snapshot: {
        state: 'active',
        activeCount: 1,
      },
    });
    const [, payload] = emitWithAck.mock.calls[0]!;
    expect(payload).not.toHaveProperty('thinking');
    expect(payload).not.toHaveProperty('activeAt');
    expect(payload).not.toHaveProperty('latestTurnStatus');
    expect(payload).not.toHaveProperty('meaningfulActivityAt');
    expect(payload).not.toHaveProperty('metadata');
    expect(payload).not.toHaveProperty('agentState');
  });

  it('raises a typed retryable error when runtime activity projection writes fail', async () => {
    const socket = {
      emitWithAck: vi.fn(async () => ({
        result: 'error',
        error: 'internal',
      })),
    };

    await expect(updateSessionRuntimeActivityProjectionWithAck({
      socket,
      sessionId: 's1',
      mutationId: 'runtime-activity-snapshot:s1',
      state: 'active',
      runtimeActivityActiveCount: 1,
    })).rejects.toMatchObject({
      code: 'runtime_activity_update_failed',
      retryable: true,
    });
  });

  it.each(['archived', 'superseded', 'unauthorized', 'not_found', 'revision_overflow', 'invalid_request'] as const)(
    'preserves the terminal Home refusal %s without retrying the same publication', async reason => {
      const socket = { emitWithAck: vi.fn(async () => reason === 'invalid_request'
        ? { status: 'rejected', reason }
        : { status: 'rejected', reason, sessionId: 's1', mutationId: 'runtime-activity-snapshot:s1' }) };
      await expect(startWrite(socket)).rejects.toMatchObject({
        name: 'SessionRuntimeActivitySnapshotRejectedError', code: 'runtime_activity_update_failed', reason, retryable: false,
      });
      expect(socket.emitWithAck).toHaveBeenCalledOnce();
    },
  );

  it('keeps an unrelated rejection from refusing this publication', async () => {
    vi.useFakeTimers();
    const socket = { emitWithAck: vi.fn()
      .mockResolvedValueOnce({ status: 'rejected', reason: 'archived', sessionId: 'other-session', mutationId: 'other-mutation' })
      .mockResolvedValue({ status: 'applied', sessionId: 's1', mutationId: 'runtime-activity-snapshot:s1',
        projection: { state: 'active', activeCount: 1, observedAt: 1_000, revision: 1 } }) };
    const result = startWrite(socket);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ disposition: 'applied' });
  });
});
