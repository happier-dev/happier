import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
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

function createSecretAxiosError(): AxiosError {
  return new AxiosError('Recovery lookup failed Authorization: Bearer MESSAGE_SECRET', 'ERR_NETWORK', {
    method: 'get',
    url: 'https://api.example.test/v2/sessions/s1/messages/by-local-id/local-1?token=QUERY_SECRET',
    headers: new AxiosHeaders({ Authorization: 'Bearer HEADER_SECRET' }),
    data: { access_token: 'BODY_SECRET' },
  });
}

describe('createSessionClientRecoveryRuntime diagnostics', () => {
  beforeEach(() => {
    axiosGetMock.mockReset();
    vi.restoreAllMocks();
  });

  it('redacts transcript recovery fetch failures before logging', async () => {
    axiosGetMock.mockRejectedValue(createSecretAxiosError());
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    const runtime = createSessionClientRecoveryRuntime({
      startupMessageCatchUpRetryDelaysMs: [],
      token: 'token-1',
      sessionId: 's1',
      getClosed: () => false,
      getSessionConnectionSupervisor: () => null,
      getCurrentConnectionState: () => ({ phase: 'connected' }) as never,
      getStartedByDaemonProcess: () => false,
      getMetadataStartedBy: () => null,
      getMetadataStartedFromDaemon: () => null,
      getStartupMessageCatchUpRetryIndex: () => 0,
      setStartupMessageCatchUpRetryIndex: vi.fn(),
      getStartupMessageCatchUpInitialAfterSeq: () => 0,
      getStartupMessageCatchUpInitialAfterSeqIsExplicit: () => false,
      getLastObservedMessageSeq: () => 0,
      getHasMaterializedLocalId: () => true,
      deleteMaterializedLocalId: vi.fn(),
      handleUpdate: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(),
      applyPendingQueueState: vi.fn(),
    });

    await expect(runtime.recoverMaterializedLocalId('local-1', {
      maxWaitMs: 1,
    })).resolves.toBe(false);

    const calls = JSON.stringify(debugSpy.mock.calls);
    expect(calls).toContain('[API] Failed to fetch transcript messages for pending-queue recovery');
    expect(calls).toContain('https://api.example.test/v2/sessions/s1/messages/by-local-id/local-1');
    expect(calls).not.toContain('MESSAGE_SECRET');
    expect(calls).not.toContain('QUERY_SECRET');
    expect(calls).not.toContain('HEADER_SECRET');
    expect(calls).not.toContain('BODY_SECRET');
    expect(calls).not.toContain('"headers"');
    expect(calls).not.toContain('"data"');
  });

  it('redacts startup transcript catch-up retry failures before logging', async () => {
    axiosGetMock.mockRejectedValue(createSecretAxiosError());
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    let retryIndex = 0;

    const runtime = createSessionClientRecoveryRuntime({
      startupMessageCatchUpRetryDelaysMs: [0],
      token: 'token-1',
      sessionId: 's1',
      getClosed: () => false,
      getSessionConnectionSupervisor: () => null,
      getCurrentConnectionState: () => ({ phase: 'connected' }) as never,
      getStartedByDaemonProcess: () => true,
      getMetadataStartedBy: () => null,
      getMetadataStartedFromDaemon: () => null,
      getStartupMessageCatchUpRetryIndex: () => retryIndex,
      setStartupMessageCatchUpRetryIndex: (value) => {
        retryIndex = value;
      },
      getStartupMessageCatchUpInitialAfterSeq: () => 0,
      getStartupMessageCatchUpInitialAfterSeqIsExplicit: () => false,
      getLastObservedMessageSeq: () => 0,
      getHasMaterializedLocalId: () => false,
      deleteMaterializedLocalId: vi.fn(),
      handleUpdate: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(),
      applyPendingQueueState: vi.fn(),
    });

    runtime.scheduleNextStartupMessageCatchUpRetry();

    await expect.poll(() => JSON.stringify(debugSpy.mock.calls)).toContain('[API] Startup transcript catch-up retry failed');

    const calls = JSON.stringify(debugSpy.mock.calls);
    expect(calls).not.toContain('MESSAGE_SECRET');
    expect(calls).not.toContain('QUERY_SECRET');
    expect(calls).not.toContain('HEADER_SECRET');
    expect(calls).not.toContain('BODY_SECRET');
    expect(calls).not.toContain('"headers"');
    expect(calls).not.toContain('"data"');
  });

  it('does not schedule another startup transcript retry after catch-up succeeds', async () => {
    axiosGetMock.mockResolvedValue({ data: { messages: [] } });
    let retryIndex = 0;

    const runtime = createSessionClientRecoveryRuntime({
      startupMessageCatchUpRetryDelaysMs: [0, 0],
      token: 'token-1',
      sessionId: 's1',
      getClosed: () => false,
      getSessionConnectionSupervisor: () => null,
      getCurrentConnectionState: () => ({ phase: 'connected' }) as never,
      getStartedByDaemonProcess: () => true,
      getMetadataStartedBy: () => null,
      getMetadataStartedFromDaemon: () => null,
      getStartupMessageCatchUpRetryIndex: () => retryIndex,
      setStartupMessageCatchUpRetryIndex: (value) => {
        retryIndex = value;
      },
      getStartupMessageCatchUpInitialAfterSeq: () => 0,
      getStartupMessageCatchUpInitialAfterSeqIsExplicit: () => false,
      getLastObservedMessageSeq: () => 0,
      getHasMaterializedLocalId: () => false,
      deleteMaterializedLocalId: vi.fn(),
      handleUpdate: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(),
      applyPendingQueueState: vi.fn(),
    });

    runtime.scheduleNextStartupMessageCatchUpRetry();

    await expect.poll(() => axiosGetMock.mock.calls.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(axiosGetMock).toHaveBeenCalledTimes(1);
    expect(retryIndex).toBe(1);
  });
});
