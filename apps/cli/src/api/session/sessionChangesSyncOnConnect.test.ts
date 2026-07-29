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
  runSessionChangesSyncOnConnect,
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

  it('refreshes the highest self-account settings version before publishing Pending and advancing the cursor', async () => {
    const events: string[] = [];
    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        nextCursor: 8,
        changes: [
          { cursor: 4, kind: 'account', entityId: 'self', changedAt: 100, hint: { settingsVersion: 5 } },
          { cursor: 5, kind: 'account', entityId: 'self', changedAt: 101, hint: { settingsVersion: 7 } },
          { cursor: 6, kind: 'session', entityId: 's1', changedAt: 102, hint: { pendingCount: 1, pendingVersion: 3 } },
        ],
      },
    });

    await runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      readChangesCursor: async () => 3,
      writeChangesCursor: async (_accountId, cursor) => { events.push(`cursor:${cursor}`); },
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer: async () => true,
      refreshAccountSettingsForMinimumVersion: async (version) => { events.push(`settings:${version}`); },
      applyPendingQueueState: () => { events.push('pending'); },
      onDebug: vi.fn(),
    });

    expect(events).toEqual(['settings:7', 'pending', 'cursor:8']);
  });

  it('does not publish Pending or advance the cursor when required settings convergence fails', async () => {
    const changesCursor = createChangesCursorStore();
    const applyPendingQueueState = vi.fn();
    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        nextCursor: 8,
        changes: [
          { cursor: 4, kind: 'account', entityId: 'self', changedAt: 100, hint: { settingsVersion: 5 } },
          { cursor: 5, kind: 'session', entityId: 's1', changedAt: 101, hint: { pendingCount: 1, pendingVersion: 3 } },
        ],
      },
    });

    await expect(runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      ...changesCursor,
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer: async () => true,
      refreshAccountSettingsForMinimumVersion: async () => { throw new Error('settings unavailable'); },
      applyPendingQueueState,
      onDebug: vi.fn(),
    })).rejects.toThrow('settings unavailable');

    expect(applyPendingQueueState).not.toHaveBeenCalled();
    expect(changesCursor.writeChangesCursor).not.toHaveBeenCalled();
  });

  it('force-refreshes settings on reconnect when no settings hint survived', async () => {
    const events: string[] = [];
    fetchChanges.mockResolvedValueOnce({ status: 'ok', response: { changes: [], nextCursor: 8 } });

    await runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      readChangesCursor: async () => 3,
      writeChangesCursor: async (_accountId, cursor) => { events.push(`cursor:${cursor}`); },
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer: async () => true,
      refreshAccountSettingsForMinimumVersion: async (version) => { events.push(`settings:${version ?? 'force'}`); },
      onDebug: vi.fn(),
    });

    expect(events).toEqual(['settings:force', 'cursor:8']);
  });

  it('force-refreshes settings before Pending and cursor work for a full changes page', async () => {
    const events: string[] = [];
    const changes = [
      ...Array.from({ length: 199 }, (_, index) => ({
        cursor: index + 1,
        kind: 'machine',
        entityId: `machine-${index}`,
        changedAt: index + 1,
        hint: null,
      })),
      { cursor: 200, kind: 'session', entityId: 's1', changedAt: 200, hint: { pendingCount: 1, pendingVersion: 2 } },
    ];
    fetchChanges.mockResolvedValueOnce({ status: 'ok', response: { changes, nextCursor: 200 } });

    await runSessionChangesSyncOnConnect({
      reason: 'connect',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      readChangesCursor: async () => 0,
      writeChangesCursor: async (_accountId, cursor) => { events.push(`cursor:${cursor}`); },
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer: async () => {
        events.push('snapshot');
        return true;
      },
      refreshAccountSettingsForMinimumVersion: async (version) => { events.push(`settings:${version ?? 'force'}`); },
      applyPendingQueueState: () => { events.push('pending'); },
      onDebug: vi.fn(),
    });

    expect(events).toEqual(['settings:force', 'pending', 'snapshot', 'cursor:200']);
  });

  it('force-refreshes settings for cursor-gone reconnect and advances only after transcript and snapshot convergence', async () => {
    const events: string[] = [];
    fetchChanges.mockResolvedValueOnce({ status: 'cursor-gone', currentCursor: 12 });

    await runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 11,
      getAccountId: async () => 'account-1',
      readChangesCursor: async () => 3,
      writeChangesCursor: async (_accountId, cursor) => { events.push(`cursor:${cursor}`); },
      catchUpSessionMessages: async () => { events.push('transcript'); },
      syncSessionSnapshotFromServer: async () => {
        events.push('snapshot');
        return false;
      },
      refreshAccountSettingsForMinimumVersion: async (version) => { events.push(`settings:${version ?? 'force'}`); },
      applyPendingQueueState: vi.fn(),
      onDebug: vi.fn(),
    });

    expect(events).toEqual(['transcript', 'settings:force', 'snapshot']);
  });

  it('uses snapshot-only convergence without advancing the cursor when the changes route is unsupported', async () => {
    const changesCursor = createChangesCursorStore();
    const catchUpSessionMessages = vi.fn(async () => {});
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const refreshAccountSettingsForMinimumVersion = vi.fn(async () => {});
    fetchChanges.mockResolvedValueOnce({ status: 'error', error: new Error('404') });

    await runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 11,
      getAccountId: async () => 'account-1',
      ...changesCursor,
      catchUpSessionMessages,
      syncSessionSnapshotFromServer,
      refreshAccountSettingsForMinimumVersion,
      applyPendingQueueState: vi.fn(),
      onDebug: vi.fn(),
    });

    expect(refreshAccountSettingsForMinimumVersion).toHaveBeenCalledWith(null);
    expect(catchUpSessionMessages).toHaveBeenCalledTimes(1);
    expect(syncSessionSnapshotFromServer).toHaveBeenCalledTimes(1);
    expect(changesCursor.writeChangesCursor).not.toHaveBeenCalled();
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

  it('does not advance the changes cursor when reconnect transcript catch-up fails', async () => {
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
      reason: 'reconnect',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 9,
      getAccountId: async () => 'account-1',
      ...changesCursor,
      catchUpSessionMessages,
      syncSessionSnapshotFromServer: vi.fn(async () => true),
      applyPendingQueueState: vi.fn(),
      onDebug: vi.fn(),
    });

    expect(catchUpSessionMessages).toHaveBeenCalledWith({
      afterSeq: 9,
    });
    expect(changesCursor.writeChangesCursor).not.toHaveBeenCalled();
  });

  it('uses the exact reconnect cursor for fallback catch-up requests', async () => {
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
      reason: 'connect',
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
      reason: 'connect',
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
