import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentId, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';

type BackendFactory = (opts: { agentId: AgentId; modelId: string; permissionPolicy: 'no_tools' | 'read_only' }) => AgentBackend;

function createDeterministicBackend(label: string): AgentBackend & { getSeenPrompts(): string[] } {
  const seenPrompts: string[] = [];
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = `s-${label}`;

  return {
    getSeenPrompts: () => [...seenPrompts],
    onMessage(h) {
      handler = h;
    },
    async startSession() {
      handler?.({ type: 'status', status: 'running' });
      return { sessionId };
    },
    async sendPrompt(_sid, prompt) {
      seenPrompts.push(prompt);
      handler?.({ type: 'model-output', fullText: `${label}:${prompt}` });
      handler?.({ type: 'status', status: 'idle' });
    },
    async cancel() {},
    async dispose() {},
  };
}

function createDeltaOnlyBackend(label: string): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = `s-${label}`;
  let n = 0;

  return {
    onMessage(h) {
      handler = h;
    },
    async startSession() {
      handler?.({ type: 'status', status: 'running' });
      return { sessionId };
    },
    async sendPrompt(_sid, _prompt) {
      n += 1;
      handler?.({ type: 'model-output', textDelta: `${label}:${n}` });
      handler?.({ type: 'status', status: 'idle' });
    },
    async cancel() {},
    async dispose() {},
  };
}

function createBlockingBackend(label: string, opts: Readonly<{ waitForSendPrompt: () => Promise<void> }>): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = `s-${label}`;

  return {
    onMessage(h) {
      handler = h;
    },
    async startSession() {
      handler?.({ type: 'status', status: 'running' });
      return { sessionId };
    },
    async sendPrompt(_sid, prompt) {
      handler?.({ type: 'model-output', textDelta: `${label}:${prompt}` });
      await opts.waitForSendPrompt();
      handler?.({ type: 'status', status: 'idle' });
    },
    async cancel() {},
    async dispose() {},
  };
}

function createMultiDeltaBackend(label: string, deltas: string[]): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = `s-${label}`;

  return {
    onMessage(h) {
      handler = h;
    },
    async startSession() {
      handler?.({ type: 'status', status: 'running' });
      return { sessionId };
    },
    async sendPrompt() {
      for (const textDelta of deltas) {
        handler?.({ type: 'model-output', textDelta });
      }
      handler?.({ type: 'status', status: 'idle' });
    },
    async cancel() {},
    async dispose() {},
  };
}

function createDelayedCompletionBackend(
  label: string,
): AgentBackend & { completeCurrentResponse: () => void } {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = `s-${label}`;
  let lastPrompt = '';
  let resolveCurrent: (() => void) | null = null;
  let currentResponseDone: Promise<void> | null = null;
  let pendingComplete = false;

  return {
    completeCurrentResponse() {
      pendingComplete = true;
      resolveCurrent?.();
    },
    onMessage(h) {
      handler = h;
    },
    async startSession() {
      handler?.({ type: 'status', status: 'running' });
      return { sessionId };
    },
    async sendPrompt(_sid, prompt) {
      lastPrompt = prompt;
      currentResponseDone = new Promise<void>((resolve) => {
        resolveCurrent = () => {
          handler?.({ type: 'model-output', fullText: `${label}:${lastPrompt}` });
          handler?.({ type: 'status', status: 'idle' });
          resolve();
        };
      });
      if (pendingComplete) {
        pendingComplete = false;
        resolveCurrent?.();
      }
    },
    async waitForResponseComplete() {
      if (!currentResponseDone) return;
      await currentResponseDone;
      resolveCurrent = null;
      currentResponseDone = null;
    },
    async cancel() {},
    async dispose() {},
  };
}

function createStaticResponseBackend(label: string, responseText: string): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = `s-${label}`;

  return {
    onMessage(h) {
      handler = h;
    },
    async startSession() {
      handler?.({ type: 'status', status: 'running' });
      return { sessionId };
    },
    async sendPrompt() {
      handler?.({ type: 'model-output', fullText: responseText });
      handler?.({ type: 'status', status: 'idle' });
    },
    async cancel() {},
    async dispose() {},
  };
}

function createPromptCaptureBackend(sequence: Array<{ responseText: string }>): AgentBackend & { prompts: string[] } {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 's-capture' as SessionId;
  const prompts: string[] = [];
  let idx = 0;

  return {
    prompts,
    onMessage(h) {
      handler = h;
    },
    async startSession() {
      handler?.({ type: 'status', status: 'running' });
      return { sessionId };
    },
    async sendPrompt(_sid, prompt) {
      prompts.push(prompt);
      const next = sequence[Math.min(idx, sequence.length - 1)];
      idx += 1;
      handler?.({ type: 'model-output', fullText: next?.responseText ?? '' });
      handler?.({ type: 'status', status: 'idle' });
    },
    async cancel() {},
    async dispose() {},
  };
}

describe('VoiceAgentManager', () => {
  it('clears the reaper interval when disposed', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      const createBackend: BackendFactory = () => createDeterministicBackend('backend');
      const manager = new VoiceAgentManager({ createBackend });

      await manager.dispose();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearIntervalSpy.mockRestore();
    }
  }, 15_000);

  it('rejects start calls after dispose without creating new backends', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const createBackend = vi.fn(() => createDeterministicBackend('backend'));
    const manager = new VoiceAgentManager({ createBackend });

    await manager.dispose();

    await expect(
      manager.start({
        agentId: 'claude',
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionPolicy: 'read_only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      }),
    ).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });

    expect(createBackend).toHaveBeenCalledTimes(0);
  }, 15_000);

  it('surfaces commit backend factory errors without disposing the chat backend', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const chatDispose = vi.fn(async () => {});
    const chatBackend: AgentBackend = {
      onMessage: () => {},
      startSession: async () => ({ sessionId: 's-chat' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      dispose: chatDispose,
    };

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') {
        throw new Error('commit backend unavailable');
      }
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await expect(manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 })).rejects.toMatchObject({
      code: 'VOICE_AGENT_START_FAILED',
    });

    expect(chatDispose).toHaveBeenCalledTimes(0);
  });

  it('passes through VoiceAgentError codes thrown by the backend factory', async () => {
    const { VoiceAgentError, VoiceAgentManager } = await import('./VoiceAgentManager');

    const createBackend: BackendFactory = () => {
      throw new VoiceAgentError('VOICE_AGENT_UNSUPPORTED', 'voice agent not supported');
    };

    const manager = new VoiceAgentManager({ createBackend });

    await expect(
      manager.start({
        agentId: 'claude',
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionPolicy: 'read_only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      }),
    ).rejects.toMatchObject({ code: 'VOICE_AGENT_UNSUPPORTED' });
  });

  it('passes agentId, model ids, and permission policy to the backend factory', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const seen: Array<{ agentId: AgentId; modelId: string; permissionPolicy: 'no_tools' | 'read_only' }> = [];
    const backend = createDeterministicBackend('chat');
    const createBackend: BackendFactory = (opts) => {
      seen.push({ agentId: opts.agentId, modelId: opts.modelId, permissionPolicy: opts.permissionPolicy });
      return backend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    expect(seen).toEqual([{ agentId: 'claude', modelId: 'chat-model', permissionPolicy: 'read_only' }]);

    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });

    expect(seen).toEqual([
      { agentId: 'claude', modelId: 'chat-model', permissionPolicy: 'read_only' },
      { agentId: 'claude', modelId: 'commit-model', permissionPolicy: 'read_only' },
    ]);
  });

  it('uses a more detailed prompt when verbosity is balanced', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      verbosity: 'balanced',
    });

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
    const [prompt] = chatBackend.getSeenPrompts();
    expect(prompt).toMatch(/be concise but include enough detail to be helpful/i);
  });

  it('keeps multi-turn history and uses the commit backend separately', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({
      createBackend,
      getNowMs: () => Date.now(),
    });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const r1 = await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
    expect(r1.assistantText).toContain('chat:');

    const r2 = await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'more' });
    expect(r2.assistantText).toContain('chat:');

    const prompts = chatBackend.getSeenPrompts();
    expect(prompts[0]).toContain('Initial context:');
    expect(prompts[1]).toBe('User: more\nVoice agent:');

    const committed = await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });
    expect(committed.commitText).toContain('commit:');

    expect(chatBackend.getSeenPrompts().length).toBe(2);
    expect(commitBackend.getSeenPrompts().length).toBe(1);
  });

  it('extracts voice tool actions from the assistant response text', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const chatBackend = createStaticResponseBackend(
      'chat',
      [
        'Ok, sending that now.',
        '',
        '<voice_actions>',
        JSON.stringify({ actions: [{ t: 'sendSessionMessage', args: { message: 'Please do X.' } }] }),
        '</voice_actions>',
      ].join('\n'),
    );
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const result = await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
    expect(result.assistantText).toBe('Ok, sending that now.');
    expect((result as any).actions?.[0]?.t).toBe('sendSessionMessage');
  });

  it('clears delta-only output buffers between operations', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const chatBackend = createDeltaOnlyBackend('chat');
    const commitBackend = createDeltaOnlyBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const r1 = await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'one' });
    expect(r1.assistantText).toBe('chat:1');

    const r2 = await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'two' });
    expect(r2.assistantText).toBe('chat:2');

    const c1 = await manager.commit({ voiceAgentId: started.voiceAgentId });
    expect(c1.commitText).toBe('commit:1');

    const c2 = await manager.commit({ voiceAgentId: started.voiceAgentId });
    expect(c2.commitText).toBe('commit:2');
  });

  it('waits for backend response completion before returning chat output', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const chatBackend = createDelayedCompletionBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    let resolved = false;
    const sendTurnPromise = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' }).then((result) => {
      resolved = true;
      return result;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    chatBackend.completeCurrentResponse();
    const result = await sendTurnPromise;
    expect(result.assistantText).toContain('chat:');
  });

  it('waits for backend response completion before returning commit output', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDelayedCompletionBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    let resolved = false;
    const commitPromise = manager.commit({ voiceAgentId: started.voiceAgentId }).then((result) => {
      resolved = true;
      return result;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    commitBackend.completeCurrentResponse();
    const result = await commitPromise;
    expect(result.commitText).toContain('commit:');
  });

  it('waits for in-flight operations to finish before stopping', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const deferred: { resolve: () => void } = { resolve: () => {} };
    let resolveWasSet = false;
    const waitForSendPrompt = () =>
      new Promise<void>((r) => {
        deferred.resolve = () => r();
        resolveWasSet = true;
      });

    const chatBackend = createBlockingBackend('chat', { waitForSendPrompt });
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const sendP = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });

    let stopResolved = false;
    const stopP = manager.stop({ voiceAgentId: started.voiceAgentId }).then(() => {
      stopResolved = true;
    });

    await Promise.resolve();
    expect(stopResolved).toBe(false);

    expect(resolveWasSet).toBe(true);
    deferred.resolve();
    await sendP;
    await stopP;
  });

  it('removes voice agents from the registry before awaiting in-flight stop, preventing new operations from starting', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const deferred: { resolve: () => void } = { resolve: () => {} };
    const waitForSendPrompt = () => new Promise<void>((r) => {
      deferred.resolve = () => r();
    });

    const chatBackend = createBlockingBackend('chat', { waitForSendPrompt });
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const sendP = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
    const stopP = manager.stop({ voiceAgentId: started.voiceAgentId });

    await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'should fail' })).rejects.toMatchObject({
      code: 'VOICE_AGENT_NOT_FOUND',
    });

    deferred.resolve();
    await sendP;
    await stopP;
  });

  it('treats a NaN idleTtlSeconds as the minimum TTL so idle voice agents can be reaped', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    let nowMs = 0;
    let disposedCount = 0;
    const createBackend: BackendFactory = ({ modelId }) => ({
      onMessage() {},
      async startSession() {
        return { sessionId: `s-${modelId}` };
      },
      async sendPrompt() {},
      async cancel() {},
      async dispose() {
        disposedCount += 1;
      },
    });

    vi.useFakeTimers();
    try {
      const manager = new VoiceAgentManager({
        createBackend,
        getNowMs: () => nowMs,
        reaperIntervalMs: 5_000,
      });

      const started = await manager.start({
        agentId: 'claude',
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionPolicy: 'read_only',
        idleTtlSeconds: Number.NaN,
        initialContext: 'CTX',
      });

      nowMs = 120_000;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(disposedCount).toBe(1);
      await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' })).rejects.toMatchObject({
        code: 'VOICE_AGENT_NOT_FOUND',
      });

      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps idleTtlSeconds at the extended maximum so persistent voice agents can stay warm', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    let nowMs = 0;
    let disposedCount = 0;
    const createBackend: BackendFactory = ({ modelId }) => ({
      onMessage() {},
      async startSession() {
        return { sessionId: `s-${modelId}` };
      },
      async sendPrompt() {},
      async cancel() {},
      async dispose() {
        disposedCount += 1;
      },
    });

    vi.useFakeTimers();
    try {
      const manager = new VoiceAgentManager({
        createBackend,
        getNowMs: () => nowMs,
        reaperIntervalMs: 5_000,
      });

      const started = await manager.start({
        agentId: 'claude',
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionPolicy: 'read_only',
        // Request an absurd TTL; the manager should cap it to the extended maximum (6h).
        idleTtlSeconds: 999_999,
        initialContext: 'CTX',
      });

      nowMs = 2 * 60 * 60 * 1000; // 2h
      await vi.advanceTimersByTimeAsync(5_000);
      expect(disposedCount).toBe(0);

      nowMs = 7 * 60 * 60 * 1000; // 7h
      await vi.advanceTimersByTimeAsync(5_000);
      expect(disposedCount).toBe(1);

      await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' })).rejects.toMatchObject({
        code: 'VOICE_AGENT_NOT_FOUND',
      });

      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps stored conversation history so prompts do not grow without bound', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    for (let i = 0; i < 30; i += 1) {
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: `user-${i}` });
    }

    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });

    const prompts = commitBackend.getSeenPrompts();
    const latestPrompt = prompts[prompts.length - 1] ?? '';
    expect(latestPrompt).toContain('user-29');
    expect(latestPrompt).not.toContain('user-0');
  });

  it('streams turn output through read cursors and closes stream when consumed', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const chatBackend = createDeltaOnlyBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    const read = await manager.readTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      cursor: 0,
      maxEvents: 32,
    });

    expect(read.done).toBe(true);
    expect(read.events.some((event) => event.t === 'delta')).toBe(true);
    expect(read.events.some((event) => event.t === 'done')).toBe(true);

    await expect(
      manager.readTurnStream({
        voiceAgentId: started.voiceAgentId,
        streamId: stream.streamId,
        cursor: read.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'VOICE_AGENT_NOT_FOUND' });
  });

  it('filters voice action blocks out of streamed deltas', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const actionJson = JSON.stringify({ actions: [{ t: 'sendSessionMessage', args: { message: 'Do X.' } }] });
    const chatBackend = createMultiDeltaBackend('chat', [
      'Hello.',
      '\n\n<voice_actions>\n',
      actionJson,
      '\n</voice_actions>',
    ]);
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    const read = await manager.readTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      cursor: 0,
      maxEvents: 64,
    });

    const deltaText = read.events.filter((e) => e.t === 'delta').map((e) => (e as any).textDelta).join('');
    expect(deltaText).toContain('Hello.');
    expect(deltaText).not.toContain('<voice_actions>');

    const done = read.events.find((e) => e.t === 'done') as any;
    expect(done.assistantText).toBe('Hello.');
    expect(done.actions?.[0]?.t).toBe('sendSessionMessage');
  });

  it('rejects a second stream start while a stream turn is still in-flight', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const chatBackend = createDelayedCompletionBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'first' });
    await expect(manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'second' })).rejects.toMatchObject({
      code: 'VOICE_AGENT_BUSY',
    });

    chatBackend.completeCurrentResponse();
    let cursor = 0;
    let done = false;
    for (let i = 0; i < 5 && !done; i += 1) {
      const read = await manager.readTurnStream({
        voiceAgentId: started.voiceAgentId,
        streamId: stream.streamId,
        cursor,
      });
      cursor = read.nextCursor;
      done = read.done;
      if (!done) {
        await Promise.resolve();
      }
    }
    expect(done).toBe(true);
  });

  it('bootstraps new sessions with a READY handshake when bootstrapMode is enabled', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const backend = createPromptCaptureBackend([
      { responseText: 'READY' },
      { responseText: 'ok' },
    ]);
    const createBackend: BackendFactory = () => backend;
    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      bootstrapMode: 'ready_handshake',
    } as any);

    expect(backend.prompts.length).toBe(1);
    expect(backend.prompts[0]).toContain('Warm-up step: reply with exactly READY');

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });

    expect(backend.prompts.length).toBe(2);
    expect(backend.prompts[1]).toContain('User: hello');
    expect(backend.prompts[1]).not.toContain('Initial context:');
  });

  it('can bootstrap a new session with a welcome message before the first user turn', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const backend = createPromptCaptureBackend([
      { responseText: 'Hello! What are we working on today?' },
      { responseText: 'ok' },
    ]);
    const createBackend: BackendFactory = () => backend;
    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    } as any);

    const welcomed = await manager.welcome({ voiceAgentId: started.voiceAgentId });
    expect(welcomed.assistantText).toContain('Hello');
    expect(backend.prompts.length).toBe(1);
    expect(backend.prompts[0]).toContain('Start this session with a short friendly greeting');

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    expect(backend.prompts.length).toBe(2);
    expect(backend.prompts[1]).toContain('User: hello');
    expect(backend.prompts[1]).not.toContain('Initial context:');
  });

  it('reuses the chat backend for commits when commitIsolation is false and commitModelId matches chatModelId', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const backend = createPromptCaptureBackend([
      { responseText: 'reply' },
      { responseText: 'COMMIT_TEXT' },
    ]);
    const createBackend = vi.fn(() => backend);
    const manager = new VoiceAgentManager({ createBackend: createBackend as any });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      commitIsolation: false,
    } as any);

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    const committed = await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 1000 });

    expect(committed.commitText).toBe('COMMIT_TEXT');
    expect(createBackend).toHaveBeenCalledTimes(1);
    expect(backend.prompts.length).toBe(2);
    expect(backend.prompts[1]).toContain('Instruction:');
  });
});
