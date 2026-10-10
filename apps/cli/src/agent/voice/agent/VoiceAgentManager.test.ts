import { describe, expect, it, vi } from 'vitest';

import { ProviderBoundModelRefSchema, buildBackendTargetKeyV2, createVoiceAgentOutputTurnV1, ingestVoiceAgentOutputEventV1, VOICE_OUTPUT_INCOMPLETE_TEXT } from '@happier-dev/protocol';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import type { BackendFactory, ResolveVoicePromptPreparationArgs, VoiceAgentTurnStreamEvent } from './voiceAgentTypes';
import { VoiceAgentError, VoiceAgentManager } from './VoiceAgentManager';
import { createVoiceSessionRuntimeThroughNativeFactory } from '@/agent/runtime/bridges/executionRun/testkit/nativeSessionContext';
import type { AgentRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { resolveCliVoicePromptStackBlocks, resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { ArtifactEncryptionMaterialUnavailableError } from '@/api/artifacts/accountArtifactStore';
import { buildMemoryRecallGuidanceBlockV1 } from '@happier-dev/protocol/prompts/memoryRecallGuidanceV1';
import { applyExecutionRunAction } from '@/agent/runtime/bridges/executionRun/executionRunApplyAction';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { readSettings, updateSettings, writeSettings } from '@/persistence';
import { DEFAULT_MEMORY_SETTINGS } from '@/settings/memorySettings';

// One runtime, one lifetime: the signal must stay stable across calls so
// subscribers do not accumulate against a fresh controller each read.
const TEST_RUNTIME_LIFETIME_SIGNAL = new AbortController().signal;

type VoiceTestRuntime<T extends object = object> = ExecutionRunHostRuntime & T;

function createInstructionBlocksResolver(readMarkdown: () => Promise<string>) {
  return async (args: ResolveVoicePromptPreparationArgs) => ({ systemAppendBlocks: await resolveCliVoicePromptStackBlocks({
    ...args,
    sessionMetadata: { work: { promptStack: [{ id: 'instruction', ref: { kind: 'doc', artifactId: 'instruction' },
      enabled: true, placement: 'system_append', required: true }] } },
    readArtifact: async ({ artifactId }) => ({
      id: artifactId,
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' },
      revision: { headerVersion: 1, bodyVersion: 1 },
      body: JSON.stringify({ v: 1, markdown: await readMarkdown(), createdAtMs: 1, updatedAtMs: 2 }),
    }),
    readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' } }),
  }), memoryRecallGuidanceEnabled: false, disabledActionIds: [] });
}

async function readVoiceAgentTurnStreamUntilDone(args: Readonly<{
  manager: {
    readTurnStream: (params: Readonly<{
      voiceAgentId: string;
      streamId: string;
      cursor: number;
      maxEvents?: number;
      waitForEvents?: boolean;
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
      waitForEvents: true,
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
    runtimeId: sessionId,
    providerSessionId: sessionId,
    resumeSupported: true,
    onProvisionRuntime() {
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
    runtimeId: sessionId,
    onProvisionRuntime() {
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
    runtimeId: sessionId,
    onProvisionRuntime() {
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
    runtimeId: sessionId,
    onProvisionRuntime() {
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
): VoiceTestRuntime<{ completeCurrentResponse: () => void; appendDelta: (text: string) => void; hasCurrentResponse: () => boolean }> {
  const sessionId = `s-${label}`;
  let lastPrompt = '';
  let resolveCurrent: (() => void) | null = null;
  let currentResponseDone: Promise<void> | null = null;
  let pendingComplete = false;

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    runtimeId: sessionId,
    onProvisionRuntime() {
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
    hasCurrentResponse: () => currentResponseDone !== null,
    appendDelta(text: string) {
      runtime.emitMessage({ type: 'model-output', textDelta: text });
    },
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
    runtimeId: sessionId,
    onProvisionRuntime() {
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
    runtimeId: 's-late-cancel',
    onProvisionRuntime() {
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
    runtimeId: 's-post-detach-cancel',
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
    runtimeId: sessionId,
    onProvisionRuntime() {
      runtime.emitMessage({ type: 'status', status: 'running' });
    },
    onSendPrompt() {
      runtime.emitMessage({ type: 'model-output', fullText: responseText });
      runtime.emitMessage({ type: 'status', status: 'idle' });
    },
  });
  return runtime;
}

function createPromptCaptureBackend(
  sequence: Array<{ responseText: string }>,
  options?: Readonly<{ resumeSupported?: boolean }>,
): VoiceTestRuntime<{ prompts: string[] }> {
  const sessionId = 's-capture';
  const prompts: string[] = [];
  let idx = 0;

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    runtimeId: sessionId,
    ...(options?.resumeSupported === true ? { resumeSupported: true } : {}),
    onProvisionRuntime() {
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
    runtimeId: sessionId,
    onProvisionRuntime() {
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
    runtimeId: sessionId,
    onProvisionRuntime() {
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
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, chatModelId: 'chat-model', commitModelId: 'chat-model',
        commitIsolation: operation === 'isolated commit',
        permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
      });
      activity.length = 0;
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, chatModelId: 'chat-model', commitModelId: 'chat-model',
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    activity.length = 0;
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, chatModelId: 'chat-model', commitModelId: 'chat-model',
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    activity.length = 0;
    try {
      const { streamId } = await manager.startTurnStream({ voiceAgentId, userText: 'hello' });
      const cancel = manager.cancelTurnStream({ voiceAgentId, streamId });
      expect(activity.at(-1)).toBe(true);
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(true);
      backend.completeCurrentResponse();
      await cancel;
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
      expect(activity.at(-1)).toBe(false);
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, chatModelId: 'chat-model', commitModelId: 'chat-model',
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    activity.length = 0;
    const work = manager.sendTurn({ voiceAgentId, userText: 'hello' });
    await vi.waitFor(() => expect(backend.hasCurrentResponse()).toBe(true));
    try {
      const removal = operation === 'stop' ? manager.stop({ voiceAgentId }) : manager.dispose();
      expect(activity.at(-1)).toBe(false);
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
      backend.completeCurrentResponse();
      await work;
      await removal;
      expect(activity.at(-1)).toBe(false);
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
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, chatModelId: 'chat-model', commitModelId: 'chat-model',
          permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
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

  it('holds an empty stream read until the owner appends events and aborts observation independently', async () => {
    const backend = createDelayedCompletionBackend('push-read');
    const manager = new VoiceAgentManager({ createBackend: () => backend });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model', commitModelId: 'commit-model',
        permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
      });
      const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
      const controller = new AbortController();
      const request = { voiceAgentId: started.voiceAgentId, streamId: stream.streamId, cursor: 0, waitForEvents: true, signal: controller.signal };
      let settled = false;
      const abortedRead = manager.readTurnStream(request);
      const pushedRead = manager.readTurnStream({ ...request, signal: new AbortController().signal });
      void abortedRead.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      controller.abort(new Error('observation cancelled'));
      await expect(abortedRead).rejects.toThrow('observation cancelled');
      backend.appendDelta('Streaming words. '.repeat(40));
      const page = await pushedRead;
      expect(page.events).toEqual(expect.arrayContaining([expect.objectContaining({
        t: 'voice_output', output: expect.objectContaining({ kind: 'speech_segment' }),
      })]));
      expect(page.done).toBe(false);
      expect(page.nextCursor).toBe(page.events.length);
      expect(page.streamId).toBe(stream.streamId);
      const terminal = manager.readTurnStream({ ...request, cursor: page.nextCursor, signal: new AbortController().signal });
      backend.completeCurrentResponse();
      let finalPage = await terminal;
      const remainingEvents = [...finalPage.events];
      while (!finalPage.done) {
        finalPage = await manager.readTurnStream({
          ...request, cursor: finalPage.nextCursor, signal: new AbortController().signal,
        });
        remainingEvents.push(...finalPage.events);
      }
      expect(finalPage.streamId).toBe(stream.streamId);
      expect(remainingEvents).toEqual(expect.arrayContaining([expect.objectContaining({
        t: 'voice_output', output: expect.objectContaining({ kind: 'turn_final' }),
      })]));
    } finally {
      await manager.dispose();
    }
  });
  it.each(['stop', 'dispose'] as const)('settles a held stream read on %s while a completed turn handoff is still pending', async (retirement) => {
    const backend = createDelayedCompletionBackend('held-terminal-handoff');
    const manager = new VoiceAgentManager({ createBackend: () => backend });
    let releaseHandoff!: () => void;
    let handoffStarted!: () => void;
    const handoff = new Promise<void>((resolve) => { releaseHandoff = resolve; });
    const startedHandoff = new Promise<void>((resolve) => { handoffStarted = resolve; });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model', commitModelId: 'commit-model',
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId, userText: 'hello',
      onTurnFinal: async () => { handoffStarted(); await handoff; },
    });
    backend.completeCurrentResponse();
    await startedHandoff;
    const read = manager.readTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId, cursor: 0, waitForEvents: true });
    let settled = false;
    void read.then(() => { settled = true; });
    const retiring = retirement === 'stop' ? manager.stop({ voiceAgentId: started.voiceAgentId }) : manager.dispose();
    try {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(true);
      await expect(read).resolves.toMatchObject({ done: true, events: [] });
    } finally {
      releaseHandoff();
      await retiring;
      await manager.dispose();
    }
  });

  it('projects current idle and active-turn authority from the exact live Voice runtime', async () => {
    let active = false;
    let publishRuntimeEvent: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const activity: boolean[] = [];
    const base = createTestExecutionRunHostRuntime({ runtimeId: 'voice-authority-session' });
    const runtime: ExecutionRunHostRuntime = {
      ...base,
      subscribeRuntimeEvents(handler) {
        publishRuntimeEvent = handler;
        return () => { publishRuntimeEvent = undefined; };
      },
      readActiveTurnAdmissionWitness: () => active
        ? ({ turnId: 'voice-turn-1' } as ReturnType<NonNullable<ExecutionRunHostRuntime['readActiveTurnAdmissionWitness']>>)
        : null,
    };
    const manager = new VoiceAgentManager({
      createBackend: () => runtime,
      onActivityChanged: (voiceAgentId) => activity.push(manager.isTurnInFlight(voiceAgentId)),
    });
    try {
      await manager.start({
        voiceAgentId: 'voice-authority',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionIntent: 'read-only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      });
      activity.length = 0;
      const idle = manager.readCurrentRuntimeAuthority('voice-authority');
      expect(idle).toMatchObject({ runtimeState: 'idle' });
      expect(manager.isTurnInFlight('voice-authority')).toBe(false);
      active = true;
      publishRuntimeEvent?.({ kind: 'turn-start', turnId: 'voice-turn-1', startedBy: 'host', sessionId: 'voice-authority-session', sequence: 1, emittedAtMs: 1 });
      expect(manager.isTurnInFlight('voice-authority')).toBe(true);
      expect(activity).toEqual([true]);
      expect(manager.readCurrentRuntimeAuthority('voice-authority')).toEqual({
        runtimeState: 'active_turn',
        activeTurnId: 'voice-turn-1',
      });
      active = false;
      publishRuntimeEvent?.({ kind: 'turn-complete', turnId: 'voice-turn-1', sessionId: 'voice-authority-session', sequence: 2, emittedAtMs: 2 });
      expect(manager.isTurnInFlight('voice-authority')).toBe(false);
      expect(activity).toEqual([true, false]);
      await manager.stop({ voiceAgentId: 'voice-authority' });
      expect(manager.readCurrentRuntimeAuthority('voice-authority')).toBeNull();
      expect(publishRuntimeEvent).toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  it('moves active-turn authority to an isolated commit runtime without retiring the Voice Run', async () => {
    let releaseCommit!: () => void;
    let commitStarted!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const commitStartedPromise = new Promise<void>((resolve) => { commitStarted = resolve; });
    let commitActive = false;
    const chat = {
      ...createTestExecutionRunHostRuntime({ runtimeId: 'voice-chat' }),
      readActiveTurnAdmissionWitness: () => null,
    } satisfies ExecutionRunHostRuntime;
    const commit = {
      ...createTestExecutionRunHostRuntime({
        runtimeId: 'voice-commit',
        async onSendPrompt() {
          commitActive = true;
          commitStarted();
          await commitGate;
          commitActive = false;
        },
      }),
      readActiveTurnAdmissionWitness: () => commitActive
        ? ({ turnId: 'voice-commit-turn' } as ReturnType<NonNullable<ExecutionRunHostRuntime['readActiveTurnAdmissionWitness']>>)
        : null,
    } satisfies ExecutionRunHostRuntime;
    const manager = new VoiceAgentManager({
      createBackend: ({ modelId }) => modelId === 'commit-model' ? commit : chat,
    });
    try {
      const started = await manager.start({
        voiceAgentId: 'voice-isolated-commit-authority',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        commitIsolation: true,
        permissionIntent: 'read-only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      });
      expect(manager.readCurrentRuntimeAuthority(started.voiceAgentId)).toEqual({ runtimeState: 'idle', activeTurnId: null });
      const committing = manager.commit({ voiceAgentId: started.voiceAgentId });
      await commitStartedPromise;
      expect(manager.readCurrentRuntimeAuthority(started.voiceAgentId)).toEqual({ runtimeState: 'active_turn', activeTurnId: 'voice-commit-turn' });
      releaseCommit();
      await committing;
      expect(manager.readCurrentRuntimeAuthority(started.voiceAgentId)).toEqual({ runtimeState: 'idle', activeTurnId: null });
    } finally {
      releaseCommit();
      await manager.dispose();
    }
  });

  it('claims a voice-agent id before provisioning so concurrent starts cannot double-provision it', async () => {
    let releaseFirstProvision!: () => void;
    let firstProvisionStarted!: () => void;
    const firstProvisionGate = new Promise<void>((resolve) => {
      releaseFirstProvision = resolve;
    });
    const firstProvisionStartedPromise = new Promise<void>((resolve) => {
      firstProvisionStarted = resolve;
    });
    const firstDispose = vi.fn(async () => {});
    let runtimeCount = 0;
    const manager = new VoiceAgentManager({
      createBackend: () => {
        runtimeCount += 1;
        const occurrence = runtimeCount;
        return createTestExecutionRunHostRuntime({
          runtimeId: `voice-session-${occurrence}`,
          providerSessionId: `voice-session-${occurrence}`,
          resumeSupported: true,
          onProvisionRuntime: async () => {
            if (occurrence !== 1) return;
            firstProvisionStarted();
            await firstProvisionGate;
          },
          ...(occurrence === 1 ? { onDispose: firstDispose } : {}),
        });
      },
    });
    const params = {
      voiceAgentId: 'shared-voice-agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' } as const,
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only' as const,
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    };

    try {
      const lateFirst = manager.start(params);
      await firstProvisionStartedPromise;
      await expect(manager.start(params)).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
      expect(runtimeCount).toBe(1);
      releaseFirstProvision();

      await expect(lateFirst).resolves.toMatchObject({ voiceAgentId: 'shared-voice-agent' });
      expect(firstDispose).not.toHaveBeenCalled();
      expect(manager.getResumeHandle('shared-voice-agent')).toMatchObject({
        kind: 'provider_session.v1',
        providerSessionId: 'voice-session-1',
      });
    } finally {
      releaseFirstProvision();
      await manager.dispose();
    }
  });

  it('does not register a late start after the manager was disposed', async () => {
    let releaseProvision!: () => void;
    let provisionStarted!: () => void;
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const provisionStartedPromise = new Promise<void>((resolve) => {
      provisionStarted = resolve;
    });
    const disposeRuntime = vi.fn(async () => {});
    const activity: boolean[] = [];
    const manager = new VoiceAgentManager({
      onActivityChanged: (voiceAgentId) => activity.push(manager.isTurnInFlight(voiceAgentId)),
      createBackend: () => createTestExecutionRunHostRuntime({
        runtimeId: 'late-session',
        onProvisionRuntime: async () => {
          provisionStarted();
          await provisionGate;
        },
        onDispose: disposeRuntime,
      }),
    });

    const start = manager.start({
      voiceAgentId: 'late-voice-agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    await provisionStartedPromise;
    expect(manager.isTurnInFlight('late-voice-agent')).toBe(true);
    expect(activity).toEqual([true]);
    await manager.dispose();
    expect(manager.isTurnInFlight('late-voice-agent')).toBe(false);
    expect(activity).toEqual([true, false]);
    releaseProvision();

    await expect(start).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
    expect(disposeRuntime).toHaveBeenCalledTimes(1);
    expect(manager.getResumeHandle('late-voice-agent')).toBeNull();
  });

  it('disposes resumed chat and provisional commit runtimes exactly once when stopped during commit provisioning', async () => {
    let commitProvisionStarted!: () => void;
    let releaseCommitProvision!: () => void;
    const commitProvisionStartedPromise = new Promise<void>((resolve) => {
      commitProvisionStarted = resolve;
    });
    const commitProvisionGate = new Promise<void>((resolve) => {
      releaseCommitProvision = resolve;
    });
    const chatDispose = vi.fn(async () => undefined);
    const commitDispose = vi.fn(async () => undefined);
    const chatBackend = createTestExecutionRunHostRuntime({
      runtimeId: 'resumed-chat-session',
      resumeSupported: true,
      onDispose: chatDispose,
    });
    const commitBackend = createTestExecutionRunHostRuntime({
      runtimeId: 'resumed-commit-session',
      resumeSupported: true,
      async onProvisionRuntime() {
        commitProvisionStarted();
        await commitProvisionGate;
      },
      onDispose: commitDispose,
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(chatBackend)
      .mockReturnValueOnce(commitBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const start = manager.start({
      voiceAgentId: 'resumed-stop-during-commit-provision',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      resumeHandle: {
        kind: 'voice_agent_sessions.v1',
        backendTarget: { kind: 'backend', backendId: 'claude' },
        chatProviderSessionId: 'resumed-chat-session',
        commitProviderSessionId: 'resumed-commit-session',
      },
    });

    try {
      await commitProvisionStartedPromise;
      await expect(manager.stop({
        voiceAgentId: 'resumed-stop-during-commit-provision',
      })).resolves.toEqual({ ok: true });
      let retirementSettled = false;
      const retirement = manager.waitForRetirement('resumed-stop-during-commit-provision').then(() => {
        retirementSettled = true;
      });
      await vi.waitFor(() => {
        expect(chatDispose).toHaveBeenCalledTimes(1);
        expect(commitDispose).toHaveBeenCalledTimes(1);
      });
      await Promise.resolve();
      expect(retirementSettled).toBe(false);

      releaseCommitProvision();
      await expect(start).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
      await retirement;
      expect(retirementSettled).toBe(true);
      expect(chatDispose).toHaveBeenCalledTimes(1);
      expect(commitDispose).toHaveBeenCalledTimes(1);
    } finally {
      releaseCommitProvision();
      await start.catch(() => {});
      await manager.dispose();
    }
  });

  it('keeps an established id retired until its exact runtime cleanup settles', async () => {
    let disposalStarted!: () => void;
    let releaseDisposal!: () => void;
    const disposalStartedPromise = new Promise<void>((resolve) => {
      disposalStarted = resolve;
    });
    const disposalGate = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    let runtimeCount = 0;
    const manager = new VoiceAgentManager({
      createBackend: () => {
        runtimeCount += 1;
        const occurrence = runtimeCount;
        return createTestExecutionRunHostRuntime({
          runtimeId: `retiring-established-session-${occurrence}`,
          async onDispose() {
            if (occurrence !== 1) return;
            disposalStarted();
            await disposalGate;
            throw new Error('provider disposal failed after retirement');
          },
        });
      },
    });
    const params = {
      voiceAgentId: 'retiring-established-agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' } as const,
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only' as const,
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    };

    let stop: Promise<{ ok: true }> | null = null;
    try {
      await manager.start(params);
      stop = manager.stop({ voiceAgentId: params.voiceAgentId });
      await disposalStartedPromise;

      let retirementSettled = false;
      const retirement = manager.waitForRetirement(params.voiceAgentId).then(() => {
        retirementSettled = true;
      });
      await Promise.resolve();
      expect(retirementSettled).toBe(false);
      await expect(manager.start(params)).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });

      releaseDisposal();
      await expect(stop).resolves.toEqual({ ok: true });
      await retirement;
      await expect(manager.start(params)).resolves.toMatchObject({ voiceAgentId: params.voiceAgentId });
      expect(runtimeCount).toBe(2);
    } finally {
      releaseDisposal();
      await stop?.catch(() => {});
      await manager.dispose();
    }
  });

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
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      runtimeId: 's-chat',
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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

  it('retains the shared legacy connected-services route for both roles when no commit override is supplied', async () => {

    const capturedOpts: Array<{ connectedServices?: unknown }> = [];
    const createBackend: BackendFactory = (opts) => {
      capturedOpts.push(opts);
      return createDeterministicBackend('backend');
    };
    const manager = new VoiceAgentManager({ createBackend });

    const connectedServices = {
      v: 2 as const,
      bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
      },
    };

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      connectedServices,
    });

    await manager.commit({ voiceAgentId: started.voiceAgentId });
    expect(capturedOpts.map((options) => options.connectedServices)).toEqual([connectedServices, connectedServices]);
    await manager.dispose();
  });

  it('passes through VoiceAgentError codes thrown by the backend factory', async () => {

    const createBackend: BackendFactory = () => {
      throw new VoiceAgentError('VOICE_AGENT_UNSUPPORTED', 'voice agent not supported');
    };

    const manager = new VoiceAgentManager({ createBackend });

    await expect(
      manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      runtimeId: 's-bootstrap-fail',
      onDispose: dispose,
      onProvisionRuntime() {
        backend.emitMessage({ type: 'status', status: 'running' });
      },
      onSendPrompt() {
        backend.emitMessage({ type: 'model-output', fullText: 'NOT_READY' });
        backend.emitMessage({ type: 'status', status: 'idle' });
      },
    });
    const manager = new VoiceAgentManager({ createBackend: () => backend });

    await expect(manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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

  it('passes the canonical backend target, model ids, permission policy, and voice_agent start intent to the backend factory', async () => {

    const seen: Array<{
      backendTarget: Parameters<BackendFactory>[0]['backendTarget'];
      backendId: string;
      modelId: string;
      permissionIntent: Parameters<BackendFactory>[0]['permissionIntent'];
      start?: { intent: 'voice_agent' };
    }> = [];
    const backend = createDeterministicBackend('chat');
    const createBackend: BackendFactory = (opts) => {
      seen.push({
        backendTarget: opts.backendTarget,
        backendId: opts.backendId,
        modelId: opts.modelId,
        permissionIntent: opts.permissionIntent,
        start: opts.start,
      });
      return backend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'external-voice-agent' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    expect(seen).toEqual([{
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'external-voice-agent' },
      backendId: 'external-voice-agent',
      modelId: 'chat-model',
      permissionIntent: 'read-only',
      start: { intent: 'voice_agent' },
    }]);
    expect(manager.getResumeHandle(started.voiceAgentId)?.backendTarget).toMatchObject({
      kind: 'backend',
      backendId: 'external-voice-agent',
      configuredBackendId: 'external-voice-agent',
      sourceKind: 'configured',
    });

    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });

    expect(seen).toEqual([
      { backendTarget: { kind: 'configuredAcpBackend', backendId: 'external-voice-agent' }, backendId: 'external-voice-agent', modelId: 'chat-model', permissionIntent: 'read-only', start: { intent: 'voice_agent' } },
      { backendTarget: { kind: 'configuredAcpBackend', backendId: 'external-voice-agent' }, backendId: 'external-voice-agent', modelId: 'commit-model', permissionIntent: 'read-only', start: { intent: 'voice_agent' } },
    ]);
    expect(manager.getResumeHandle(started.voiceAgentId)).toMatchObject({
      kind: 'voice_agent_sessions.v1',
      backendTarget: {
        kind: 'backend',
        backendId: 'external-voice-agent',
        configuredBackendId: 'external-voice-agent',
        sourceKind: 'configured',
      },
    });
  });

  it('routes independent Provider selections and the same non-default temperature to chat and commit', async () => {
    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDeterministicBackend('commit');
    const seen: Parameters<BackendFactory>[0][] = [];
    const createBackend: BackendFactory = (options) => {
      seen.push(options);
      return options.modelId === 'commit-model' ? commitBackend : chatBackend;
    };
    const manager = new VoiceAgentManager({ createBackend });
    const canonicalOpenCodeTargetKey = buildBackendTargetKeyV2({
      kind: 'agent',
      identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
    });
    const chatModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: canonicalOpenCodeTargetKey,
      providerConnectionId: 'pc_chat',
      modelId: 'chat-model',
    });
    const commitModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: canonicalOpenCodeTargetKey,
      providerConnectionId: 'pc_commit',
      modelId: 'commit-model',
    });
    const sessionConfigOptionOverrides = {
      v: 1,
      updatedAt: 0,
      overrides: { temperature: { updatedAt: 0, value: 0.73 } },
    } as const;

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      chatModelSelection,
      commitModelSelection,
      sessionConfigOptionOverrides,
      connectedServices: null,
      commitConnectedServices: { v: 2, bindingsByServiceId: {
        'happier.agent.opencode/openai': { source: 'connected', selection: 'group', groupId: 'parent-pool' },
      } },
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });

    expect(seen).toEqual([
      expect.objectContaining({
        modelId: 'chat-model',
        modelSelection: chatModelSelection,
        sessionConfigOptionOverrides,
        connectedServices: null,
      }),
      expect.objectContaining({
        modelId: 'commit-model',
        modelSelection: commitModelSelection,
        sessionConfigOptionOverrides,
        connectedServices: { v: 2, bindingsByServiceId: {
          'happier.agent.opencode/openai': { source: 'connected', selection: 'group', groupId: 'parent-pool' },
        } },
      }),
    ]);
  });

  it.each([false, true])('keeps role-specific native versus pool routes distinct with the same native model (native commit: %s)', async (nativeCommit) => {
    const seen: Parameters<BackendFactory>[0][] = [];
    const manager = new VoiceAgentManager({ createBackend: (options) => {
      seen.push(options);
      return createDeterministicBackend(`role-${seen.length}`);
    } });
    const pool = { v: 2 as const, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'group' as const, groupId: 'parent-pool' },
    } };
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      chatModelId: 'same-model', commitModelId: 'same-model',
      connectedServices: nativeCommit ? pool : null,
      commitConnectedServices: nativeCommit ? null : pool,
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    await manager.commit({ voiceAgentId: started.voiceAgentId });
    expect(seen.map((options) => options.connectedServices)).toEqual(nativeCommit ? [pool, null] : [null, pool]);
    await manager.dispose();
  });

  it('does not reuse chat for commit when identical model ids belong to different Provider connections', async () => {
    const createBackend = vi.fn<BackendFactory>(() => createDeterministicBackend('provider'));
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      chatModelId: 'shared-model',
      commitModelId: 'shared-model',
      chatModelSelection: ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'agent:happier.agent.opencode/opencode',
        providerConnectionId: 'pc_chat',
        modelId: 'shared-model',
      }),
      commitModelSelection: ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'agent:happier.agent.opencode/opencode',
        providerConnectionId: 'pc_commit',
        modelId: 'shared-model',
      }),
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });

    expect(createBackend).toHaveBeenCalledTimes(2);
    expect(createBackend.mock.calls[1]?.[0]).toMatchObject({
      modelSelection: { providerConnectionId: 'pc_commit', modelId: 'shared-model' },
    });
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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

  it('surfaces the runtime refusal when the host declines the prompt instead of treating it as delivered', async () => {
    // `deliverInput` reports a refusal as a value rather than a throw. If Voice
    // ignored the status it would fall through to an empty chat buffer and report
    // the generic 'Bootstrap failed', hiding the reason the Agent gave.
    const refusingBackend: ExecutionRunHostRuntime = {
      readResumeSupport: async () => false,
      provisionRuntime: async () => ({ runtimeId: 'chat-session' }),
      deliverInput: async () => ({
        status: 'rejected' as const,
        diagnostic: { code: 'provider_busy', severity: 'error' as const, message: 'Agent refused the prompt' },
        retryable: false,
      }),
      getRuntimeLifetimeSignal: () => TEST_RUNTIME_LIFETIME_SIGNAL,
      cancel: async () => undefined,
      subscribeMessages: () => () => undefined,
      dispose: async () => undefined,
    };

    const manager = new VoiceAgentManager({ createBackend: () => refusingBackend });

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' }))
      .rejects.toMatchObject({
        code: 'VOICE_AGENT_START_FAILED',
        message: 'Agent refused the prompt',
      });
  });

  it('keeps Account Voice Follow pending through ambiguous delivery and settles it once for later exact acceptance', async () => {
    const base = createDeterministicBackend('chat');
    let outcomeHandler: Parameters<NonNullable<ExecutionRunHostRuntime['subscribeProviderInputOutcomes']>>[0] | null = null;
    let deliveredLocalId: string | null = null;
    const unsubscribeProviderInputOutcomes = vi.fn();
    const backend: ExecutionRunHostRuntime = {
      ...base,
      async deliverInput(runtimeId, input, context) {
        deliveredLocalId = context?.localId ?? null;
        return await base.deliverInput(runtimeId, input, context);
      },
      subscribeProviderInputOutcomes(handler) {
        outcomeHandler = handler;
        return () => {
          unsubscribeProviderInputOutcomes();
          if (outcomeHandler === handler) outcomeHandler = null;
        };
      },
    };
    const acknowledgeAccepted = vi.fn();
    const prepareFollowContext = vi.fn().mockResolvedValue({
      updates: [{
        v: 1,
        kind: 'session_follow_update',
        edge: { sourceSessionId: 'source', destinationSessionId: 'voice-session' },
        reason: 'source_changed',
        deliveryIntent: 'context_only',
        observed: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null },
        awareness: {
          v: 1,
          sessionId: 'source',
          lifecycle: 'ready',
          runtime: 'idle',
          freshness: 'live',
          operational: { primary: 'ready', reasons: ['ready'] },
          encryption: 'plain',
          availability: 'complete',
        },
        recentMessages: [],
        truncated: false,
      }],
      acknowledgeAccepted,
    });
    const manager = new VoiceAgentManager({ createBackend: () => backend, prepareFollowContext });
    const started = await manager.start({
      voiceAgentId: 'voice-agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    expect(prepareFollowContext).not.toHaveBeenCalled();
    await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId,
      userText: 'what changed?',
      durableUserTranscriptLocalId: 'voice-user-1',
    });
    await vi.waitFor(() => expect(base.getSeenPrompts()).toHaveLength(1));
    expect(base.getSeenPrompts()[0]).toContain('<session_follow>');
    expect(prepareFollowContext).toHaveBeenCalledWith(expect.objectContaining({
      executionRunId: started.voiceAgentId,
    }));
    expect(deliveredLocalId).toBe('voice-user-1');
    expect(acknowledgeAccepted).not.toHaveBeenCalled();
    const subscribedOutcomeHandler = outcomeHandler!;
    subscribedOutcomeHandler({
      kind: 'effect_may_have_occurred',
      localId: deliveredLocalId!,
      userMessageSeq: 17,
      issue: { code: 'provider_response_lost', severity: 'error' },
    });
    expect(unsubscribeProviderInputOutcomes).not.toHaveBeenCalled();
    expect(acknowledgeAccepted).not.toHaveBeenCalled();

    subscribedOutcomeHandler({ kind: 'accepted', localId: deliveredLocalId!, userMessageSeq: 17 });
    subscribedOutcomeHandler({ kind: 'accepted', localId: deliveredLocalId!, userMessageSeq: 17 });
    expect(unsubscribeProviderInputOutcomes).toHaveBeenCalledOnce();
    expect(acknowledgeAccepted).toHaveBeenCalledExactlyOnceWith({
      kind: 'admitted_input',
      localInputId: deliveredLocalId,
      userMessageSeq: 17,
    });

    await manager.dispose();
  });

  it('never delivers a Voice prompt cancelled while Follow context was still hydrating', async () => {
    const chatBackendBase = createDeterministicBackend('chat-cancel-during-hydration');
    // Follow context is only prepared for a runtime that reports provider input
    // outcomes; a backend without that port never reaches the hydration path at
    // all, so this case must carry it to exercise the real cancellation seam.
    const chatBackend = Object.assign({}, chatBackendBase, {
      subscribeProviderInputOutcomes: (_handler: Parameters<
        NonNullable<ExecutionRunHostRuntime['subscribeProviderInputOutcomes']>
      >[0]) => () => undefined,
    });
    const replacementBackend = createDeterministicBackend('chat-cancel-during-hydration-replacement');
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(chatBackend)
      .mockReturnValueOnce(replacementBackend);
    const acknowledgeAccepted = vi.fn();
    let announceHydrationStarted: (() => void) | null = null;
    const hydrationStarted = new Promise<void>((resolve) => { announceHydrationStarted = resolve; });
    let releaseHydration!: () => void;
    const hydrationReleased = new Promise<void>((resolve) => { releaseHydration = resolve; });
    const prepareFollowContext = vi.fn(async () => {
      announceHydrationStarted?.();
      await hydrationReleased;
      return {
        updates: [{
          v: 1 as const,
          kind: 'session_follow_update' as const,
          edge: { sourceSessionId: 'source', destinationSessionId: 'voice-session' },
          reason: 'source_changed' as const,
          deliveryIntent: 'context_only' as const,
          observed: { transcriptSeq: 4, readyEventSeq: 0, agentStateVersion: 0, turn: null },
          awareness: {
            v: 1 as const,
            sessionId: 'source',
            lifecycle: 'ready' as const,
            runtime: 'idle' as const,
            freshness: 'live' as const,
            operational: { primary: 'ready' as const, reasons: ['ready' as const] },
            encryption: 'plain' as const,
            availability: 'complete' as const,
          },
          recentMessages: [],
          truncated: false,
        }],
        acknowledgeAccepted,
      };
    });
    const manager = new VoiceAgentManager({ createBackend, prepareFollowContext });
    const started = await manager.start({
      voiceAgentId: 'voice-agent-cancel-during-hydration',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const stream = await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId,
      userText: 'what changed?',
      durableUserTranscriptLocalId: 'voice-user-cancelled-during-hydration',
    });
    await hydrationStarted;
    const cancelling = manager.cancelTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
    });
    releaseHydration();
    await expect(cancelling).resolves.toEqual({ ok: true });

    expect(prepareFollowContext).toHaveBeenCalledTimes(1);
    expect(chatBackend.getSeenPrompts()).toHaveLength(0);
    expect(acknowledgeAccepted).not.toHaveBeenCalled();

    await manager.dispose();
  });

  it('keeps Account Voice Follow pending through retryable pre-effect rejection and accepts a later exact outcome', async () => {
    const base = createDeterministicBackend('chat-retryable-rejection');
    let outcomeHandler: Parameters<NonNullable<ExecutionRunHostRuntime['subscribeProviderInputOutcomes']>>[0] | null = null;
    const unsubscribeProviderInputOutcomes = vi.fn();
    const backend: ExecutionRunHostRuntime = {
      ...base,
      subscribeProviderInputOutcomes(handler) {
        outcomeHandler = handler;
        return () => {
          unsubscribeProviderInputOutcomes();
          if (outcomeHandler === handler) outcomeHandler = null;
        };
      },
    };
    const acknowledgeAccepted = vi.fn();
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      prepareFollowContext: vi.fn().mockResolvedValue({
        updates: [],
        acknowledgeAccepted,
      }),
    });
    const started = await manager.start({
      voiceAgentId: 'voice-agent-retryable-rejection',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId,
      userText: 'what changed?',
      durableUserTranscriptLocalId: 'voice-user-retryable',
    });
    await vi.waitFor(() => expect(base.getSeenPrompts()).toHaveLength(1));
    const subscribedOutcomeHandler = outcomeHandler!;
    subscribedOutcomeHandler({
      kind: 'rejected_before_effect',
      localId: 'voice-user-retryable',
      userMessageSeq: 23,
      reason: 'provider_unavailable_before_acceptance',
      diagnostic: { code: 'provider_unavailable', severity: 'error' },
      retryable: true,
    });
    expect(unsubscribeProviderInputOutcomes).not.toHaveBeenCalled();
    expect(acknowledgeAccepted).not.toHaveBeenCalled();

    subscribedOutcomeHandler({ kind: 'accepted', localId: 'voice-user-retryable', userMessageSeq: 23 });
    expect(unsubscribeProviderInputOutcomes).toHaveBeenCalledOnce();
    expect(acknowledgeAccepted).toHaveBeenCalledExactlyOnceWith({
      kind: 'admitted_input',
      localInputId: 'voice-user-retryable',
      userMessageSeq: 23,
    });

    await manager.dispose();
  });

  it('settles Account Voice Follow without ACK on definitive pre-effect rejection', async () => {
    const base = createDeterministicBackend('chat-definitive-rejection');
    let outcomeHandler: Parameters<NonNullable<ExecutionRunHostRuntime['subscribeProviderInputOutcomes']>>[0] | null = null;
    const unsubscribeProviderInputOutcomes = vi.fn();
    const backend: ExecutionRunHostRuntime = {
      ...base,
      subscribeProviderInputOutcomes(handler) {
        outcomeHandler = handler;
        return () => {
          unsubscribeProviderInputOutcomes();
          if (outcomeHandler === handler) outcomeHandler = null;
        };
      },
    };
    const acknowledgeAccepted = vi.fn();
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      prepareFollowContext: vi.fn().mockResolvedValue({
        updates: [],
        acknowledgeAccepted,
      }),
    });
    const started = await manager.start({
      voiceAgentId: 'voice-agent-definitive-rejection',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId,
      userText: 'what changed?',
      durableUserTranscriptLocalId: 'voice-user-definitive',
    });
    await vi.waitFor(() => expect(base.getSeenPrompts()).toHaveLength(1));
    const subscribedOutcomeHandler = outcomeHandler!;
    subscribedOutcomeHandler({
      kind: 'rejected_before_effect',
      localId: 'voice-user-definitive',
      userMessageSeq: 29,
      reason: 'unsupported_action',
      diagnostic: { code: 'unsupported_action', severity: 'error' },
      retryable: false,
    });
    subscribedOutcomeHandler({ kind: 'accepted', localId: 'voice-user-definitive', userMessageSeq: 29 });
    expect(unsubscribeProviderInputOutcomes).toHaveBeenCalledOnce();
    expect(acknowledgeAccepted).not.toHaveBeenCalled();

    await manager.dispose();
  });

  it('does not prepare Account Voice Follow when the runtime cannot report exact provider acceptance', async () => {
    const backend = createDeterministicBackend('chat');
    const prepareFollowContext = vi.fn().mockResolvedValue({
      updates: [],
      acknowledgeAccepted: vi.fn(),
    });
    const manager = new VoiceAgentManager({ createBackend: () => backend, prepareFollowContext });
    const started = await manager.start({
      voiceAgentId: 'voice-agent-without-acceptance',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId,
      userText: 'what changed?',
      durableUserTranscriptLocalId: 'voice-user-1',
    });
    await vi.waitFor(() => expect(backend.getSeenPrompts()).toHaveLength(1));

    expect(prepareFollowContext).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it('does not prepare Account Voice Follow without a durable user transcript identity', async () => {
    const base = createDeterministicBackend('chat');
    const backend: ExecutionRunHostRuntime = {
      ...base,
      subscribeProviderInputOutcomes() {
        return () => undefined;
      },
    };
    const prepareFollowContext = vi.fn().mockResolvedValue({
      updates: [],
      acknowledgeAccepted: vi.fn(),
    });
    const manager = new VoiceAgentManager({ createBackend: () => backend, prepareFollowContext });
    const started = await manager.start({
      voiceAgentId: 'voice-agent-without-durable-transcript',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'what changed?' });

    expect(prepareFollowContext).not.toHaveBeenCalled();
    await manager.dispose();
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const sendP = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });

    await vi.waitFor(() => expect(resolveWasSet).toBe(true));

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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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

  it('replays completed textual history when cancellation requires a fresh chat session', async () => {
    let promptCount = 0;
    let releaseCancelledPrompt: (() => void) | null = null;
    let cancelledRuntime: ReturnType<typeof createTestExecutionRunHostRuntime>;
    cancelledRuntime = createTestExecutionRunHostRuntime({
      runtimeId: 's-cancelled-mid-conversation',
      async onSendPrompt() {
        promptCount += 1;
        if (promptCount === 1) {
          cancelledRuntime.emitMessage({ type: 'model-output', fullText: 'first response <voice_actions>{"actions":[{"t":"ui.voice_agent.teleport","args":{"sessionId":"prior-effect-session"}}]}</voice_actions>' });
          cancelledRuntime.emitMessage({ type: 'status', status: 'idle' });
          return;
        }
        await new Promise<void>((resolve) => {
          releaseCancelledPrompt = resolve;
        });
        cancelledRuntime.emitMessage({ type: 'status', status: 'idle' });
      },
      onCancel() {
        releaseCancelledPrompt?.();
        releaseCancelledPrompt = null;
      },
    });
    const replacementRuntime = createPromptCaptureBackend([{ responseText: 'replacement response' }]);
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(cancelledRuntime)
      .mockReturnValueOnce(replacementRuntime);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CURRENT VOICE CONTEXT',
    });

    const first = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'first turn' });
    await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: first.streamId });
    const cancelled = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel this turn' });
    await manager.cancelTurnStream({ voiceAgentId: started.voiceAgentId, streamId: cancelled.streamId });
    const next = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'next turn' });
    await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: next.streamId });

    expect(replacementRuntime.prompts).toHaveLength(1);
    expect(replacementRuntime.prompts[0]).toContain('CURRENT VOICE CONTEXT');
    expect(replacementRuntime.prompts[0]).toContain('next turn');
    expect(replacementRuntime.prompts[0]).toContain('first turn');
    expect(replacementRuntime.prompts[0]).toContain('first response');
    expect(replacementRuntime.prompts[0]).not.toContain('cancel this turn');
    expect(replacementRuntime.prompts[0]).not.toContain('prior-effect-session');
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
    const onTerminalFailure = vi.fn(async () => {});
    const manager = new VoiceAgentManager({ createBackend, onTerminalFailure });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
    expect(onTerminalFailure).toHaveBeenCalledWith(started.voiceAgentId, 'backend_replacement_failed');
  });

  it('makes backend replacement exclusive and never resumes the cancelled provider session', async () => {
    const replacementDeferred: { resolve: () => void } = { resolve: () => {} };
    const replacementBarrier = new Promise<void>((resolve) => { replacementDeferred.resolve = resolve; });
    const provisionArgs: unknown[] = [];
    let replacementStarted!: () => void;
    const startedReplacement = new Promise<void>((resolve) => { replacementStarted = resolve; });
    const activity: boolean[] = [];
    const cancelledBackend = createCancelableBlockingBackend('chat');
    const replacementBackend = createTestExecutionRunHostRuntime({
      runtimeId: 's-replacement',
      async onProvisionRuntime(opts) {
        provisionArgs.push(opts);
        replacementStarted();
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
    const manager = new VoiceAgentManager({
      createBackend,
      onActivityChanged: (voiceAgentId) => activity.push(manager.isTurnInFlight(voiceAgentId)),
    });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });
    const cancelling = manager.cancelTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
    await startedReplacement;
    expect(manager.readCurrentRuntimeAuthority(started.voiceAgentId)?.runtimeState).toBe('idle');
    expect(manager.isTurnInFlight(started.voiceAgentId)).toBe(true);
    expect(activity.at(-1)).toBe(true);

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
    expect(manager.isTurnInFlight(started.voiceAgentId)).toBe(false);
    expect(activity.at(-1)).toBe(false);
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
      runtimeId: 's-failed-replacement',
      onProvisionRuntime() { throw new Error('replacement provision failed'); },
      onDispose() { disposed.replacement += 1; },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(chatBackend)
      .mockReturnValueOnce(commitBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      runtimeId: 's-replacement-subscribe-throw',
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      runtimeId: 's-replacement-after-unsubscribe-throw',
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      runtimeId: 's-replacement-unsubscribe-throw',
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      runtimeId: 's-stop-replacement',
      async onProvisionRuntime() { await replacementBarrier; },
      onDispose() { disposed.replacement += 1; },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(oldBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
    // Preparation may cross the Account settings boundary before the runtime
    // completes; one timer tick is not evidence that this stream has settled.
    await vi.waitFor(() => expect(manager.isTurnInFlight(started.voiceAgentId)).toBe(false));
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
      runtimeId: 'completed-unread-stop',
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
    let promptStarted = false;
    const waitForSendPrompt = () => new Promise<void>((r) => {
      deferred.resolve = () => r();
      promptStarted = true;
    });

    const chatBackend = createBlockingBackend('chat', { waitForSendPrompt });
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const sendP = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
    await vi.waitFor(() => expect(promptStarted).toBe(true));
    const stopP = manager.stop({ voiceAgentId: started.voiceAgentId });

    await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'should fail' })).rejects.toMatchObject({
      code: 'VOICE_AGENT_NOT_FOUND',
    });

    deferred.resolve();
    await sendP;
    await stopP;
  });

  it('notifies the lifecycle owner before reaping an idle voice agent', async () => {
    let nowMs = 0;
    let disposed = false;
    const reapedVoiceAgentIds: string[] = [];
    const createBackend: BackendFactory = ({ modelId }) => createTestExecutionRunHostRuntime({
      runtimeId: `s-${modelId}`,
      onDispose() {
        disposed = true;
      },
    });

    vi.useFakeTimers();
    try {
      const manager = new VoiceAgentManager({
        createBackend,
        getNowMs: () => nowMs,
        reaperIntervalMs: 5_000,
        async onIdleReaped(voiceAgentId) {
          expect(disposed).toBe(false);
          reapedVoiceAgentIds.push(voiceAgentId);
        },
      });
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionIntent: 'read-only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      });

      nowMs = 120_000;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(reapedVoiceAgentIds).toEqual([started.voiceAgentId]);
      expect(disposed).toBe(true);
      await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' })).rejects.toMatchObject({
        code: 'VOICE_AGENT_NOT_FOUND',
      });

      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a NaN idleTtlSeconds as the minimum TTL so idle voice agents can be reaped', async () => {

    let nowMs = 0;
    let disposedCount = 0;
    const createBackend: BackendFactory = ({ modelId }) => createTestExecutionRunHostRuntime({
      runtimeId: `s-${modelId}`,
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
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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

  it('honors the configured idle lifetime beyond six hours through the native host runtime', async () => {

    let nowMs = 0;
    let disposedCount = 0;
    // Agent/native boundary only; the host adapter and manager lifecycle are real.
    const runtime: AgentRuntime = { sessions: { async open() { return {
      watch() { return { dispose() {} }; },
      async send() { return { status: 'admitted' as const }; },
      async dispose() { disposedCount += 1; },
    }; } } };

    vi.useFakeTimers();
    try {
      const manager = new VoiceAgentManager({
        createRuntime: ({ modelId }) => createVoiceSessionRuntimeThroughNativeFactory({ runtime, modelId,
          capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false } }),
        getNowMs: () => nowMs,
        reaperIntervalMs: 5_000,
      });

      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionIntent: 'read-only',
        idleTtlSeconds: 8 * 60 * 60,
        initialContext: '',
      });

      nowMs = 2 * 60 * 60 * 1000; // 2h
      await vi.advanceTimersByTimeAsync(5_000);
      expect(disposedCount).toBe(0);

      nowMs = 7 * 60 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(disposedCount).toBe(0);
      expect(manager.readCurrentRuntimeAuthority(started.voiceAgentId)).toMatchObject({ runtimeState: 'idle' });

      nowMs = 8 * 60 * 60 * 1000 + 1;
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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

  it('uses the admitted speech latency target before provider completion', async () => {
    let releaseProvider: (() => void) | undefined;
    const providerDone = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
    runtime = createTestExecutionRunHostRuntime({
      runtimeId: 'latency-runtime',
      onProvisionRuntime() { runtime.emitMessage({ type: 'status', status: 'running' }); },
      async onSendPrompt() {
        runtime.emitMessage({ type: 'model-output', textDelta: `Sure. ${'word '.repeat(30)}` });
        await providerDone;
        runtime.emitMessage({ type: 'status', status: 'idle' });
      },
    });
    const manager = new VoiceAgentManager({ createBackend: () => runtime });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model', commitModelId: 'chat-model',
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    try {
      const stream = await manager.startTurnStream({
        voiceAgentId: started.voiceAgentId, userText: 'hello', speechSegmentTargetChars: 120,
      });
      await vi.waitFor(async () => {
        const read = await manager.readTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId, cursor: 0 });
        expect(read.done).toBe(false);
        const speech = read.events.flatMap((event) => event.t === 'voice_output' && event.output.kind === 'speech_segment'
          ? [event.output.text.trim()] : []);
        expect(speech).toEqual(['Sure.', 'word '.repeat(30).trim()]);
      });
    } finally {
      releaseProvider?.();
      await manager.stop({ voiceAgentId: started.voiceAgentId });
    }
  });

  it.each([
    { label: 'multilingual bytes', text: '你好🙂'.repeat(15_000), actionCount: 1, incomplete: true },
    { label: 'multilingual text with normalized action preamble', text: '你好🙂'.repeat(15_000), actionCount: 1, incomplete: true, sendMessage: true },
    { label: 'serialized JSON escaping', text: '\u0001'.repeat(60_000), actionCount: 1, incomplete: true },
    { label: 'valid action event overhead', text: 'word '.repeat(9_000), actionCount: 230, incomplete: false },
    { label: 'action event overflow', text: 'word '.repeat(9_000), actionCount: 300, incomplete: true },
    { label: 'valid near-boundary ASCII', text: 'word '.repeat(12_800), actionCount: 1, incomplete: false },
  ])('keeps $label inside the Protocol budget including actions and the repeated terminal final', async ({ text, actionCount, incomplete, sendMessage }) => {
    const action = sendMessage
      ? { t: 'sendSessionMessage', args: { message: 'Do X.' } }
      : { t: 'teleportVoiceAgentToSessionRoot', args: { sessionId: 's1' } };
    const block = `<voice_actions>${JSON.stringify({ actions: Array.from({ length: actionCount }, () => action) })}</voice_actions>`;
    const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    let sequence = 0;
    const publish = (event: AgentSessionRuntimeEvent) => { for (const listener of listeners) listener(event); };
    // Only the external Agent SDK is a fixture; factory, host runtime, Voice and Protocol owners are real.
    const runtime: AgentRuntime = { sessions: { async open() { return {
      watch(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
      async send(request) {
        const base = { sessionId: 'session-parent', emittedAtMs: 1 };
        const turnId = request.delivery.turnId;
        publish({ ...base, sequence: sequence++, kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
        publish({ ...base, sequence: sequence++, kind: 'turn-start', turnId, startedBy: 'host' });
        for (const delta of [text, block]) {
          publish({ ...base, sequence: sequence++, kind: 'message-delta', turnId, channel: 'assistant', text: delta });
        }
        publish({ ...base, sequence: sequence++, kind: 'turn-complete', turnId });
        return { status: 'admitted' as const };
      },
      async dispose() { listeners.clear(); },
    }; } } };
    const manager = new VoiceAgentManager({ createRuntime: ({ modelId }) => createVoiceSessionRuntimeThroughNativeFactory({
      runtime, modelId, capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
    }) });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model', commitModelId: 'chat-model', permissionIntent: 'read-only',
      idleTtlSeconds: 60, initialContext: 'CTX',
    });
    let persistedText = '';
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello', onTurnFinal: (value) => { persistedText = value; } });
    await vi.waitFor(async () => {
      const page = await manager.readTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId, cursor: 0, maxEvents: 1 });
      expect(page.terminalEvent).toBeDefined();
    });
    const firstPage = await manager.readTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId, cursor: 0, maxEvents: 1 });
    expect(firstPage.done).toBe(false);
    expect(firstPage.terminalEvent).toMatchObject({ t: 'voice_output', output: { kind: 'turn_final', text: persistedText } });
    const events = await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: stream.streamId, maxEvents: 256 });
    let state = createVoiceAgentOutputTurnV1(stream.streamId);
    let spokenText = '';
    let finalText: string | undefined;
    for (const event of events) {
      if (event.t !== 'voice_output') continue;
      const result = ingestVoiceAgentOutputEventV1(state, event.output);
      state = result.state;
      if (event.output.kind === 'speech_segment') spokenText += event.output.text;
      if (event.output.kind === 'turn_final') finalText = event.output.text;
    }
    expect(state.terminal).toBe('final');
    expect(finalText).toBe(persistedText);
    expect(finalText?.startsWith(spokenText.trimEnd())).toBe(true);
    expect(spokenText.length).toBeGreaterThan(text.length / 4);
    expect(text.startsWith(spokenText)).toBe(true);
    expect(spokenText).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(finalText?.endsWith(VOICE_OUTPUT_INCOMPLETE_TEXT)).toBe(incomplete);
    expect(events.some((event) => event.t === 'error')).toBe(false);
    if (!incomplete) {
      expect(spokenText).toBe(text);
      expect(finalText).toBe(text.trimEnd());
      expect(events.filter((event) => event.t === 'voice_output' && event.output.kind === 'side_effect')).toHaveLength(actionCount);
    }
  });

  it('rejects a cursor beyond produced events without evicting the stream or skipping its final event', async () => {
    const chatBackend = createDeltaOnlyBackend('cursor-ahead');
    const manager = new VoiceAgentManager({ createBackend: () => chatBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
        waitForEvents: true,
      });
      cursor = read.nextCursor;
      done = read.done;
      if (!done) {
        await Promise.resolve();
      }
    }
    expect(done).toBe(true);
  });

  it.each([
    { enabled: false, mode: 'immediate' as const },
    { enabled: true, mode: 'immediate' as const },
    { enabled: true, mode: 'on_first_turn' as const },
  ])('delivers admitted reply and greeting policy to the model on seeded and READY paths: %j', async (welcome) => {
    for (const bootstrapMode of ['none', 'ready_handshake'] as const) {
      const backend = createPromptCaptureBackend([
        ...(bootstrapMode === 'ready_handshake' ? [{ responseText: 'READY' }] : []),
        { responseText: 'Bonjour.' },
      ]);
      const manager = new VoiceAgentManager({ createBackend: () => backend });
      try {
        const start = {
          backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
          chatModelId: 'chat-model', commitModelId: 'commit-model',
          permissionIntent: 'read-only' as const, idleTtlSeconds: 60,
          initialContext: 'CTX', bootstrapMode,
          voicePolicy: { assistantLanguage: 'fr-FR', welcome },
        };
        const started = await manager.start(start);
        await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'What should we do?' });
        const prompt = backend.prompts[0];
        expect(prompt).toContain('Reply in fr-FR.');
        if (!welcome.enabled) expect(prompt).toContain('Do not add greeting filler');
        else if (welcome.mode === 'on_first_turn') expect(prompt).toContain('first reply to the user');
        else expect(prompt).toContain('Do not repeat this startup greeting');
      } finally { await manager.dispose(); }
    }
  });

  it('bootstraps new sessions with a READY handshake when bootstrapMode is enabled', async () => {

    const backend = createPromptCaptureBackend([
      { responseText: 'READY' },
      { responseText: 'ok' },
    ]);
    const createBackend: BackendFactory = () => backend;
    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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

  it('strips malformed action markup from the welcome response', async () => {
    const backend = createPromptCaptureBackend([{
      responseText: 'Hello!\n<voice_actions>\n{"actions": [',
    }]);
    const manager = new VoiceAgentManager({ createBackend: () => backend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await expect(manager.welcome({ voiceAgentId: started.voiceAgentId }))
      .resolves.toEqual({ assistantText: 'Hello!' });
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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

  it('refreshes target memory availability even when instruction text is unchanged', async () => {
    const savedSettings = await readSettings();
    await updateSettings(current => ({ ...current, memory: { ...DEFAULT_MEMORY_SETTINGS, enabled: true, enabledAtMs: 1 } }));
    const backend = createPromptCaptureBackend([{ responseText: 'READY' }, { responseText: 'off' }, { responseText: 'on' }]);
    let memoryEnabled = true;
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: async args => await resolveCliVoicePromptPreparation({ ...args,
        sessionMetadata: { work: { memoryEnabled, promptStack: [{ id: 'persona', enabled: true, placement: 'system_append',
          ref: { kind: 'doc', artifactId: 'persona' } }] } },
        readArtifact: async () => ({ id: 'persona', header: { v: 1, kind: 'prompt_doc.v2', title: 'Persona' },
          revision: { headerVersion: 1, bodyVersion: 1 }, body: JSON.stringify({ v: 1, markdown: 'Same bound persona', createdAtMs: 1, updatedAtMs: 1 }) }),
        readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Persona' } }),
      }),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, contextSessionId: 'admitted-target',
        chatModelId: 'chat-model', commitModelId: 'commit-model', permissionIntent: 'read-only',
        idleTtlSeconds: 60, initialContext: 'CTX', bootstrapMode: 'ready_handshake',
      });
      expect(backend.prompts[0]).toContain(buildMemoryRecallGuidanceBlockV1('voice'));
      memoryEnabled = false;
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'memory off' });
      expect(backend.prompts[1]).toContain('Same bound persona');
      expect(backend.prompts[1]).not.toContain(buildMemoryRecallGuidanceBlockV1('voice'));
      memoryEnabled = true;
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'memory on' });
      expect(backend.prompts[2]).toContain(buildMemoryRecallGuidanceBlockV1('voice'));
    } finally { await manager.dispose(); await writeSettings(savedSettings); }
  });

  it.each(['turn', 'stream'] as const)('reads current instruction content again before a %s and keeps unchanged text seeded', async (carrier) => {
    const backend = createPromptCaptureBackend([
      { responseText: 'READY' }, { responseText: 'first' }, { responseText: 'second' },
    ]);
    let markdown = 'Current admitted instruction';
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: createInstructionBlocksResolver(async () => markdown),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        profileId: 'work', contextSessionId: 'admitted-target',
        chatModelId: 'chat-model', commitModelId: 'commit-model', permissionIntent: 'read-only',
        idleTtlSeconds: 60, initialContext: 'CTX', bootstrapMode: 'ready_handshake',
      });
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'first' });
      expect(backend.prompts[1]).not.toContain('Current admitted instruction');
      markdown = 'Edited admitted instruction';
      if (carrier === 'turn') {
        await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'second' });
      } else {
        const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'second' });
        await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
      }
      expect(backend.prompts[2]).toContain('Edited admitted instruction');
      expect(backend.prompts[2]).not.toContain('Current admitted instruction');
    } finally {
      await manager.dispose();
    }
  });

  it('does not install or dispatch a fresh instruction read after the voice instance stops', async () => {
    const backend = createPromptCaptureBackend([{ responseText: 'unused' }]);
    let completeRead!: () => void;
    const pendingRead = new Promise<void>((resolve) => { completeRead = resolve; });
    let reads = 0;
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: createInstructionBlocksResolver(async () => {
        reads += 1;
        if (reads > 1) await pendingRead;
        return 'Admitted target instruction';
      }),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        contextSessionId: 'admitted-target', chatModelId: 'chat-model', commitModelId: 'commit-model',
        permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
      });
      await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
      await vi.waitFor(() => expect(reads).toBe(2));
      const stopped = manager.stop({ voiceAgentId: started.voiceAgentId });
      completeRead();
      await stopped;
      expect(backend.prompts).toEqual([]);
    } finally {
      completeRead();
      await manager.dispose();
    }
  });

  it('reads current instruction content before the supported welcome preparation', async () => {
    const backend = createPromptCaptureBackend([{ responseText: 'READY' }, { responseText: 'hello' }]);
    let markdown = 'STARTUP_DOC_PERSONA_OLD';
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: createInstructionBlocksResolver(async () => markdown),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        contextSessionId: 'admitted-target', chatModelId: 'chat-model', commitModelId: 'commit-model',
        permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX', bootstrapMode: 'ready_handshake',
      });
      markdown = 'Current welcome instruction';
      await manager.welcome({ voiceAgentId: started.voiceAgentId });
      expect(backend.prompts[1]).toContain('Current welcome instruction');
      expect(backend.prompts[1]).not.toContain('STARTUP_DOC_PERSONA_OLD');
    } finally {
      await manager.dispose();
    }
  });
  it.each(['  Literal greeting.\n\n', '   ', ''])('admits exact welcome bytes at the execution Action owner %j', async welcomeText => {
    const backend = createPromptCaptureBackend([{ responseText: 'hello' }]);
    const manager = new VoiceAgentManager({ createRuntime: () => backend });
    try {
      const { voiceAgentId } = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat', commitModelId: 'chat', permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: '' });
      const run: ExecutionRunState = { runId: voiceAgentId, callId: 'call', sidechainId: 'sidechain', sessionId: 'control', depth: 0,
        intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude', instructions: '',
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 0 };
      const controller: ExecutionRunController = { kind: 'voice_agent', controllerOccurrenceId: 'occurrence', voiceAgentId,
        cancelled: false, lastMarkerWriteAtMs: 0, terminalPromise: Promise.resolve(), resolveTerminal: () => {},
        transcript: { persistenceMode: 'ephemeral', epoch: 1 }, externalStreamIdByInternal: new Map(), internalStreamIdByExternal: new Map(),
        pendingTranscriptTurnByExternalStreamId: new Map(), terminalReadByExternalStreamId: new Map(), readInFlightByExternalStreamId: new Map() };
      const result = await applyExecutionRunAction({ runId: voiceAgentId,
        params: { actionId: 'voice_agent.welcome', input: { welcomeText } }, runs: new Map([[voiceAgentId, run]]),
        controllers: new Map([[voiceAgentId, controller]]), voiceAgentManager: manager, parentProvider: 'claude',
        startRun: async () => { throw new Error('Welcome must not start another Run'); } });
      expect(result).toMatchObject({ ok: true });
      expect(backend.prompts[0]).toContain(`exactly this message:\n${welcomeText}\n\nThen, wait`);
    } finally { await manager.dispose(); }
  });

  it('installs current instruction content on the first supported preparation of a resumed runtime', async () => {
    const backend = createPromptCaptureBackend([{ responseText: 'first' }, { responseText: 'second' }], { resumeSupported: true });
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: createInstructionBlocksResolver(async () => 'Current resumed instruction'),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        contextSessionId: 'admitted-target', chatModelId: 'chat-model', commitModelId: 'commit-model',
        permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
        resumeHandle: {
          kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'claude' },
          providerSessionId: 'previous-provider-session',
        },
      });
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'first' });
      expect(backend.prompts[0]).toContain('Current resumed instruction');
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'second' });
      expect(backend.prompts[1]).not.toContain('Current resumed instruction');
    } finally {
      await manager.dispose();
    }
  });

  it('keeps an installed voice runtime retryable after fresh instruction transport fails', async () => {
    const backend = createPromptCaptureBackend([{ responseText: 'READY' }, { responseText: 'recovered' }]);
    let failRead = false;
    let markdown = 'Installed instruction';
    // The HTTP artifact reader propagates this boundary failure, including the
    // temporary "Failed to get artifact" server response.
    const unavailable = new ArtifactEncryptionMaterialUnavailableError();
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: createInstructionBlocksResolver(async () => {
        if (failRead) throw unavailable;
        return markdown;
      }),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        contextSessionId: 'admitted-target', chatModelId: 'chat-model', commitModelId: 'commit-model',
        permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX', bootstrapMode: 'ready_handshake',
      });
      failRead = true;
      await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'retryable' })).rejects.toMatchObject({
        status: 'attachment_unavailable', reason: 'locked', admittedEntries: [{ entryId: 'instruction', outcome: 'unavailable', reason: 'locked' }],
      });
      expect(backend.prompts).toHaveLength(1);
      expect(manager.readCurrentRuntimeAuthority(started.voiceAgentId)?.runtimeState).toBe('idle');
      failRead = false;
      markdown = 'Recovered current instruction';
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'try again' });
      expect(backend.prompts[1]).toContain('Recovered current instruction');
    } finally {
      await manager.dispose();
    }
  });

  it('resolves and forwards voice prompt stack blocks into the READY bootstrap prompt', async () => {

    const backend = createPromptCaptureBackend([
      { responseText: 'READY' },
      { responseText: 'ok' },
    ]);
    const seenArgs: Array<{ profileId?: string | null; sessionId?: string | null; workingDirectory?: string | null }> = [];
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      resolvePromptPreparation: async (args: ResolveVoicePromptPreparationArgs) => {
        seenArgs.push(args);
        return { systemAppendBlocks: ['Voice stack block'], memoryRecallGuidanceEnabled: false, disabledActionIds: [] };
      },
    } as any);

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      resolvePromptPreparation: async () => ({ systemAppendBlocks: ['Voice stack block'], memoryRecallGuidanceEnabled: false, disabledActionIds: [] }),
    } as any);

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
