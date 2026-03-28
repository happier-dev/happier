import { describe, expect, it } from 'vitest';

import {
  createChannelBridgeInboundDeduper,
  createInMemoryChannelBindingStore,
  executeChannelBridgeTick,
  type ChannelBridgeAdapter,
  type ChannelBridgeAgentMessageRow,
  type ChannelBridgeDeps,
  type ChannelBridgeInboundMessage,
  type ChannelBridgeInboundMode,
} from '../../../../apps/cli/src/channels/core/channelBridgeWorker';

type OutboundRow = Readonly<{ conversationId: string; threadId: string | null; text: string }>;

function createInMemoryAdapter(providerId: string) {
  const inboundQueue: ChannelBridgeInboundMessage[] = [];
  const outbound: OutboundRow[] = [];

  const adapter: ChannelBridgeAdapter = {
    providerId,
    pullInboundMessages: async () => {
      const batch = inboundQueue.splice(0, inboundQueue.length);
      return batch;
    },
    sendMessage: async (params) => {
      outbound.push({ conversationId: params.conversationId, threadId: params.threadId, text: params.text });
    },
  };

  return {
    adapter,
    outbound,
    pushInbound: (...messages: ChannelBridgeInboundMessage[]) => {
      inboundQueue.push(...messages);
    },
  } as const;
}

function createInMemorySessionDeps(params: Readonly<{
  sessionId: string;
  label?: string | null;
  inboundMode: ChannelBridgeInboundMode;
  ownerSenderId: string;
  conversationId: string;
  threadId: string | null;
  providerId: string;
}>) {
  const agentRows: ChannelBridgeAgentMessageRow[] = [];
  let nextSeq = 0;
  const forwardedUserMessages: Array<Readonly<{ sessionId: string; text: string; providerId: string; sentFrom: string; messageId?: string }>> = [];

  const deps: ChannelBridgeDeps = {
    listSessions: async () => [{ sessionId: params.sessionId, label: params.label ?? null }],
    resolveSessionIdOrPrefix: async (idOrPrefix) => {
      if (idOrPrefix === params.sessionId || params.sessionId.startsWith(idOrPrefix)) {
        return { ok: true, sessionId: params.sessionId };
      }
      return { ok: false, code: 'session_not_found' };
    },
    sendUserMessageToSession: async (send) => {
      forwardedUserMessages.push({
        sessionId: send.sessionId,
        text: send.text,
        providerId: send.providerId,
        sentFrom: send.sentFrom,
        messageId: send.messageId,
      });

      nextSeq += 1;
      agentRows.push({ seq: nextSeq, text: `echo:${send.text}` });
    },
    resolveLatestSessionSeq: async () => nextSeq,
    fetchAgentMessagesAfterSeq: async ({ afterSeq }) => agentRows.filter((row) => row.seq > afterSeq),
  };

  return {
    deps,
    agentRows,
    forwardedUserMessages,
    pushAgentMessage: (text: string) => {
      nextSeq += 1;
      agentRows.push({ seq: nextSeq, text });
    },
  } as const;
}

describe('core e2e: channel bridge in-memory contract', () => {
  it('DM: /attach then forwards inbound message and agent output back to the channel', async () => {
    const store = createInMemoryChannelBindingStore();
    const adapter = createInMemoryAdapter('test');
    const session = createInMemorySessionDeps({
      sessionId: 'sess-1',
      inboundMode: 'ownerOnly',
      ownerSenderId: 'user-1',
      providerId: 'test',
      conversationId: 'conv-1',
      threadId: null,
    });

    adapter.pushInbound(
      {
        providerId: 'test',
        conversationId: 'conv-1',
        threadId: null,
        senderId: 'user-1',
        conversationKind: 'dm',
        text: '/attach sess-1',
        messageId: 'm-attach',
      },
      {
        providerId: 'test',
        conversationId: 'conv-1',
        threadId: null,
        senderId: 'user-1',
        conversationKind: 'dm',
        text: 'hello',
        messageId: 'm-hello',
      },
    );

    await executeChannelBridgeTick({
      store,
      adapters: [adapter.adapter],
      deps: session.deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(session.forwardedUserMessages).toEqual([
      expect.objectContaining({ sessionId: 'sess-1', text: 'hello', providerId: 'test', messageId: 'm-hello' }),
    ]);

    const outbound = adapter.outbound.map((row) => row.text).join('\n');
    expect(outbound).toContain('Attached');
    expect(outbound).toContain('echo:hello');
  });

  it('Group: default owner-only denies non-owner forwarding', async () => {
    const store = createInMemoryChannelBindingStore();
    const adapter = createInMemoryAdapter('test');
    const session = createInMemorySessionDeps({
      sessionId: 'sess-1',
      inboundMode: 'ownerOnly',
      ownerSenderId: 'user-1',
      providerId: 'test',
      conversationId: 'group-1',
      threadId: null,
    });

    adapter.pushInbound(
      {
        providerId: 'test',
        conversationId: 'group-1',
        threadId: null,
        senderId: 'user-1',
        conversationKind: 'group',
        text: '/attach sess-1',
        messageId: 'm-attach',
      },
      {
        providerId: 'test',
        conversationId: 'group-1',
        threadId: null,
        senderId: 'user-2',
        conversationKind: 'group',
        text: 'pls run rm -rf /',
        messageId: 'm-hijack',
      },
    );

    await executeChannelBridgeTick({
      store,
      adapters: [adapter.adapter],
      deps: session.deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    expect(session.forwardedUserMessages).toEqual([]);
    expect(adapter.outbound.map((row) => row.text).join('\n')).toContain('not authorized');
  });

  it('Restart-safe: advancing binding cursor prevents duplicate outbound forwards across ticks', async () => {
    const store = createInMemoryChannelBindingStore();
    const adapter = createInMemoryAdapter('test');
    const session = createInMemorySessionDeps({
      sessionId: 'sess-1',
      inboundMode: 'ownerOnly',
      ownerSenderId: 'user-1',
      providerId: 'test',
      conversationId: 'conv-1',
      threadId: null,
    });

    adapter.pushInbound({
      providerId: 'test',
      conversationId: 'conv-1',
      threadId: null,
      senderId: 'user-1',
      conversationKind: 'dm',
      text: '/attach sess-1',
      messageId: 'm-attach',
    });

    await executeChannelBridgeTick({
      store,
      adapters: [adapter.adapter],
      deps: session.deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    session.pushAgentMessage('agent:one');
    await executeChannelBridgeTick({
      store,
      adapters: [adapter.adapter],
      deps: session.deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    const firstOutboundCount = adapter.outbound.filter((row) => row.text.includes('agent:one')).length;
    expect(firstOutboundCount).toBe(1);

    await executeChannelBridgeTick({
      store,
      adapters: [adapter.adapter],
      deps: session.deps,
      inboundDeduper: createChannelBridgeInboundDeduper(),
    });

    const secondOutboundCount = adapter.outbound.filter((row) => row.text.includes('agent:one')).length;
    expect(secondOutboundCount).toBe(1);
  });
});
