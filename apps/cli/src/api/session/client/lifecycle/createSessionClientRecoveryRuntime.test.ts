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
  let retryIndex: number;

  beforeEach(() => {
    vi.useFakeTimers();
    axiosGetMock.mockReset();
    retryIndex = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function createRuntime(params: Readonly<{
    initialAfterSeq?: number;
    lastObservedSeq?: number;
    delays?: readonly number[];
    handleUpdate?: (update: Update) => void;
    accountChangesEnabled?: boolean;
    reconcilePendingExecutionRunTarget?: (runId: string) => Promise<void>;
  }> = {}) {
    return createSessionClientRecoveryRuntime({
      mode: 'plain',
      ctx: null,
      startupMessageCatchUpRetryDelaysMs: params.delays ?? [300, 1_200],
      token: 'token',
      sessionId: 's1',
      accountChangesEnabled: params.accountChangesEnabled ?? true,
      getClosed: () => false,
      getSessionConnectionSupervisor: () => null,
      getCurrentConnectionState: () => ({
        phase: 'online',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
      }),
      getStartedByDaemonProcess: () => true,
      getMetadataStartedBy: () => null,
      getMetadataStartedFromDaemon: () => false,
      getStartupMessageCatchUpRetryIndex: () => retryIndex,
      setStartupMessageCatchUpRetryIndex: (value) => {
        retryIndex = value;
      },
      getStartupMessageCatchUpInitialAfterSeq: () => params.initialAfterSeq ?? 0,
      getStartupMessageCatchUpInitialAfterSeqIsExplicit: () => true,
      getLastObservedMessageSeq: () => params.lastObservedSeq ?? 0,
      handleUpdate: params.handleUpdate ?? (() => {}),
      syncSessionSnapshotFromServer: async () => true,
      applyPendingQueueState: () => {},
      reconcilePendingExecutionRunTarget: params.reconcilePendingExecutionRunTarget,
    });
  }

  it('uses the initial catch-up cursor through the bounded retry window after success', async () => {
    axiosGetMock.mockResolvedValue({ data: { messages: [] } });
    const runtime = createRuntime({ initialAfterSeq: 3, lastObservedSeq: 99 });

    runtime.scheduleNextStartupMessageCatchUpRetry();
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(1_200);

    expect(axiosGetMock).toHaveBeenCalledTimes(2);
    expect(axiosGetMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('afterSeq'))).toEqual(['3', '3']);
  });

  it('stops retrying after terminal authentication failure', async () => {
    axiosGetMock.mockRejectedValue(new HttpStatusError(401, 'expired token'));
    const runtime = createRuntime();

    runtime.scheduleNextStartupMessageCatchUpRetry();
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(1_200);

    expect(axiosGetMock).toHaveBeenCalledTimes(1);
  });

  it('retries non-authentication failures from the same initial cursor', async () => {
    axiosGetMock
      .mockRejectedValueOnce(new Error('temporary server failure'))
      .mockResolvedValueOnce({ data: { messages: [] } });
    const runtime = createRuntime({ initialAfterSeq: 4, lastObservedSeq: 101 });

    runtime.scheduleNextStartupMessageCatchUpRetry();
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(1_200);

    expect(axiosGetMock).toHaveBeenCalledTimes(2);
    expect(axiosGetMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('afterSeq'))).toEqual(['4', '4']);
  });

  it('retries a corrupt transcript page from the original cursor without applying its valid neighbors', async () => {
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
    const runtime = createRuntime({ initialAfterSeq: 4, handleUpdate });

    runtime.scheduleNextStartupMessageCatchUpRetry();
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(1_200);

    expect(handleUpdate).not.toHaveBeenCalled();
    expect(axiosGetMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('afterSeq'))).toEqual(['4', '4']);
  });

  it('reconciles changes once per connect or reconnect and never from elapsed time', async () => {
    axiosGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) {
        return { status: 200, data: { id: 'account-1' } };
      }
      if (url.endsWith('/v2/changes')) {
        return { status: 200, data: { changes: [], nextCursor: 0 } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    const runtime = createRuntime();

    await runtime.syncChangesOnConnect({ reason: 'connect' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await runtime.syncChangesOnConnect({ reason: 'reconnect' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(axiosGetMock.mock.calls.filter(([url]) => String(url).endsWith('/v2/changes'))).toHaveLength(2);
  });

  it('routes durable Pending recipient projection into exact Execution Run reconciliation', async () => {
    axiosGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) {
        return { status: 200, data: { id: 'account-1' } };
      }
      if (url.endsWith('/v2/changes')) {
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
