import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

const {
  fetchChanges,
  publishPluginAccountSettingsWatchInvalidation,
} = vi.hoisted(() => ({
  fetchChanges: vi.fn(),
  publishPluginAccountSettingsWatchInvalidation: vi.fn(),
}));

vi.mock('../changes', () => ({
  fetchChanges,
}));

vi.mock('@/api/connection/requestSupervision/reportRequestOutcomeToSupervisor', () => ({
  handleRequestAuthenticationFailure: vi.fn(() => false),
}));

vi.mock('@/plugins/runtime/context/pluginAccountSettingsChangeBroker', () => ({
  publishPluginAccountSettingsWatchInvalidation,
  readPluginAccountSettingsWatchInvalidations: (changes: readonly unknown[]) => changes.flatMap((change) => {
    if (!change || typeof change !== 'object') return [];
    const entry = change as { kind?: unknown; hint?: unknown };
    if (entry.kind !== 'pluginDomain' || !entry.hint || typeof entry.hint !== 'object') return [];
    const hint = entry.hint as { pluginDomain?: unknown; pluginId?: unknown; revision?: unknown };
    return hint.pluginDomain === 'settings'
      && typeof hint.pluginId === 'string'
      && typeof hint.revision === 'number'
      ? [{ kind: 'record' as const, pluginId: hint.pluginId, revision: hint.revision }]
      : [];
  }),
}));

import {
  runSessionChangesSyncOnConnect,
} from './sessionChangesSyncOnConnect';
import { buildPromptLibraryPhysicalKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

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

  it('reads one changes page for concurrent Session clients of one Account wake and applies it to each', async () => {
    fetchChanges.mockResolvedValue({ status: 'ok', response: { nextCursor: 4, changes: [
      { cursor: 4, kind: 'session', entityId: 's2', changedAt: 100, hint: { kind: 'workflow-run-delivery', runId: 'run-1', revision: 2 } },
    ] } });
    const contexts: string[] = [];
    const cursors: string[] = [];
    // A session host's Sessions share one Account update connection: one wake reaches all of them.
    await Promise.all(['s1', 's2', 's3'].map(sessionId => runSessionChangesSyncOnConnect({
      reason: 'live', token: 'token-1', sessionId, lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1', readChangesCursor: async () => 3,
      writeChangesCursor: async () => { cursors.push(sessionId); },
      catchUpSessionMessages: async () => {}, syncSessionSnapshotFromServer: async () => true,
      onSessionFollowInvalidated: () => { contexts.push(sessionId); }, onDebug: vi.fn(),
    })));
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    expect(contexts).toEqual(['s2']);
    expect(cursors.sort()).toEqual(['s1', 's2', 's3']);
    // A later wake reads again: only an in-flight read is shared.
    await runSessionChangesSyncOnConnect({
      reason: 'live', token: 'token-1', sessionId: 's1', lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1', readChangesCursor: async () => 4,
      writeChangesCursor: async () => {}, catchUpSessionMessages: async () => {}, syncSessionSnapshotFromServer: async () => true,
      onDebug: vi.fn(),
    });
    expect(fetchChanges).toHaveBeenCalledTimes(2);
  });

  it.each(['s1', 'another-session'])('wakes context only for its own durable Session changes (%s)', async entityId => {
    fetchChanges.mockResolvedValueOnce({ status: 'ok', response: { nextCursor: 4, changes: [
      { cursor: 4, kind: 'session', entityId, changedAt: 100, hint: { kind: 'workflow-run-delivery', runId: 'run-1', revision: 2 } },
    ] } });
    const events: string[] = [];
    await runSessionChangesSyncOnConnect({
      reason: 'live', token: 'token-1', sessionId: 's1', lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1', readChangesCursor: async () => 3,
      writeChangesCursor: async () => { events.push('cursor'); },
      catchUpSessionMessages: async () => {}, syncSessionSnapshotFromServer: async () => true,
      onSessionFollowInvalidated: () => { events.push('context'); }, onDebug: vi.fn(),
    });
    expect(events).toEqual(entityId === 's1' ? ['context', 'cursor'] : ['cursor']);
  });

  it.each([
    { name: 'pruned cursor', result: { status: 'cursor-gone', currentCursor: 5 } },
    { name: 'unavailable changes route', result: { status: 'error', error: { status: 404 } } },
    { name: 'full changes page', result: { status: 'ok', response: { nextCursor: 203,
      changes: Array.from({ length: 200 }, (_, i) => ({ cursor: i + 4, kind: 'session', entityId: `other-${i}`, changedAt: 1 })) } } },
  ])('retains context recovery when the changed Session cannot be determined ($name)', async ({ result }) => {
    fetchChanges.mockResolvedValueOnce(result);
    let wakes = 0;
    await runSessionChangesSyncOnConnect({
      reason: 'live', token: 'token-1', sessionId: 's1', lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1', ...createChangesCursorStore(),
      catchUpSessionMessages: async () => {}, syncSessionSnapshotFromServer: async () => true,
      onSessionFollowInvalidated: () => { wakes++; }, onDebug: vi.fn(),
    });
    expect(wakes).toBe(1);
  });

  it('re-observes a changed skill-rules row before acknowledging the Account recovery cursor', async () => {
    const events: string[] = [];
    fetchChanges.mockResolvedValueOnce({ status: 'ok', response: { nextCursor: 4, changes: [
      { cursor: 4, kind: 'account', entityId: buildPromptLibraryPhysicalKeyV1('skill-rules'), changedAt: 100 },
    ] } });
    await runSessionChangesSyncOnConnect({
      reason: 'connect', token: 'token-1', sessionId: 's1', lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1', readChangesCursor: async () => 3,
      writeChangesCursor: async () => { events.push('cursor'); },
      catchUpSessionMessages: async () => {}, syncSessionSnapshotFromServer: async () => true,
      refreshDemandedAccountCatalogs: async () => { events.push('catalog'); }, onDebug: vi.fn(),
    });
    expect(events).toEqual(['catalog', 'cursor']);
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

  it('notifies only the exact Account plugin Settings record watcher from the shared changes feed', async () => {
    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        nextCursor: 8,
        changes: [
          {
            cursor: 4,
            kind: 'pluginDomain',
            entityId: 'pluginDomain/example.tasks/settings',
            changedAt: 100,
            hint: {
              pluginDomain: 'settings',
              pluginId: 'example.tasks',
              scope: 'account',
              revision: 5,
            },
          },
          {
            cursor: 5,
            kind: 'pluginDomain',
            entityId: 'pluginDomain/example.tasks/data-kv',
            changedAt: 101,
            hint: {
              pluginDomain: 'dataKv',
              pluginId: 'example.tasks',
              full: true,
            },
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
      ...createChangesCursorStore(),
      catchUpSessionMessages: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(async () => true),
      onDebug: vi.fn(),
    });

    expect(publishPluginAccountSettingsWatchInvalidation).toHaveBeenCalledTimes(1);
    expect(publishPluginAccountSettingsWatchInvalidation).toHaveBeenCalledWith({
      kind: 'record',
      pluginId: 'example.tasks',
      revision: 5,
    });
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

  it('awaits reconciliation of every exact queued Execution Run target before acknowledging the change cursor', async () => {
    const events: string[] = [];
    let releaseRunA!: () => void;
    const runABlocked = new Promise<void>((resolve) => {
      releaseRunA = resolve;
    });
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
            hint: {
              pendingCount: 3,
              pendingVersion: 7,
              pendingExecutionRunIds: ['run-a', 'run-b', 'run-a'],
            },
          },
        ],
      },
    });

    const sync = runSessionChangesSyncOnConnect({
      reason: 'connect',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      readChangesCursor: async () => 3,
      writeChangesCursor: async (_accountId, cursor) => { events.push(`cursor:${cursor}`); },
      catchUpSessionMessages: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(async () => true),
      applyPendingQueueState: () => { events.push('pending'); },
      reconcilePendingExecutionRunTarget: async (runId) => {
        events.push(`target:${runId}:start`);
        if (runId === 'run-a') await runABlocked;
        events.push(`target:${runId}:done`);
      },
      onDebug: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(events).toEqual([
        'pending',
        'target:run-a:start',
        'target:run-b:start',
        'target:run-b:done',
      ]);
    });
    expect(events).not.toContain('cursor:8');

    releaseRunA();
    await sync;
    expect(events).toEqual([
      'pending',
      'target:run-a:start',
      'target:run-b:start',
      'target:run-b:done',
      'target:run-a:done',
      'cursor:8',
    ]);
  });

  it('recovers exact Pending targets when a later ordinary Session hint replaced the Pending counters', async () => {
    const events: string[] = [];
    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        nextCursor: 8,
        changes: [{
          cursor: 4,
          kind: 'session',
          entityId: 's1',
          changedAt: 123,
          hint: { lastMessageSeq: 0, pendingExecutionRunIds: ['run-offline'] },
        }],
      },
    });

    await runSessionChangesSyncOnConnect({
      reason: 'connect',
      token: 'token-1',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      readChangesCursor: async () => 3,
      writeChangesCursor: async (_accountId, cursor) => { events.push(`cursor:${cursor}`); },
      catchUpSessionMessages: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(async () => true),
      applyPendingQueueState: () => { events.push('pending'); },
      reconcilePendingExecutionRunTarget: async (runId) => { events.push(`target:${runId}`); },
      onDebug: vi.fn(),
    });

    expect(events).toEqual(['target:run-offline', 'cursor:8']);
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
