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

function createDelayedCompletionBackend(
  label: string,
): AgentBackend & { completeCurrentResponse: () => void } {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = `s-${label}`;
  let lastPrompt = '';
  let resolveCurrent: (() => void) | null = null;
  let currentResponseDone: Promise<void> | null = null;

  return {
    completeCurrentResponse() {
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

describe('VoiceMediatorManager', () => {
  it('clears the reaper interval when disposed', async () => {
    const { VoiceMediatorManager } = await import('./VoiceMediatorManager');

    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      const createBackend: BackendFactory = () => createDeterministicBackend('backend');
      const manager = new VoiceMediatorManager({ createBackend });

      await manager.dispose();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearIntervalSpy.mockRestore();
    }
  });

  it('rejects start calls after dispose without creating new backends', async () => {
    const { VoiceMediatorManager } = await import('./VoiceMediatorManager');

    const createBackend = vi.fn(() => createDeterministicBackend('backend'));
    const manager = new VoiceMediatorManager({ createBackend });

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
    ).rejects.toMatchObject({ code: 'VOICE_MEDIATOR_START_FAILED' });

    expect(createBackend).toHaveBeenCalledTimes(0);
  });

  it('turns backend factory errors into VOICE_MEDIATOR_START_FAILED and disposes already-created backends', async () => {
    const { VoiceMediatorManager } = await import('./VoiceMediatorManager');

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

    const manager = new VoiceMediatorManager({ createBackend });

    await expect(
      manager.start({
        agentId: 'claude',
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionPolicy: 'read_only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      }),
    ).rejects.toMatchObject({ code: 'VOICE_MEDIATOR_START_FAILED' });

    expect(chatDispose).toHaveBeenCalledTimes(1);
  });

  it('passes through VoiceMediatorError codes thrown by the backend factory', async () => {
    const { VoiceMediatorError, VoiceMediatorManager } = await import('./VoiceMediatorManager');

    const createBackend: BackendFactory = () => {
      throw new VoiceMediatorError('VOICE_MEDIATOR_UNSUPPORTED', 'voice mediator not supported');
    };

    const manager = new VoiceMediatorManager({ createBackend });

    await expect(
      manager.start({
        agentId: 'claude',
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionPolicy: 'read_only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      }),
    ).rejects.toMatchObject({ code: 'VOICE_MEDIATOR_UNSUPPORTED' });
  });

  it('passes agentId, model ids, and permission policy to the backend factory', async () => {
    const { VoiceMediatorManager } = await import('./VoiceMediatorManager');

    const seen: Array<{ agentId: AgentId; modelId: string; permissionPolicy: 'no_tools' | 'read_only' }> = [];
    const backend = createDeterministicBackend('chat');
    const createBackend: BackendFactory = (opts) => {
      seen.push({ agentId: opts.agentId, modelId: opts.modelId, permissionPolicy: opts.permissionPolicy });
      return backend;
    };

    const manager = new VoiceMediatorManager({ createBackend });
    await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    expect(seen).toEqual([
      { agentId: 'claude', modelId: 'chat-model', permissionPolicy: 'read_only' },
      { agentId: 'claude', modelId: 'commit-model', permissionPolicy: 'read_only' },
    ]);
  });

  it('uses a more detailed prompt when verbosity is balanced', async () => {
    const { VoiceMediatorManager } = await import('./VoiceMediatorManager');

    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceMediatorManager({ createBackend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      verbosity: 'balanced',
    });

    await manager.sendTurn({ mediatorId: started.mediatorId, userText: 'hi' });
    const [prompt] = chatBackend.getSeenPrompts();
    expect(prompt).toContain('be concise but include enough detail to be helpful');
  });

  it('keeps multi-turn history and uses the commit backend separately', async () => {
    const { VoiceMediatorManager } = await import('./VoiceMediatorManager');

    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceMediatorManager({
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

    const r1 = await manager.sendTurn({ mediatorId: started.mediatorId, userText: 'hi' });
    expect(r1.assistantText).toContain('chat:');

    const r2 = await manager.sendTurn({ mediatorId: started.mediatorId, userText: 'more' });
    expect(r2.assistantText).toContain('chat:');

    const committed = await manager.commit({ mediatorId: started.mediatorId, maxChars: 10_000 });
    expect(committed.commitText).toContain('commit:');

    expect(chatBackend.getSeenPrompts().length).toBe(2);
    expect(commitBackend.getSeenPrompts().length).toBe(1);
  });

  it('clears delta-only output buffers between operations', async () => {
    const { VoiceMediatorManager } = await import('./VoiceMediatorManager');

    const chatBackend = createDeltaOnlyBackend('chat');
    const commitBackend = createDeltaOnlyBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceMediatorManager({ createBackend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const r1 = await manager.sendTurn({ mediatorId: started.mediatorId, userText: 'one' });
    expect(r1.assistantText).toBe('chat:1');

    const r2 = await manager.sendTurn({ mediatorId: started.mediatorId, userText: 'two' });
    expect(r2.assistantText).toBe('chat:2');

    const c1 = await manager.commit({ mediatorId: started.mediatorId });
    expect(c1.commitText).toBe('commit:1');

    const c2 = await manager.commit({ mediatorId: started.mediatorId });
    expect(c2.commitText).toBe('commit:2');
  });

  it('waits for backend response completion before returning chat output', async () => {
    const { VoiceMediatorManager } = await import('./VoiceMediatorManager');

    const chatBackend = createDelayedCompletionBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceMediatorManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    let resolved = false;
    const sendTurnPromise = manager.sendTurn({ mediatorId: started.mediatorId, userText: 'hello' }).then((result) => {
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
    const { VoiceMediatorManager } = await import('./VoiceMediatorManager');

    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDelayedCompletionBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceMediatorManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    let resolved = false;
    const commitPromise = manager.commit({ mediatorId: started.mediatorId }).then((result) => {
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
    const { VoiceMediatorManager } = await import('./VoiceMediatorManager');

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

    const manager = new VoiceMediatorManager({ createBackend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const sendP = manager.sendTurn({ mediatorId: started.mediatorId, userText: 'hi' });

    let stopResolved = false;
    const stopP = manager.stop({ mediatorId: started.mediatorId }).then(() => {
      stopResolved = true;
    });

    await Promise.resolve();
    expect(stopResolved).toBe(false);

    expect(resolveWasSet).toBe(true);
    deferred.resolve();
    await sendP;
    await stopP;
  });

  it('removes mediators from the registry before awaiting in-flight stop, preventing new operations from starting', async () => {
    const { VoiceMediatorManager } = await import('./VoiceMediatorManager');

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

    const manager = new VoiceMediatorManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const sendP = manager.sendTurn({ mediatorId: started.mediatorId, userText: 'hi' });
    const stopP = manager.stop({ mediatorId: started.mediatorId });

    await expect(manager.sendTurn({ mediatorId: started.mediatorId, userText: 'should fail' })).rejects.toMatchObject({
      code: 'VOICE_MEDIATOR_NOT_FOUND',
    });

    deferred.resolve();
    await sendP;
    await stopP;
  });

  it('treats a NaN idleTtlSeconds as the minimum TTL so idle mediators can be reaped', async () => {
    const { VoiceMediatorManager } = await import('./VoiceMediatorManager');

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
      const manager = new VoiceMediatorManager({
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

      expect(disposedCount).toBe(2);
      await expect(manager.sendTurn({ mediatorId: started.mediatorId, userText: 'hi' })).rejects.toMatchObject({
        code: 'VOICE_MEDIATOR_NOT_FOUND',
      });

      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
