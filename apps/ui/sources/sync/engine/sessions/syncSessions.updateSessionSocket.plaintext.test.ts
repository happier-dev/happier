import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { buildUpdatedSessionFromSocketUpdate } from './syncSessions';

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

  it('applies archivedAt from update-session payloads', async () => {
    const base = createSession({ sessionId: 's1', encryptionMode: 'plain' });

    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({
      session: base,
      updateBody: {
        archivedAt: 123,
      },
      updateSeq: 10,
      updateCreatedAt: 456,
      sessionEncryption: null,
    });

    expect(nextSession.archivedAt).toBe(123);
    expect(nextSession.updatedAt).toBe(456);
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
