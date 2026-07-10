import { describe, expect, it, vi } from 'vitest';

import type { OpenCodeServerClient } from '../openCodeServerClient.js';
import { encodeOpenCodeIndexCursor } from './indexedTranscript.js';
import { createOpenCodeTranscriptSourceDefinition } from './source.js';

function createMessage(id: string, role: 'user' | 'assistant', text: string) {
  return {
    info: { id, role, time: { created: 100 } },
    parts: [{ type: 'text', text }],
  };
}

function createClientFixture(readMessages: () => readonly unknown[]): OpenCodeServerClient {
  return {
    mcpAdd: vi.fn(async () => undefined),
    sessionCreate: vi.fn(async () => ({ id: 'session-1' })),
    sessionPromptAsync: vi.fn(async () => undefined),
    sessionAbort: vi.fn(async () => undefined),
    sessionStatus: vi.fn(async () => ({ type: 'idle' })),
    sessionMessages: vi.fn(async () => readMessages()),
    sessionTodo: vi.fn(async () => []),
    permissionReply: vi.fn(async () => undefined),
    appSkills: vi.fn(async () => []),
    subscribeGlobalEvents: vi.fn(async () => undefined),
    globalConfigGet: vi.fn(async () => ({})),
    providersList: vi.fn(async () => []),
  };
}

describe('createOpenCodeTranscriptSourceDefinition', () => {
  it('returns empty reads before provider session identity is available', async () => {
    const client = createClientFixture(() => [
      createMessage('msg-user', 'user', 'hello'),
    ]);
    const source = createOpenCodeTranscriptSourceDefinition({
      id: 'opencode:test:http-sse',
      client,
      readProviderSessionId: () => null,
    });

    await expect(source.page({
      direction: 'older',
      maxBytes: 100_000,
      maxItems: 10,
    })).resolves.toEqual({
      items: [],
      nextCursor: null,
      tailCursor: null,
      hasMore: false,
      truncated: false,
    });
    await expect(source.readAfter({
      cursor: 'tail',
      maxBytes: 100_000,
      maxItems: 10,
    })).resolves.toEqual({
      items: [],
      nextCursor: null,
      truncated: false,
    });
    await expect(source.acquireFollowLease?.({ reason: 'test' })).resolves.toBeNull();
    expect(client.sessionMessages).not.toHaveBeenCalled();
  });

  it('fails closed for invalid cursors and wrong page directions', async () => {
    const client = createClientFixture(() => [
      createMessage('msg-user', 'user', 'hello'),
    ]);
    const source = createOpenCodeTranscriptSourceDefinition({
      id: 'opencode:test:http-sse',
      client,
      readProviderSessionId: () => 'oc-session-1',
    });

    await expect(source.page({
      direction: 'newer',
      maxBytes: 100_000,
      maxItems: 10,
    })).resolves.toEqual({
      items: [],
      nextCursor: null,
      tailCursor: null,
      hasMore: false,
      truncated: false,
    });
    await expect(source.page({
      direction: 'older',
      cursor: 'not-a-valid-opencode-cursor',
      maxBytes: 100_000,
      maxItems: 10,
    })).resolves.toEqual({
      items: [],
      nextCursor: null,
      tailCursor: null,
      hasMore: false,
      truncated: true,
    });
    await expect(source.readAfter({
      cursor: 'not-a-valid-opencode-cursor',
      maxBytes: 100_000,
      maxItems: 10,
    })).resolves.toEqual({
      items: [],
      nextCursor: null,
      truncated: true,
    });
    expect(client.sessionMessages).not.toHaveBeenCalled();
  });

  it('declares follow unsupported without polling provider history', async () => {
    const client = createClientFixture(() => [
      createMessage('msg-user', 'user', 'hello'),
    ]);
    const source = createOpenCodeTranscriptSourceDefinition({
      id: 'opencode:test:http-sse',
      client,
      readProviderSessionId: () => 'oc-session-1',
    });

    await expect(source.acquireFollowLease?.({ reason: 'test' })).resolves.toBeNull();
    expect(client.sessionMessages).not.toHaveBeenCalled();
  });

  it('reads after a tail cursor without replaying historical messages', async () => {
    let messages: readonly unknown[] = [
      createMessage('msg-user-1', 'user', 'hello'),
      createMessage('msg-agent-1', 'assistant', 'answer'),
    ];
    const client = createClientFixture(() => messages);
    const source = createOpenCodeTranscriptSourceDefinition({
      id: 'opencode:test:http-sse',
      client,
      readProviderSessionId: () => 'oc-session-1',
    });

    const tail = await source.readAfter({
      cursor: 'tail',
      maxBytes: 100_000,
      maxItems: 10,
    });
    messages = [
      ...messages,
      createMessage('msg-agent-2', 'assistant', 'later answer'),
    ];

    const afterTail = await source.readAfter({
      cursor: tail.nextCursor ?? 'tail',
      maxBytes: 100_000,
      maxItems: 10,
    });

    expect(tail.items).toEqual([]);
    expect(afterTail.items.map((item) => item.id)).toEqual(['opencode:oc-session-1:msg-agent-2']);
    expect(afterTail.nextCursor).toEqual(expect.any(String));
    expect(afterTail.truncated).toBe(false);
  });

  it('returns the latest bounded transcript window on the initial older page', async () => {
    const client = createClientFixture(() => [
      createMessage('msg-user-1', 'user', 'oldest'),
      createMessage('msg-agent-1', 'assistant', 'older answer'),
      createMessage('msg-user-2', 'user', 'latest question'),
      createMessage('msg-agent-2', 'assistant', 'latest answer'),
    ]);
    const source = createOpenCodeTranscriptSourceDefinition({
      id: 'opencode:test:http-sse',
      client,
      readProviderSessionId: () => 'oc-session-1',
    });

    const page = await source.page({
      direction: 'older',
      maxBytes: 100_000,
      maxItems: 2,
    });

    expect(page.items.map((item) => item.id)).toEqual([
      'opencode:oc-session-1:msg-user-2',
      'opencode:oc-session-1:msg-agent-2',
    ]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));

    const older = await source.page({
      direction: 'older',
      cursor: page.nextCursor ?? undefined,
      maxBytes: 100_000,
      maxItems: 2,
    });

    expect(older.items.map((item) => item.id)).toEqual([
      'opencode:oc-session-1:msg-user-1',
      'opencode:oc-session-1:msg-agent-1',
    ]);
    expect(older.hasMore).toBe(false);
  });

  it('suppresses Happier-authored provider user rows and their late assistant replies', async () => {
    const client = createClientFixture(() => [
      createMessage('msg-user-external', 'user', 'external user'),
      createMessage('msg-agent-external', 'assistant', 'external answer'),
      createMessage('msg-user-happier', 'user', 'happier-authored prompt'),
      createMessage('msg-agent-late', 'assistant', 'late provider answer'),
    ]);
    const source = createOpenCodeTranscriptSourceDefinition({
      id: 'opencode:test:http-sse',
      client,
      readProviderSessionId: () => 'oc-session-1',
      isHappierAuthoredProviderUserMessageId: (messageId) => messageId === 'msg-user-happier',
    });

    const page = await source.page({
      direction: 'older',
      maxBytes: 100_000,
      maxItems: 10,
    });
    const after = await source.readAfter({
      cursor: encodeOpenCodeIndexCursor({ v: 1, kind: 'opencodeTranscript', nextIndex: 0 }),
      maxBytes: 100_000,
      maxItems: 10,
    });

    expect(page.items.map((item) => item.id)).toEqual([
      'opencode:oc-session-1:msg-user-external',
      'opencode:oc-session-1:msg-agent-external',
    ]);
    expect(after.items.map((item) => item.id)).toEqual([
      'opencode:oc-session-1:msg-user-external',
      'opencode:oc-session-1:msg-agent-external',
    ]);
  });

  it('skips provider transcript rows without durable OpenCode message ids', async () => {
    const messageWithoutId = {
      info: { role: 'assistant', time: { created: 100 } },
      parts: [{ type: 'text', text: 'answer' }],
    };
    const client = createClientFixture(() => [
      messageWithoutId,
      createMessage('msg-stable', 'assistant', 'stable answer'),
    ]);
    const source = createOpenCodeTranscriptSourceDefinition({
      id: 'opencode:test:http-sse',
      client,
      readProviderSessionId: () => 'oc-session-1',
    });

    const page = await source.page({
      direction: 'older',
      maxBytes: 100_000,
      maxItems: 10,
    });

    expect(page.items.map((item) => item.id)).toEqual(['opencode:oc-session-1:msg-stable']);
    expect(page.items.map((item) => item.localId)).toEqual(['opencode:oc-session-1:msg-stable']);
    expect(page.hasMore).toBe(false);
  });

  it('marks an oversized transcript item as truncated while advancing the cursor', async () => {
    const client = createClientFixture(() => [
      createMessage('msg-long', 'assistant', 'x'.repeat(10_000)),
    ]);
    const source = createOpenCodeTranscriptSourceDefinition({
      id: 'opencode:test:http-sse',
      client,
      readProviderSessionId: () => 'oc-session-1',
    });

    const page = await source.page({
      direction: 'older',
      maxBytes: 16,
      maxItems: 10,
    });

    expect(page.items.map((item) => item.id)).toEqual(['opencode:oc-session-1:msg-long']);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.truncated).toBe(true);
  });
});
