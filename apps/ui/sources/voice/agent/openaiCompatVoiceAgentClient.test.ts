import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installVoiceAgentCommonModuleMocks } from './voiceAgentTestHelpers';

const settingsState: any = {
  voice: {
    providers: {
      local_conversation: { schemaVersion: 1, config: {
        networkTimeoutMs: 5_000,
        agent: {
          openaiCompat: {
            chatBaseUrl: 'http://localhost:8002',
            insecureLocalOriginConsent: 'http://localhost:8002',
            insecureLocalConsentMachineId: 'machine-raw',
            chatApiKey: null,
            temperature: 0.4,
            maxTokens: null,
          },
        },
      } },
    },
  },
};
const state: any = {
  settings: settingsState,
  sessions: {
    s1: {
      id: 's1',
      active: true,
      presence: 'online',
      modelMode: 'default',
      metadata: { flavor: 'claude', machineId: 'machine-raw' },
    },
  },
  sessionListRenderables: {
    s1: {
      id: 's1',
      updatedAt: 0,
      metadata: { flavor: 'claude', machineId: 'machine-cached', path: '/tmp/project' },
    },
  },
  sessionListIndexByServerId: {
    'server-a': [
      { type: 'session', sessionId: 's1', serverId: 'server-a', serverName: 'Server A' },
    ],
  },
  concurrentSessionListCacheByServerId: {},
};
const getState = vi.fn(() => state);
const resolveUiVoicePromptStackBlocks = vi.fn(async (_args?: { profileId?: string | null }) => []);
const resolveUiMemoryRecallGuidanceEnabled = vi.fn(async (_args: any) => false);

vi.mock('@/voice/local/openaiCompat/client', () => ({
  OpenAiCompatDaemonClient: class {
    async chat(input: unknown): Promise<string> {
      const response = await globalThis.fetch('daemon://openai-compat/chat', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error('chat_failed');
      const json = await response.json().catch(() => null) as any;
      return typeof json?.choices?.[0]?.message?.content === 'string'
        ? json.choices[0].message.content.trim()
        : '';
    }

    async listModels(): Promise<readonly { id: string }[]> {
      return [];
    }
  },
}));

installVoiceAgentCommonModuleMocks({
  storage: async () => ({
    storage: {
      getState,
    },
  }),
});

vi.mock('@/sync/sync', () => ({
  sync: {
    decryptSecretValue: (v: any) => v,
  },
}));

vi.mock('@/voice/agent/resolveUiVoicePromptStackBlocks', () => ({
  resolveUiVoicePromptStackBlocks: (args: { profileId?: string | null }) => resolveUiVoicePromptStackBlocks(args),
}));

vi.mock('@/sync/domains/memory/resolveUiMemoryRecallGuidanceEnabled', () => ({
  resolveUiMemoryRecallGuidanceEnabled: (args: any) => resolveUiMemoryRecallGuidanceEnabled(args),
}));

describe('OpenAiCompatVoiceAgentClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as any;
    settingsState.voice.providers.local_conversation.config.networkTimeoutMs = 5_000;
    settingsState.voice.providers.local_conversation.config.agent.openaiCompat.insecureLocalOriginConsent = 'http://localhost:8002';
    settingsState.voice.providers.local_conversation.config.agent.openaiCompat.insecureLocalConsentMachineId = 'machine-raw';
    resolveUiVoicePromptStackBlocks.mockClear();
    resolveUiVoicePromptStackBlocks.mockResolvedValue([]);
    resolveUiMemoryRecallGuidanceEnabled.mockClear();
    resolveUiMemoryRecallGuidanceEnabled.mockResolvedValue(false);
    state.sessions.s1.metadata = { flavor: 'claude', machineId: 'machine-raw' };
    state.sessionListRenderables.s1.metadata = { flavor: 'claude', machineId: 'machine-cached', path: '/tmp/project' };
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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' });
    const first = bodies[0];
    expect(first?.messages?.[0]?.role).toBe('system');
    expect(String(first?.messages?.[0]?.content ?? '')).toMatch(/Active coding session\s*\(internal tool target\)\s*:\s*s1/i);
  });

  it('passes profileId through when resolving UI voice prompt-stack blocks', async () => {
    (globalThis.fetch as any).mockImplementation(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    }));

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');

    const client = new OpenAiCompatVoiceAgentClient();
    await client.start({
      sessionId: 's1',
      profileId: 'work',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    expect(resolveUiVoicePromptStackBlocks).toHaveBeenCalledWith({ profileId: 'work' });
  });

  it('prefers visible lookup session metadata when resolving memory recall guidance machine ids', async () => {
    const guidanceCalls: any[] = [];
    resolveUiMemoryRecallGuidanceEnabled.mockImplementationOnce(async (args: any) => {
      guidanceCalls.push(args);
      return false;
    });

    (globalThis.fetch as any).mockImplementation(async (_url: string, init?: any) => {
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    });

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');
    const client = new OpenAiCompatVoiceAgentClient();
    await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    expect(guidanceCalls[0]).toMatchObject({
      machineId: 'machine-cached',
      surfaces: ['voice'],
    });
  });

  it('welcome inserts an assistant greeting into message history', async () => {
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
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await expect(client.welcome({ sessionId: 's1', voiceAgentId, welcomeText: 'Welcome!' })).resolves.toEqual({ assistantText: 'Welcome!' });

    await client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' });
    const first = bodies[0];
    const roles = (first?.messages ?? []).map((m: any) => ({ role: m?.role, content: m?.content }));
    expect(roles).toContainEqual({ role: 'assistant', content: 'Welcome!' });
    expect(roles).toContainEqual({ role: 'user', content: 'hello' });
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
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    const result = await client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' });
    expect(result.assistantText).toBe('Ok, sending.');
    expect((result as any).actions?.[0]?.t).toBe('sendSessionMessage');
  });

  it('omits disabled voice tools from the system prompt when disabledActionIds are provided', async () => {
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
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
      disabledActionIds: ['review.start', 'machines.list'],
    } as any);

    await client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' });
    const prompt = String(bodies[0]?.messages?.[0]?.content ?? '');
    expect(prompt).not.toContain('startReview');
    expect(prompt).not.toContain('listMachines');
    expect(prompt).toContain('listAgentBackends');
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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    const stream = await client.startTurnStream({ sessionId: 's1', voiceAgentId, userText: 'hello' });
    const read = await client.readTurnStream({ sessionId: 's1', voiceAgentId, streamId: stream.streamId, cursor: 0, maxEvents: 64 });

    expect(read.done).toBe(true);
    expect(read.events.some((event) => event.t === 'voice_output' && event.output.kind === 'speech_segment')).toBe(true);
    expect(read.events.some((event) => event.t === 'voice_output' && event.output.kind === 'turn_final')).toBe(true);
  });

  it('reports daemon chat failure without a direct browser timeout owner', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false });

    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');
    const client = new OpenAiCompatVoiceAgentClient();
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });

    await expect(client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' })).rejects.toThrow('chat_failed');
  });

  it('routes chat and model catalog through the selected-daemon client without browser fetch or raw keys', async () => {
    const chat = vi.fn(async () => 'daemon reply');
    const listModels = vi.fn(async () => [{ id: 'daemon-model' }]);
    globalThis.fetch = vi.fn(async () => { throw new Error('browser fetch forbidden'); }) as any;
    const { OpenAiCompatVoiceAgentClient } = await import('./openaiCompatVoiceAgentClient');
    const client = new OpenAiCompatVoiceAgentClient({ daemonClient: { chat, listModels } as any });
    const { voiceAgentId } = await client.start({
      sessionId: 's1',
      chatModelId: 'fast-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'Initial context',
    });
    await expect(client.sendTurn({ sessionId: 's1', voiceAgentId, userText: 'hello' }))
      .resolves.toEqual({ assistantText: 'daemon reply' });
    await expect(client.getModels({ sessionId: 's1' })).resolves.toMatchObject({
      availableModels: [{ id: 'daemon-model', name: 'daemon-model' }],
    });
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      insecureLocalOriginConsent: 'http://localhost:8002',
      insecureLocalConsentMachineId: 'machine-raw',
      credentialKind: 'chat_api_key',
      messages: expect.any(Array),
    }));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
