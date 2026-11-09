import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpStatusError } from '@/api/client/httpStatusError';
import type { Update } from '@/api/types';
import { createSessionClientRecoveryRuntime } from './createSessionClientRecoveryRuntime';

const axiosGetMock = vi.hoisted(() => vi.fn());

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      get: axiosGetMock,
      isAxiosError: actual.default.isAxiosError,
    },
    get: axiosGetMock,
    isAxiosError: actual.isAxiosError,
  };
});

describe('createSessionClientRecoveryRuntime startup catch-up ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    axiosGetMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function createRuntime(params: Readonly<{
    lastObservedSeq?: number;
    handleUpdate?: (update: Update) => void;
    accountChangesEnabled?: boolean;
    reconcilePendingExecutionRunTarget?: (runId: string) => Promise<void>;
  }> = {}) {
    return createSessionClientRecoveryRuntime({
      mode: 'plain',
      ctx: null,
      token: 'token',
      sessionId: 's1',
      accountChangesEnabled: params.accountChangesEnabled ?? true,
      getClosed: () => false,
      getSessionConnectionSupervisor: () => null,
      getLastObservedMessageSeq: () => params.lastObservedSeq ?? 0,
      handleUpdate: params.handleUpdate ?? (() => {}),
      syncSessionSnapshotFromServer: async () => true,
      applyPendingQueueState: () => {},
      reconcilePendingExecutionRunTarget: params.reconcilePendingExecutionRunTarget,
    });
  }

  it('propagates terminal authentication failure without scheduling a startup retry', async () => {
    axiosGetMock.mockRejectedValue(new HttpStatusError(401, 'expired token'));
    const runtime = createRuntime();

    await expect(runtime.catchUpSessionMessages({ afterSeq: 0 })).rejects.toBeInstanceOf(HttpStatusError);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(axiosGetMock).toHaveBeenCalledTimes(1);
  });

  it('leaves failure recovery to the next explicit catch-up instead of a timer', async () => {
    axiosGetMock
      .mockRejectedValueOnce(new Error('temporary server failure'))
      .mockResolvedValueOnce({ data: { messages: [] } });
    const runtime = createRuntime({ lastObservedSeq: 101 });

    await expect(runtime.catchUpSessionMessages({ afterSeq: 4 })).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(axiosGetMock).toHaveBeenCalledTimes(1);
    await runtime.catchUpSessionMessages({ afterSeq: 4 });

    expect(axiosGetMock).toHaveBeenCalledTimes(2);
    expect(axiosGetMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('afterSeq'))).toEqual(['4', '4']);
  });

  it('rejects a corrupt transcript page without applying its valid neighbors or advancing recovery', async () => {
    axiosGetMock
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            { id: 'm5', seq: 5, createdAt: 5, content: { t: 'plain', v: { role: 'user', content: 'before' } } },
            { id: 'm6', seq: 6, createdAt: 6, content: { t: 'future', value: 'unreadable' } },
            { id: 'm7', seq: 7, createdAt: 7, content: { t: 'plain', v: { role: 'user', content: 'after' } } },
          ],
          nextAfterSeq: 7,
        },
      })
      .mockResolvedValueOnce({ data: { messages: [] } });
    const handleUpdate = vi.fn();
    const runtime = createRuntime({ handleUpdate });

    await expect(runtime.catchUpSessionMessages({ afterSeq: 4 })).rejects.toBeInstanceOf(Error);
    await runtime.catchUpSessionMessages({ afterSeq: 4 });

    expect(handleUpdate).not.toHaveBeenCalled();
    expect(axiosGetMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('afterSeq'))).toEqual(['4', '4']);
  });

  it('reconciles changes once per connect or reconnect and never from elapsed time', async () => {
    axiosGetMock.mockImplementation(async (url: string) => {
      if (new URL(url).pathname === '/v1/account/profile') {
        return { status: 200, data: { id: 'account-1' } };
      }
      if (new URL(url).pathname === '/v2/changes') {
        return { status: 200, data: { changes: [], nextCursor: 0 } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    const runtime = createRuntime();

    await runtime.syncChangesOnConnect({ reason: 'connect' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await runtime.syncChangesOnConnect({ reason: 'reconnect' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(axiosGetMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v2/changes')).toHaveLength(2);
  });

  it('routes durable Pending recipient projection into exact Execution Run reconciliation', async () => {
    axiosGetMock.mockImplementation(async (url: string) => {
      if (new URL(url).pathname === '/v1/account/profile') {
        return { status: 200, data: { id: 'account-1' } };
      }
      if (new URL(url).pathname === '/v2/changes') {
        return {
          status: 200,
          data: {
            changes: [{
              cursor: 1,
              kind: 'session',
              entityId: 's1',
              changedAt: 1,
              hint: {
                pendingCount: 1,
                pendingVersion: 2,
                pendingExecutionRunIds: ['run-offline'],
              },
            }],
            nextCursor: 1,
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    const reconcilePendingExecutionRunTarget = vi.fn(async () => {});
    const runtime = createRuntime({ reconcilePendingExecutionRunTarget });

    await runtime.syncChangesOnConnect({ reason: 'connect' });

    expect(reconcilePendingExecutionRunTarget).toHaveBeenCalledWith('run-offline');
  });

  it('recovers the exact Session transcript on scoped reconnect without Account profile or changes access', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', '0');
    axiosGetMock.mockImplementation(async (url: string) => {
      if (new URL(url).pathname === '/v1/sessions/s1/messages') {
        return { status: 200, data: { messages: [
          { id: 'm18', seq: 18, createdAt: 18, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Continue' } } } },
        ] } };
      }
      return { status: 403, data: {} };
    });
    const updates: unknown[] = [];
    const runtime = createRuntime({ accountChangesEnabled: false, lastObservedSeq: 17, handleUpdate: (update) => updates.push(update) });

    await runtime.syncChangesOnConnect({ reason: 'reconnect' });

    expect(axiosGetMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v1/sessions/s1/messages']);
    expect(new URL(String(axiosGetMock.mock.calls[0][0])).searchParams.get('afterSeq')).toBe('17');
    expect(updates).toEqual([expect.objectContaining({ body: expect.objectContaining({ sid: 's1', message: expect.objectContaining({ id: 'm18' }) }) })]);
  });
});
