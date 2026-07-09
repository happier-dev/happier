import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

const { fetchChanges } = vi.hoisted(() => ({
  fetchChanges: vi.fn(),
}));

vi.mock('../changes', () => ({
  fetchChanges,
}));

vi.mock('@/api/connection/requestSupervision/reportRequestOutcomeToSupervisor', () => ({
  handleRequestAuthenticationFailure: vi.fn(() => false),
}));

import {
  readSessionCatchUpAuthorization,
  runSessionChangesSyncOnConnect,
  type SessionCatchUpAuthorization,
} from './sessionChangesSyncOnConnect';

function createChangesCursorStore(initialCursor = 3): {
  readChangesCursor: (accountId: string) => Promise<number>;
  writeChangesCursor: (accountId: string, cursor: number) => Promise<void>;
} {
  let cursor = initialCursor;
  return {
    readChangesCursor: vi.fn(async () => cursor),
    writeChangesCursor: vi.fn(async (_accountId, nextCursor) => {
      cursor = nextCursor;
    }),
  };
}

describe('runSessionChangesSyncOnConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads catch-up authorization through the protocol-owned parser', () => {
    const authorization: SessionCatchUpAuthorization = readSessionCatchUpAuthorization('explicit_cursor')!;

    expect(authorization).toBe('explicit_cursor');
    expect(readSessionCatchUpAuthorization('reconnect_watermark')).toBe('reconnect_watermark');
    expect(readSessionCatchUpAuthorization('startup_recovery')).toBe('startup_recovery');
    expect(readSessionCatchUpAuthorization('no_explicit_authorization')).toBeNull();
  });

  it('applies pending queue hints from relevant session changes', async () => {
    const changesCursor = createChangesCursorStore();
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
      ...changesCursor,
      catchUpSessionMessages: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(),
      applyPendingQueueState,
      onDebug: vi.fn(),
    });

    expect(applyPendingQueueState).toHaveBeenCalledWith({
      known: true,
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 7,
    });
    expect(changesCursor.writeChangesCursor).toHaveBeenCalledWith('account-1', 8);
  });

  it('falls back to targeted degraded detail repair for relevant non-self-sufficient safety changes', async () => {
    const changesCursor = createChangesCursorStore();
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
      ...changesCursor,
      catchUpSessionMessages,
      syncSessionSnapshotFromServer,
      applyPendingQueueState: vi.fn(),
      onDebug: vi.fn(),
    });

    expect(catchUpSessionMessages).not.toHaveBeenCalled();
    expect(syncSessionSnapshotFromServer).toHaveBeenCalledWith({ reason: 'degraded-socket' });
    expect(changesCursor.writeChangesCursor).toHaveBeenCalledWith('account-1', 9);
  });

  it('does not advance the changes cursor when stale-safety transcript catch-up fails', async () => {
    const changesCursor = createChangesCursorStore();
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
      ...changesCursor,
      catchUpSessionMessages,
      syncSessionSnapshotFromServer,
      applyPendingQueueState: vi.fn(),
      onDebug: vi.fn(),
    });

    expect(catchUpSessionMessages).toHaveBeenCalledWith({
      afterSeq: 9,
      authorization: 'reconnect_watermark',
    });
    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
    expect(changesCursor.writeChangesCursor).not.toHaveBeenCalled();
  });

  it('authorizes reconnect fallback catch-up requests with the reconnect watermark', async () => {
    const changesCursor = createChangesCursorStore();
    const catchUpSessionMessages = vi.fn();
    fetchChanges.mockResolvedValueOnce({
      status: 'cursor-gone',
      currentCursor: 12,
    });

    await runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 11,
      getAccountId: async () => 'account-1',
      ...changesCursor,
      catchUpSessionMessages,
      syncSessionSnapshotFromServer: vi.fn(),
      applyPendingQueueState: vi.fn(),
      onDebug: vi.fn(),
    });

    expect(catchUpSessionMessages).toHaveBeenCalledWith({
      afterSeq: 11,
      authorization: 'reconnect_watermark',
    });
  });

  it('does not let one live session advance another live session past its pending hint', async () => {
    const firstSessionCursor = createChangesCursorStore(0);
    const secondSessionCursor = createChangesCursorStore(0);
    fetchChanges.mockImplementation(async ({ after }: { after: number }) => ({
      status: 'ok',
      response: {
        changes: after < 9
          ? [
              {
                cursor: 9,
                kind: 'session',
                entityId: 's2',
                changedAt: 900,
                hint: { pendingCount: 1, pendingVersion: 4 },
              },
            ]
          : [],
        nextCursor: 9,
      },
    }));

    await runSessionChangesSyncOnConnect({
      reason: 'stale-safety',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      ...firstSessionCursor,
      catchUpSessionMessages: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(),
      applyPendingQueueState: vi.fn(),
      onDebug: vi.fn(),
    });

    const applyPendingQueueStateForSecondSession = vi.fn();
    await runSessionChangesSyncOnConnect({
      reason: 'stale-safety',
      token: 'token-1',
      sessionId: 's2',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      ...secondSessionCursor,
      catchUpSessionMessages: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(),
      applyPendingQueueState: applyPendingQueueStateForSecondSession,
      onDebug: vi.fn(),
    });

    expect(applyPendingQueueStateForSecondSession).toHaveBeenCalledWith({
      known: true,
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 4,
    });
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
      ...createChangesCursorStore(),
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
