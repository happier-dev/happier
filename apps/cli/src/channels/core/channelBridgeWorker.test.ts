import { describe, expect, it } from 'vitest';

import {
  createInMemoryChannelBindingStore,
  executeChannelBridgeTick,
  startChannelBridgeWorker,
  createChannelBridgeInboundDeduper,
  type ChannelBridgeAdapter,
  type ChannelBindingStore,
  type ChannelBridgeDeps,
  type ChannelBridgeInboundMessage,
} from '@/channels/core/channelBridgeWorker';
import { TelegramApiError } from '@/channels/telegram/telegramAdapter';

interface SentConversationMessage {
  conversationId: string;
  threadId: string | null;
  text: string;
}

interface SentSessionMessage {
  sessionId: string;
  text: string;
  sentFrom: string;
  providerId: string;
  conversationId: string;
  threadId: string | null;
}

interface WarningRecord {
  message: string;
  error?: unknown;
}

interface DepsHarness {
  deps: ChannelBridgeDeps;
  sentToSession: SentSessionMessage[];
  warnings: WarningRecord[];
}

interface DeferredPromise<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDepsHarness(options?: {
  sessions?: Array<{ sessionId: string; label: string | null }>;
  listSessions?: ChannelBridgeDeps['listSessions'];
  resolveSessionIdOrPrefix?: ChannelBridgeDeps['resolveSessionIdOrPrefix'];
  sendUserMessageToSession?: ChannelBridgeDeps['sendUserMessageToSession'];
  resolveLatestSessionSeq?: ChannelBridgeDeps['resolveLatestSessionSeq'];
  fetchAgentMessagesAfterSeq?: ChannelBridgeDeps['fetchAgentMessagesAfterSeq'];
  authorizeCommand?: ChannelBridgeDeps['authorizeCommand'];
}): DepsHarness {
  const sentToSession: SentSessionMessage[] = [];
  const warnings: WarningRecord[] = [];
  const deps: ChannelBridgeDeps = {
    listSessions: options?.listSessions ?? (async () => options?.sessions ?? []),
    resolveSessionIdOrPrefix:
      options?.resolveSessionIdOrPrefix ??
      (async () => ({ ok: false as const, code: 'session_not_found' as const })),
    sendUserMessageToSession:
      options?.sendUserMessageToSession ??
      (async (params) => {
        sentToSession.push({ ...params });
      }),
    resolveLatestSessionSeq: options?.resolveLatestSessionSeq ?? (async () => 0),
    fetchAgentMessagesAfterSeq: options?.fetchAgentMessagesAfterSeq ?? (async () => []),
    authorizeCommand: options?.authorizeCommand,
    onWarning: (message, error) => {
      warnings.push({ message, error });
    },
  };
  return { deps, sentToSession, warnings };
}

function createAdapterHarness(providerId: string = 'telegram'): {
  adapter: ChannelBridgeAdapter;
  pushInbound: (event: ChannelBridgeInboundMessage) => void;
  sent: SentConversationMessage[];
  failPullOnce: (error: Error) => void;
  stopCalls: () => number;
  pendingInboundCount: () => number;
} {
  const queue: ChannelBridgeInboundMessage[] = [];
  const sent: SentConversationMessage[] = [];
  let pullError: Error | null = null;
  let stopCallCount = 0;

  return {
    adapter: {
      providerId,
      pullInboundMessages: async () => {
        if (pullError) {
          const error = pullError;
          pullError = null;
          throw error;
        }
        const items = queue.slice();
        queue.length = 0;
        return items;
      },
      sendMessage: async (params) => {
        sent.push({
          conversationId: params.conversationId,
          threadId: params.threadId,
          text: params.text,
        });
      },
      stop: async () => {
        stopCallCount += 1;
      },
    },
    pushInbound: (event) => {
      queue.push(event);
    },
    sent,
    failPullOnce: (error) => {
      pullError = error;
    },
    stopCalls: () => stopCallCount,
    pendingInboundCount: () => queue.length,
  };
}

function createDeferredPromise<T>(): DeferredPromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean, timeoutMs: number = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('createInMemoryChannelBindingStore', () => {
  it('normalizes non-finite cursor values and ignores invalid cursor updates', async () => {
    const store = createInMemoryChannelBindingStore();
    const ref = {
      providerId: 'telegram',
      conversationId: '-100-cursor',
      threadId: null,
    } as const;

    await store.upsertBinding({
      ...ref,
      sessionId: 'sess-cursor',
      lastForwardedSeq: Number.NaN,
    });

    const created = await store.getBinding(ref);
    expect(created?.lastForwardedSeq).toBe(0);

    await store.updateLastForwardedSeq(ref, {
      expectedSessionId: 'sess-cursor',
      seq: 7,
    });
    await store.updateLastForwardedSeq(ref, {
      expectedSessionId: 'sess-cursor',
      seq: Number.NaN,
    });

    const updated = await store.getBinding(ref);
    expect(updated?.lastForwardedSeq).toBe(7);
  });
});

describe('executeChannelBridgeTick', () => {
  it('sanitizes non-finite in-memory cursor values in binding writes', async () => {
    const store = createInMemoryChannelBindingStore();

    const upserted = await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-100sanity',
      threadId: null,
      sessionId: 'sess-sanity',
      lastForwardedSeq: Number.NaN,
    });

    expect(upserted.lastForwardedSeq).toBe(0);

    await store.updateLastForwardedSeq({
      providerId: 'telegram',
      conversationId: '-100sanity',
      threadId: null,
    }, {
      expectedSessionId: 'sess-sanity',
      seq: Number.POSITIVE_INFINITY,
    });

    const afterInvalidUpdate = await store.getBinding({
      providerId: 'telegram',
      conversationId: '-100sanity',
      threadId: null,
    });

    expect(afterInvalidUpdate?.lastForwardedSeq).toBe(0);
  });

  it('returns defensive copies from in-memory binding store reads', async () => {
    const store = createInMemoryChannelBindingStore(() => 1_000);
    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: 'room-copy',
      threadId: null,
      sessionId: 'sess-copy',
      lastForwardedSeq: 5,
    });

    const firstRead = await store.getBinding({
      providerId: 'telegram',
      conversationId: 'room-copy',
      threadId: null,
    });
    expect(firstRead).not.toBeNull();
    (firstRead as { sessionId: string }).sessionId = 'mutated-first-read';

    const listed = await store.listBindings();
    (listed[0] as { sessionId: string }).sessionId = 'mutated-list-read';

    const secondRead = await store.getBinding({
      providerId: 'telegram',
      conversationId: 'room-copy',
      threadId: null,
    });

    expect(secondRead?.sessionId).toBe('sess-copy');
  });

  it('supports /attach then forwards inbound user messages into the bound session', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    const { deps, sentToSession } = createDepsHarness({
      resolveSessionIdOrPrefix: async (idOrPrefix: string) => {
        if (idOrPrefix === 'abc123') {
          return { ok: true as const, sessionId: 'sess-abc123' };
        }
        return { ok: false as const, code: 'session_not_found' as const };
      },
      resolveLatestSessionSeq: async () => 41,
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '88',
      text: '/attach abc123',
      messageId: 'm1',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    const [binding] = await store.listBindings();
    expect(binding).toMatchObject({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '88',
      sessionId: 'sess-abc123',
      lastForwardedSeq: 41,
    });
    expect(harness.sent.some((row) => row.text.includes('Attached'))).toBe(true);

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '88',
      text: 'Ship it',
      messageId: 'm2',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(sentToSession).toEqual([
      {
        sessionId: 'sess-abc123',
        text: 'Ship it',
        sentFrom: 'telegram',
        providerId: 'telegram',
        conversationId: '-1001',
        threadId: '88',
      },
    ]);
  });

  it('includes previous session id when /attach replaces an existing binding', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '88',
      sessionId: 'sess-old',
      lastForwardedSeq: 12,
    });

    const { deps } = createDepsHarness({
      resolveSessionIdOrPrefix: async () => ({ ok: true as const, sessionId: 'sess-new' }),
      resolveLatestSessionSeq: async () => 41,
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '88',
      text: '/attach sess-new',
      messageId: 'm-attach-replace',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent.some((row) => row.text.includes('replaced previous session sess-old'))).toBe(true);
  });

  it('supports /sessions and /detach command flow', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      sessionId: 'sess-old',
      lastForwardedSeq: 3,
    });

    const { deps } = createDepsHarness({
      sessions: [
        { sessionId: 'sess-1', label: 'build-docs' },
        { sessionId: 'sess-2', label: null },
      ],
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      text: '/sessions',
      messageId: 'm-sessions',
    });
    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      text: '/detach',
      messageId: 'm-detach',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent.some((row) => row.text.includes('Recent sessions'))).toBe(true);
    expect(harness.sent.some((row) => row.text.includes('Detached'))).toBe(true);

    const remaining = await store.listBindings();
    expect(remaining).toHaveLength(0);
  });

  it('warns and replies when /sessions fails to list sessions', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    const { deps, warnings } = createDepsHarness({
      listSessions: async () => {
        throw new Error('list unavailable');
      },
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      text: '/sessions',
      messageId: 'm-sessions-fail',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(warnings.some((row) => row.message.includes('Failed to list sessions for /sessions command'))).toBe(true);
    expect(harness.sent.some((row) => row.text.includes('Failed to retrieve sessions'))).toBe(true);
  });

  it('supports /session command for attached conversations', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();
    const { deps } = createDepsHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      sessionId: 'sess-bound',
      lastForwardedSeq: 3,
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      text: '/session',
      messageId: 'm-session-bound',
    });
    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent.some((row) => row.text.includes('Attached session: sess-bound'))).toBe(true);
  });

  it('supports /session command for non-attached conversations', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();
    const { deps } = createDepsHarness();

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '100',
      text: '/session',
      messageId: 'm-session-unbound',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent.some((row) => row.text.includes('No session is attached here'))).toBe(true);
  });

  it('warns and replies when /session cannot read binding from store', async () => {
    const baseStore = createInMemoryChannelBindingStore();
    const store: ChannelBindingStore = {
      ...baseStore,
      getBinding: async () => {
        throw new Error('binding read failed');
      },
    };
    const harness = createAdapterHarness();
    const { deps, warnings } = createDepsHarness();

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      text: '/session',
      messageId: 'm-session-store-fail',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(warnings.some((row) => row.message.includes('Failed to read binding for /session command'))).toBe(true);
    expect(harness.sent.some((row) => row.text.includes('Failed to read current session binding'))).toBe(true);
  });

  it('warns and replies when /detach fails to remove a binding from store', async () => {
    const baseStore = createInMemoryChannelBindingStore();
    const store: ChannelBindingStore = {
      ...baseStore,
      removeBinding: async () => {
        throw new Error('binding remove failed');
      },
    };
    const harness = createAdapterHarness();
    const { deps, warnings } = createDepsHarness();

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      text: '/detach',
      messageId: 'm-detach-store-fail',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(warnings.some((row) => row.message.includes('Failed to remove binding for /detach command'))).toBe(true);
    expect(harness.sent.some((row) => row.text.includes('Failed to detach current session binding'))).toBe(true);
  });

  it('supports /help and /start command aliases', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();
    const { deps, sentToSession } = createDepsHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      sessionId: 'sess-bound',
      lastForwardedSeq: 3,
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      text: '/help',
      messageId: 'm-help',
    });
    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      text: '/start',
      messageId: 'm-start',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    const helpReplies = harness.sent.filter((row) => row.text.includes('Happier bridge commands:'));
    expect(helpReplies).toHaveLength(2);
    for (const reply of helpReplies) {
      expect(reply.text.includes('/help - show command help')).toBe(true);
      expect(reply.text.includes('/start - alias for /help')).toBe(true);
    }
    expect(sentToSession).toHaveLength(0);
  });

  it('replies for unknown slash commands instead of forwarding them', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();
    const { deps, sentToSession } = createDepsHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      sessionId: 'sess-bound',
      lastForwardedSeq: 3,
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      text: '/bogus-command',
      messageId: 'm-unknown-command',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent.some((row) => row.text.includes('Unknown command: /bogus-command'))).toBe(true);
    expect(sentToSession).toHaveLength(0);
  });

  it('replies for malformed slash command tokens instead of forwarding them', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();
    const { deps, sentToSession } = createDepsHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      sessionId: 'sess-bound',
      lastForwardedSeq: 3,
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      text: '/@',
      messageId: 'm-malformed-command',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent.some((row) => row.text.includes('Unknown command. Use /help'))).toBe(true);
    expect(sentToSession).toHaveLength(0);
  });

  it('replies with no-binding hint for non-command inbound text when conversation is unbound', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();
    const { deps, sentToSession } = createDepsHarness();

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: 'unbound-room',
      threadId: null,
      text: 'hello from unbound thread',
      messageId: 'unbound-non-command',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent.some((row) => row.text.includes('No session is attached here'))).toBe(true);
    expect(sentToSession).toHaveLength(0);
  });

  it('warns and replies when non-command forwarding cannot read binding from store', async () => {
    const baseStore = createInMemoryChannelBindingStore();
    const store: ChannelBindingStore = {
      ...baseStore,
      getBinding: async () => {
        throw new Error('binding read failed');
      },
    };
    const harness = createAdapterHarness();
    const { deps, warnings, sentToSession } = createDepsHarness();

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: 'bound-room',
      threadId: null,
      text: 'hello from channel',
      messageId: 'non-command-getbinding-fail',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(sentToSession).toHaveLength(0);
    expect(warnings.some((row) => row.message.includes('Failed to read binding for inbound message forwarding'))).toBe(true);
    expect(harness.sent.some((row) => row.text.includes('Failed to read current session binding'))).toBe(true);
  });

  it('indicates when /sessions output is truncated', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();
    const { deps } = createDepsHarness({
      sessions: Array.from({ length: 21 }, (_, index) => ({
        sessionId: `sess-${index + 1}`,
        label: null,
      })),
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1001',
      threadId: '99',
      text: '/sessions',
      messageId: 'm-sessions-truncated',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent.some((row) => row.text.includes('…and 1 more.'))).toBe(true);
  });

  it('forwards agent replies to the bound conversation and advances cursor', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-1005',
      threadId: null,
      sessionId: 'sess-a',
      lastForwardedSeq: 9,
    });

    const { deps } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async ({ afterSeq }: { afterSeq: number }) => {
        if (afterSeq === 9) {
          return [
            { seq: 10, text: 'First agent reply' },
            { seq: 11, text: 'Second agent reply' },
          ];
        }
        return [];
      },
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent).toEqual([
      { conversationId: '-1005', threadId: null, text: 'First agent reply' },
      { conversationId: '-1005', threadId: null, text: 'Second agent reply' },
    ]);

    const [binding] = await store.listBindings();
    expect(binding?.lastForwardedSeq).toBe(11);
  });

  it('skips agent rows with invalid seq values and continues forwarding valid rows', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-1006',
      threadId: null,
      sessionId: 'sess-invalid-seq-row',
      lastForwardedSeq: 9,
    });

    const { deps, warnings } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => [
        { seq: Number.NaN, text: 'bad row' },
        { seq: 12, text: 'valid row' },
      ],
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent).toEqual([
      { conversationId: '-1006', threadId: null, text: 'valid row' },
    ]);
    const [binding] = await store.listBindings();
    expect(binding?.lastForwardedSeq).toBe(12);
    expect(warnings.some((row) => row.message.includes('invalid seq'))).toBe(true);
  });

  it('does not attach when latest session sequence cannot be resolved', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    const { deps } = createDepsHarness({
      resolveSessionIdOrPrefix: async () => ({ ok: true as const, sessionId: 'sess-invalid-seq' }),
      resolveLatestSessionSeq: async () => {
        throw new Error('sequence unavailable');
      },
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1007',
      threadId: null,
      text: '/attach sess-invalid-seq',
      messageId: 'attach-fails',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(await store.listBindings()).toHaveLength(0);
    expect(harness.sent.some((row) => row.text.includes('Failed to attach'))).toBe(true);
  });

  it('does not attach when session id/prefix resolution throws', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    const { deps, warnings } = createDepsHarness({
      resolveSessionIdOrPrefix: async () => {
        throw new Error('resolver unavailable');
      },
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1007',
      threadId: null,
      text: '/attach sess-resolver-error',
      messageId: 'attach-resolver-throws',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(await store.listBindings()).toHaveLength(0);
    expect(warnings.some((row) => row.message.includes('Failed to resolve session by id/prefix for attach'))).toBe(true);
    expect(harness.sent.some((row) => row.text.includes('Failed to attach to session sess-resolver-error'))).toBe(true);
  });

  it('does not attach when latest session sequence resolves to an invalid value', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    const { deps, warnings } = createDepsHarness({
      resolveSessionIdOrPrefix: async () => ({ ok: true as const, sessionId: 'sess-invalid-seq-value' }),
      resolveLatestSessionSeq: async () => Number.NaN,
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1007',
      threadId: null,
      text: '/attach sess-invalid-seq-value',
      messageId: 'attach-invalid-seq-value',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(await store.listBindings()).toHaveLength(0);
    expect(harness.sent.some((row) => row.text.includes('Failed to attach'))).toBe(true);
    expect(warnings.some((row) => row.message.includes('resolveLatestSessionSeq returned an invalid value'))).toBe(true);
  });

  it('does not attach when binding persistence fails', async () => {
    const baseStore = createInMemoryChannelBindingStore();
    const store: ChannelBindingStore = {
      ...baseStore,
      upsertBinding: async () => {
        throw new Error('binding upsert failed');
      },
    };
    const harness = createAdapterHarness();

    const { deps, warnings } = createDepsHarness({
      resolveSessionIdOrPrefix: async () => ({ ok: true as const, sessionId: 'sess-upsert-fail' }),
      resolveLatestSessionSeq: async () => 10,
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1007',
      threadId: null,
      text: '/attach sess-upsert-fail',
      messageId: 'attach-upsert-throws',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(await baseStore.listBindings()).toHaveLength(0);
    expect(warnings.some((row) => row.message.includes('Failed to persist binding during /attach'))).toBe(true);
    expect(harness.sent.some((row) => row.text.includes('unable to persist binding'))).toBe(true);
  });

  it('does not attach when reading an existing binding fails before persistence', async () => {
    const baseStore = createInMemoryChannelBindingStore();
    const store: ChannelBindingStore = {
      ...baseStore,
      getBinding: async () => {
        throw new Error('prior binding read failed');
      },
    };
    const harness = createAdapterHarness();

    const { deps, warnings } = createDepsHarness({
      resolveSessionIdOrPrefix: async () => ({ ok: true as const, sessionId: 'sess-prior-fail' }),
      resolveLatestSessionSeq: async () => 10,
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1007',
      threadId: null,
      text: '/attach sess-prior-fail',
      messageId: 'attach-getbinding-throws',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(await baseStore.listBindings()).toHaveLength(0);
    expect(warnings.some((row) => row.message.includes('Failed to read existing binding during /attach'))).toBe(true);
    expect(harness.sent.some((row) => row.text.includes('Failed to read current binding before attach'))).toBe(true);
  });

  it('returns ambiguous attach message even when resolver omits candidate ids', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    const { deps } = createDepsHarness({
      resolveSessionIdOrPrefix: async () => ({
        ok: false as const,
        code: 'session_id_ambiguous' as const,
        candidates: [],
      }),
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1007',
      threadId: null,
      text: '/attach sess-ambiguous',
      messageId: 'attach-ambiguous-empty-candidates',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(await store.listBindings()).toHaveLength(0);
    expect(harness.sent.some((row) => row.text.includes('Ambiguous session prefix'))).toBe(true);
  });

  it('returns unsupported attach message when resolver does not support attach by id/prefix', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    const { deps } = createDepsHarness({
      resolveSessionIdOrPrefix: async () => ({ ok: false as const, code: 'unsupported' as const }),
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1007',
      threadId: null,
      text: '/attach sess-unsupported',
      messageId: 'attach-unsupported',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(await store.listBindings()).toHaveLength(0);
    expect(harness.sent.some((row) => row.text.includes('Attaching by session ID or prefix is not supported'))).toBe(true);
  });

  it('returns session-not-found attach message when resolver cannot find target', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    const { deps } = createDepsHarness({
      resolveSessionIdOrPrefix: async () => ({ ok: false as const, code: 'session_not_found' as const }),
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1007',
      threadId: null,
      text: '/attach sess-missing',
      messageId: 'attach-session-not-found',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(await store.listBindings()).toHaveLength(0);
    expect(harness.sent.some((row) => row.text.includes('Session not found'))).toBe(true);
  });

  it('replies with usage hint when /attach is called without arguments', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();
    const { deps } = createDepsHarness();

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1007',
      threadId: null,
      text: '/attach',
      messageId: 'attach-no-args',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(await store.listBindings()).toHaveLength(0);
    expect(harness.sent.some((row) => row.text.includes('Usage: /attach'))).toBe(true);
  });

  it('enforces sender-scoped command authorization via deps hook', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    const { deps } = createDepsHarness({
      authorizeCommand: async ({ commandName, actor }) => {
        if (commandName === 'attach' && actor.senderId === 'blocked-user') {
          return { allowed: false as const, message: 'Not authorized for attach.' };
        }
        return true;
      },
      resolveSessionIdOrPrefix: async () => ({ ok: true as const, sessionId: 'sess-new' }),
      resolveLatestSessionSeq: async () => 5,
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1008',
      threadId: null,
      senderId: 'blocked-user',
      text: '/attach sess-new',
      messageId: 'attach-authz-blocked',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(await store.listBindings()).toHaveLength(0);
    expect(harness.sent.some((row) => row.text.includes('Not authorized for attach.'))).toBe(true);
  });

  it('denies command and warns when authorizeCommand hook throws', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    const { deps, warnings } = createDepsHarness({
      authorizeCommand: async () => {
        throw new Error('auth service unavailable');
      },
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-1009',
      threadId: null,
      text: '/sessions',
      messageId: 'authz-throws',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent.some((row) => row.text.includes('Unable to authorize this command right now.'))).toBe(true);
    expect(warnings.some((row) => row.message.includes('Authorization check failed'))).toBe(true);
  });

  it('normalizes inbound provider identity to adapter provider and warns on mismatch', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness('telegram');

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: 'chat-42',
      threadId: null,
      sessionId: 'sess-42',
      lastForwardedSeq: 0,
    });

    const { deps, sentToSession, warnings } = createDepsHarness();

    harness.pushInbound({
      providerId: 'discord',
      conversationId: 'chat-42',
      threadId: null,
      text: 'Hello from spoofed provider',
      messageId: 'm-spoof',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(sentToSession).toHaveLength(1);
    expect(sentToSession[0]).toMatchObject({
      providerId: 'telegram',
      sentFrom: 'telegram',
      conversationId: 'chat-42',
      threadId: null,
    });
    expect(warnings.some((row) => row.message.includes('Inbound provider mismatch'))).toBe(true);
  });

  it('continues processing other adapters when one adapter pull fails', async () => {
    const store = createInMemoryChannelBindingStore();
    const failing = createAdapterHarness('telegram');
    const healthy = createAdapterHarness('discord');

    await store.upsertBinding({
      providerId: 'discord',
      conversationId: 'discord-room',
      threadId: null,
      sessionId: 'sess-discord',
      lastForwardedSeq: 0,
    });

    const { deps, sentToSession, warnings } = createDepsHarness();

    failing.failPullOnce(new Error('telegram pull failed'));
    healthy.pushInbound({
      providerId: 'discord',
      conversationId: 'discord-room',
      threadId: null,
      text: 'still processed',
      messageId: 'discord-message',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [failing.adapter, healthy.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(sentToSession).toEqual([
      {
        sessionId: 'sess-discord',
        text: 'still processed',
        sentFrom: 'discord',
        providerId: 'discord',
        conversationId: 'discord-room',
        threadId: null,
      },
    ]);
    expect(warnings.some((row) => row.message.includes('Failed to pull inbound messages for adapter telegram'))).toBe(true);
  });

  it('warns and ignores duplicate adapter provider ids', async () => {
    const store = createInMemoryChannelBindingStore();
    const first = createAdapterHarness('telegram');
    const second = createAdapterHarness('telegram');

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: 'room-1',
      threadId: null,
      sessionId: 'sess-dup',
      lastForwardedSeq: 0,
    });

    const { deps, sentToSession, warnings } = createDepsHarness();

    first.pushInbound({
      providerId: 'telegram',
      conversationId: 'room-1',
      threadId: null,
      text: 'from first adapter',
      messageId: 'dup-1',
    });
    second.pushInbound({
      providerId: 'telegram',
      conversationId: 'room-1',
      threadId: null,
      text: 'from second adapter',
      messageId: 'dup-2',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [first.adapter, second.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(sentToSession).toHaveLength(1);
    expect(sentToSession[0]?.text).toBe('from first adapter');
    expect(warnings.some((row) => row.message.includes('Duplicate adapter providerId detected: telegram'))).toBe(true);
  });

  it('warns and replies when forwarding inbound text into session fails', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: 'failing-room',
      threadId: null,
      sessionId: 'sess-fail',
      lastForwardedSeq: 0,
    });

    const { deps, warnings } = createDepsHarness({
      sendUserMessageToSession: async () => {
        throw new Error('session unavailable');
      },
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: 'failing-room',
      threadId: null,
      text: 'hello',
      messageId: 'send-fail-msg',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(warnings.some((row) => row.message.includes('Failed to forward channel message into session'))).toBe(true);
    expect(harness.sent.some((row) => row.text.includes('Failed to send message to session sess-fail.'))).toBe(true);
  });

  it('persists cursor after successful sends when a later outbound row fails', async () => {
    const store = createInMemoryChannelBindingStore();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-2002',
      threadId: null,
      sessionId: 'sess-partial',
      lastForwardedSeq: 9,
    });

    let sendCalls = 0;
    const adapter: ChannelBridgeAdapter = {
      providerId: 'telegram',
      pullInboundMessages: async () => [],
      sendMessage: async () => {
        sendCalls += 1;
        if (sendCalls >= 2) {
          throw new Error('simulated send failure');
        }
      },
      stop: async () => {},
    };

    const { deps, warnings } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => [
        { seq: 10, text: 'first row' },
        { seq: 11, text: 'second row fails' },
      ],
    });

    await executeChannelBridgeTick({
      store,
      adapters: [adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    const [binding] = await store.listBindings();
    expect(binding?.lastForwardedSeq).toBe(10);
    expect(warnings.some((row) => row.message.includes('Failed to forward agent output to channel'))).toBe(true);
  });

  it('warns when fetching outbound agent rows fails', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-2003',
      threadId: null,
      sessionId: 'sess-fetch-fail',
      lastForwardedSeq: 3,
    });

    const { deps, warnings } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => {
        throw new Error('transcript read failed');
      },
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent).toHaveLength(0);
    expect(warnings.some((row) => row.message.includes('Failed to forward agent output to channel'))).toBe(true);
  });

  it('deduplicates repeated inbound messages across direct executeChannelBridgeTick calls', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: 'direct-dedupe-room',
      threadId: null,
      sessionId: 'sess-direct-dedupe',
      lastForwardedSeq: 0,
    });

    const { deps, sentToSession } = createDepsHarness();
    const repeated = {
      providerId: 'telegram' as const,
      conversationId: 'direct-dedupe-room',
      threadId: null,
      text: 'same payload',
      messageId: 'direct-dedupe-id-1',
    };

    const deduper = createChannelBridgeInboundDeduper();

    harness.pushInbound(repeated);
    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: deduper,
    });

    harness.pushInbound(repeated);
    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: deduper,
    });

    expect(sentToSession).toHaveLength(1);
  });

  it('does not dedupe messages when inbound messageId is empty', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: 'empty-id-room',
      threadId: null,
      sessionId: 'sess-empty-id',
      lastForwardedSeq: 0,
    });

    const { deps, sentToSession } = createDepsHarness();
    const messageWithEmptyId = {
      providerId: 'telegram' as const,
      conversationId: 'empty-id-room',
      threadId: null,
      text: 'same payload',
      messageId: '   ',
    };

    const deduper = createChannelBridgeInboundDeduper();

    harness.pushInbound(messageWithEmptyId);
    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: deduper,
    });

    harness.pushInbound(messageWithEmptyId);
    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: deduper,
    });

    expect(sentToSession).toHaveLength(2);
  });

  it('skips invalid outbound seq rows and warns without stalling valid cursor updates', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-3001',
      threadId: null,
      sessionId: 'sess-invalid-seq',
      lastForwardedSeq: 9,
    });

    const { deps, warnings } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => [
        { seq: Number.NaN, text: 'invalid row' },
        { seq: 10, text: 'valid row' },
      ],
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    const [binding] = await store.listBindings();
    expect(binding?.lastForwardedSeq).toBe(10);
    expect(harness.sent.some((row) => row.text.includes('valid row'))).toBe(true);
    expect(harness.sent.some((row) => row.text.includes('invalid row'))).toBe(false);
    expect(warnings.some((row) => row.message.includes('Skipped agent output row with invalid seq'))).toBe(true);
  });

  it('forwards outbound agent rows in ascending seq order even when source rows are unsorted', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-3002',
      threadId: null,
      sessionId: 'sess-unsorted-seq',
      lastForwardedSeq: 9,
    });

    const { deps } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => [
        { seq: 12, text: 'third by seq' },
        { seq: 10, text: 'first by seq' },
        { seq: 11, text: 'second by seq' },
      ],
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent.map((row) => row.text)).toEqual([
      'first by seq',
      'second by seq',
      'third by seq',
    ]);

    const [binding] = await store.listBindings();
    expect(binding?.lastForwardedSeq).toBe(12);
  });

  it('skips outbound rows at or below the current cursor', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-3003',
      threadId: null,
      sessionId: 'sess-cursor-guard',
      lastForwardedSeq: 10,
    });

    const { deps } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => [
        { seq: 9, text: 'already forwarded before cursor' },
        { seq: 10, text: 'exactly at cursor' },
        { seq: 11, text: 'new row after cursor' },
      ],
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent.map((row) => row.text)).toEqual(['new row after cursor']);

    const [binding] = await store.listBindings();
    expect(binding?.lastForwardedSeq).toBe(11);
  });

  it('warns and stops forwarding remaining rows when cursor persistence fails after send', async () => {
    const baseStore = createInMemoryChannelBindingStore();
    const store: ChannelBindingStore = {
      ...baseStore,
      updateLastForwardedSeq: async () => {
        throw new Error('cursor store unavailable');
      },
    };
    const harness = createAdapterHarness();

    await baseStore.upsertBinding({
      providerId: 'telegram',
      conversationId: '-3004',
      threadId: null,
      sessionId: 'sess-cursor-persist-fail',
      lastForwardedSeq: 9,
    });

    const { deps, warnings } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => [
        { seq: 10, text: 'first send succeeds' },
        { seq: 11, text: 'should not send after cursor failure' },
      ],
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent.map((row) => row.text)).toEqual(['first send succeeds']);
    expect(warnings.some((row) => row.message.includes('Failed to persist channel bridge cursor'))).toBe(true);
    expect(warnings.some((row) => row.message.includes('Failed to forward agent output to channel'))).toBe(false);

    const [binding] = await baseStore.listBindings();
    expect(binding?.lastForwardedSeq).toBe(9);
  });

  it('treats typed Telegram permanent delivery failures as non-retryable and advances cursor', async () => {
    const store = createInMemoryChannelBindingStore();
    const { deps, warnings } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => [{ seq: 1, text: 'delivery fails permanently' }],
    });

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-3004b',
      threadId: null,
      sessionId: 'sess-typed-permanent',
      lastForwardedSeq: 0,
    });

    const adapter: ChannelBridgeAdapter = {
      providerId: 'telegram',
      pullInboundMessages: async () => [],
      sendMessage: async () => {
        throw new TelegramApiError({
          method: 'sendMessage',
          statusCode: 403,
          data: { description: 'Forbidden: bot was blocked by the user' },
        });
      },
    };

    await executeChannelBridgeTick({
      store,
      adapters: [adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    const [binding] = await store.listBindings();
    expect(binding?.lastForwardedSeq).toBe(1);
    expect(
      warnings.some((row) => row.message.includes('Detected permanent Telegram delivery failure')),
    ).toBe(true);
    expect(
      warnings.some((row) => row.message.includes('Failed to forward agent output to channel')),
    ).toBe(false);
  });

  it('treats typed Telegram permanent failures as non-retryable even for non-default provider ids', async () => {
    const store = createInMemoryChannelBindingStore();
    const { deps, warnings } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => [{ seq: 1, text: 'delivery fails permanently' }],
    });

    await store.upsertBinding({
      providerId: 'telegram-v2',
      conversationId: '-3004b-alt',
      threadId: null,
      sessionId: 'sess-typed-permanent-alt',
      lastForwardedSeq: 0,
    });

    const adapter: ChannelBridgeAdapter = {
      providerId: 'telegram-v2',
      pullInboundMessages: async () => [],
      sendMessage: async () => {
        throw new TelegramApiError({
          method: 'sendMessage',
          statusCode: 403,
          data: { description: 'Forbidden: bot was blocked by the user' },
        });
      },
    };

    await executeChannelBridgeTick({
      store,
      adapters: [adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    const [binding] = await store.listBindings();
    expect(binding?.lastForwardedSeq).toBe(1);
    expect(
      warnings.some((row) => row.message.includes('Detected permanent Telegram delivery failure')),
    ).toBe(true);
  });

  it('does not treat untyped telegram-like send errors as permanent failures', async () => {
    const store = createInMemoryChannelBindingStore();
    const { deps, warnings } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => [{ seq: 1, text: 'must not be treated as permanent' }],
    });

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-3004c',
      threadId: null,
      sessionId: 'sess-untyped-error',
      lastForwardedSeq: 0,
    });

    const adapter: ChannelBridgeAdapter = {
      providerId: 'telegram',
      pullInboundMessages: async () => [],
      sendMessage: async () => {
        throw new Error('Telegram sendMessage failed (403): Forbidden');
      },
    };

    await executeChannelBridgeTick({
      store,
      adapters: [adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    const [binding] = await store.listBindings();
    expect(binding?.lastForwardedSeq).toBe(0);
    expect(
      warnings.some((row) => row.message.includes('Detected permanent Telegram delivery failure')),
    ).toBe(false);
    expect(
      warnings.some((row) => row.message.includes('Failed to forward agent output to channel')),
    ).toBe(true);
  });

  it('does not advance cursor when conversation is reattached to a different session', async () => {
    const baseStore = createInMemoryChannelBindingStore();
    const ref = {
      providerId: 'telegram',
      conversationId: '-3005',
      threadId: null,
    } as const;

    await baseStore.upsertBinding({
      ...ref,
      sessionId: 'sess-old',
      lastForwardedSeq: 0,
    });

    const store: ChannelBindingStore = {
      ...baseStore,
      updateLastForwardedSeq: async (bindingRef, params) => {
        await baseStore.upsertBinding({
          ...bindingRef,
          sessionId: 'sess-new',
          lastForwardedSeq: 0,
        });
        return await baseStore.updateLastForwardedSeq(bindingRef, params);
      },
    };

    const harness = createAdapterHarness();
    const { deps, warnings } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => [
        { seq: 1, text: 'first send' },
        { seq: 2, text: 'must not send' },
      ],
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(harness.sent.map((row) => row.text)).toEqual(['first send']);

    const rebound = await baseStore.getBinding(ref);
    expect(rebound?.sessionId).toBe('sess-new');
    expect(rebound?.lastForwardedSeq).toBe(0);
    expect(warnings.some((row) => row.message.includes('Skipped cursor advance because binding changed'))).toBe(true);
  });

  it('warns when binding provider has no active adapter for outbound forwarding', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness('discord');

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: 'orphaned-room',
      threadId: null,
      sessionId: 'sess-orphaned',
      lastForwardedSeq: 0,
    });

    const { deps, warnings } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => [{ seq: 1, text: 'ignored' }],
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(warnings.some((row) => row.message.includes('No adapter registered for binding providerId=telegram'))).toBe(true);
  });

  it('warns once per binding when missing adapter warnings are tracked across ticks', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness('discord');

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: 'orphaned-room',
      threadId: null,
      sessionId: 'sess-orphaned',
      lastForwardedSeq: 0,
    });

    const { deps, warnings } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => [{ seq: 1, text: 'ignored' }],
    });
    const warnedMissingAdapterBindings = new Set<string>();

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
      warnedMissingAdapterBindings,
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
      warnedMissingAdapterBindings,
    });

    const missingAdapterWarnings = warnings.filter((row) =>
      row.message.includes('No adapter registered for binding providerId=telegram'),
    );
    expect(missingAdapterWarnings).toHaveLength(1);
  });

  it('prunes stale missing-adapter warning keys when bindings are removed', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness('discord');

    const bindingRef = {
      providerId: 'telegram',
      conversationId: 'orphaned-room',
      threadId: null,
    } as const;

    await store.upsertBinding({
      ...bindingRef,
      sessionId: 'sess-orphaned',
      lastForwardedSeq: 0,
    });

    const { deps, warnings } = createDepsHarness({
      fetchAgentMessagesAfterSeq: async () => [{ seq: 1, text: 'ignored' }],
    });
    const warnedMissingAdapterBindings = new Set<string>();

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
      warnedMissingAdapterBindings,
    });

    await store.removeBinding(bindingRef);

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
      warnedMissingAdapterBindings,
    });

    await store.upsertBinding({
      ...bindingRef,
      sessionId: 'sess-orphaned-2',
      lastForwardedSeq: 0,
    });

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
      warnedMissingAdapterBindings,
    });

    const missingAdapterWarnings = warnings.filter((row) =>
      row.message.includes('No adapter registered for binding providerId=telegram'),
    );
    expect(missingAdapterWarnings).toHaveLength(2);
  });

  it('warns and exits tick when listing bindings fails', async () => {
    const baseStore = createInMemoryChannelBindingStore();
    const store: ChannelBindingStore = {
      ...baseStore,
      listBindings: async () => {
        throw new Error('list bindings unavailable');
      },
    };
    const harness = createAdapterHarness();
    const { deps, warnings } = createDepsHarness();

    await executeChannelBridgeTick({
      store,
      adapters: [harness.adapter],
      deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(warnings.some((row) => row.message.includes('Failed to list bindings for outbound forwarding'))).toBe(true);
  });

  it('acknowledges handled inbound messages when adapter exposes ack hook', async () => {
    const store = createInMemoryChannelBindingStore();
    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: 'room-ack',
      threadId: null,
      sessionId: 'sess-ack',
      lastForwardedSeq: 0,
    });

    const acknowledged: ChannelBridgeInboundMessage[][] = [];
    const adapter: ChannelBridgeAdapter = {
      providerId: 'telegram',
      pullInboundMessages: async () => [
        {
          providerId: 'telegram',
          conversationId: 'room-ack',
          threadId: null,
          senderId: 'user-1',
          text: 'hello from telegram',
          messageId: 'm-ack-1',
        },
      ],
      ackInboundMessages: async (messages) => {
        acknowledged.push(messages.map((message) => ({ ...message })));
      },
      sendMessage: async () => {},
    };
    const depsHarness = createDepsHarness();

    await executeChannelBridgeTick({
      store,
      adapters: [adapter],
      deps: depsHarness.deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(depsHarness.sentToSession).toHaveLength(1);
    expect(acknowledged).toHaveLength(1);
    expect(acknowledged[0]?.map((message) => message.messageId)).toEqual(['m-ack-1']);
  });

  it('acknowledges slash-command and no-binding inbound messages in the same tick', async () => {
    const store = createInMemoryChannelBindingStore();

    const acknowledged: ChannelBridgeInboundMessage[][] = [];
    const adapter: ChannelBridgeAdapter = {
      providerId: 'telegram',
      pullInboundMessages: async () => [
        {
          providerId: 'telegram',
          conversationId: 'room-cmd-ack',
          threadId: null,
          senderId: 'user-1',
          text: '/sessions',
          messageId: 'm-ack-command',
        },
        {
          providerId: 'telegram',
          conversationId: 'room-cmd-ack',
          threadId: null,
          senderId: 'user-1',
          text: 'hello on unbound conversation',
          messageId: 'm-ack-unbound',
        },
      ],
      ackInboundMessages: async (messages) => {
        acknowledged.push(messages.map((message) => ({ ...message })));
      },
      sendMessage: async () => {},
    };

    const depsHarness = createDepsHarness({
      sessions: [{ sessionId: 'sess-1', label: 'demo' }],
    });

    await executeChannelBridgeTick({
      store,
      adapters: [adapter],
      deps: depsHarness.deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(acknowledged).toHaveLength(1);
    expect(acknowledged[0]?.map((message) => message.messageId)).toEqual([
      'm-ack-command',
      'm-ack-unbound',
    ]);
  });
});
describe('startChannelBridgeWorker', () => {
  it('runs the first tick on startup', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();
    const { deps } = createDepsHarness({
      sessions: [{ sessionId: 'sess-1', label: 'demo' }],
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: '-2001',
      threadId: null,
      text: '/sessions',
      messageId: 'startup-sessions',
    });

    const worker = startChannelBridgeWorker({
      store,
      adapters: [harness.adapter],
      deps,
      tickMs: 60_000,
    });

    try {
      await waitFor(() => harness.sent.length > 0);
      expect(harness.sent.some((row) => row.text.includes('Recent sessions'))).toBe(true);
    } finally {
      await worker.stop();
    }
  });

  it('deduplicates inbound messages across runtime ticks', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: 'dedupe-room',
      threadId: null,
      sessionId: 'sess-dedupe',
      lastForwardedSeq: 0,
    });

    const { deps, sentToSession } = createDepsHarness();

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: 'dedupe-room',
      threadId: null,
      text: 'duplicate payload',
      messageId: 'dedupe-id-1',
    });

    const worker = startChannelBridgeWorker({
      store,
      adapters: [harness.adapter],
      deps,
      tickMs: 60_000,
    });

    try {
      await waitFor(() => harness.pendingInboundCount() === 0 && sentToSession.length === 1);
      expect(sentToSession).toHaveLength(1);

      harness.pushInbound({
        providerId: 'telegram',
        conversationId: 'dedupe-room',
        threadId: null,
        text: 'duplicate payload',
        messageId: 'dedupe-id-1',
      });
      worker.trigger();

      await waitFor(() => harness.pendingInboundCount() === 0 && sentToSession.length === 1);
      expect(sentToSession).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  });

  it('stops idempotently and waits for in-flight tick before stopping adapters', async () => {
    const store = createInMemoryChannelBindingStore();
    const harness = createAdapterHarness();
    let startedTick = false;

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: 'stop-room',
      threadId: null,
      sessionId: 'sess-stop',
      lastForwardedSeq: 0,
    });

    const gate = createDeferredPromise<void>();
    const { deps } = createDepsHarness({
      sendUserMessageToSession: async () => {
        startedTick = true;
        await gate.promise;
      },
    });

    harness.pushInbound({
      providerId: 'telegram',
      conversationId: 'stop-room',
      threadId: null,
      text: 'block until released',
      messageId: 'stop-message',
    });

    const worker = startChannelBridgeWorker({
      store,
      adapters: [harness.adapter],
      deps,
      tickMs: 60_000,
    });

    try {
      await waitFor(() => startedTick);

      const stopFirst = worker.stop();
      const stopSecond = worker.stop();
      expect(harness.stopCalls()).toBe(0);

      gate.resolve();
      await stopFirst;
      await stopSecond;

      expect(harness.stopCalls()).toBe(1);
    } finally {
      gate.resolve();
      await worker.stop();
    }
  });

  it('waits for startup-triggered tick when stop is called immediately', async () => {
    const store = createInMemoryChannelBindingStore();
    const gate = createDeferredPromise<void>();
    let startedTick = false;
    let stopCallCount = 0;

    const adapter: ChannelBridgeAdapter = {
      providerId: 'telegram',
      pullInboundMessages: async () => {
        startedTick = true;
        await gate.promise;
        return [];
      },
      sendMessage: async () => {},
      stop: async () => {
        stopCallCount += 1;
      },
    };

    const { deps } = createDepsHarness();
    const worker = startChannelBridgeWorker({
      store,
      adapters: [adapter],
      deps,
      tickMs: 60_000,
    });

    try {
      const stopPromise = worker.stop();

      await Promise.resolve();
      await waitFor(() => startedTick);
      expect(stopCallCount).toBe(0);

      gate.resolve();
      await stopPromise;

      expect(stopCallCount).toBe(1);
    } finally {
      gate.resolve();
      await worker.stop();
    }
  });

  it('continues stopping remaining adapters if one stop fails', async () => {
    const store = createInMemoryChannelBindingStore();
    let secondaryStopped = false;
    const adapters: ChannelBridgeAdapter[] = [
      {
        providerId: 'telegram',
        pullInboundMessages: async () => [],
        sendMessage: async () => {},
        stop: async () => {
          throw new Error('primary stop failed');
        },
      },
      {
        providerId: 'discord',
        pullInboundMessages: async () => [],
        sendMessage: async () => {},
        stop: async () => {
          secondaryStopped = true;
        },
      },
    ];

    const { deps, warnings } = createDepsHarness();
    const worker = startChannelBridgeWorker({
      store,
      adapters,
      deps,
      tickMs: 60_000,
    });

    try {
      await worker.stop();

      expect(secondaryStopped).toBe(true);
      expect(warnings.some((row) => row.message.includes('Failed to stop channel adapter telegram'))).toBe(true);
    } finally {
      await worker.stop();
    }
  });

  it('stops distinct adapter instances even when provider ids are duplicated', async () => {
    const store = createInMemoryChannelBindingStore();
    const firstStop = { calls: 0 };
    const duplicateStop = { calls: 0 };

    const adapters: ChannelBridgeAdapter[] = [
      {
        providerId: 'telegram',
        pullInboundMessages: async () => [],
        sendMessage: async () => {},
        stop: async () => {
          firstStop.calls += 1;
        },
      },
      {
        providerId: 'telegram',
        pullInboundMessages: async () => [],
        sendMessage: async () => {},
        stop: async () => {
          duplicateStop.calls += 1;
        },
      },
    ];

    const { deps } = createDepsHarness();
    const worker = startChannelBridgeWorker({
      store,
      adapters,
      deps,
      tickMs: 60_000,
    });

    try {
      await worker.stop();
      expect(firstStop.calls).toBe(1);
      expect(duplicateStop.calls).toBe(1);
    } finally {
      await worker.stop();
    }
  });

  it('stops shared adapter references once during shutdown', async () => {
    const store = createInMemoryChannelBindingStore();
    const stopCounter = { calls: 0 };

    const sharedAdapter: ChannelBridgeAdapter = {
      providerId: 'telegram',
      pullInboundMessages: async () => [],
      sendMessage: async () => {},
      stop: async () => {
        stopCounter.calls += 1;
      },
    };

    const { deps, warnings } = createDepsHarness();
    const worker = startChannelBridgeWorker({
      store,
      adapters: [sharedAdapter, sharedAdapter],
      deps,
      tickMs: 60_000,
    });

    try {
      await worker.stop();
      expect(stopCounter.calls).toBe(1);
      expect(warnings.some((row) => row.message.includes('Duplicate adapter providerId detected: telegram'))).toBe(true);
    } finally {
      await worker.stop();
    }
  });
});
