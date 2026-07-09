import { describe, expect, it, vi } from 'vitest';

import type { Update } from '../types';
import { encrypt } from '../encryption';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';

describe('handleSessionNewMessageUpdate', () => {
  it('logs invalid content envelope shapes without leaking string contents', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const debug = vi.fn();

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: { foo: 'bar', secret: 'SUPER_SECRET_VALUE' },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug,
      debugLargeJson: () => void 0,
    });

    expect(debug).toHaveBeenCalled();
    const calls = JSON.stringify(debug.mock.calls);
    expect(calls).toContain('secret');
    expect(calls).not.toContain('SUPER_SECRET_VALUE');
    expect(pendingMessages).toHaveLength(0);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(false);
  });

  it('delivers legacy string user prompts to the agent queue', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: { t: 'plain', v: { role: 'user', content: 'hello legacy' } },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('hello legacy');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('observes committed user seqs from parsed payloads before delivering to the agent queue', () => {
    const events: string[] = [];
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const observeCommittedUserMessageSeq = vi.fn((params: { localId: string | null | undefined; seq: number }) => {
      events.push(`observed:${params.localId}:${params.seq}`);
    });

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 24,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'pending prompt without transport role' },
              localId: 'pending-local-24',
            },
          },
          localId: 'pending-local-24',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => true,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: () => {
        events.push('delivered');
      },
      pendingMessages,
      observeCommittedUserMessageSeq,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(observeCommittedUserMessageSeq).toHaveBeenCalledWith({
      localId: 'pending-local-24',
      seq: 24,
    });
    expect(events).toEqual(['observed:pending-local-24:24', 'delivered']);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('applies the agent-queue delivery gate to legacy string user prompts', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const shouldDeliverUserMessageToAgentQueue = vi.fn(() => false);

    const update = {
      id: 'catchup-1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: { t: 'plain', v: { role: 'user', content: 'stale legacy prompt' } },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      shouldDeliverUserMessageToAgentQueue,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(shouldDeliverUserMessageToAgentQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: { type: 'text', text: 'stale legacy prompt' },
      }),
      update,
    );
    expect(pendingMessages).toHaveLength(0);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('delivers legacy ciphertext string content envelopes to the agent queue', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];

    const encryptionKey = new Uint8Array(32);
    encryptionKey.fill(7);

    const rawBody = {
      role: 'user',
      content: { type: 'text', text: 'hello encrypted' },
    };
    const ciphertextBytes = encrypt(encryptionKey, 'legacy', rawBody);
    const ciphertext = Buffer.from(ciphertextBytes).toString('base64');

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          // Legacy server/client shape: `content` was just ciphertext.
          content: ciphertext,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey,
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('hello encrypted');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('does not drop user prompts when agent-queue echo suppression is set but no callback is attached', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => true,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('hello');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('delivers daemon-initial-prompt user messages even when they originate from the CLI', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const pendingMessageCallback = (msg: any) => {
      pendingMessages.push(msg);
    };

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'daemon initial prompt' },
              localId: 'l1',
              meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => true,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback,
      pendingMessages: [],
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('daemon initial prompt');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('keeps pending-queue materialized custody when the local id is also self-echo suppressed', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const deleteMaterializedLocalId = vi.fn();

    const update = {
      id: 'pending-materialized-m1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 4,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'pending materialized prompt' },
              localId: 'local-pending-1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          localId: 'local-pending-1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => true,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => true,
      deleteMaterializedLocalId,
      pendingMessageCallback: (message) => {
        pendingMessages.push(message);
      },
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.text).toBe('pending materialized prompt');
    expect(deleteMaterializedLocalId).not.toHaveBeenCalled();
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('does not permanently dedupe a catch-up user prompt that was skipped before it became deliverable', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const receivedMessageIds = new Set<string>();
    const pendingMessageCallback = vi.fn((msg: any) => {
      pendingMessages.push(msg);
    });

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'startup catch-up prompt' },
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          localId: null,
          createdAt: Date.now() - 120_000,
          updatedAt: Date.now() - 120_000,
        },
      },
    } as unknown as Update;

    const skippedResult = handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds,
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback,
      pendingMessages,
      shouldDeliverUserMessageToAgentQueue: () => false,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(skippedResult.handled).toBe(true);
    expect(pendingMessageCallback).not.toHaveBeenCalled();
    expect(receivedMessageIds.has('m1')).toBe(false);

    const deliveredResult = handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds,
      lastObservedMessageSeq: skippedResult.lastObservedMessageSeq,
      lastObservedUserMessageSeq: skippedResult.lastObservedUserMessageSeq,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback,
      pendingMessages,
      shouldDeliverUserMessageToAgentQueue: () => true,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(deliveredResult.handled).toBe(true);
    expect(pendingMessageCallback).toHaveBeenCalledTimes(1);
    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.text).toBe('startup catch-up prompt');
    expect(receivedMessageIds.has('m1')).toBe(true);
  });

  it('publishes mapped connected-service turn lifecycle completion events from agent lifecycle messages', () => {
    const lifecycleEvents: Array<'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled'> = [];
    const update = {
      id: 'u-task-complete',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm-task-complete',
          seq: 5,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: { type: 'acp', data: { type: 'task_complete', id: 'run_1' } },
            },
          },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages: [],
      onConnectedServiceTurnLifecycleEvent: (event) => lifecycleEvents.push(event),
      emit: () => void 0,
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(lifecycleEvents).toEqual(['assistant_message_end']);
  });

  it('publishes task-started connected-service lifecycle events from agent lifecycle messages', () => {
    const lifecycleEvents: Array<'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled'> = [];
    const update = {
      id: 'u-task-started',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm-task-started',
          seq: 6,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: { type: 'acp', data: { type: 'task_started', id: 'run_1' } },
            },
          },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages: [],
      onConnectedServiceTurnLifecycleEvent: (event) => lifecycleEvents.push(event),
      emit: () => void 0,
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(lifecycleEvents).toEqual(['task_started']);
  });

  it('publishes mapped connected-service turn lifecycle events from runtime turn events', () => {
    const lifecycleEvents: Array<'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled'> = [];
    const update = {
      id: 'u-runtime-turn-start',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm-runtime-turn-start',
          seq: 6,
          content: {
            t: 'plain',
            v: {
              v: 1,
              sessionId: 'sess_1',
              emittedAtMs: 1_000,
              kind: 'turn-start',
              turnId: 'session-turn-1',
            },
          },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages: [],
      onConnectedServiceTurnLifecycleEvent: (event) => lifecycleEvents.push(event),
      emit: () => void 0,
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(lifecycleEvents).toEqual(['prompt_or_steer']);
  });

  it('publishes mapped connected-service turn lifecycle cancel events from agent lifecycle messages', () => {
    const lifecycleEvents: Array<'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled'> = [];
    const update = {
      id: 'u-turn-cancelled',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm-turn-cancelled',
          seq: 6,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: { type: 'acp', data: { type: 'turn_cancelled', id: 'run_2' } },
            },
          },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages: [],
      onConnectedServiceTurnLifecycleEvent: (event) => lifecycleEvents.push(event),
      emit: () => void 0,
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(lifecycleEvents).toEqual(['turn_cancelled']);
  });

  describe('owed-delivery watermark (deliveredUserMessageSeqV1)', () => {
    function buildUserMessageUpdate(opts: { seq: number; localId?: string | null; source?: string }): Update {
      return {
        id: `u-seq-${opts.seq}`,
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 'sess_1',
          message: {
            id: `m-seq-${opts.seq}`,
            seq: opts.seq,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: `prompt-${opts.seq}` },
                ...(opts.source ? { meta: { source: opts.source } } : {}),
              },
            },
            localId: opts.localId ?? null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      } as unknown as Update;
    }

    function baseParams() {
      return {
        sessionId: 'sess_1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy' as const,
        receivedMessageIds: new Set<string>(),
        lastObservedMessageSeq: 0,
        lastObservedUserMessageSeq: 0,
        hasSelfEchoSuppressedLocalId: () => false,
        hasAgentQueueEchoSuppressedLocalId: () => false,
        markAgentQueueEchoSuppressedLocalId: () => void 0,
        hasPendingQueueMaterializedLocalId: () => false,
        deleteMaterializedLocalId: () => void 0,
        emit: () => void 0,
        debug: () => void 0,
        debugLargeJson: () => void 0,
      };
    }

    it('fires the delivery hook with the message seq when a user message is handed to the agent queue', () => {
      const deliveredSeqs: number[] = [];
      const delivered: unknown[] = [];

      handleSessionNewMessageUpdate({
        ...baseParams(),
        update: buildUserMessageUpdate({ seq: 6 }),
        pendingMessageCallback: (message) => {
          delivered.push(message);
        },
        pendingMessages: [],
        onUserMessageDeliveredToAgentQueue: (seq) => {
          deliveredSeqs.push(seq);
        },
      });

      expect(delivered).toHaveLength(1);
      expect(deliveredSeqs).toEqual([6]);
    });

    it('keeps a server echo replayable when the agent queue handoff is declined', () => {
      const receivedMessageIds = new Set<string>();
      const delivered: unknown[] = [];
      let acceptQueueHandoff = false;
      const update = buildUserMessageUpdate({ seq: 7, localId: 'first-turn-1' });

      const params = {
        ...baseParams(),
        update,
        receivedMessageIds,
        pendingMessageCallback: (message: unknown) => {
          if (!acceptQueueHandoff) return false;
          delivered.push(message);
          return true;
        },
        pendingMessages: [],
      };

      handleSessionNewMessageUpdate(params);

      expect(delivered).toHaveLength(0);
      expect(receivedMessageIds.has('m-seq-7')).toBe(false);

      acceptQueueHandoff = true;
      handleSessionNewMessageUpdate(params);

      expect(delivered).toHaveLength(1);
      expect(receivedMessageIds.has('m-seq-7')).toBe(true);
    });

    it('routes an agent-queue echo of a locally delivered prompt to the queue-handoff hook', () => {
      // The echo suppresses duplicate queue delivery and carries the committed seq, but provider
      // acceptance may still be pending. Keep it on the queue-handoff hook so HF-1 launchers can
      // defer the durable delivered watermark until provider acceptance.
      const deliveredSeqs: number[] = [];
      const echoProvenSeqs: number[] = [];
      const delivered: unknown[] = [];

      handleSessionNewMessageUpdate({
        ...baseParams(),
        update: buildUserMessageUpdate({ seq: 9, localId: 'local-echo-1' }),
        hasAgentQueueEchoSuppressedLocalId: (localId) => localId === 'local-echo-1',
        hasAgentQueueDeliveredLocalId: (localId) => localId === 'local-echo-1',
        pendingMessageCallback: (message) => {
          delivered.push(message);
        },
        pendingMessages: [],
        onUserMessageDeliveredToAgentQueue: (seq) => {
          deliveredSeqs.push(seq);
        },
        onUserMessageDeliveryProvenByLocalEcho: (seq) => {
          echoProvenSeqs.push(seq);
        },
      });

      // Echo of a prompt already handed to the loop locally carries the seq without requeueing it.
      expect(delivered).toHaveLength(0);
      expect(deliveredSeqs).toEqual([9]);
      expect(echoProvenSeqs).toEqual([]);
    });

    it('keeps pending-queue materialized markers until provider acceptance owns cleanup', () => {
      const delivered: unknown[] = [];
      const deleteMaterializedLocalId = vi.fn();

      handleSessionNewMessageUpdate({
        ...baseParams(),
        update: buildUserMessageUpdate({ seq: 10, localId: 'pending-materialized-10' }),
        hasPendingQueueMaterializedLocalId: (localId) => localId === 'pending-materialized-10',
        deleteMaterializedLocalId,
        pendingMessageCallback: (message) => {
          delivered.push(message);
        },
        pendingMessages: [],
      });

      expect(delivered).toHaveLength(1);
      expect(deleteMaterializedLocalId).not.toHaveBeenCalled();
    });

    it('delivers provider-claim pending materializations even when local queue markers already exist', () => {
      const delivered: unknown[] = [];
      const deliveredSeqs: number[] = [];
      const localId = 'pending-provider-claim-local';

      handleSessionNewMessageUpdate({
        ...baseParams(),
        update: {
          id: 'pending-materialized-pending-provider-claim-local',
          createdAt: Date.now(),
          body: {
            t: 'new-message',
            sid: 'sess_1',
            message: {
              id: `pending-claim:${localId}:1000`,
              seq: null,
              content: {
                t: 'plain',
                v: {
                  role: 'user',
                  content: { type: 'text', text: 'provider claim prompt' },
                  localId,
                  meta: { source: 'ui' },
                },
              },
              localId,
              createdAt: 1_000,
              updatedAt: 1_000,
            },
          },
        } as unknown as Update,
        hasAgentQueueEchoSuppressedLocalId: (candidateLocalId) => candidateLocalId === localId,
        hasAgentQueueDeliveredLocalId: (candidateLocalId) => candidateLocalId === localId,
        hasPendingQueueMaterializedLocalId: (candidateLocalId) => candidateLocalId === localId,
        pendingMessageCallback: (message) => {
          delivered.push(message);
        },
        pendingMessages: [],
        onUserMessageDeliveredToAgentQueue: (seq) => {
          deliveredSeqs.push(seq);
        },
      });

      expect(delivered).toHaveLength(1);
      expect(deliveredSeqs).toEqual([]);
    });

    it('keeps agent-queue echo delivery observable when only the legacy queue-handoff hook is wired', () => {
      // Back-compat: callers that have not split the hooks must keep seeing the committed seq on
      // the queue-handoff hook (legacy persist-at-handoff backends).
      const deliveredSeqs: number[] = [];

      handleSessionNewMessageUpdate({
        ...baseParams(),
        update: buildUserMessageUpdate({ seq: 9, localId: 'local-echo-1' }),
        hasAgentQueueEchoSuppressedLocalId: (localId) => localId === 'local-echo-1',
        pendingMessageCallback: () => void 0,
        pendingMessages: [],
        onUserMessageDeliveredToAgentQueue: (seq) => {
          deliveredSeqs.push(seq);
        },
      });

      expect(deliveredSeqs).toEqual([9]);
    });

    it('routes a self-echo CLI transcript write to the echo hook, not the queue-handoff hook', () => {
      const deliveredSeqs: number[] = [];
      const echoProvenSeqs: number[] = [];
      const delivered: unknown[] = [];

      handleSessionNewMessageUpdate({
        ...baseParams(),
        update: buildUserMessageUpdate({ seq: 11, localId: 'local-cli-1', source: 'cli' }),
        hasSelfEchoSuppressedLocalId: (localId) => localId === 'local-cli-1',
        pendingMessageCallback: (message) => {
          delivered.push(message);
        },
        pendingMessages: [],
        onUserMessageDeliveredToAgentQueue: (seq) => {
          deliveredSeqs.push(seq);
        },
        onUserMessageDeliveryProvenByLocalEcho: (seq) => {
          echoProvenSeqs.push(seq);
        },
      });

      expect(delivered).toHaveLength(0);
      expect(deliveredSeqs).toEqual([]);
      expect(echoProvenSeqs).toEqual([11]);
    });

    it('uses the pre-delete self-echo suppression state for structured and legacy prompts', () => {
      const scenarios = [
        {
          label: 'structured',
          seq: 15,
          localId: 'local-structured-cli-stateful',
          body: {
            role: 'user',
            content: { type: 'text', text: 'structured provider-native self echo' },
            meta: { source: 'cli' },
          },
        },
        {
          label: 'legacy',
          seq: 16,
          localId: 'local-legacy-cli-stateful',
          body: {
            role: 'user',
            content: 'legacy provider-native self echo',
            meta: { source: 'cli' },
          },
        },
      ] as const;

      const results = scenarios.map((scenario) => {
        const selfEchoSuppressedLocalIds = new Set<string>([scenario.localId]);
        const deliveredSeqs: number[] = [];
        const echoProvenSeqs: number[] = [];
        const delivered: unknown[] = [];

        handleSessionNewMessageUpdate({
          ...baseParams(),
          update: {
            id: `u-${scenario.localId}`,
            createdAt: Date.now(),
            body: {
              t: 'new-message',
              sid: 'sess_1',
              message: {
                id: `m-${scenario.localId}`,
                seq: scenario.seq,
                content: { t: 'plain', v: scenario.body },
                localId: scenario.localId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            },
          } as unknown as Update,
          hasSelfEchoSuppressedLocalId: (localId) => selfEchoSuppressedLocalIds.has(localId),
          deleteMaterializedLocalId: (localId) => {
            selfEchoSuppressedLocalIds.delete(localId);
          },
          pendingMessageCallback: (message) => {
            delivered.push(message);
          },
          pendingMessages: [],
          onUserMessageDeliveredToAgentQueue: (seq) => {
            deliveredSeqs.push(seq);
          },
          onUserMessageDeliveryProvenByLocalEcho: (seq) => {
            echoProvenSeqs.push(seq);
          },
        });

        return {
          label: scenario.label,
          deliveredCount: delivered.length,
          deliveredSeqs,
          echoProvenSeqs,
        };
      });

      expect(results).toEqual([
        {
          label: 'structured',
          deliveredCount: 0,
          deliveredSeqs: [],
          echoProvenSeqs: [15],
        },
        {
          label: 'legacy',
          deliveredCount: 0,
          deliveredSeqs: [],
          echoProvenSeqs: [16],
        },
      ]);
    });

    it('dedupes structured and legacy echo-suppressed prompts after watermark hooks fire', () => {
      const scenarios = [
        {
          label: 'structured-agent-queue',
          seq: 17,
          localId: 'local-structured-agent-queue-dedupe',
          selfEchoSuppressed: false,
          agentQueueEchoSuppressed: true,
          body: {
            role: 'user',
            content: { type: 'text', text: 'structured agent queue echo' },
            meta: { source: 'ui' },
          },
          expectedDeliveredSeqs: [17],
          expectedEchoProvenSeqs: [],
        },
        {
          label: 'legacy-agent-queue',
          seq: 18,
          localId: 'local-legacy-agent-queue-dedupe',
          selfEchoSuppressed: false,
          agentQueueEchoSuppressed: true,
          body: {
            role: 'user',
            content: 'legacy agent queue echo',
            meta: { source: 'ui' },
          },
          expectedDeliveredSeqs: [18],
          expectedEchoProvenSeqs: [],
        },
        {
          label: 'structured-self-echo',
          seq: 19,
          localId: 'local-structured-self-dedupe',
          selfEchoSuppressed: true,
          agentQueueEchoSuppressed: false,
          body: {
            role: 'user',
            content: { type: 'text', text: 'structured self echo' },
            meta: { source: 'cli' },
          },
          expectedDeliveredSeqs: [],
          expectedEchoProvenSeqs: [19],
        },
        {
          label: 'legacy-self-echo',
          seq: 20,
          localId: 'local-legacy-self-dedupe',
          selfEchoSuppressed: true,
          agentQueueEchoSuppressed: false,
          body: {
            role: 'user',
            content: 'legacy self echo',
            meta: { source: 'cli' },
          },
          expectedDeliveredSeqs: [],
          expectedEchoProvenSeqs: [20],
        },
      ] as const;

      const results = scenarios.map((scenario) => {
        const messageId = `m-${scenario.localId}`;
        const receivedMessageIds = new Set<string>();
        const selfEchoSuppressedLocalIds = new Set<string>(
          scenario.selfEchoSuppressed ? [scenario.localId] : [],
        );
        const deliveredSeqs: number[] = [];
        const echoProvenSeqs: number[] = [];
        const delivered: unknown[] = [];
        const update = {
          id: `u-${scenario.localId}`,
          createdAt: Date.now(),
          body: {
            t: 'new-message',
            sid: 'sess_1',
            message: {
              id: messageId,
              seq: scenario.seq,
              content: { t: 'plain', v: scenario.body },
              localId: scenario.localId,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        } as unknown as Update;
        const params = {
          ...baseParams(),
          update,
          receivedMessageIds,
          hasSelfEchoSuppressedLocalId: (localId: string) => selfEchoSuppressedLocalIds.has(localId),
          hasAgentQueueEchoSuppressedLocalId: (localId: string) =>
            scenario.agentQueueEchoSuppressed && localId === scenario.localId,
          hasAgentQueueDeliveredLocalId: (localId: string) =>
            scenario.agentQueueEchoSuppressed && localId === scenario.localId,
          deleteMaterializedLocalId: (localId: string) => {
            selfEchoSuppressedLocalIds.delete(localId);
          },
          pendingMessageCallback: (message: unknown) => {
            delivered.push(message);
          },
          pendingMessages: [],
          onUserMessageDeliveredToAgentQueue: (seq: number) => {
            deliveredSeqs.push(seq);
          },
          onUserMessageDeliveryProvenByLocalEcho: (seq: number) => {
            echoProvenSeqs.push(seq);
          },
        };

        handleSessionNewMessageUpdate(params);
        handleSessionNewMessageUpdate(params);

        return {
          label: scenario.label,
          deliveredCount: delivered.length,
          deliveredSeqs,
          echoProvenSeqs,
          received: receivedMessageIds.has(messageId),
        };
      });

      expect(results).toEqual(scenarios.map((scenario) => ({
        label: scenario.label,
        deliveredCount: 0,
        deliveredSeqs: scenario.expectedDeliveredSeqs,
        echoProvenSeqs: scenario.expectedEchoProvenSeqs,
        received: true,
      })));
    });

    it('marks accepted queue handoffs before invoking reentrant callbacks', () => {
      const receivedMessageIds = new Set<string>();
      const delivered: unknown[] = [];
      const update = buildUserMessageUpdate({ seq: 21, localId: 'local-reentrant-accepted' });
      let didReenter = false;

      const invoke = () => handleSessionNewMessageUpdate({
        ...baseParams(),
        update,
        receivedMessageIds,
        pendingMessageCallback: (message) => {
          delivered.push(message);
          if (!didReenter) {
            didReenter = true;
            invoke();
          }
        },
        pendingMessages: [],
      });

      invoke();

      expect(delivered).toHaveLength(1);
      expect(receivedMessageIds.has('m-seq-21')).toBe(true);
    });

    it('does not advance the delivered watermark for buffered prompts before a callback attaches', () => {
      const deliveredSeqs: number[] = [];
      const pendingMessages: any[] = [];

      handleSessionNewMessageUpdate({
        ...baseParams(),
        update: buildUserMessageUpdate({ seq: 24, localId: 'local-buffered-before-callback' }),
        pendingMessageCallback: null,
        pendingMessages,
        onUserMessageDeliveredToAgentQueue: (seq) => {
          deliveredSeqs.push(seq);
        },
      });

      expect(pendingMessages).toHaveLength(1);
      expect(deliveredSeqs).toEqual([]);
    });

    it('does not treat an echo-suppression marker as agent-queue delivery proof', () => {
      const deliveredSeqs: number[] = [];
      const delivered: unknown[] = [];

      handleSessionNewMessageUpdate({
        ...baseParams(),
        update: buildUserMessageUpdate({ seq: 25, localId: 'local-suppressed-not-delivered' }),
        hasAgentQueueEchoSuppressedLocalId: (localId) => localId === 'local-suppressed-not-delivered',
        pendingMessageCallback: (message) => {
          delivered.push(message);
        },
        pendingMessages: [],
        onUserMessageDeliveredToAgentQueue: (seq) => {
          deliveredSeqs.push(seq);
        },
      });

      expect(delivered).toHaveLength(1);
      expect(deliveredSeqs).toEqual([25]);
    });

    it('keeps declined structured and legacy queue handoffs off the owed cursor', () => {
      const scenarios = [
        {
          label: 'structured',
          seq: 22,
          localId: 'local-structured-declined-cursor',
          body: {
            role: 'user',
            content: { type: 'text', text: 'structured declined handoff' },
            meta: { source: 'ui' },
          },
        },
        {
          label: 'legacy',
          seq: 23,
          localId: 'local-legacy-declined-cursor',
          body: {
            role: 'user',
            content: 'legacy declined handoff',
            meta: { source: 'ui' },
          },
        },
      ] as const;

      const results = scenarios.map((scenario) => {
        const messageId = `m-${scenario.localId}`;
        const receivedMessageIds = new Set<string>();
        const result = handleSessionNewMessageUpdate({
          ...baseParams(),
          update: {
            id: `u-${scenario.localId}`,
            createdAt: Date.now(),
            body: {
              t: 'new-message',
              sid: 'sess_1',
              message: {
                id: messageId,
                seq: scenario.seq,
                content: { t: 'plain', v: scenario.body },
                localId: scenario.localId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            },
          } as unknown as Update,
          receivedMessageIds,
          pendingMessageCallback: () => false,
          pendingMessages: [],
        });

        return {
          label: scenario.label,
          lastObservedMessageSeq: result.lastObservedMessageSeq,
          lastObservedUserMessageSeq: result.lastObservedUserMessageSeq,
          received: receivedMessageIds.has(messageId),
        };
      });

      expect(results).toEqual([
        {
          label: 'structured',
          lastObservedMessageSeq: 0,
          lastObservedUserMessageSeq: 0,
          received: false,
        },
        {
          label: 'legacy',
          lastObservedMessageSeq: 0,
          lastObservedUserMessageSeq: 0,
          received: false,
        },
      ]);
    });

    it('keeps provider-native CLI self echoes on the echo hook when an agent-queue suppression marker also exists', () => {
      const deliveredSeqs: number[] = [];
      const echoProvenSeqs: number[] = [];
      const delivered: unknown[] = [];

      handleSessionNewMessageUpdate({
        ...baseParams(),
        update: buildUserMessageUpdate({ seq: 13, localId: 'local-cli-both-1', source: 'cli' }),
        hasSelfEchoSuppressedLocalId: (localId) => localId === 'local-cli-both-1',
        hasAgentQueueEchoSuppressedLocalId: (localId) => localId === 'local-cli-both-1',
        pendingMessageCallback: (message) => {
          delivered.push(message);
        },
        pendingMessages: [],
        onUserMessageDeliveredToAgentQueue: (seq) => {
          deliveredSeqs.push(seq);
        },
        onUserMessageDeliveryProvenByLocalEcho: (seq) => {
          echoProvenSeqs.push(seq);
        },
      });

      expect(delivered).toHaveLength(0);
      expect(deliveredSeqs).toEqual([]);
      expect(echoProvenSeqs).toEqual([13]);
    });

    it('routes a legacy agent-queue echo to the queue-handoff hook without re-delivering it', () => {
      const deliveredSeqs: number[] = [];
      const echoProvenSeqs: number[] = [];
      const delivered: unknown[] = [];

      handleSessionNewMessageUpdate({
        ...baseParams(),
        update: {
          id: 'u-legacy-agent-queue-echo',
          createdAt: Date.now(),
          body: {
            t: 'new-message',
            sid: 'sess_1',
            message: {
              id: 'm-legacy-agent-queue-1',
              seq: 14,
              content: {
                t: 'plain',
                v: {
                  role: 'user',
                  content: 'legacy prompt already handed to queue',
                  meta: { source: 'ui', sentFrom: 'cli' },
                },
              },
              localId: 'local-legacy-agent-queue-1',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        } as unknown as Update,
        hasAgentQueueEchoSuppressedLocalId: (localId) => localId === 'local-legacy-agent-queue-1',
        hasAgentQueueDeliveredLocalId: (localId) => localId === 'local-legacy-agent-queue-1',
        pendingMessageCallback: (message) => {
          delivered.push(message);
        },
        pendingMessages: [],
        onUserMessageDeliveredToAgentQueue: (seq) => {
          deliveredSeqs.push(seq);
        },
        onUserMessageDeliveryProvenByLocalEcho: (seq) => {
          echoProvenSeqs.push(seq);
        },
      });

      expect(delivered).toHaveLength(0);
      expect(deliveredSeqs).toEqual([14]);
      expect(echoProvenSeqs).toEqual([]);
    });

    it('routes a legacy self-echo CLI transcript write to the echo hook without coercing it back into the queue', () => {
      const deliveredSeqs: number[] = [];
      const echoProvenSeqs: number[] = [];
      const delivered: unknown[] = [];

      handleSessionNewMessageUpdate({
        ...baseParams(),
        update: {
          id: 'u-legacy-cli-echo',
          createdAt: Date.now(),
          body: {
            t: 'new-message',
            sid: 'sess_1',
            message: {
              id: 'm-legacy-cli-1',
              seq: 12,
              content: {
                t: 'plain',
                v: {
                  role: 'user',
                  content: 'legacy typed directly in provider',
                  meta: { source: 'cli' },
                },
              },
              localId: 'local-legacy-cli-1',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        } as unknown as Update,
        hasSelfEchoSuppressedLocalId: (localId) => localId === 'local-legacy-cli-1',
        pendingMessageCallback: (message) => {
          delivered.push(message);
        },
        pendingMessages: [],
        onUserMessageDeliveredToAgentQueue: (seq) => {
          deliveredSeqs.push(seq);
        },
        onUserMessageDeliveryProvenByLocalEcho: (seq) => {
          echoProvenSeqs.push(seq);
        },
      });

      expect(delivered).toHaveLength(0);
      expect(deliveredSeqs).toEqual([]);
      expect(echoProvenSeqs).toEqual([12]);
    });
  });
});
