import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settingsState: any = {
  voice: {
    adapters: {
      local_conversation: {
        networkTimeoutMs: 5_000,
        agent: {
          openaiCompat: {
            chatBaseUrl: 'http://localhost:8002',
            chatApiKey: null,
            temperature: 0.4,
            maxTokens: null,
          },
        },
      },
    },
  },
};

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => ({
      settings: settingsState,
    }),
  },
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    decryptSecretValue: (v: any) => v,
  },
}));

describe('OpenAiCompatVoiceAgentClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as any;
    settingsState.voice.adapters.local_conversation.networkTimeoutMs = 5_000;
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

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');

    const client = new OpenAiCompatVoiceAgentClient();
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' });
    await client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'world' });

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

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');

    const client = new OpenAiCompatVoiceAgentClient();
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
      verbosity: 'balanced',
    } as any);

    await client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' });
    const first = bodies[0];
    expect(first?.messages?.[0]?.role).toBe('system');
    expect(String(first?.messages?.[0]?.content ?? '')).toMatch(/be concise but include enough detail to be helpful/i);
  });

  it('includes the active sessionId in the system prompt', async () => {
    const bodies: any[] = [];
    (globalThis.fetch as any).mockImplementation(async (_url: string, init?: any) => {
      bodies.push(JSON.parse(String(init?.body ?? 'null')));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    });

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');

    const client = new OpenAiCompatVoiceAgentClient();
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' });
    const first = bodies[0];
    expect(first?.messages?.[0]?.role).toBe('system');
    expect(String(first?.messages?.[0]?.content ?? '')).toMatch(/sessionId\s*:\s*s1/i);
  });

  it('extracts voice actions from assistant responses', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: [
                'Ok, sending.',
                '',
                '<voice_actions>',
                JSON.stringify({ actions: [{ t: 'sendSessionMessage', args: { message: 'Do X.' } }] }),
                '</voice_actions>',
              ].join('\n'),
            },
          },
        ],
      }),
    });

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');

    const client = new OpenAiCompatVoiceAgentClient();
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    const result = await client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' });
    expect(result.assistantText).toBe('Ok, sending.');
    expect((result as any).actions?.[0]?.t).toBe('sendSessionMessage');
  });

  it('throws when commit produces an empty response', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    });

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');

    const client = new OpenAiCompatVoiceAgentClient();
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await expect(client.commit({ sessionId: 's1', voiceAgentId, kind: 'session_instruction' })).rejects.toThrow('commit_empty_response');
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

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');
    const client = new OpenAiCompatVoiceAgentClient();
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' });
    await client.commit({ sessionId: 's1', voiceAgentId, kind: 'session_instruction', maxChars: 123 });

    const commitReq = bodies[1];
    const commitMessages = commitReq?.messages ?? [];
    const lastMessage = commitMessages[commitMessages.length - 1];

    expect(lastMessage?.role).toBe('user');
    expect(String(lastMessage?.content ?? '')).toContain('Based on the conversation so far');
    expect(String(lastMessage?.content ?? '')).toContain('Max 123 characters.');
  });

  it('does not persist a failed user turn in agent state', async () => {
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

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');
    const client = new OpenAiCompatVoiceAgentClient();
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await expect(client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'first failed turn' })).rejects.toThrow('chat_failed');
    await expect(client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'second turn' })).resolves.toEqual({ assistantText: 'ok' });

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

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');
    const client = new OpenAiCompatVoiceAgentClient();
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' });
    await expect(client.commit({ sessionId: 's1', voiceAgentId, kind: 'session_instruction' })).rejects.toThrow('commit_failed');
  });

  it('supports stop and rejects subsequent calls for removed agent', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');
    const client = new OpenAiCompatVoiceAgentClient();
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await expect(client.stop({ sessionId: 's1', voiceAgentId })).resolves.toEqual({ ok: true });
    await expect(client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' })).rejects.toThrow('VOICE_AGENT_NOT_FOUND');
  });

  it('caps stored agent messages so chat requests stay bounded', async () => {
    const bodies: any[] = [];
    (globalThis.fetch as any).mockImplementation(async (_url: string, init?: any) => {
      const body = JSON.parse(String(init?.body ?? 'null'));
      bodies.push(body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    });

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');
    const client = new OpenAiCompatVoiceAgentClient();
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    for (let i = 0; i < 30; i += 1) {
      await client.sendTurn({ sessionId: 's1', voiceAgentId, userText: `turn-${i}` });
    }

    const last = bodies[bodies.length - 1];
    const serialized = JSON.stringify(last?.messages ?? []);
    expect(serialized).toContain('turn-29');
    expect(serialized).not.toContain('turn-0');
  });

  it('supports stream start/read flow for local openai-compatible agent', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'streamed response text' } }] }),
    });

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');
    const client = new OpenAiCompatVoiceAgentClient();
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    const stream = await client.startTurnStream({ sessionId: 's1', voiceAgentId, userText: 'hello' });
    const read = await client.readTurnStream({ sessionId: 's1', voiceAgentId, streamId: stream.streamId, cursor: 0, maxEvents: 64 });

    expect(read.done).toBe(true);
    expect(read.events.some((event) => event.t === 'delta')).toBe(true);
    expect(read.events.some((event) => event.t === 'done')).toBe(true);
  });

  it('times out chat requests when fetch exceeds configured timeout', async () => {
    settingsState.voiceLocalNetworkTimeoutMs = 5;
    (globalThis.fetch as any).mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    });

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');
    const client = new OpenAiCompatVoiceAgentClient();
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await expect(client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' })).rejects.toThrow('chat_timeout');
  });
});
