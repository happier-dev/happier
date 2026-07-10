import { describe, expect, it, vi } from 'vitest';

import {
  updateSessionAgentStateWithAck,
  updateSessionMetadataWithAck,
  updateSessionRuntimeActivityProjectionWithAck,
} from './stateUpdates';
import { logger } from '@/ui/logger';
import type { Metadata } from '@/api/types';

type PlainMetadataAckPayload = {
  metadata: string;
  expectedVersion: number;
};

function createMetadata(overrides: Partial<Metadata> = {}): Metadata {
  return {
    path: '/tmp',
    host: 'localhost',
    homeDir: '/home/test',
    happyHomeDir: '/home/test/.happier',
    happyLibDir: '/home/test/.happier/lib',
    happyToolsDir: '/home/test/.happier/tools',
    ...overrides,
  };
}

describe('stateUpdates (plaintext sessions)', () => {
  it('sends runtime activity through its public projection socket mutation only', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => ({
      result: 'success',
      didWrite: true,
      runtimeActivityActiveCount: payload.runtimeActivityActiveCount,
      runtimeActivityObservedAt: payload.runtimeActivityObservedAt,
      runtimeActivityExpiresAt: payload.runtimeActivityExpiresAt,
      runtimeActivitySourceClass: payload.runtimeActivitySourceClass,
    }));

    await updateSessionRuntimeActivityProjectionWithAck({
      socket: { emitWithAck },
      sessionId: 's1',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });

    expect(emitWithAck).toHaveBeenCalledWith('update-runtime-activity', {
      sid: 's1',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    });
    const [, payload] = emitWithAck.mock.calls[0]!;
    expect(payload).not.toHaveProperty('thinking');
    expect(payload).not.toHaveProperty('activeAt');
    expect(payload).not.toHaveProperty('latestTurnStatus');
    expect(payload).not.toHaveProperty('meaningfulActivityAt');
    expect(payload).not.toHaveProperty('metadata');
    expect(payload).not.toHaveProperty('agentState');
  });

  it('raises a typed retryable error when runtime activity projection writes fail', async () => {
    const socket = {
      emitWithAck: vi.fn(async () => ({
        result: 'error',
        error: 'internal',
      })),
    };

    await expect(updateSessionRuntimeActivityProjectionWithAck({
      socket,
      sessionId: 's1',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task',
    })).rejects.toMatchObject({
      code: 'runtime_activity_update_failed',
      retryable: true,
    });
  });

  it('sends + applies plaintext metadata updates when session encryption mode is plain', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => {
      expect(typeof payload.metadata).toBe('string');
      expect(payload.metadata).toContain('"path":"');
      return {
        result: 'success',
        metadata: payload.metadata,
        version: payload.expectedVersion + 1,
      };
    });

    const socket = { emitWithAck };

    let metadata: any = { path: '/tmp', host: 'localhost' };
    let version = 1;

    await updateSessionMetadataWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => ({ ...current, path: '/tmp2' }),
    });

    expect(metadata.path).toBe('/tmp2');
    expect(version).toBe(2);
  });

  it('logs currentModeId from the canonical sessionModesV1 metadata key', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => ({
      result: 'success',
      metadata: payload.metadata,
      version: payload.expectedVersion + 1,
    }));

    const socket = { emitWithAck };
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    let metadata: any = { path: '/tmp', host: 'localhost' };
    let version = 1;

    await updateSessionMetadataWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => ({
        ...current,
        sessionModesV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 1,
          currentModeId: 'plan',
          availableModes: [{ id: 'plan', name: 'Plan' }],
        },
      }),
    });

    expect(debugSpy).toHaveBeenCalledWith(
      '[API] updateMetadata attempting',
      expect.objectContaining({ currentModeId: 'plan' }),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      '[API] updateMetadata success',
      expect.objectContaining({ currentModeId: 'plan' }),
    );

    debugSpy.mockRestore();
  });

  it('sends projected request counts with update-state payloads', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => {
      expect(payload.activitySummaryV1).toEqual({
        pendingPermissionRequestCount: 1,
        pendingUserActionRequestCount: 1,
        pendingRequestNewestCreatedAt: 2,
      });
      return {
        result: 'success',
        agentState: payload.agentState,
        version: payload.expectedVersion + 1,
      };
    });

    const socket = { emitWithAck };

    let agentState: any = { requests: {}, completedRequests: {} };
    let version = 1;

    await updateSessionAgentStateWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getAgentState: () => agentState,
      setAgentState: (next) => {
        agentState = next;
      },
      getAgentStateVersion: () => version,
      setAgentStateVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: () => ({
        requests: {
          req_permission: {
            tool: 'Write',
            arguments: { path: '/tmp/a.ts' },
            createdAt: 1,
          },
          req_action: {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            arguments: { question: 'Ship it?' },
            createdAt: 2,
          },
          req_completed: {
            tool: 'Write',
            arguments: { path: '/tmp/b.ts' },
            createdAt: 3,
          },
        },
        completedRequests: {
          req_completed: {
            tool: 'Write',
            arguments: { path: '/tmp/b.ts' },
            createdAt: 3,
            status: 'approved',
            completedAt: 4,
          },
        },
      }),
    });

    expect(agentState.requests.req_permission.tool).toBe('Write');
    expect(version).toBe(2);
  });

  it('does not send stale runtime issue summaries with update-state payloads', async () => {
    const runtimeIssueSummaryV1 = {
      latestTurnStatus: 'failed',
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1_778_089_800_000,
        provider: 'codex',
        sanitizedPreview: 'Usage limit reached',
      },
    } as const;
    const emitWithAck = vi.fn(async (_event: string, payload: any) => {
      expect(payload).not.toHaveProperty('runtimeIssueSummaryV1');
      return {
        result: 'success',
        agentState: payload.agentState,
        version: payload.expectedVersion + 1,
      };
    });

    let agentState: any = { requests: {}, completedRequests: {} };
    let version = 1;
    const updateWithStaleRuntimeIssueSummary = {
      socket: { emitWithAck },
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getAgentState: () => agentState,
      setAgentState: (next) => {
        agentState = next;
      },
      getAgentStateVersion: () => version,
      setAgentStateVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => current,
      runtimeIssueSummaryV1,
    } satisfies Parameters<typeof updateSessionAgentStateWithAck>[0] & {
      runtimeIssueSummaryV1: typeof runtimeIssueSummaryV1;
    };

    await updateSessionAgentStateWithAck(updateWithStaleRuntimeIssueSummary);

    expect(version).toBe(2);
  });

  it('rejects metadata writes when the version remains unknown after snapshot sync', async () => {
    const socket = { emitWithAck: vi.fn() };
    let version = -1;

    await expect(updateSessionMetadataWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => null,
      setMetadata: () => {},
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => ({ ...current, path: '/tmp' }),
    })).rejects.toMatchObject({
      code: 'metadata_version_unknown',
      retryable: false,
    });

    expect(socket.emitWithAck).not.toHaveBeenCalled();
  });

  it('treats null metadata snapshots as empty objects once the version is known', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: PlainMetadataAckPayload) => ({
      result: 'success',
      metadata: payload.metadata,
      version: payload.expectedVersion + 1,
    }));

    let metadata: Metadata | null = null;
    let version = 1;

    await updateSessionMetadataWithAck({
      socket: { emitWithAck },
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => createMetadata({ ...current, path: '/tmp' }),
    });

    expect(metadata).toEqual(createMetadata({ path: '/tmp' }));
    expect(version).toBe(2);
  });

  it('uses socket ACK timeouts for metadata writes when supported by the socket', async () => {
    const timedSocket = {
      emitWithAck: vi.fn(async (_event: string, payload: PlainMetadataAckPayload) => ({
        result: 'success',
        metadata: payload.metadata,
        version: payload.expectedVersion + 1,
      })),
    };
    const socket = {
      timeout: vi.fn(() => timedSocket),
      emitWithAck: vi.fn(),
    };

    await updateSessionMetadataWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => createMetadata({ path: '/tmp' }),
      setMetadata: () => {},
      getMetadataVersion: () => 1,
      setMetadataVersion: () => {},
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => current,
    });

    expect(socket.timeout).toHaveBeenCalledWith(expect.any(Number));
    expect(timedSocket.emitWithAck).toHaveBeenCalledTimes(1);
    expect(socket.emitWithAck).not.toHaveBeenCalled();
  });

  it('does not leave metadata updates pending forever when the socket ACK never settles', async () => {
    const previousTimeout = process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
    process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = '5';
    vi.useFakeTimers();

    try {
      const socket = {
        connected: true,
        emitWithAck: vi.fn(() => new Promise<never>(() => {})),
      };

      const updatePromise = updateSessionMetadataWithAck({
        socket,
        sessionId: 's1',
        sessionEncryptionMode: 'plain',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
        getMetadata: () => createMetadata({ path: '/tmp' }),
        setMetadata: () => {},
        getMetadataVersion: () => 1,
        setMetadataVersion: () => {},
        syncSessionSnapshotFromServer: async () => {},
        handler: (current) => current,
      }).then(
        () => ({ status: 'resolved' as const }),
        (error) => ({
          status: 'rejected' as const,
          code: error && typeof error === 'object' && 'code' in error ? String(error.code) : null,
        }),
      );

      await vi.advanceTimersByTimeAsync(20_000);
      const outcome = await Promise.race([
        updatePromise,
        Promise.resolve({ status: 'pending' as const }),
      ]);

      expect(outcome).toEqual({ status: 'rejected', code: 'socket_ack_timeout' });
    } finally {
      vi.useRealTimers();
      if (typeof previousTimeout === 'string') {
        process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = previousTimeout;
      } else {
        delete process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
      }
    }
  });
});
