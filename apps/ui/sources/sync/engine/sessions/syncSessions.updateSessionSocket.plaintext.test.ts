import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
  buildUpdatedSessionFromSocketUpdate,
  buildUpdatedSessionListRenderablePatchFromSocketUpdate,
} from './syncSessions';

function createSession(params: { sessionId: string; encryptionMode: 'plain' | 'e2ee' }): Session {
  const now = 1_700_000_000_000;
  return {
    id: params.sessionId,
    seq: 1,
    encryptionMode: params.encryptionMode,
    createdAt: now,
    updatedAt: now,
    active: true,
    activeAt: now,
    metadata: { path: '/tmp', host: 'localhost' },
    metadataVersion: 1,
    agentState: {},
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
    optimisticThinkingAt: null,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('buildUpdatedSessionFromSocketUpdate (plaintext)', () => {
  afterEach(() => {
    syncPerformanceTelemetry.configure({ enabled: false });
    syncPerformanceTelemetry.reset();
  });

  it('parses plaintext metadata and agentState when session encryptionMode is plain', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });

    const updateBody = {
      metadata: { version: 2, value: JSON.stringify({ path: '/work', host: 'devbox' }) },
      agentState: { version: 3, value: JSON.stringify({ controlledByUser: true }) },
    };

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody,
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: {
        decryptAgentState: async () => {
          throw new Error('decryptAgentState should not be called for plaintext sessions');
        },
        decryptMetadata: async () => {
          throw new Error('decryptMetadata should not be called for plaintext sessions');
        },
      },
    });

    expect(nextSession.encryptionMode).toBe('plain');
    expect(nextSession.metadataVersion).toBe(2);
    expect(nextSession.metadata).toEqual({ path: '/work', host: 'devbox' });
    expect(nextSession.agentStateVersion).toBe(3);
    const agentState = nextSession.agentState as unknown as { controlledByUser?: unknown };
    expect(agentState.controlledByUser).toBe(true);
  });

  it('applies archivedAt changes from update-session payloads', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: { archivedAt: 1_700_000_000_000 },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(nextSession.archivedAt).toBe(1_700_000_000_000);
  });

  it('applies primary runtime issue projection from update-session payloads', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });
    const issue = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'provider_status_error',
      source: 'provider_status_error',
      occurredAt: 100,
      sanitizedPreview: 'Provider reported an error',
    } as const;

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        latestTurnStatus: 'failed',
        lastRuntimeIssue: issue,
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(nextSession.latestTurnStatus).toBe('failed');
    expect(nextSession.lastRuntimeIssue).toEqual(issue);
  });

  it('clears stale thinking for terminal primary turn projections', async () => {
    const base = {
      ...createSession({ sessionId: 's1', encryptionMode: 'plain' }),
      thinking: true,
      thinkingAt: 999,
      latestTurnStatus: 'in_progress' as const,
    };

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        latestTurnStatus: 'completed',
        lastRuntimeIssue: null,
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(nextSession.latestTurnStatus).toBe('completed');
    expect(nextSession.thinking).toBe(false);
  });

  it('applies runtime activity projection fields from update-session payloads', async () => {
    const base = {
      ...createSession({ sessionId: 's1', encryptionMode: 'plain' }),
      active: true,
      activeAt: 100,
      thinking: true,
      thinkingAt: 100,
    };

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        active: false,
        activeAt: 123_456,
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(nextSession.active).toBe(false);
    expect(nextSession.activeAt).toBe(123_456);
    expect(nextSession.thinking).toBe(false);
    expect(nextSession.thinkingAt).toBe(123_456);
  });

  it('clears stale renderable thinking for terminal primary turn projections', async () => {
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: {
        id: 's1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: true,
        thinkingAt: 999,
        presence: 'online',
        latestTurnStatus: 'in_progress',
      },
      updateBody: {
        latestTurnStatus: 'completed',
        lastRuntimeIssue: null,
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(patch.latestTurnStatus).toBe('completed');
    expect(patch.thinking).toBe(false);
  });

  it('applies runtime activity projection fields to renderable socket patches', async () => {
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: {
        id: 's1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 100,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: true,
        thinkingAt: 100,
        presence: 'online',
      },
      updateBody: {
        active: false,
        activeAt: 123_456,
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(patch.active).toBe(false);
    expect(patch.activeAt).toBe(123_456);
    expect(patch.thinking).toBe(false);
    expect(patch.thinkingAt).toBe(123_456);
    expect(patch.presence).toBe(123_456);
  });

  it('applies pending request observation timestamps to renderable socket patches', async () => {
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: {
        id: 's1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        pendingRequestObservedAt: null,
      },
      updateBody: {
        pendingRequestObservedAt: 1_700,
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(patch.pendingRequestObservedAt).toBe(1_700);
  });

  it('applies flattened rollback eligibility from update-session payloads', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        rollbackEligibleTurnStarts: [1, 3],
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(nextSession.rollbackEligibleTurnStarts).toEqual([1, 3]);
  });

  it('applies flattened rollback eligibility to renderable socket patches', async () => {
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: {
        id: 's1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
      },
      updateBody: {
        rollbackEligibleTurnStarts: [1, 3],
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(patch.rollbackEligibleTurnStarts).toEqual([1, 3]);
  });

  it('marks renderable unread when ready projection advances past the read cursor', async () => {
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: {
        id: 's1',
        seq: 945,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        lastViewedSessionSeq: 945,
        latestReadyEventSeq: null,
        hasUnreadMessages: false,
      },
      updateBody: {
        latestReadyEventSeq: 946,
      },
      updateSeq: 946,
      updateCreatedAt: 1234,
      sessionEncryption: null,
    });

    expect(patch.latestReadyEventSeq).toBe(946);
    expect(patch.hasUnreadMessages).toBe(true);
  });

  it('clears renderable unread when read cursor reaches the latest ready projection', async () => {
    const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
      renderable: {
        id: 's1',
        seq: 946,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        lastViewedSessionSeq: 945,
        latestReadyEventSeq: 946,
        hasUnreadMessages: true,
      },
      updateBody: {
        lastViewedSessionSeq: 946,
      },
      updateSeq: 947,
      updateCreatedAt: 1235,
      sessionEncryption: null,
    });

    expect(patch.lastViewedSessionSeq).toBe(946);
    expect(patch.hasUnreadMessages).toBe(false);
  });

  it('clears renderable unread when read cursor reaches the latest displayable message but update-session seq trails with usage activity', async () => {
    const previousState = storage.getState();
    try {
      storage.setState((state) => ({
        ...state,
        sessionMessages: {
          s1: {
            messageIdsOldestFirst: ['m-visible'],
            messagesById: {
              'm-visible': {
                id: 'm-visible',
                kind: 'agent-text',
                seq: 945,
                localId: null,
                createdAt: 1,
                text: 'Visible assistant message',
              },
            },
          },
        },
      } as never));

      const patch = await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
        renderable: {
          id: 's1',
          seq: 946,
          createdAt: 0,
          updatedAt: 0,
          active: true,
          activeAt: 0,
          metadataVersion: 1,
          agentStateVersion: 1,
          metadata: null,
          thinking: false,
          thinkingAt: 0,
          presence: 'online',
          latestTurnStatus: 'in_progress',
          hasUnreadMessages: true,
        },
        updateBody: {
          lastViewedSessionSeq: 945,
        },
        updateSeq: 946,
        updateCreatedAt: 1234,
        sessionEncryption: null,
      });

      expect(patch.hasUnreadMessages).toBe(false);
    } finally {
      storage.setState(previousState);
    }
  });

  it('decrypts encrypted metadata and agent-state socket updates in one batch when available', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'e2ee' });
    syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 1_000_000, flushIntervalMs: 60_000 });
    syncPerformanceTelemetry.reset();
    const decryptMetadata = vi.fn(async () => ({ path: '/fallback', host: 'fallback' }));
    const decryptAgentState = vi.fn(async () => ({ controlledByUser: false }));
    const decryptSessionSnapshotState = vi.fn(async () => ({
      metadata: { path: '/work', host: 'devbox' },
      agentState: { controlledByUser: true },
    }));

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        metadata: { version: 2, value: 'enc-meta' },
        agentState: { version: 3, value: 'enc-state' },
      },
      updateSeq: 10,
      updateCreatedAt: 1234,
      sessionEncryption: { decryptMetadata, decryptAgentState, decryptSessionSnapshotState },
    });

    expect(decryptSessionSnapshotState).toHaveBeenCalledWith(2, 'enc-meta', 3, 'enc-state');
    expect(decryptMetadata).not.toHaveBeenCalled();
    expect(decryptAgentState).not.toHaveBeenCalled();
    expect(nextSession.metadataVersion).toBe(2);
    expect(nextSession.agentStateVersion).toBe(3);
    expect(nextSession.metadata).toEqual({ path: '/work', host: 'devbox' });
    expect(nextSession.agentState).toEqual({ controlledByUser: true });
    expect(syncPerformanceTelemetry.snapshot().events).toContainEqual(expect.objectContaining({
      name: 'sync.sessions.socket.updateSession.decryptState',
      count: 1,
      fields: expect.objectContaining({
        encrypted: 1,
        metadata: 1,
        agentState: 1,
        batched: 1,
      }),
    }));
  });
});
