import { describe, expect, it, vi } from 'vitest';
import { SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY } from '@happier-dev/protocol';

import type { Update, UserMessage } from '../../../types';
import { createSessionClientUpdateRuntime } from './createSessionClientUpdateRuntime';

describe('createSessionClientUpdateRuntime', () => {
  type RuntimeDeps = Parameters<typeof createSessionClientUpdateRuntime>[0];

  function createUserMessageUpdate(opts: {
    id: string;
    messageId: string;
    localId: string;
    seq: number;
    text: string;
    intent: 'default' | 'explicit_pending';
  }): Update {
    return {
      id: opts.id,
      createdAt: 1_000 + opts.seq,
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: opts.messageId,
          seq: opts.seq,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: opts.text },
              localId: opts.localId,
              meta: {
                source: 'ui',
                [SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY]: opts.intent,
              },
            },
          },
          localId: opts.localId,
          createdAt: 1_000 + opts.seq,
          updatedAt: 1_000 + opts.seq,
        },
      },
    } as Update;
  }

  function createRuntime(overrides: Partial<RuntimeDeps> = {}) {
    const delivered: UserMessage[] = [];
    const runtime = createSessionClientUpdateRuntime({
      sessionId: 'sess_1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => null,
      setMetadata: vi.fn(),
      getMetadataVersion: () => 0,
      setMetadataVersion: vi.fn(),
      getAgentState: () => null,
      setAgentState: vi.fn(),
      getAgentStateVersion: () => 0,
      setAgentStateVersion: vi.fn(),
      applyPendingQueueState: vi.fn(() => false),
      getPendingMessages: () => [],
      getPendingMessageCallback: () => (message) => {
        delivered.push(message);
      },
      getUserMessageCallbackAttachedAtMs: () => null,
      emit: vi.fn(),
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      hasAgentQueueDeliveredLocalId: () => false,
      hasCanonicalPendingDeliveryLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: vi.fn(),
      markAgentQueueDeliveredLocalId: vi.fn(),
      clearAgentQueueEchoSuppressedLocalId: vi.fn(),
      clearAgentQueueDeliveredLocalId: vi.fn(),
      hasPendingQueueMaterializedLocalId: () => true,
      deleteMaterializedLocalId: vi.fn(),
      initialLastObservedMessageSeq: 0,
      getLatestTurnStatus: () => 'in_progress',
      ...overrides,
    } satisfies RuntimeDeps);

    return { delivered, runtime };
  }

  it('drives pending-change retries from the accepted canonical queue state', () => {
    const onPendingChangedDrainTrigger = vi.fn();
    const canonicalState = {
      known: true,
      pendingCount: 2,
      pendingBlockedCount: 0,
      pendingVersion: 5,
    } as const;
    const { runtime } = createRuntime({
      getPendingQueueState: () => canonicalState,
      applyPendingQueueState: vi.fn(() => false),
      onPendingChangedDrainTrigger,
    });

    runtime.handleUpdate({
      id: 'stale-pending-change',
      seq: 1,
      createdAt: 1_000,
      body: {
        t: 'pending-changed',
        sid: 'sess_1',
        pendingCount: 0,
        pendingBlockedCount: 0,
        pendingVersion: 4,
      },
    } as Update, { source: 'user-scoped' });

    expect(onPendingChangedDrainTrigger).toHaveBeenCalledWith(canonicalState);
  });

  it('holds explicit-pending materialized rows during active turns while allowing default rows', () => {
    const { delivered, runtime } = createRuntime();

    runtime.handleUpdate(
      createUserMessageUpdate({
        id: 'pending-materialized-explicit',
        messageId: 'm-explicit',
        localId: 'pending-explicit',
        seq: 6,
        text: 'stay pending',
        intent: 'explicit_pending',
      }),
      { source: 'session-scoped' },
    );
    runtime.handleUpdate(
      createUserMessageUpdate({
        id: 'pending-materialized-default',
        messageId: 'm-default',
        localId: 'pending-default',
        seq: 7,
        text: 'deliver default',
        intent: 'default',
      }),
      { source: 'session-scoped' },
    );

    expect(delivered.map((message) => message.content.text)).toEqual(['deliver default']);
  });

  it('delivers materialized explicit-pending rows during active turns when live delivery is requested', () => {
    const { delivered, runtime } = createRuntime();

    runtime.handleUpdate(
      createUserMessageUpdate({
        id: 'pending-materialized-explicit-live',
        messageId: 'm-explicit-live',
        localId: 'pending-explicit-live',
        seq: 8,
        text: 'deliver active pending',
        intent: 'explicit_pending',
      }),
      {
        source: 'session-scoped',
        pendingMaterializationActiveTurnPolicy: 'allow_live_delivery',
      },
    );

    expect(delivered.map((message) => message.content.text)).toEqual(['deliver active pending']);
  });

  it('records delivered user-message seqs from committed local queue handoff acks', () => {
    const deliveredSeqs: number[] = [];
    const markAgentQueueEchoSuppressedLocalId = vi.fn();
    const { runtime } = createRuntime({
      markAgentQueueEchoSuppressedLocalId,
      onUserMessageDeliveredToAgentQueue: (seq) => {
        deliveredSeqs.push(seq);
      },
    });

    runtime.observeCommittedAck({
      seq: 12,
      localId: 'daemon-initial-prompt:sess_1',
      markAsUserMessage: true,
      refreshAgentQueueEchoSuppression: true,
    });

    expect(markAgentQueueEchoSuppressedLocalId).toHaveBeenCalledWith('daemon-initial-prompt:sess_1');
    expect(deliveredSeqs).toEqual([12]);
  });

  it('does not redeliver non-catchup socket replays below the delivered user-message watermark', () => {
    const { delivered, runtime } = createRuntime({
      getDeliveredUserMessageSeq: () => 12,
    });

    runtime.handleUpdate(
      createUserMessageUpdate({
        id: 'socket-replay-user-message',
        messageId: 'm-socket-replay',
        localId: 'daemon-initial-prompt:sess_1',
        seq: 12,
        text: 'already delivered',
        intent: 'default',
      }),
      { source: 'session-scoped' },
    );

    expect(delivered).toHaveLength(0);
    expect(runtime.getLastObservedUserMessageSeq()).toBe(12);
  });

  it('does not deliver catch-up rows still owned by canonical pending delivery', () => {
    const { delivered, runtime } = createRuntime({
      hasCanonicalPendingDeliveryLocalId: (localId) => localId === 'pending-claim-local',
    });

    runtime.handleUpdate(
      createUserMessageUpdate({
        id: 'catchup-canonical-pending',
        messageId: 'm-canonical-pending',
        localId: 'pending-claim-local',
        seq: 13,
        text: 'still owned by pending queue',
        intent: 'explicit_pending',
      }),
      {
        source: 'session-scoped',
        catchUpAfterSeq: 12,
        catchUpAuthorization: 'explicit_cursor',
      },
    );

    expect(delivered).toHaveLength(0);
  });

  it('preserves positive-watermark catch-up delivery for reconnect recovery', () => {
    const { delivered, runtime } = createRuntime({
      getLatestTurnStatus: () => 'completed',
    });

    runtime.handleUpdate(
      createUserMessageUpdate({
        id: 'catchup-reconnect-watermark',
        messageId: 'm-reconnect-watermark',
        localId: 'reconnect-watermark-local',
        seq: 14,
        text: 'deliver from reconnect watermark',
        intent: 'default',
      }),
      {
        source: 'session-scoped',
        catchUpAfterSeq: 12,
        catchUpAuthorization: 'reconnect_watermark',
      },
    );

    expect(delivered.map((message) => message.content.text)).toEqual(['deliver from reconnect watermark']);
  });

  it('preserves explicit zero-cursor catch-up delivery', () => {
    const { delivered, runtime } = createRuntime({
      getLatestTurnStatus: () => 'completed',
    });

    runtime.handleUpdate(
      createUserMessageUpdate({
        id: 'catchup-explicit-zero',
        messageId: 'm-explicit-zero',
        localId: 'explicit-zero-local',
        seq: 1,
        text: 'deliver from explicit zero cursor',
        intent: 'default',
      }),
      {
        source: 'session-scoped',
        catchUpAfterSeq: 0,
        catchUpAuthorization: 'explicit_cursor',
      },
    );

    expect(delivered.map((message) => message.content.text)).toEqual(['deliver from explicit zero cursor']);
  });

  it('applies runtime activity projection from update-session payloads', () => {
    const onRuntimeActivityProjectionFromServer = vi.fn();
    const { runtime } = createRuntime({
      onRuntimeActivityProjectionFromServer,
    });

    runtime.handleUpdate(
      {
        id: 'runtime-activity-update',
        seq: 14,
        createdAt: 1_014,
        body: {
          t: 'update-session',
          id: 'sess_1',
          sid: 'sess_1',
          runtimeActivityActiveCount: 0,
          runtimeActivityObservedAt: null,
          runtimeActivityExpiresAt: null,
          runtimeActivitySourceClass: null,
        },
      } as Update,
      { source: 'session-scoped' },
    );

    expect(onRuntimeActivityProjectionFromServer).toHaveBeenCalledWith({
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: null,
      runtimeActivityExpiresAt: null,
      runtimeActivitySourceClass: null,
    });
  });
});
