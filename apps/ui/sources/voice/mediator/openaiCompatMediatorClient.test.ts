import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => ({
      settings: {
        voiceLocalChatBaseUrl: 'http://localhost:8002',
        voiceLocalChatApiKey: null,
        voiceLocalChatTemperature: 0.4,
        voiceLocalChatMaxTokens: null,
      },
    }),
  },
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    decryptSecretValue: (v: any) => v,
  },
}));

describe('OpenAiCompatMediatorClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('preserves empty assistant responses in message history', async () => {
    const bodies: any[] = [];
    (globalThis.fetch as any).mockImplementation(async (_url: string, init?: any) => {
      bodies.push(JSON.parse(String(init?.body ?? 'null')));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '' } }] }),
      };
    });

    const { OpenAiCompatMediatorClient } = await import('./openaiCompatMediatorClient');

    const client = new OpenAiCompatMediatorClient();
    const { mediatorId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await client.sendTurn({ sessionId: 's1', mediatorId, userText: 'hello' });
    await client.sendTurn({ sessionId: 's1', mediatorId, userText: 'world' });

    const second = bodies[1];
    expect(second?.messages?.some((m: any) => m?.role === 'assistant' && m?.content === '')).toBe(true);
  });

  it('includes verbosity guidance in the system prompt', async () => {
    const bodies: any[] = [];
    (globalThis.fetch as any).mockImplementation(async (_url: string, init?: any) => {
      bodies.push(JSON.parse(String(init?.body ?? 'null')));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    });

    const { OpenAiCompatMediatorClient } = await import('./openaiCompatMediatorClient');

    const client = new OpenAiCompatMediatorClient();
    const { mediatorId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
      verbosity: 'balanced',
    } as any);

    await client.sendTurn({ sessionId: 's1', mediatorId, userText: 'hello' });
    const first = bodies[0];
    expect(first?.messages?.[0]?.role).toBe('system');
    expect(String(first?.messages?.[0]?.content ?? '')).toContain('be concise but include enough detail to be helpful');
  });

  it('throws when commit produces an empty response', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    });

    const { OpenAiCompatMediatorClient } = await import('./openaiCompatMediatorClient');

    const client = new OpenAiCompatMediatorClient();
    const { mediatorId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await expect(client.commit({ sessionId: 's1', mediatorId, kind: 'session_instruction' })).rejects.toThrow('commit_empty_response');
  });

  it('appends commit instruction as the final message', async () => {
    const bodies: any[] = [];
    (globalThis.fetch as any).mockImplementation(async (_url: string, init?: any) => {
      bodies.push(JSON.parse(String(init?.body ?? 'null')));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    });

    const { OpenAiCompatMediatorClient } = await import('./openaiCompatMediatorClient');
    const client = new OpenAiCompatMediatorClient();
    const { mediatorId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await client.sendTurn({ sessionId: 's1', mediatorId, userText: 'hello' });
    await client.commit({ sessionId: 's1', mediatorId, kind: 'session_instruction', maxChars: 123 });

    const commitReq = bodies[1];
    const commitMessages = commitReq?.messages ?? [];
    const lastMessage = commitMessages[commitMessages.length - 1];

    expect(lastMessage?.role).toBe('user');
    expect(String(lastMessage?.content ?? '')).toContain('Based on the conversation so far');
    expect(String(lastMessage?.content ?? '')).toContain('Max 123 characters.');
  });

  it('does not persist a failed user turn in mediator state', async () => {
    const bodies: any[] = [];
    (globalThis.fetch as any)
      .mockImplementationOnce(async (_url: string, init?: any) => {
        bodies.push(JSON.parse(String(init?.body ?? 'null')));
        return { ok: false };
      })
      .mockImplementationOnce(async (_url: string, init?: any) => {
        bodies.push(JSON.parse(String(init?.body ?? 'null')));
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        };
      });

    const { OpenAiCompatMediatorClient } = await import('./openaiCompatMediatorClient');
    const client = new OpenAiCompatMediatorClient();
    const { mediatorId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await expect(client.sendTurn({ sessionId: 's1', mediatorId, userText: 'first failed turn' })).rejects.toThrow('chat_failed');
    await expect(client.sendTurn({ sessionId: 's1', mediatorId, userText: 'second turn' })).resolves.toEqual({ assistantText: 'ok' });

    const second = bodies[1];
    expect(second?.messages?.some((m: any) => m?.role === 'user' && m?.content === 'first failed turn')).toBe(false);
    expect(second?.messages?.some((m: any) => m?.role === 'user' && m?.content === 'second turn')).toBe(true);
  });

  it('throws commit_failed when commit HTTP request is not ok', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      })
      .mockResolvedValueOnce({ ok: false });

    const { OpenAiCompatMediatorClient } = await import('./openaiCompatMediatorClient');
    const client = new OpenAiCompatMediatorClient();
    const { mediatorId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await client.sendTurn({ sessionId: 's1', mediatorId, userText: 'hello' });
    await expect(client.commit({ sessionId: 's1', mediatorId, kind: 'session_instruction' })).rejects.toThrow('commit_failed');
  });

  it('supports stop and rejects subsequent calls for removed mediator', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });

    const { OpenAiCompatMediatorClient } = await import('./openaiCompatMediatorClient');
    const client = new OpenAiCompatMediatorClient();
    const { mediatorId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await expect(client.stop({ sessionId: 's1', mediatorId })).resolves.toEqual({ ok: true });
    await expect(client.sendTurn({ sessionId: 's1', mediatorId, userText: 'hello' })).rejects.toThrow('VOICE_MEDIATOR_NOT_FOUND');
  });
});
