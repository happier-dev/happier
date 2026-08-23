import {
  FeaturesResponseSchema,
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseReleasedServerV021Features } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { loadPendingOutboxForSession } from '@/sync/domains/state/pendingOutboxPersistence';
import { buildSession, resetPendingQueueState } from '@/sync/engine/pending/pendingQueueV2.testHelpers';
import { createServerScopedSessionSendMessage } from './serverScopedSessionSendMessage';

const serverFeaturesSnapshotMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const resumeSessionMock = vi.hoisted(() => vi.fn());
const kvStore = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
  class MMKV {
    getString(key: string) {
      return kvStore.get(key);
    }
    set(key: string, value: string) {
      kvStore.set(key, value);
    }
    delete(key: string) {
      kvStore.delete(key);
    }
    getAllKeys() {
      return [...kvStore.keys()];
    }
    clearAll() {
      kvStore.clear();
    }
  }

  return { MMKV };
});

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
  getServerFeaturesSnapshot: serverFeaturesSnapshotMock,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
  runtimeFetchWithServerReachability: runtimeFetchMock,
}));

vi.mock('@/sync/ops/sessions', () => ({
  resumeSession: resumeSessionMock,
}));

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1', serverId: 'server-1', seq: 1, createdAt: 1, updatedAt: 1,
    active: true, activeAt: 1, pendingVersion: 2, pendingCount: 0,
    metadata: { machineId: 'm1', path: '/tmp/project', host: 'host', flavor: 'claude', version: '999.0.0' },
    metadataVersion: 1, agentState: null, agentStateVersion: 1,
    thinking: false, thinkingAt: 0, presence: 1, optimisticThinkingAt: null,
    ...overrides,
  };
}

function composerAttachmentOnlyMeta(): Record<string, unknown> {
  return {
    [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
      v: 1,
      composerAttachments: [{
        v: 1,
        instanceId: 'attachment-instance-1',
        attachment: {
          pluginId: 'com.acme.review',
          localId: 'review',
        },
        key: 'review-42',
        value: { reviewId: '42' },
        presentation: { label: 'Review #42', typeLabel: 'Review comment' },
        // The real Composer shape: a draft whose media is still the
        // transfer-owned staged claim. Only the daemon's SessionMedia
        // finalizer may replace it, so the admitted-only projection cannot
        // hold this record and must not decide whether the turn is empty.
        content: {
          kind: 'stagedMedia',
          handle: {
            v: 1,
            id: 'staged-content-42',
            executionTarget: { serverId: 'server-1', machineId: 'm1' },
            owner: { pluginId: 'com.acme.review', localId: 'review' },
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'review-42.png',
            sizeBytes: 2048,
            sha256: 'a'.repeat(64),
          },
        },
      }],
    },
  };
}

describe('sendSessionMessageWithServerScope', () => {
  beforeEach(() => {
    resetPendingQueueState();
    kvStore.clear();
    serverFeaturesSnapshotMock.mockReset();
    runtimeFetchMock.mockReset();
    resumeSessionMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes active ordinary input with an explicit enqueue action', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'local-1', accepted: true }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession(),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1', message: 'hello', messageLocalId: 'local-1',
    })).resolves.toMatchObject({ ok: true, ack: { localId: 'local-1', persistence: 'pending', accepted: true } });

    expect(enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1', 'hello', undefined, undefined,
      { localId: 'local-1', requestedAction: { v: 1, kind: 'enqueue' } },
    );
  });

  it('admits an attachment-only active first turn with the stable local id', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'attachment-only-1', accepted: true }));
    serverFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: parseReleasedServerV021Features(),
    });
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession(),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });
    const metaOverrides = composerAttachmentOnlyMeta();

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: '',
      metaOverrides,
      messageLocalId: 'attachment-only-1',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({
      ok: true,
      ack: { localId: 'attachment-only-1', persistence: 'pending', accepted: true },
    });

    expect(enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1',
      '',
      undefined,
      metaOverrides,
      { localId: 'attachment-only-1', requestedAction: { v: 1, kind: 'enqueue' } },
    );
  });

  it('keeps blank input without an approved composer attachment rejected', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'must-not-send', accepted: true }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession(),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: '   ',
      metaOverrides: { arbitrary: 'metadata-is-not-input' },
      messageLocalId: 'must-not-send',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(enqueuePendingMessageActive).not.toHaveBeenCalled();
  });

  it('keeps blank input with a malformed composer attachment selection rejected', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'must-not-send-malformed', accepted: true }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession(),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: '',
      metaOverrides: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [{ malformed: true }],
        },
      },
      messageLocalId: 'must-not-send-malformed',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(enqueuePendingMessageActive).not.toHaveBeenCalled();
  });

  it('preserves an explicit settings-aware action intent from the Action surface', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'action-1', accepted: true }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession(),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });

    await sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'continue',
      messageLocalId: 'action-1',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    });

    expect(enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1', 'continue', undefined, undefined,
      { localId: 'action-1', requestedAction: { v: 1, kind: 'steer_if_active' } },
    );
  });

  it('leaves an inactive first-turn wake to the durable Pending activation owner', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'wake-1', accepted: true }));
    const session = createSession({ active: false, presence: 0 });
    serverFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
          session: {
            pendingInput: { protocolVersion: 1 },
          },
        },
      }),
    });
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => session,
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });

    await sendSessionMessageWithServerScope({
      sessionId: 's1', message: 'wake now', messageLocalId: 'wake-1', providerDeliveryIntent: 'first_turn',
    });

    expect(enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1', 'wake now', undefined, undefined,
      { localId: 'wake-1', requestedAction: { v: 1, kind: 'send_now' } },
    );
    expect(serverFeaturesSnapshotMock).toHaveBeenCalledWith({ serverId: 'server-1' });
    expect(resumeSessionMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'current Pending contract',
      snapshot: {
        status: 'ready' as const,
        features: FeaturesResponseSchema.parse({
          features: {},
          capabilities: {
            session: {
              pendingInput: { protocolVersion: 1 },
            },
          },
        }),
      },
      expectedAction: 'send_now',
    },
    {
      name: 'released server',
      snapshot: {
        status: 'ready' as const,
        features: parseReleasedServerV021Features(),
      },
      expectedAction: 'enqueue',
    },
    {
      name: 'indeterminate server contract',
      snapshot: { status: 'error' as const, reason: 'network' as const },
      expectedAction: 'enqueue',
    },
  ])('maps active first-turn input for the $name', async ({ snapshot, expectedAction }) => {
    serverFeaturesSnapshotMock.mockResolvedValue(snapshot);
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'active-first-turn', accepted: true }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession(),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'first prompt',
      messageLocalId: 'active-first-turn',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({ ok: true, ack: { localId: 'active-first-turn', accepted: true } });

    expect(enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1',
      'first prompt',
      undefined,
      undefined,
      { localId: 'active-first-turn', requestedAction: { v: 1, kind: expectedAction } },
    );
    expect(serverFeaturesSnapshotMock).toHaveBeenCalledWith({ serverId: 'server-1' });
  });

  it.each([
    {
      name: 'released server first turn',
      features: parseReleasedServerV021Features(),
      expectedBody: {
        localId: 'first-turn-1',
        content: expect.objectContaining({ t: 'plain' }),
      },
      released: true,
    },
    {
      name: 'current server first turn',
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
          session: {
            pendingInput: { protocolVersion: 1 },
          },
        },
      }),
      expectedBody: expect.objectContaining({
        localId: 'first-turn-1',
        requestedAction: { v: 1, kind: 'send_now' },
      }),
      released: false,
    },
  ])('serializes $name through its selected wire contract', async ({ features, expectedBody, released }) => {
    const session = buildSession({
      sessionId: 's1',
      overrides: { serverId: 'server-1', encryptionMode: 'plain' },
    });
    storage.getState().applySessions([session]);
    serverFeaturesSnapshotMock.mockResolvedValue({ status: 'ready', features });
    runtimeFetchMock.mockImplementation(async (request: Readonly<{ init?: RequestInit }>) => {
      const body = JSON.parse(String(request.init?.body ?? 'null')) as Record<string, unknown>;
      if (!released) {
        return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId } });
      }
      return Response.json({
        didWrite: true,
        pending: {
          localId: body.localId,
          content: body.content,
          status: 'queued',
          position: 0,
          createdAt: 1,
          updatedAt: 1,
          discardedAt: null,
          discardedReason: null,
          authorAccountId: 'account-1',
        },
        pendingCount: 1,
        pendingVersion: 1,
      });
    });
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      schedulePendingOutboxRetry: vi.fn(),
      markSessionLiveTailIntent: vi.fn(),
      resolveContext: vi.fn(async () => ({
        scope: 'scoped' as const,
        timeoutMs: 1_000,
        targetServerId: 'server-1',
        targetServerUrl: 'https://server.example.test',
        targetAccountId: 'account-1',
        token: 'token-1',
        encryption: {
          decryptEncryptionKey: async () => null,
          initializeSessions: async () => {},
          getSessionEncryption: () => null,
        },
      })),
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-1',
      message: 'first prompt',
      messageLocalId: 'first-turn-1',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({ ok: true, ack: { localId: 'first-turn-1', accepted: true } });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    const request = runtimeFetchMock.mock.calls[0]?.[0] as Readonly<{ init?: RequestInit }>;
    const body = JSON.parse(String(request.init?.body ?? 'null')) as Record<string, unknown>;
    expect(body).toEqual(expectedBody);
    if (released) {
      expect(body).not.toHaveProperty('requestedAction');
    }
  });

  it('establishes live-tail intent before a scoped first-turn pending projection', async () => {
    const session = buildSession({
      sessionId: 's1',
      overrides: { serverId: 'server-1', encryptionMode: 'plain' },
    });
    storage.getState().applySessions([session]);
    const { sync } = await import('@/sync/sync');
    sync.onSessionViewportChange('s1', {
      isPinned: false,
      offsetY: 420,
      shouldPersistViewport: false,
      shouldRestoreViewport: true,
      anchor: {
        kind: 'message',
        messageId: 'message-1',
        seq: 1,
        itemId: 'msg:message-1',
        itemOffsetPx: 12,
        capturedAtMs: 1_000,
      },
    });
    expect(sync.getSessionViewport('s1')).toMatchObject({
      isPinned: false,
      source: 'observed',
    });

    const originalMarkOptimisticThinking = storage.getState().markSessionOptimisticThinking;
    const markOptimisticThinking = vi
      .spyOn(storage.getState(), 'markSessionOptimisticThinking')
      .mockImplementation((sessionId) => {
        expect(sessionId).toBe('s1');
        expect(sync.getSessionViewport('s1')).toMatchObject({
          isPinned: true,
          offsetY: 0,
          source: 'default',
          anchor: null,
        });
        originalMarkOptimisticThinking(sessionId);
      });
    serverFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
          session: {
            pendingInput: { protocolVersion: 1 },
          },
        },
      }),
    });
    runtimeFetchMock.mockResolvedValue(Response.json({
      requestedAction: { v: 1, kind: 'send_now' },
      pending: { localId: 'scoped-cross-mount-first-turn' },
    }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      schedulePendingOutboxRetry: vi.fn(),
      markSessionLiveTailIntent: (sessionId) => sync.markSessionLiveTailIntent(sessionId),
      resolveContext: vi.fn(async () => ({
        scope: 'scoped' as const,
        timeoutMs: 1_000,
        targetServerId: 'server-1',
        targetServerUrl: 'https://server.example.test',
        targetAccountId: 'account-1',
        token: 'token-1',
        encryption: {
          decryptEncryptionKey: async () => null,
          initializeSessions: async () => {},
          getSessionEncryption: () => null,
        },
      })),
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-1',
      message: 'scoped first prompt',
      messageLocalId: 'scoped-cross-mount-first-turn',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({ ok: true });

    expect(markOptimisticThinking).toHaveBeenCalled();
  });

  it('persists scoped first-turn custody as enqueue while the server wire mode is indeterminate', async () => {
    const session = buildSession({
      sessionId: 's1',
      overrides: { serverId: 'server-1', encryptionMode: 'plain' },
    });
    storage.getState().applySessions([session]);
    serverFeaturesSnapshotMock.mockResolvedValue({ status: 'error', reason: 'network' });
    const schedulePendingOutboxRetry = vi.fn();
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      schedulePendingOutboxRetry,
      markSessionLiveTailIntent: vi.fn(),
      resolveContext: vi.fn(async () => ({
        scope: 'scoped' as const,
        timeoutMs: 1_000,
        targetServerId: 'server-1',
        targetServerUrl: 'https://server.example.test',
        targetAccountId: 'account-1',
        token: 'token-1',
        encryption: {
          decryptEncryptionKey: async () => null,
          initializeSessions: async () => {},
          getSessionEncryption: () => null,
        },
      })),
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-1',
      message: 'first prompt',
      messageLocalId: 'first-turn-indeterminate',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({
      ok: true,
      ack: { localId: 'first-turn-indeterminate', accepted: false },
    });

    expect(runtimeFetchMock).not.toHaveBeenCalled();
    expect(schedulePendingOutboxRetry).not.toHaveBeenCalled();
    const [outboxRow] = loadPendingOutboxForSession('s1', {
      serverId: 'server-1',
      accountId: 'account-1',
    });
    expect(JSON.parse(String(outboxRow?.request.body ?? 'null'))).toMatchObject({
      localId: 'first-turn-indeterminate',
      requestedAction: { v: 1, kind: 'enqueue' },
    });
  });

  it('keeps explicit immediate send_now fail-closed against the released server', async () => {
    const session = buildSession({
      sessionId: 's1',
      overrides: { serverId: 'server-1', encryptionMode: 'plain' },
    });
    storage.getState().applySessions([session]);
    serverFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: parseReleasedServerV021Features(),
    });
    const schedulePendingOutboxRetry = vi.fn();
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      schedulePendingOutboxRetry,
      markSessionLiveTailIntent: vi.fn(),
      resolveContext: vi.fn(async () => ({
        scope: 'scoped' as const,
        timeoutMs: 1_000,
        targetServerId: 'server-1',
        targetServerUrl: 'https://server.example.test',
        targetAccountId: 'account-1',
        token: 'token-1',
        encryption: {
          decryptEncryptionKey: async () => null,
          initializeSessions: async () => {},
          getSessionEncryption: () => null,
        },
      })),
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-1',
      message: 'send immediately',
      messageLocalId: 'immediate-old-server',
      providerDeliveryIntent: 'immediate',
    })).rejects.toMatchObject({ code: 'server-upgrade-required' });

    expect(runtimeFetchMock).not.toHaveBeenCalled();
    expect(schedulePendingOutboxRetry).not.toHaveBeenCalled();
    expect(loadPendingOutboxForSession('s1', {
      serverId: 'server-1',
      accountId: 'account-1',
    })).toEqual([]);
  });
});
