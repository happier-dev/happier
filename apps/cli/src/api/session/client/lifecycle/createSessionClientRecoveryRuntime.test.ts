import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpStatusError } from '@/api/client/httpStatusError';
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

vi.mock('@/persistence', () => ({
  readAccountChangesCursor: vi.fn(async () => 0),
}));

describe('createSessionClientRecoveryRuntime startup catch-up ownership', () => {
  let retryIndex: number;

  beforeEach(() => {
    vi.useFakeTimers();
    axiosGetMock.mockReset();
    retryIndex = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createRuntime(params: Readonly<{
    initialAfterSeq?: number;
    lastObservedSeq?: number;
    delays?: readonly number[];
  }> = {}) {
    return createSessionClientRecoveryRuntime({
      startupMessageCatchUpRetryDelaysMs: params.delays ?? [300, 1_200],
      token: 'token',
      sessionId: 's1',
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
      handleUpdate: () => {},
      syncSessionSnapshotFromServer: async () => true,
      applyPendingQueueState: () => {},
    });
  }

  it('uses the initial catch-up cursor and stops after success', async () => {
    axiosGetMock.mockResolvedValue({ data: { messages: [] } });
    const runtime = createRuntime({ initialAfterSeq: 3, lastObservedSeq: 99 });

    runtime.scheduleNextStartupMessageCatchUpRetry();
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(1_200);

    expect(axiosGetMock).toHaveBeenCalledTimes(1);
    expect(axiosGetMock.mock.calls[0]?.[1]).toMatchObject({ params: { afterSeq: 3 } });
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
    expect(axiosGetMock.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ afterSeq: 4 }) }),
      expect.objectContaining({ params: expect.objectContaining({ afterSeq: 4 }) }),
    ]);
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
});
