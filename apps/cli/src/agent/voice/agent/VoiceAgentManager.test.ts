import { describe, expect, it, vi } from 'vitest';

import type { PermissionIntent } from '@happier-dev/agents';
import type { CatalogAgentId as AgentId } from '@/agent/catalog/ids';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import type { BackendFactory, ResolveVoiceSystemAppendBlocksArgs, VoiceAgentTurnStreamEvent } from './voiceAgentTypes';
import { VoiceAgentError, VoiceAgentManager } from './VoiceAgentManager';

type VoiceTestRuntime<T extends object = object> = ExecutionRunHostRuntime & T;

async function readVoiceAgentTurnStreamUntilDone(args: Readonly<{
  manager: {
    readTurnStream: (params: Readonly<{
      voiceAgentId: string;
      streamId: string;
      cursor: number;
      maxEvents?: number;
    }>) => Promise<{
      streamId: string;
      events: VoiceAgentTurnStreamEvent[];
      nextCursor: number;
      done: boolean;
    }>;
  };
  voiceAgentId: string;
  streamId: string;
  maxEvents?: number;
  maxReads?: number;
}>): Promise<VoiceAgentTurnStreamEvent[]> {
  const events: VoiceAgentTurnStreamEvent[] = [];
  let cursor = 0;

  for (let i = 0; i < (args.maxReads ?? 8); i += 1) {
    const read = await args.manager.readTurnStream({
      voiceAgentId: args.voiceAgentId,
      streamId: args.streamId,
      cursor,
      ...(typeof args.maxEvents === 'number' ? { maxEvents: args.maxEvents } : {}),
    });
    events.push(...read.events);
    cursor = read.nextCursor;
    if (read.done) {
      return events;
    }
    await Promise.resolve();
  }

  return events;
}

function createDeterministicBackend(label: string): VoiceTestRuntime<{ getSeenPrompts(): string[] }> {
  const seenPrompts: string[] = [];
  const sessionId = `s-${label}`;

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    sessionId,
    onProvisionSession() {
      runtime.emitMessage({ type: 'status', status: 'running' });
    },
    onSendPrompt(_sid, prompt) {
      seenPrompts.push(prompt);
      runtime.emitMessage({ type: 'model-output', fullText: `${label}:${prompt}` });
      runtime.emitMessage({ type: 'status', status: 'idle' });
    },
  });
  return Object.assign({}, runtime, {
    getSeenPrompts: () => [...seenPrompts],
  });
}

function createDeltaOnlyBackend(label: string): ExecutionRunHostRuntime {
  const sessionId = `s-${label}`;
  let n = 0;

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    sessionId,
    onProvisionSession() {
      runtime.emitMessage({ type: 'status', status: 'running' });
    },
    onSendPrompt() {
      n += 1;
      runtime.emitMessage({ type: 'model-output', textDelta: `${label}:${n}` });
      runtime.emitMessage({ type: 'status', status: 'idle' });
    },
  });
  return runtime;
}

function createBlockingBackend(label: string, opts: Readonly<{ waitForSendPrompt: () => Promise<void> }>): ExecutionRunHostRuntime {
  const sessionId = `s-${label}`;

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    sessionId,
    onProvisionSession() {
      runtime.emitMessage({ type: 'status', status: 'running' });
    },
    async onSendPrompt(_sid, prompt) {
      runtime.emitMessage({ type: 'model-output', textDelta: `${label}:${prompt}` });
      await opts.waitForSendPrompt();
      runtime.emitMessage({ type: 'status', status: 'idle' });
    },
  });
  return runtime;
}

function createMultiDeltaBackend(label: string, deltas: string[]): ExecutionRunHostRuntime {
  const sessionId = `s-${label}`;

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    sessionId,
    onProvisionSession() {
      runtime.emitMessage({ type: 'status', status: 'running' });
    },
    onSendPrompt() {
      for (const textDelta of deltas) {
        runtime.emitMessage({ type: 'model-output', textDelta });
      }
      runtime.emitMessage({ type: 'status', status: 'idle' });
    },
  });
  return runtime;
}

function createDelayedCompletionBackend(
  label: string,
): VoiceTestRuntime<{ completeCurrentResponse: () => void }> {
  const sessionId = `s-${label}`;
  let lastPrompt = '';
  let resolveCurrent: (() => void) | null = null;
  let currentResponseDone: Promise<void> | null = null;
  let pendingComplete = false;

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    sessionId,
    onProvisionSession() {
      runtime.emitMessage({ type: 'status', status: 'running' });
    },
    onSendPrompt(_sid, prompt) {
      lastPrompt = prompt;
      currentResponseDone = new Promise<void>((resolve) => {
        resolveCurrent = () => {
          runtime.emitMessage({ type: 'model-output', fullText: `${label}:${lastPrompt}` });
          runtime.emitMessage({ type: 'status', status: 'idle' });
          resolve();
        };
      });
      if (pendingComplete) {
        pendingComplete = false;
        resolveCurrent?.();
      }
    },
    async onWaitForTurnCompletion() {
      if (!currentResponseDone) return;
      await currentResponseDone;
      resolveCurrent = null;
      currentResponseDone = null;
    },
  });
  return Object.assign({}, runtime, {
    completeCurrentResponse() {
      pendingComplete = true;
      resolveCurrent?.();
    },
  });
}

function createCancelableBlockingBackend(
  label: string,
): VoiceTestRuntime<{ wasCancelled: () => boolean }> {
  const sessionId = `s-${label}`;
  let resolveCurrent: (() => void) | null = null;
  let cancelled = false;

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    sessionId,
    onProvisionSession() {
      runtime.emitMessage({ type: 'status', status: 'running' });
    },
    async onSendPrompt(_sid, prompt) {
      runtime.emitMessage({ type: 'model-output', textDelta: `${label}:${prompt}` });
      await new Promise<void>((resolve) => {
        resolveCurrent = resolve;
      });
      runtime.emitMessage({ type: 'status', status: 'idle' });
    },
    onCancel() {
      cancelled = true;
      resolveCurrent?.();
      resolveCurrent = null;
    },
  });
  return Object.assign({}, runtime, {
    wasCancelled: () => cancelled,
  });
}

function createLateResolvingCancellationBackend(
  responseText: string,
): VoiceTestRuntime<{ wasCancelled: () => boolean }> {
  let releasePrompt: (() => void) | null = null;
  let cancelled = false;

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    sessionId: 's-late-cancel',
    onProvisionSession() {
      runtime.emitMessage({ type: 'status', status: 'running' });
    },
    async onSendPrompt() {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    },
    onCancel() {
      cancelled = true;
      // Model output arriving as cancellation resolves is the race W0.6 must
      // make terminal: it must not become a delta, action, history, or commit input.
      runtime.emitMessage({ type: 'model-output', fullText: responseText });
      runtime.emitMessage({ type: 'status', status: 'idle' });
      releasePrompt?.();
      releasePrompt = null;
    },
  });

  return Object.assign({}, runtime, {
    wasCancelled: () => cancelled,
  });
}

function createPostDetachOutputBackend(cancelledText: string): ExecutionRunHostRuntime {
  let releasePrompt: (() => void) | null = null;
  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    sessionId: 's-post-detach-cancel',
    async onSendPrompt(_sessionId, prompt) {
      if (prompt.includes('cancel this turn')) {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
        runtime.emitMessage({ type: 'status', status: 'idle' });
        return;
      }
      runtime.emitMessage({ type: 'model-output', fullText: cancelledText });
    },
    onCancel() {
      releasePrompt?.();
      releasePrompt = null;
    },
  });
  return runtime;
}

function createStaticResponseBackend(label: string, responseText: string): ExecutionRunHostRuntime {
  const sessionId = `s-${label}`;

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    sessionId,
    onProvisionSession() {
      runtime.emitMessage({ type: 'status', status: 'running' });
    },
    onSendPrompt() {
      runtime.emitMessage({ type: 'model-output', fullText: responseText });
      runtime.emitMessage({ type: 'status', status: 'idle' });
    },
  });
  return runtime;
}

function createPromptCaptureBackend(sequence: Array<{ responseText: string }>): VoiceTestRuntime<{ prompts: string[] }> {
  const sessionId = 's-capture';
  const prompts: string[] = [];
  let idx = 0;

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    sessionId,
    onProvisionSession() {
      runtime.emitMessage({ type: 'status', status: 'running' });
    },
    onSendPrompt(_sid, prompt) {
      prompts.push(prompt);
      const next = sequence[Math.min(idx, sequence.length - 1)];
      idx += 1;
      runtime.emitMessage({ type: 'model-output', fullText: next?.responseText ?? '' });
      runtime.emitMessage({ type: 'status', status: 'idle' });
    },
  });
  return Object.assign({}, runtime, { prompts });
}

function createBootstrapTimeoutBackend(): VoiceTestRuntime<{ prompts: string[]; seenTimeouts: number[] }> {
  const sessionId = 's-bootstrap-timeout';
  const prompts: string[] = [];
  const seenTimeouts: number[] = [];

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    sessionId,
    onProvisionSession() {
      runtime.emitMessage({ type: 'status', status: 'running' });
    },
    onSendPrompt(_sid, prompt) {
      prompts.push(prompt);
    },
    onWaitForTurnCompletion(timeoutMs) {
      seenTimeouts.push(timeoutMs ?? -1);
      throw new Error(`bootstrap timeout ${String(timeoutMs ?? 'default')}`);
    },
  });
  return Object.assign({}, runtime, { prompts, seenTimeouts });
}

function createResponseTimeoutCaptureBackend(responseText = 'ok'): VoiceTestRuntime<{ seenTimeouts: number[] }> {
  const sessionId = 's-response-timeout-capture';
  const seenTimeouts: number[] = [];

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    sessionId,
    onProvisionSession() {
      runtime.emitMessage({ type: 'status', status: 'running' });
    },
    onSendPrompt() {
      runtime.emitMessage({ type: 'model-output', fullText: responseText });
      runtime.emitMessage({ type: 'status', status: 'idle' });
    },
    onWaitForTurnCompletion(timeoutMs) {
      seenTimeouts.push(typeof timeoutMs === 'number' ? timeoutMs : -1);
    },
  });
  return Object.assign({}, runtime, { seenTimeouts });
}

describe('VoiceAgentManager', () => {
  it('clears the reaper interval when disposed', async () => {

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

    const createBackend = vi.fn(() => createDeterministicBackend('backend'));
    const manager = new VoiceAgentManager({ createBackend });

    await manager.dispose();

    await expect(
      manager.start({
        agentId: 'claude',
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionIntent: 'read-only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      }),
    ).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });

    expect(createBackend).toHaveBeenCalledTimes(0);
  }, 15_000);

  it('surfaces commit backend factory errors without disposing the chat backend', async () => {

    const chatDispose = vi.fn(async () => {});
    const chatBackend = createTestExecutionRunHostRuntime({
      sessionId: 's-chat',
      onDispose: chatDispose,
    });

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
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await expect(manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 })).rejects.toMatchObject({
      code: 'VOICE_AGENT_START_FAILED',
    });

    expect(chatDispose).toHaveBeenCalledTimes(0);
  });

  it('forwards the connected-services selection to the backend factory (R3-2 fail-closed: no silent native)', async () => {

    const capturedOpts: Array<{ connectedServices?: unknown }> = [];
    const createBackend: BackendFactory = (opts) => {
      capturedOpts.push(opts);
      return createDeterministicBackend('backend');
    };
    const manager = new VoiceAgentManager({ createBackend });

    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
      },
    };

    await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      connectedServices,
    });

    expect(capturedOpts[0]).toMatchObject({ connectedServices });
  });

  it('passes through VoiceAgentError codes thrown by the backend factory', async () => {

    const createBackend: BackendFactory = () => {
      throw new VoiceAgentError('VOICE_AGENT_UNSUPPORTED', 'voice agent not supported');
    };

    const manager = new VoiceAgentManager({ createBackend });

    await expect(
      manager.start({
        agentId: 'claude',
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionIntent: 'read-only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      }),
    ).rejects.toMatchObject({ code: 'VOICE_AGENT_UNSUPPORTED' });
  });

  it('removes the voice-agent registry entry when READY bootstrap fails', async () => {

    const dispose = vi.fn(async () => {});
    const backend = createTestExecutionRunHostRuntime({
      sessionId: 's-bootstrap-fail',
      onDispose: dispose,
      onProvisionSession() {
        backend.emitMessage({ type: 'status', status: 'running' });
      },
      onSendPrompt() {
        backend.emitMessage({ type: 'model-output', fullText: 'NOT_READY' });
        backend.emitMessage({ type: 'status', status: 'idle' });
      },
    });
    const manager = new VoiceAgentManager({ createBackend: () => backend });

    await expect(manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      bootstrapMode: 'ready_handshake',
      voiceAgentId: 'voice-agent-bootstrap-fail',
    })).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.getResumeHandle('voice-agent-bootstrap-fail')).toBeNull();
  });

  it('passes agentId, model ids, permission policy, and voice_agent start intent to the backend factory', async () => {

    const seen: Array<{
      agentId: AgentId;
      modelId: string;
      permissionIntent: PermissionIntent;
      start?: { intent: 'voice_agent' };
    }> = [];
    const backend = createDeterministicBackend('chat');
    const createBackend: BackendFactory = (opts) => {
      seen.push({
        agentId: opts.agentId,
        modelId: opts.modelId,
        permissionIntent: opts.permissionIntent,
        start: opts.start,
      });
      return backend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    expect(seen).toEqual([{
      agentId: 'claude',
      modelId: 'chat-model',
      permissionIntent: 'read-only',
      start: { intent: 'voice_agent' },
    }]);

    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });

    expect(seen).toEqual([
      { agentId: 'claude', modelId: 'chat-model', permissionIntent: 'read-only', start: { intent: 'voice_agent' } },
      { agentId: 'claude', modelId: 'commit-model', permissionIntent: 'read-only', start: { intent: 'voice_agent' } },
    ]);
  });

  it('uses a more detailed prompt when verbosity is balanced', async () => {

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
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      verbosity: 'balanced',
    });

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
    const [prompt] = chatBackend.getSeenPrompts();
    expect(prompt).toMatch(/be concise but include enough detail to be helpful/i);
  });

  it('keeps multi-turn history and uses the commit backend separately', async () => {

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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const result = await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
    expect(result.assistantText).toBe('I sent that to the coding assistant and am waiting for its update.');
    expect((result as any).actions?.[0]?.t).toBe('sendSessionMessage');
  });

  it('clears delta-only output buffers between operations', async () => {

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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
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

    const chatBackend = createCancelableBlockingBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend = vi.fn<BackendFactory>(({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    });

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hi' });

    await expect(manager.stop({ voiceAgentId: started.voiceAgentId })).resolves.toEqual({ ok: true });
    expect(chatBackend.wasCancelled()).toBe(true);
    expect(createBackend).toHaveBeenCalledTimes(1);
  });

  it('treats late backend completion after cancellation as terminal without done, deltas, actions, or history', async () => {

    const cancelledUserText = 'do not commit this cancelled request';
    const cancelledAssistantText =
      'late text <voice_actions>{"actions":[{"t":"sendSessionMessage","args":{"message":"must not run"}}]}</voice_actions>';
    const chatBackend = createLateResolvingCancellationBackend(cancelledAssistantText);
    const replacementBackend = createStaticResponseBackend('replacement-after-cancel', 'clean');
    const commitBackend = createDeterministicBackend('commit');
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(chatBackend)
      .mockReturnValueOnce(replacementBackend)
      .mockReturnValueOnce(commitBackend);

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId,
      userText: cancelledUserText,
    });

    const cancelPromise = manager.cancelTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
    });
    const cancelledRead = await manager.readTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      cursor: 0,
    });
    await cancelPromise;

    expect(chatBackend.wasCancelled()).toBe(true);
    expect(cancelledRead.done).toBe(true);
    expect(cancelledRead.events).toEqual([{
      t: 'voice_output',
      output: { v: 1, kind: 'turn_cancelled', turnId: stream.streamId, seq: 0 },
    }]);
    expect(cancelledRead.events.some((event) => event.t === 'voice_output' && event.output.kind === 'turn_final')).toBe(false);
    expect(cancelledRead.events.some((event) => event.t === 'voice_output' && event.output.kind === 'speech_segment')).toBe(false);

    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });
    const commitPrompt = commitBackend.getSeenPrompts().at(-1) ?? '';
    expect(commitPrompt).not.toContain(cancelledUserText);
    expect(commitPrompt).not.toContain(cancelledAssistantText);
    expect(commitPrompt).not.toContain('must not run');
  });

  it('ignores provider output emitted after a cancelled stream has detached', async () => {
    const cancelledText = 'POST DETACH CANCELLED OUTPUT';
    const cancelledBackend = createPostDetachOutputBackend(cancelledText);
    const replacementBackend = createStaticResponseBackend('replacement', 'clean next response');
    const createBackend = vi.fn()
      .mockReturnValueOnce(cancelledBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId,
      userText: 'cancel this turn',
    });

    await manager.cancelTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
    const next = await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'next turn' });

    expect(createBackend).toHaveBeenCalledTimes(2);
    expect(next.assistantText).toBe('clean next response');
    expect(next.assistantText).not.toContain(cancelledText);
    const commit = await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });
    expect(commit.commitText).not.toContain(cancelledText);
  });

  it('retires the complete voice agent cleanly when cancelled-backend replacement creation fails', async () => {
    let chatDisposeCount = 0;
    const chatBase = createCancelableBlockingBackend('chat');
    const chatBackend = Object.assign({}, chatBase, {
      async dispose() {
        chatDisposeCount += 1;
        await chatBase.dispose();
      },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(chatBackend)
      .mockImplementationOnce(() => { throw new Error('replacement factory failed'); });
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });

    await expect(manager.cancelTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
    })).resolves.toEqual({ ok: true });
    await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'next' })).rejects.toMatchObject({
      code: 'VOICE_AGENT_NOT_FOUND',
    });
    expect(chatDisposeCount).toBe(1);
  });

  it('makes backend replacement exclusive and never resumes the cancelled provider session', async () => {
    const replacementDeferred: { resolve: () => void } = { resolve: () => {} };
    const replacementBarrier = new Promise<void>((resolve) => { replacementDeferred.resolve = resolve; });
    const provisionArgs: unknown[] = [];
    const cancelledBackend = createCancelableBlockingBackend('chat');
    const replacementBackend = createTestExecutionRunHostRuntime({
      sessionId: 's-replacement',
      async onProvisionSession(opts) {
        provisionArgs.push(opts);
        await replacementBarrier;
      },
      onSendPrompt() {
        replacementBackend.emitMessage({ type: 'model-output', fullText: 'replacement reply' });
        replacementBackend.emitMessage({ type: 'status', status: 'idle' });
      },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(cancelledBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });
    const cancelling = manager.cancelTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
    await Promise.resolve();
    await Promise.resolve();

    await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'too early' })).rejects.toMatchObject({
      code: 'VOICE_AGENT_BUSY',
    });
    await expect(manager.commit({ voiceAgentId: started.voiceAgentId })).rejects.toMatchObject({
      code: 'VOICE_AGENT_BUSY',
    });
    const secondCancellation = manager.cancelTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
    });
    replacementDeferred.resolve();
    await expect(Promise.all([cancelling, secondCancellation])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(provisionArgs).toEqual([undefined]);
    await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'next' })).resolves.toMatchObject({
      assistantText: 'replacement reply',
    });
  });

  it('disposes chat, isolated commit, and failed replacement backends exactly once when replacement provisioning fails', async () => {
    const disposed = { chat: 0, commit: 0, replacement: 0 };
    const chatBase = createCancelableBlockingBackend('chat');
    const chatBackend = Object.assign({}, chatBase, {
      async dispose() {
        disposed.chat += 1;
        await chatBase.dispose();
      },
    });
    const commitBase = createDeterministicBackend('commit');
    const commitBackend = Object.assign({}, commitBase, {
      async dispose() {
        disposed.commit += 1;
        await commitBase.dispose();
      },
    });
    const replacementBackend = createTestExecutionRunHostRuntime({
      sessionId: 's-failed-replacement',
      onProvisionSession() { throw new Error('replacement provision failed'); },
      onDispose() { disposed.replacement += 1; },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(chatBackend)
      .mockReturnValueOnce(commitBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      commitIsolation: true,
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    await manager.commit({ voiceAgentId: started.voiceAgentId });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });

    await expect(manager.cancelTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
    })).resolves.toEqual({ ok: true });
    expect(disposed).toEqual({ chat: 1, commit: 1, replacement: 1 });
    await manager.dispose();
    expect(disposed).toEqual({ chat: 1, commit: 1, replacement: 1 });
  });

  it('retires both generations exactly once when replacement subscription construction throws', async () => {
    const disposed = { old: 0, replacement: 0 };
    const oldBase = createCancelableBlockingBackend('old-subscribe-throw');
    const oldBackend = Object.assign({}, oldBase, {
      async dispose() {
        disposed.old += 1;
        await oldBase.dispose();
      },
    });
    const replacementBase = createTestExecutionRunHostRuntime({
      sessionId: 's-replacement-subscribe-throw',
      onDispose() { disposed.replacement += 1; },
    });
    const replacementBackend = Object.assign({}, replacementBase, {
      subscribeMessages() {
        throw new Error('replacement subscribe failed');
      },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(oldBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });

    await expect(manager.cancelTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
    })).resolves.toEqual({ ok: true });
    await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'next' })).rejects.toMatchObject({
      code: 'VOICE_AGENT_NOT_FOUND',
    });
    expect(disposed).toEqual({ old: 1, replacement: 1 });
    await manager.dispose();
    expect(disposed).toEqual({ old: 1, replacement: 1 });
  });

  it('contains a throwing old subscription disposer and still installs and retires the replacement once', async () => {
    const disposed = { old: 0, replacement: 0 };
    const oldBase = createCancelableBlockingBackend('old-unsubscribe-throw');
    const oldBackend = Object.assign({}, oldBase, {
      subscribeMessages(handler: Parameters<ExecutionRunHostRuntime['subscribeMessages']>[0]) {
        const unsubscribe = oldBase.subscribeMessages(handler);
        return () => {
          unsubscribe();
          throw new Error('old unsubscribe failed');
        };
      },
      async dispose() {
        disposed.old += 1;
        await oldBase.dispose();
      },
    });
    let replacementBackend: ReturnType<typeof createTestExecutionRunHostRuntime>;
    replacementBackend = createTestExecutionRunHostRuntime({
      sessionId: 's-replacement-after-unsubscribe-throw',
      onSendPrompt() {
        replacementBackend.emitMessage({ type: 'model-output', fullText: 'replacement survived' });
        replacementBackend.emitMessage({ type: 'status', status: 'idle' });
      },
      onDispose() { disposed.replacement += 1; },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(oldBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });

    await expect(manager.cancelTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
    })).resolves.toEqual({ ok: true });
    await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'next' })).resolves.toMatchObject({
      assistantText: 'replacement survived',
    });
    expect(disposed).toEqual({ old: 1, replacement: 0 });
    await manager.dispose();
    expect(disposed).toEqual({ old: 1, replacement: 1 });
  });

  it('contains a throwing replacement subscription disposer during stop', async () => {
    const disposed = { old: 0, replacement: 0 };
    const oldBase = createCancelableBlockingBackend('old-replacement-unsubscribe-throw');
    const oldBackend = Object.assign({}, oldBase, {
      async dispose() {
        disposed.old += 1;
        await oldBase.dispose();
      },
    });
    const replacementBase = createTestExecutionRunHostRuntime({
      sessionId: 's-replacement-unsubscribe-throw',
      onDispose() { disposed.replacement += 1; },
    });
    const replacementBackend = Object.assign({}, replacementBase, {
      subscribeMessages(handler: Parameters<ExecutionRunHostRuntime['subscribeMessages']>[0]) {
        const unsubscribe = replacementBase.subscribeMessages(handler);
        return () => {
          unsubscribe();
          throw new Error('replacement unsubscribe failed');
        };
      },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(oldBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });
    await manager.cancelTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId });

    await expect(manager.stop({ voiceAgentId: started.voiceAgentId })).resolves.toEqual({ ok: true });
    expect(disposed).toEqual({ old: 1, replacement: 1 });
    await manager.dispose();
    expect(disposed).toEqual({ old: 1, replacement: 1 });
  });

  it('lets stop own teardown during an in-progress replacement without double-disposing either generation', async () => {
    const replacementDeferred: { resolve: () => void } = { resolve: () => {} };
    const replacementBarrier = new Promise<void>((resolve) => { replacementDeferred.resolve = resolve; });
    const disposed = { old: 0, replacement: 0 };
    const oldBase = createCancelableBlockingBackend('old');
    const oldBackend = Object.assign({}, oldBase, {
      async dispose() {
        disposed.old += 1;
        await oldBase.dispose();
      },
    });
    const replacementBackend = createTestExecutionRunHostRuntime({
      sessionId: 's-stop-replacement',
      async onProvisionSession() { await replacementBarrier; },
      onDispose() { disposed.replacement += 1; },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(oldBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });
    const cancelling = manager.cancelTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
    await Promise.resolve();
    await Promise.resolve();
    const stopping = manager.stop({ voiceAgentId: started.voiceAgentId });

    replacementDeferred.resolve();
    await expect(Promise.all([cancelling, stopping])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(disposed).toEqual({ old: 1, replacement: 1 });
    await manager.dispose();
    expect(disposed).toEqual({ old: 1, replacement: 1 });
  });

  it('does not suppress same-backend commit output while a naturally completed stream awaits its final read', async () => {

    const backend = createDeltaOnlyBackend('chat');
    const manager = new VoiceAgentManager({ createBackend: () => backend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      commitIsolation: false,
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const stream = await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId,
      userText: 'first turn',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const partialRead = await manager.readTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      cursor: 0,
      maxEvents: 1,
    });
    expect(partialRead.done).toBe(false);
    expect(partialRead.events).toEqual([{
      t: 'voice_output',
      output: {
        v: 1,
        kind: 'speech_segment',
        turnId: stream.streamId,
        seq: 0,
        segmentId: `${stream.streamId}:segment:0`,
        text: 'chat:1',
      },
    }]);

    const committed = await manager.commit({ voiceAgentId: started.voiceAgentId });
    expect(committed.commitText).toBe('chat:2');
  });

  it('lets stop retire a naturally completed unread stream without reclassifying it as a cancellation', async () => {
    let disposed = 0;
    let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
    runtime = createTestExecutionRunHostRuntime({
      sessionId: 'completed-unread-stop',
      onSendPrompt() {
        runtime.emitMessage({ type: 'model-output', fullText: 'completed response' });
        runtime.emitMessage({ type: 'status', status: 'idle' });
      },
      onDispose() {
        disposed += 1;
      },
    });
    const manager = new VoiceAgentManager({ createRuntime: () => runtime });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId,
      userText: 'completed before stop',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await expect(manager.stop({ voiceAgentId: started.voiceAgentId })).resolves.toEqual({ ok: true });
    expect(disposed).toBe(1);
    await manager.dispose();
    expect(disposed).toBe(1);
  });

  it('removes voice agents from the registry before awaiting in-flight stop, preventing new operations from starting', async () => {

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
      permissionIntent: 'read-only',
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

    let nowMs = 0;
    let disposedCount = 0;
    const createBackend: BackendFactory = ({ modelId }) => createTestExecutionRunHostRuntime({
      sessionId: `s-${modelId}`,
      onDispose() {
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
        permissionIntent: 'read-only',
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

    let nowMs = 0;
    let disposedCount = 0;
    const createBackend: BackendFactory = ({ modelId }) => createTestExecutionRunHostRuntime({
      sessionId: `s-${modelId}`,
      onDispose() {
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
        permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    const events = await readVoiceAgentTurnStreamUntilDone({
      manager,
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      maxEvents: 32,
    });
    expect(events.some((event) => event.t === 'voice_output' && event.output?.kind === 'speech_segment')).toBe(true);
    expect(events.some((event) => event.t === 'voice_output' && event.output?.kind === 'turn_final')).toBe(true);

    await expect(
      manager.readTurnStream({
        voiceAgentId: started.voiceAgentId,
        streamId: stream.streamId,
        cursor: events.length,
      }),
    ).rejects.toMatchObject({ code: 'VOICE_AGENT_NOT_FOUND' });
  });

  it('rejects a cursor beyond produced events without evicting the stream or skipping its final event', async () => {
    const chatBackend = createDeltaOnlyBackend('cursor-ahead');
    const manager = new VoiceAgentManager({ createBackend: () => chatBackend });
    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await expect(manager.readTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      cursor: 999,
    })).rejects.toMatchObject({ code: 'VOICE_AGENT_INVALID_CURSOR' });

    const events = await readVoiceAgentTurnStreamUntilDone({
      manager,
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      maxEvents: 1,
    });
    expect(events.some((event) => event.t === 'voice_output' && event.output.kind === 'turn_final')).toBe(true);
  });

  it('filters voice action blocks out of streamed deltas and normalizes sendSessionMessage preambles', async () => {

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
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    const events = await readVoiceAgentTurnStreamUntilDone({
      manager,
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      maxEvents: 64,
    });

    const deltaText = events
      .filter((e) => e.t === 'voice_output' && (e as any).output?.kind === 'speech_segment')
      .map((e) => (e as any).output.text)
      .join('');
    expect(deltaText).toContain('Hello.');
    expect(deltaText).not.toContain('<voice_actions>');

    const final = events.find((e) => e.t === 'voice_output' && (e as any).output?.kind === 'turn_final') as any;
    const effect = events.find((e) => e.t === 'voice_output' && (e as any).output?.kind === 'side_effect') as any;
    expect(final.output.text).toBe('I sent that to the coding assistant and am waiting for its update.');
    expect(effect.output.action.t).toBe('sendSessionMessage');
  });

  it('extracts inline canonical voice action blocks from streamed assistant text', async () => {

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
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'teleport now' });
    const events = await readVoiceAgentTurnStreamUntilDone({
      manager,
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      maxEvents: 64,
    });

    const deltaText = events
      .filter((e) => e.t === 'voice_output' && (e as any).output?.kind === 'speech_segment')
      .map((e) => (e as any).output.text)
      .join('');
    expect(deltaText).toContain('Calling the teleport action for that session now.');
    expect(deltaText).not.toContain('<voice_actions>');

    const final = events.find((e) => e.t === 'voice_output' && (e as any).output?.kind === 'turn_final') as any;
    const effect = events.find((e) => e.t === 'voice_output' && (e as any).output?.kind === 'side_effect') as any;
    expect(final.output.text).toBe('Calling the teleport action for that session now.');
    expect(effect.output.action).toEqual({ t: 'teleportVoiceAgentToSessionRoot', args: { sessionId: 's1' } });
  });

  it('rejects a second stream start while a stream turn is still in-flight', async () => {

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
      permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
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

    const backend = createPromptCaptureBackend([
      { responseText: 'READY' },
      { responseText: 'ok' },
    ]);
    const manager = new VoiceAgentManager({ createBackend: () => backend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
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

  it('uses the provided bootstrap timeout for READY handshakes', async () => {

    const backend = createBootstrapTimeoutBackend();
    const manager = new VoiceAgentManager({ createBackend: () => backend });

    await expect(
      manager.start({
        agentId: 'codex',
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionIntent: 'read-only',
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
      permissionIntent: 'read-only',
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

    const backend = createPromptCaptureBackend([
      { responseText: 'reply' },
      { responseText: 'COMMIT_TEXT' },
    ]);
    const createBackendSpy = vi.fn(() => backend);
    const createBackend: BackendFactory = () => createBackendSpy();
    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      commitIsolation: false,
    } as any);

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    const committed = await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 1000 });

    expect(committed.commitText).toBe('COMMIT_TEXT');
    expect(createBackendSpy).toHaveBeenCalledTimes(1);
    expect(backend.prompts.length).toBe(2);
    expect(backend.prompts[1]).toContain('Instruction:');
  });

  it('uses disabledActionIds when building seeded voice prompts', async () => {

    const backend = createPromptCaptureBackend([{ responseText: 'ok' }]);
    const createBackend: BackendFactory = () => backend;
    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      disabledActionIds: ['review.start'],
    } as any);

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });

    expect(backend.prompts[0]).not.toContain('startReview');
    expect(backend.prompts[0]).toContain('listAgentBackends');
  });

  it('resolves and forwards voice prompt stack blocks into the READY bootstrap prompt', async () => {

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
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      bootstrapMode: 'ready_handshake',
    } as any);

    expect(backend.prompts[0]).toContain('Voice stack block');
    expect(seenArgs).toEqual([{ profileId: 'work', sessionId: 'session-1' }]);
  });

  it('resolves and forwards voice prompt stack blocks into the first seeded turn when bootstrap is skipped', async () => {

    const backend = createPromptCaptureBackend([{ responseText: 'ok' }]);
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      resolveSystemAppendBlocks: async () => ['Voice stack block'],
    } as any);

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    } as any);

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });

    expect(backend.prompts[0]).toContain('Voice stack block');
  });

  it('passes an explicit bounded timeout to non-bootstrap voice waits', async () => {

    const backend = createResponseTimeoutCaptureBackend('ok');
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      responseTimeoutMs: 45_000,
    });

    const started = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await manager.welcome({ voiceAgentId: started.voiceAgentId, welcomeText: 'hi' });
    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });

    expect(backend.seenTimeouts).toEqual([45_000, 45_000, 45_000]);
  });
});
