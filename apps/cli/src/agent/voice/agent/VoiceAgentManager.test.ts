import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentId, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { BackendFactory, ResolveVoiceSystemAppendBlocksArgs } from './voiceAgentTypes';

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

function createCancelableBlockingBackend(
  label: string,
): AgentBackend & { wasCancelled: () => boolean } {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = `s-${label}`;
  let resolveCurrent: (() => void) | null = null;
  let cancelled = false;

  return {
    wasCancelled: () => cancelled,
    onMessage(h) {
      handler = h;
    },
    async startSession() {
      handler?.({ type: 'status', status: 'running' });
      return { sessionId };
    },
    async sendPrompt(_sid, prompt) {
      handler?.({ type: 'model-output', textDelta: `${label}:${prompt}` });
      await new Promise<void>((resolve) => {
        resolveCurrent = resolve;
      });
      handler?.({ type: 'status', status: 'idle' });
    },
    async cancel() {
      cancelled = true;
      resolveCurrent?.();
      resolveCurrent = null;
    },
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

function createBootstrapTimeoutBackend(): AgentBackend & { prompts: string[]; seenTimeouts: number[] } {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 's-bootstrap-timeout' as SessionId;
  const prompts: string[] = [];
  const seenTimeouts: number[] = [];

  return {
    prompts,
    seenTimeouts,
    onMessage(h) {
      handler = h;
    },
    async startSession() {
      handler?.({ type: 'status', status: 'running' });
      return { sessionId };
    },
    async sendPrompt(_sid, prompt) {
      prompts.push(prompt);
    },
    async waitForResponseComplete(timeoutMs) {
      seenTimeouts.push(timeoutMs ?? -1);
      throw new Error(`bootstrap timeout ${String(timeoutMs ?? 'default')}`);
    },
    async cancel() {},
    async dispose() {},
  };
}

function createResponseTimeoutCaptureBackend(responseText = 'ok'): AgentBackend & { seenTimeouts: number[] } {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 's-response-timeout-capture' as SessionId;
  const seenTimeouts: number[] = [];

  return {
    seenTimeouts,
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
    async waitForResponseComplete(timeoutMs) {
      seenTimeouts.push(typeof timeoutMs === 'number' ? timeoutMs : -1);
    },
    async cancel() {},
    async dispose() {},
  };
}

describe('VoiceAgentManager', () => {
  it.each(['welcome', 'turn', 'commit', 'isolated commit'] as const)(
    'reports actual work activity for %s and becomes idle after completion',
    async (operation) => {
      const { VoiceAgentManager } = await import('./VoiceAgentManager');
      const backend = createDelayedCompletionBackend('activity');
      const activity: Array<{ voiceAgentId: string; active: boolean }> = [];
      const manager = new VoiceAgentManager({
        createBackend: () => backend,
        onActivityChanged: (voiceAgentId) => {
          activity.push({ voiceAgentId, active: manager.isTurnInFlight(voiceAgentId) });
        },
      });
      const { voiceAgentId } = await manager.start({
        agentId: 'claude', chatModelId: 'chat-model', commitModelId: 'chat-model',
        commitIsolation: operation === 'isolated commit',
        permissionPolicy: 'read_only', idleTtlSeconds: 60, initialContext: 'CTX',
      });
      let work: Promise<unknown> | undefined;
      try {
        expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
        work = operation === 'welcome'
          ? manager.welcome({ voiceAgentId })
          : operation === 'turn'
            ? manager.sendTurn({ voiceAgentId, userText: 'hello' })
            : manager.commit({ voiceAgentId });
        expect(activity).toEqual([{ voiceAgentId, active: true }]);
        expect(manager.isTurnInFlight(voiceAgentId)).toBe(true);
        backend.completeCurrentResponse();
        await work;
        expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
        expect(activity).toEqual([{ voiceAgentId, active: true }, { voiceAgentId, active: false }]);
      } finally {
        backend.completeCurrentResponse();
        await work;
        await manager.dispose();
      }
    },
  );

  it('reports a completed unread stream as idle and notifies again for the next stream', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');
    const backend = createDelayedCompletionBackend('stream');
    const activity: boolean[] = [];
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      onActivityChanged: (voiceAgentId) => activity.push(manager.isTurnInFlight(voiceAgentId)),
    });
    const { voiceAgentId } = await manager.start({
      agentId: 'claude', chatModelId: 'chat-model', commitModelId: 'chat-model',
      permissionPolicy: 'read_only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    try {
      for (const userText of ['first', 'second']) {
        const { streamId } = await manager.startTurnStream({ voiceAgentId, userText });
        expect(manager.isTurnInFlight(voiceAgentId)).toBe(true);
        backend.completeCurrentResponse();
        await vi.waitFor(() => expect(manager.isTurnInFlight(voiceAgentId)).toBe(false));
        expect((await manager.readTurnStream({ voiceAgentId, streamId, cursor: 0 })).done).toBe(true);
      }
      expect(activity).toEqual([true, false, true, false]);
    } finally {
      backend.completeCurrentResponse();
      await manager.dispose();
    }
  });

  it('keeps cancellation active until backend work settles', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');
    const backend = createDelayedCompletionBackend('cancel');
    const activity: boolean[] = [];
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      onActivityChanged: (voiceAgentId) => activity.push(manager.isTurnInFlight(voiceAgentId)),
    });
    const { voiceAgentId } = await manager.start({
      agentId: 'claude', chatModelId: 'chat-model', commitModelId: 'chat-model',
      permissionPolicy: 'read_only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    try {
      const { streamId } = await manager.startTurnStream({ voiceAgentId, userText: 'hello' });
      const cancel = manager.cancelTurnStream({ voiceAgentId, streamId });
      expect(activity).toEqual([true]);
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(true);
      backend.completeCurrentResponse();
      await cancel;
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
      expect(activity).toEqual([true, false]);
    } finally {
      backend.completeCurrentResponse();
      await manager.dispose();
    }
  });

  it.each(['stop', 'dispose'] as const)('notifies removal of active work during %s', async (operation) => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');
    const backend = createDelayedCompletionBackend('removal');
    const activity: boolean[] = [];
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      onActivityChanged: (voiceAgentId) => activity.push(manager.isTurnInFlight(voiceAgentId)),
    });
    const { voiceAgentId } = await manager.start({
      agentId: 'claude', chatModelId: 'chat-model', commitModelId: 'chat-model',
      permissionPolicy: 'read_only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    const work = manager.sendTurn({ voiceAgentId, userText: 'hello' });
    try {
      const removal = operation === 'stop' ? manager.stop({ voiceAgentId }) : manager.dispose();
      expect(activity).toEqual([true, false]);
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
      backend.completeCurrentResponse();
      await work;
      await removal;
      expect(activity).toEqual([true, false]);
    } finally {
      backend.completeCurrentResponse();
      await work;
      await manager.dispose();
    }
  });

  it.each(['READY', 'unexpected response'])(
    'reports bootstrap activity and settlement for %s',
    async (responseText) => {
      const { VoiceAgentManager } = await import('./VoiceAgentManager');
      const backend = createStaticResponseBackend('bootstrap', responseText);
      const activity: Array<{ voiceAgentId: string; active: boolean }> = [];
      const manager = new VoiceAgentManager({
        createBackend: () => backend,
        onActivityChanged: (voiceAgentId) => activity.push({ voiceAgentId, active: manager.isTurnInFlight(voiceAgentId) }),
      });
      try {
        const start = manager.start({
          agentId: 'claude', chatModelId: 'chat-model', commitModelId: 'chat-model',
          permissionPolicy: 'read_only', idleTtlSeconds: 60, initialContext: 'CTX',
          bootstrapMode: 'ready_handshake',
        });
        if (responseText === 'READY') await start;
        else await expect(start).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
        expect(activity.map(({ active }) => active)).toEqual([true, false]);
        expect(manager.isTurnInFlight(activity[0]!.voiceAgentId)).toBe(false);
      } finally {
        await manager.dispose();
      }
    },
  );

  it('clears work activity when a backend turn fails', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');
    const backend = createBootstrapTimeoutBackend();
    const activity: boolean[] = [];
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      onActivityChanged: (voiceAgentId) => activity.push(manager.isTurnInFlight(voiceAgentId)),
    });
    try {
      const { voiceAgentId } = await manager.start({
        agentId: 'claude', chatModelId: 'chat-model', commitModelId: 'chat-model',
        permissionPolicy: 'read_only', idleTtlSeconds: 60, initialContext: 'CTX',
      });
      await expect(manager.sendTurn({ voiceAgentId, userText: 'hello' })).rejects.toThrow('bootstrap timeout');
      expect(activity).toEqual([true, false]);
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
    } finally {
      await manager.dispose();
    }
  });

  it('reports resumed commit-session setup as work until the backend load completes', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');
    let completeLoad: () => void = () => {};
    const load = new Promise<void>((resolve) => { completeLoad = resolve; });
    const chatBackend: AgentBackend = {
      ...createStaticResponseBackend('chat', 'ok'),
      loadSession: async () => ({ sessionId: 'resumed-chat' }),
    };
    const commitBackend: AgentBackend = {
      ...createStaticResponseBackend('commit', 'ok'),
      loadSession: async () => {
        await load;
        return { sessionId: 'resumed-commit' };
      },
    };
    const activity: Array<{ voiceAgentId: string; active: boolean }> = [];
    let activeObserved: () => void = () => {};
    const active = new Promise<void>((resolve) => { activeObserved = resolve; });
    const manager = new VoiceAgentManager({
      createBackend: ({ modelId }) => modelId === 'chat-model' ? chatBackend : commitBackend,
      onActivityChanged: (voiceAgentId) => {
        const inFlight = manager.isTurnInFlight(voiceAgentId);
        activity.push({ voiceAgentId, active: inFlight });
        if (inFlight) activeObserved();
      },
    });
    const start = manager.start({
      agentId: 'claude', chatModelId: 'chat-model', commitModelId: 'commit-model',
      permissionPolicy: 'read_only', idleTtlSeconds: 60, initialContext: 'CTX',
      resumeHandle: {
        kind: 'voice_agent_sessions.v1', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatVendorSessionId: 'resumed-chat', commitVendorSessionId: 'resumed-commit',
      },
    });
    try {
      await active;
      expect(activity.map(({ active }) => active)).toEqual([true]);
      completeLoad();
      const { voiceAgentId } = await start;
      expect(activity).toEqual([{ voiceAgentId, active: true }, { voiceAgentId, active: false }]);
    } finally {
      completeLoad();
      await start;
      await manager.dispose();
    }
  });

  it('logs activity-observer errors without failing or retaining completed work', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');
    const { logger } = await import('@/ui/logger');
    const warning = vi.spyOn(logger, 'infoFile');
    const error = new Error('observer failed');
    const manager = new VoiceAgentManager({
      createBackend: () => createStaticResponseBackend('chat', 'ok'),
      onActivityChanged: () => { throw error; },
    });
    try {
      const { voiceAgentId } = await manager.start({
        agentId: 'claude', chatModelId: 'chat-model', commitModelId: 'chat-model',
        permissionPolicy: 'read_only', idleTtlSeconds: 60, initialContext: 'CTX',
      });
      await expect(manager.sendTurn({ voiceAgentId, userText: 'hello' })).resolves.toEqual({ assistantText: 'ok' });
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
      expect(warning).toHaveBeenCalledWith(expect.any(String), { voiceAgentId, error });
    } finally {
      await manager.dispose();
      warning.mockRestore();
    }
  });

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

  it('passes agentId, model ids, permission policy, and voice_agent start intent to the backend factory', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const seen: Array<{
      agentId: AgentId;
      modelId: string;
      permissionPolicy: 'no_tools' | 'read_only';
      start?: { intent: 'voice_agent' };
    }> = [];
    const backend = createDeterministicBackend('chat');
    const createBackend: BackendFactory = (opts) => {
      seen.push({
        agentId: opts.agentId,
        modelId: opts.modelId,
        permissionPolicy: opts.permissionPolicy,
        start: opts.start,
      });
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

    expect(seen).toEqual([{
      agentId: 'claude',
      modelId: 'chat-model',
      permissionPolicy: 'read_only',
      start: { intent: 'voice_agent' },
    }]);

    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });

    expect(seen).toEqual([
      { agentId: 'claude', modelId: 'chat-model', permissionPolicy: 'read_only', start: { intent: 'voice_agent' } },
      { agentId: 'claude', modelId: 'commit-model', permissionPolicy: 'read_only', start: { intent: 'voice_agent' } },
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

  it('normalizes sendSessionMessage preambles when extracting voice tool actions from the assistant response text', async () => {
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
    expect(result.assistantText).toBe('I sent that to the coding assistant and am waiting for its update.');
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

  it('cancels an active turn stream before stopping', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const chatBackend = createCancelableBlockingBackend('chat');
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

    await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hi' });

    await expect(manager.stop({ voiceAgentId: started.voiceAgentId })).resolves.toEqual({ ok: true });
    expect(chatBackend.wasCancelled()).toBe(true);
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

  it('filters voice action blocks out of streamed deltas and normalizes sendSessionMessage preambles', async () => {
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
    expect(done.assistantText).toBe('I sent that to the coding assistant and am waiting for its update.');
    expect(done.actions?.[0]?.t).toBe('sendSessionMessage');
  });

  it('extracts inline canonical voice action blocks from streamed assistant text', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const chatBackend = createMultiDeltaBackend('chat', [
      'Calling the teleport action for that session now. <voice_actions> {"actions":[{"t":"ui.voice_agent.teleport","args":{"sessionId":"s1"}}]} </voice_actions>',
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

    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'teleport now' });
    const read = await manager.readTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      cursor: 0,
      maxEvents: 64,
    });

    const deltaText = read.events.filter((e) => e.t === 'delta').map((e) => (e as any).textDelta).join('');
    expect(deltaText).toContain('Calling the teleport action for that session now.');
    expect(deltaText).not.toContain('<voice_actions>');

    const done = read.events.find((e) => e.t === 'done') as any;
    expect(done.assistantText).toBe('Calling the teleport action for that session now.');
    expect(done.actions).toEqual([{ t: 'teleportVoiceAgentToSessionRoot', args: { sessionId: 's1' } }]);
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

  it('can defer initial context until the first user turn while still prewarming with READY', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const backend = createPromptCaptureBackend([
      { responseText: 'READY' },
      { responseText: 'ok' },
    ]);
    const manager = new VoiceAgentManager({ createBackend: () => backend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      bootstrapMode: 'ready_handshake',
      initialContextMode: 'first_turn',
    } as any);

    expect(backend.prompts[0]).toContain('Warm-up step: reply with exactly READY');
    expect(backend.prompts[0]).not.toContain('Initial context:');

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });

    expect(backend.prompts[1]).toContain('User: hello');
    expect(backend.prompts[1]).toContain('Initial context:\nCTX');
  });

  it('accepts a READY handshake reply with trailing punctuation or whitespace', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const backend = createPromptCaptureBackend([{ responseText: '  Ready.\n' }]);
    const manager = new VoiceAgentManager({ createBackend: () => backend });
    try {
      const started = await manager.start({
        agentId: 'claude',
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionPolicy: 'read_only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
        bootstrapMode: 'ready_handshake',
      });
      expect(started.voiceAgentId).toEqual(expect.any(String));
    } finally {
      await manager.dispose();
    }
  });

  it('bounds backend session start by the bootstrap budget and disposes the backend on timeout', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const dispose = vi.fn(async () => {});
    const backend: AgentBackend = {
      onMessage() {},
      startSession: () => new Promise<never>(() => {}),
      async sendPrompt() {},
      async cancel() {},
      dispose,
    };
    const manager = new VoiceAgentManager({ createBackend: () => backend });
    try {
      await expect(
        manager.start({
          agentId: 'claude',
          chatModelId: 'chat-model',
          commitModelId: 'commit-model',
          permissionPolicy: 'read_only',
          idleTtlSeconds: 60,
          initialContext: 'CTX',
          bootstrapMode: 'ready_handshake',
          bootstrapTimeoutMs: 25,
        }),
      ).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
      expect(dispose).toHaveBeenCalled();
    } finally {
      await manager.dispose();
    }
  });

  it('gives the READY handshake only the bootstrap budget left after session start', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    let nowMs = 1_000;
    const backend = createBootstrapTimeoutBackend();
    const startSession = backend.startSession.bind(backend);
    backend.startSession = async () => {
      nowMs += 10_000;
      return await startSession();
    };
    const manager = new VoiceAgentManager({ createBackend: () => backend, getNowMs: () => nowMs });
    try {
      await expect(
        manager.start({
          agentId: 'codex',
          chatModelId: 'chat-model',
          commitModelId: 'commit-model',
          permissionPolicy: 'read_only',
          idleTtlSeconds: 60,
          initialContext: 'CTX',
          bootstrapMode: 'ready_handshake',
          bootstrapTimeoutMs: 15_000,
        }),
      ).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
      expect(backend.seenTimeouts).toEqual([5_000]);
    } finally {
      await manager.dispose();
    }
  });

  it('rejects start at the bootstrap deadline when the READY prompt write never completes', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const dispose = vi.fn(async () => {});
    const backend: AgentBackend = {
      onMessage() {},
      async startSession() {
        return { sessionId: 's-stalled-prompt' as SessionId };
      },
      sendPrompt: () => new Promise<never>(() => {}),
      async waitForResponseComplete() {},
      async cancel() {},
      dispose,
    };
    const manager = new VoiceAgentManager({ createBackend: () => backend });
    try {
      await expect(
        manager.start({
          agentId: 'claude',
          chatModelId: 'chat-model',
          commitModelId: 'commit-model',
          permissionPolicy: 'read_only',
          idleTtlSeconds: 60,
          initialContext: 'CTX',
          bootstrapMode: 'ready_handshake',
          bootstrapTimeoutMs: 25,
        }),
      ).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
      expect(dispose).toHaveBeenCalled();
    } finally {
      await manager.dispose();
    }
  });

  it('rejects start at the bootstrap deadline when the READY response keeps extending its own wait', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const dispose = vi.fn(async () => {});
    const backend: AgentBackend = {
      onMessage() {},
      async startSession() {
        return { sessionId: 's-chatty' as SessionId };
      },
      async sendPrompt() {},
      // Models an ACP backend whose idle timer restarts on every streamed update.
      waitForResponseComplete: () => new Promise<void>(() => {}),
      async cancel() {},
      dispose,
    };
    const manager = new VoiceAgentManager({ createBackend: () => backend });
    try {
      await expect(
        manager.start({
          agentId: 'claude',
          chatModelId: 'chat-model',
          commitModelId: 'commit-model',
          permissionPolicy: 'read_only',
          idleTtlSeconds: 60,
          initialContext: 'CTX',
          bootstrapMode: 'ready_handshake',
          bootstrapTimeoutMs: 25,
        }),
      ).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
      expect(dispose).toHaveBeenCalled();
    } finally {
      await manager.dispose();
    }
  });

  it('uses the provided bootstrap timeout for READY handshakes', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const backend = createBootstrapTimeoutBackend();
    // A fixed clock keeps the whole bootstrap budget available to the handshake.
    const manager = new VoiceAgentManager({ createBackend: () => backend, getNowMs: () => 0 });

    await expect(
      manager.start({
        agentId: 'codex',
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionPolicy: 'read_only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
        bootstrapMode: 'ready_handshake',
        bootstrapTimeoutMs: 15_000,
      } as any),
    ).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED', message: 'bootstrap timeout 15000' });

    expect(backend.prompts).toHaveLength(1);
    expect(backend.seenTimeouts).toEqual([15_000]);
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

  it('uses disabledActionIds when building seeded voice prompts', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const backend = createPromptCaptureBackend([{ responseText: 'ok' }]);
    const createBackend: BackendFactory = () => backend;
    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      disabledActionIds: ['review.start'],
    } as any);

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });

    expect(backend.prompts[0]).not.toContain('startReview');
    expect(backend.prompts[0]).toContain('listAgentBackends');
  });

  it('resolves and forwards voice prompt stack blocks into the READY bootstrap prompt', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const backend = createPromptCaptureBackend([
      { responseText: 'READY' },
      { responseText: 'ok' },
    ]);
    const seenArgs: Array<{ profileId?: string | null; sessionId?: string | null; workingDirectory?: string | null }> = [];
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      resolveSystemAppendBlocks: async (args: ResolveVoiceSystemAppendBlocksArgs) => {
        seenArgs.push(args);
        return ['Voice stack block'];
      },
    } as any);

    const started = await manager.start({
      agentId: 'claude',
      profileId: 'work',
      contextSessionId: 'session-1',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      bootstrapMode: 'ready_handshake',
    } as any);

    expect(backend.prompts[0]).toContain('Voice stack block');
    expect(seenArgs).toEqual([{ profileId: 'work', sessionId: 'session-1' }]);
  });

  it('resolves and forwards voice prompt stack blocks into the first seeded turn when bootstrap is skipped', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const backend = createPromptCaptureBackend([{ responseText: 'ok' }]);
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      resolveSystemAppendBlocks: async () => ['Voice stack block'],
    } as any);

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    } as any);

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });

    expect(backend.prompts[0]).toContain('Voice stack block');
  });

  it('R3-2: forwards connectedServicesEnv to BOTH the chat and commit backend factories', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const seenEnvByModel: Record<string, Readonly<Record<string, string>> | null | undefined> = {};
    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDeterministicBackend('commit');
    const createBackend: BackendFactory = (opts) => {
      seenEnvByModel[opts.modelId] = opts.connectedServicesEnv;
      return opts.modelId === 'commit-model' ? commitBackend : chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      connectedServicesEnv: { CODEX_HOME: '/materialized/run/codex-home' },
    } as any);

    // Chat backend received the materialized CS env at start…
    expect(seenEnvByModel['chat-model']).toEqual({ CODEX_HOME: '/materialized/run/codex-home' });
    // …and the lazily-created commit backend gets the SAME env (not the runner's inherited account).
    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });
    expect(seenEnvByModel['commit-model']).toEqual({ CODEX_HOME: '/materialized/run/codex-home' });
  });

  it('R3-2: runs connectedServicesCleanup exactly once at voice-agent dispose (release), after backends dispose', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const disposeOrder: string[] = [];
    const chatBackend: AgentBackend = {
      onMessage: () => {},
      startSession: async () => ({ sessionId: 's-chat' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      dispose: async () => { disposeOrder.push('chat'); },
    };
    const connectedServicesCleanup = vi.fn(async () => { disposeOrder.push('cleanup'); });
    const createBackend: BackendFactory = () => chatBackend;

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      connectedServicesCleanup,
    } as any);

    await manager.stop({ voiceAgentId: started.voiceAgentId });

    // Cleanup ran exactly once, and only after the backend was disposed (root still needed until then).
    expect(connectedServicesCleanup).toHaveBeenCalledTimes(1);
    expect(disposeOrder).toEqual(['chat', 'cleanup']);

    // Manager dispose (or a reap after stop) must NOT re-run the run-scoped release.
    await manager.dispose();
    expect(connectedServicesCleanup).toHaveBeenCalledTimes(1);
  });

  it('R4-1: releases connectedServicesCleanup exactly once when start fails BEFORE the instance is created', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    let disposed = 0;
    const connectedServicesCleanup = vi.fn(async () => {});
    const chatBackend: AgentBackend = {
      onMessage: () => {},
      // Fails before the voice-agent instance is registered → the happy-path exactly-once owner
      // (instance.dispose) never runs, so the failure path must release the materialized run root.
      startSession: async () => { throw new Error('backend session boot failed'); },
      sendPrompt: async () => {},
      cancel: async () => {},
      dispose: async () => { disposed += 1; },
    };

    const manager = new VoiceAgentManager({ createBackend: () => chatBackend });
    await expect(manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      connectedServicesCleanup,
    } as any)).rejects.toThrow();

    // The materialized run root MUST be released on the pre-instance failure path (no leak).
    expect(connectedServicesCleanup).toHaveBeenCalledTimes(1);
    expect(disposed).toBe(1);

    // Manager dispose must not double-release.
    await manager.dispose();
    expect(connectedServicesCleanup).toHaveBeenCalledTimes(1);
  });

  it('R4-1: releases connectedServicesCleanup exactly once when the bootstrap handshake throws', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    let disposed = 0;
    const connectedServicesCleanup = vi.fn(async () => {});
    const chatBackend: AgentBackend = {
      onMessage: () => {},
      startSession: async () => ({ sessionId: 's-chat' as SessionId }),
      sendPrompt: async () => {},
      // Bootstrap reads chatBuffer (stays '', never 'READY') → start throws AFTER the instance is
      // registered. Cleanup must still fire exactly once.
      waitForResponseComplete: async () => {},
      cancel: async () => {},
      dispose: async () => { disposed += 1; },
    };

    const manager = new VoiceAgentManager({ createBackend: () => chatBackend });
    await expect(manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      bootstrapMode: 'ready_handshake',
      connectedServicesCleanup,
    } as any)).rejects.toThrow();

    expect(connectedServicesCleanup).toHaveBeenCalledTimes(1);
    expect(disposed).toBe(1);

    // The failed instance must not linger in the registry and re-release on manager dispose.
    await manager.dispose();
    expect(connectedServicesCleanup).toHaveBeenCalledTimes(1);
  });

  it('passes an explicit bounded timeout to non-bootstrap voice waits', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');

    const backend = createResponseTimeoutCaptureBackend('ok');
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      responseTimeoutMs: 45_000,
    });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionPolicy: 'read_only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await manager.welcome({ voiceAgentId: started.voiceAgentId, welcomeText: 'hi' });
    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });

    expect(backend.seenTimeouts).toEqual([45_000, 45_000, 45_000]);
  });
});
