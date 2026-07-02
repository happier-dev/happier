import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

const { fetchChanges, readLastChangesCursor, writeLastChangesCursor } = vi.hoisted(() => ({
  fetchChanges: vi.fn(),
  readLastChangesCursor: vi.fn(),
  writeLastChangesCursor: vi.fn(),
}));

vi.mock('../changes', () => ({
  fetchChanges,
}));

vi.mock('@/persistence', () => ({
  readLastChangesCursor,
  writeLastChangesCursor,
}));

vi.mock('@/api/connection/requestSupervision/reportRequestOutcomeToSupervisor', () => ({
  handleRequestAuthenticationFailure: vi.fn(() => false),
}));

import { runSessionChangesSyncOnConnect } from './sessionChangesSyncOnConnect';

describe('runSessionChangesSyncOnConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readLastChangesCursor.mockResolvedValue(3);
    writeLastChangesCursor.mockResolvedValue(undefined);
  });

  it('applies pending queue hints from relevant session changes', async () => {
    const applyPendingQueueState = vi.fn();
    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        nextCursor: 8,
        changes: [
          {
            cursor: 4,
            kind: 'session',
            entityId: 's1',
            changedAt: 123,
            hint: { pendingCount: 0, pendingVersion: 7 },
          },
        ],
      },
    });

    await runSessionChangesSyncOnConnect({
      reason: 'connect',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      catchUpSessionMessages: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(),
      applyPendingQueueState,
      onDebug: vi.fn(),
    });

    expect(applyPendingQueueState).toHaveBeenCalledWith({ known: true, pendingCount: 0, pendingVersion: 7 });
    expect(writeLastChangesCursor).toHaveBeenCalledWith('account-1', 8);
  });

  it('falls back to targeted degraded detail repair for relevant non-self-sufficient safety changes', async () => {
    const syncSessionSnapshotFromServer = vi.fn();
    const catchUpSessionMessages = vi.fn();
    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        nextCursor: 9,
        changes: [
          {
            cursor: 5,
            kind: 'share',
            entityId: 's1',
            changedAt: 123,
            hint: null,
          },
        ],
      },
    });

    await runSessionChangesSyncOnConnect({
      reason: 'stale-safety',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      catchUpSessionMessages,
      syncSessionSnapshotFromServer,
      applyPendingQueueState: vi.fn(),
      onDebug: vi.fn(),
    });

    expect(catchUpSessionMessages).not.toHaveBeenCalled();
    expect(syncSessionSnapshotFromServer).toHaveBeenCalledWith({ reason: 'degraded-socket' });
    expect(writeLastChangesCursor).toHaveBeenCalledWith('account-1', 9);
  });

  it('does not advance the changes cursor when stale-safety transcript catch-up fails', async () => {
    const syncSessionSnapshotFromServer = vi.fn();
    const catchUpSessionMessages = vi.fn(async () => {
      throw new Error('transcript unavailable');
    });
    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        nextCursor: 6,
        changes: [
          {
            cursor: 4,
            kind: 'session',
            entityId: 's1',
            changedAt: 123,
            hint: { lastMessageSeq: 10 },
          },
        ],
      },
    });

    await runSessionChangesSyncOnConnect({
      reason: 'stale-safety',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 9,
      getAccountId: async () => 'account-1',
      catchUpSessionMessages,
      syncSessionSnapshotFromServer,
      applyPendingQueueState: vi.fn(),
      onDebug: vi.fn(),
    });

    expect(catchUpSessionMessages).toHaveBeenCalledWith(9);
    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
    expect(writeLastChangesCursor).not.toHaveBeenCalled();
  });

  it('redacts reconnect catch-up diagnostics', async () => {
    const onDebug = vi.fn();
    fetchChanges.mockResolvedValueOnce({
      status: 'cursor-gone',
      currentCursor: 8,
    });

    await runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      catchUpSessionMessages: async () => {
        throw new AxiosError('Request failed with Authorization: Bearer MESSAGE_SECRET', 'ERR_BAD_RESPONSE', {
          method: 'get',
          url: 'https://api.example.test/v1/sessions/s1/messages?token=QUERY_SECRET',
          headers: new AxiosHeaders({ Authorization: 'Bearer HEADER_SECRET' }),
          data: { access_token: 'BODY_SECRET' },
        });
      },
      syncSessionSnapshotFromServer: vi.fn(),
      applyPendingQueueState: vi.fn(),
      onDebug,
    });

    const payload = JSON.stringify(onDebug.mock.calls.at(-1)?.[1]);
    expect(payload).toContain('https://api.example.test/v1/sessions/s1/messages');
    expect(payload).not.toContain('MESSAGE_SECRET');
    expect(payload).not.toContain('QUERY_SECRET');
    expect(payload).not.toContain('HEADER_SECRET');
    expect(payload).not.toContain('BODY_SECRET');
    expect(payload).not.toContain('"headers"');
    expect(payload).not.toContain('"data"');
  });
});
