import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type {
  SessionRuntimeActivityContribution,
  SessionRuntimeActivityContributionHandle,
} from '@/session/runtimeActivity/types';
import { logger } from '@/ui/logger';
import { listExecutionRunMarkers, removeExecutionRunMarker } from '@/daemon/executionRunRegistry';

import { ExecutionRunManager } from './ExecutionRunManager';

async function flushAsyncEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createRuntimeActivityContributionHarness() {
  const reports: SessionRuntimeActivityContribution[] = [];
  return {
    reports,
    handle: {
      report: vi.fn(async (snapshot: SessionRuntimeActivityContribution) => {
        reports.push(snapshot);
      }),
      markUnknown: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } satisfies SessionRuntimeActivityContributionHandle,
  };
}

function createStaticJsonBackend(responseText: string): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_1' as SessionId;
  return {
    async startSession(): Promise<{ sessionId: SessionId }> {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
      handler?.({ type: 'model-output', fullText: responseText } as AgentMessage);
    },
    async cancel(_sessionId: SessionId): Promise<void> {},
    onMessage(next: AgentMessageHandler): void {
      handler = next;
    },
    async dispose(): Promise<void> {},
    async waitForResponseComplete(): Promise<void> {},
  };
}

function createDelayedJsonBackend(responseText: string, delayMs: number): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_1' as SessionId;
  let done: Promise<void> | null = null;
  return {
    async startSession(): Promise<{ sessionId: SessionId }> {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
      done = new Promise((resolve) => {
        setTimeout(() => {
          handler?.({ type: 'model-output', fullText: responseText } as AgentMessage);
          resolve();
        }, delayMs);
      });
    },
    async cancel(_sessionId: SessionId): Promise<void> {},
    onMessage(next: AgentMessageHandler): void {
      handler = next;
    },
    async dispose(): Promise<void> {},
    async waitForResponseComplete(): Promise<void> {
      await (done ?? Promise.resolve());
    },
  };
}

describe('ExecutionRunManager start request idempotency', () => {
  it('settles resumed bounded runs through the same result, activity and marker lifecycle as their initial turn', async () => {
    const contribution = createRuntimeActivityContributionHarness();
    const prompts: string[] = [];
    const loadSession = vi.fn(async (sessionId: SessionId) => ({ sessionId }));
    const disposals: Array<ReturnType<typeof vi.fn>> = [];
    let occurrence = 0;
    const manager = new ExecutionRunManager({
      parentProvider: 'claude', cwd: process.cwd(), sendAcp: () => {},
      runtimeActivityContributionHandle: contribution.handle,
      createBackend: () => {
        const summary = `Complete ${++occurrence}`;
        const backend = createStaticJsonBackend(JSON.stringify({ summary, deliverables: [] }));
        const dispose = vi.fn(async () => {});
        disposals.push(dispose);
        return { ...backend, loadSession, dispose,
          async sendPrompt(sessionId, prompt) {
            prompts.push(prompt);
            await backend.sendPrompt(sessionId, prompt);
          },
        };
      },
    });
    const started = await manager.start({
      sessionId: 'parent-bounded-resume', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'First task', permissionMode: 'read_only', retentionPolicy: 'resumable',
      runClass: 'bounded', ioMode: 'request_response',
    });
    try {
      await manager.waitForTerminal(started.runId);
      for (const message of ['Second task', 'Third task']) {
        await expect(manager.send(started.runId, { message, resume: true })).resolves.toEqual({ ok: true });
        await expect.poll(() => manager.get(started.runId)?.status).toBe('succeeded');
        await manager.waitForTerminal(started.runId);
        expect(manager.getLatestToolResult(started.runId)).toMatchObject({ summary: `Complete ${occurrence}` });
        expect(prompts.at(-1)).toContain(message);
        expect(prompts.at(-1)).toContain('deliverables');
        expect(contribution.reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
        expect((await listExecutionRunMarkers()).find(marker => marker.runId === started.runId))
          .toMatchObject({ status: 'succeeded' });
      }
      expect(loadSession.mock.calls.map(([id]) => id)).toEqual(['child_session_1', 'child_session_1']);
      expect(disposals.every(dispose => dispose.mock.calls.length === 1)).toBe(true);
    } finally {
      await manager.dispose();
      await removeExecutionRunMarker(started.runId);
    }
  });

  it('recreates a terminal resumable occurrence while its original backend disposal is pending', async () => {
    let releaseDisposal!: () => void;
    const disposalGate = new Promise<void>((resolve) => { releaseDisposal = resolve; });
    let markDisposalStarted!: () => void;
    const disposalStarted = new Promise<void>((resolve) => { markDisposalStarted = resolve; });
    const loadSession = vi.fn(async (_sessionId: SessionId) => ({ sessionId: 'child_session_1' as SessionId }));
    const initial = {
      ...createStaticJsonBackend('{"summary":"Complete","deliverables":[]}'),
      loadSession,
      async dispose() { markDisposalStarted(); await disposalGate; },
    };
    const replacement = { ...createStaticJsonBackend('{"summary":"Continued","deliverables":[]}'), loadSession };
    let acquired = 0;
    const manager = new ExecutionRunManager({
      parentProvider: 'claude', cwd: process.cwd(), sendAcp: () => {},
      createBackend: () => acquired++ === 0 ? initial : replacement,
    });
    const started = await manager.start({
      sessionId: 'parent-pending-disposal', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Complete', permissionMode: 'read_only', retentionPolicy: 'resumable',
      runClass: 'bounded', ioMode: 'request_response',
    });
    try {
      await disposalStarted;
      expect(manager.get(started.runId)?.status).toBe('succeeded');
      await expect(manager.send(started.runId, { message: 'Continue', resume: true })).resolves.toEqual({ ok: true });
      expect(acquired).toBe(2);
      expect(loadSession).toHaveBeenCalledWith('child_session_1');
      expect(manager.get(started.runId)?.status).toBe('running');
      releaseDisposal();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(manager.send(started.runId, { message: 'Continue again', resume: true })).resolves.toEqual({ ok: true });
    } finally {
      releaseDisposal();
      await manager.dispose();
    }
  });

  it('keeps a waiter from the first running publication pending until canonical terminal state', async () => {
    const backend = createStaticJsonBackend('{"summary":"unused","findings":[]}');
    backend.sendPrompt = async () => {};
    backend.waitForResponseComplete = async () => await new Promise<void>(() => {});
    let manager!: ExecutionRunManager;
    let waiter: Promise<void> | null = null;
    let waiterSettled = false;
    manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: () => {},
      onPublicStateUpdated: (run) => {
        if (run.status !== 'running' || waiter) return;
        waiter = manager.waitForTerminal(run.runId);
        void waiter.then(() => {
          waiterSettled = true;
        });
      },
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Wait for stop.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    await flushAsyncEffects();
    expect(waiter).not.toBeNull();
    expect(waiterSettled).toBe(false);

    await manager.stop(started.runId);
    await expect(waiter).resolves.toBeUndefined();
    expect(waiterSettled).toBe(true);
  });

  it('detaches a cancelled terminal wait observer while leaving the run active', async () => {
    const backend = createStaticJsonBackend('{"summary":"unused","findings":[]}');
    backend.sendPrompt = async () => {};
    backend.waitForResponseComplete = async () => await new Promise<void>(() => {});
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: () => {},
    });
    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Wait for stop.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    const abort = new AbortController();
    const removeAbortListener = vi.spyOn(abort.signal, 'removeEventListener');
    const wait = manager.waitForTerminal(started.runId, { signal: abort.signal });
    const terminalStateWaiters = (manager as unknown as {
      terminalStateWaiters: Map<string, Set<unknown>>;
    }).terminalStateWaiters;
    expect(terminalStateWaiters.get(started.runId)?.size).toBe(1);

    const cancellation = new Error('caller stopped waiting');
    abort.abort(cancellation);

    const outcome = await Promise.race([
      wait.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'still_waiting' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'still_waiting' }), 50);
      }),
    ]);
    expect(outcome).toEqual({ kind: 'rejected', error: cancellation });
    expect(manager.get(started.runId)?.status).toBe('running');
    expect(terminalStateWaiters.has(started.runId)).toBe(false);

    await manager.stop(started.runId);
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('does not gate stop acknowledgement or terminal observation on a pending runtime-activity projection', async () => {
    let reportCount = 0;
    const backend = createStaticJsonBackend('{"summary":"unused","findings":[]}');
    backend.sendPrompt = async () => {};
    backend.waitForResponseComplete = async () => await new Promise<void>(() => {});
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: () => {},
      runtimeActivityContributionHandle: {
        report: vi.fn(async () => {
          reportCount += 1;
          if (reportCount > 1) await new Promise<void>(() => {});
        }),
        markUnknown: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      },
    });
    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Wait for stop.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    const terminal = manager.waitForTerminal(started.runId);

    const stopOutcome = await Promise.race([
      manager.stop(started.runId),
      new Promise<'still_stopping'>((resolve) => setTimeout(() => resolve('still_stopping'), 2_000)),
    ]);

    expect(stopOutcome).toEqual({ ok: true });
    await expect(terminal).resolves.toBeUndefined();
    expect(manager.get(started.runId)?.status).toBe('cancelled');
  });

  it('logs a rejected terminal runtime-activity projection without changing stop acknowledgement', async () => {
    let reportCount = 0;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const backend = createStaticJsonBackend('{"summary":"unused","findings":[]}');
    backend.sendPrompt = async () => {};
    backend.waitForResponseComplete = async () => await new Promise<void>(() => {});
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: () => {},
      runtimeActivityContributionHandle: {
        report: vi.fn(async () => {
          reportCount += 1;
          if (reportCount > 1) throw new Error('projection unavailable');
        }),
        markUnknown: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      },
    });
    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Wait for stop.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    try {
      await expect(manager.stop(started.runId)).resolves.toEqual({ ok: true });
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
        '[EXECUTION RUN] Failed to publish terminal runtime activity',
        expect.objectContaining({ runId: started.runId, error: 'projection unavailable' }),
      ));
    } finally {
      warn.mockRestore();
    }
  });

  it('returns the same run handle for the same correlated start without creating a duplicate backend', async () => {
    const createBackend = vi.fn(() => createStaticJsonBackend('{"summary":"ok","findings":[]}'));
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend,
      sendAcp: () => {},
    });
    const request = {
      sessionId: 'parent_session_1',
      intent: 'review' as const,
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral' as const,
      runClass: 'bounded' as const,
      ioMode: 'request_response' as const,
      startRequestId: 'action-request-1',
      startRequestFingerprint: 'fingerprint-1',
    };

    const first = await manager.start(request);
    const retry = await manager.start(request);

    expect(retry).toEqual(first);
    expect(createBackend).toHaveBeenCalledOnce();
  });

  it('rejects conflicting reuse of a correlated start request id', async () => {
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createStaticJsonBackend('{"summary":"ok","findings":[]}'),
      sendAcp: () => {},
    });
    const base = {
      sessionId: 'parent_session_1',
      intent: 'review' as const,
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral' as const,
      runClass: 'bounded' as const,
      ioMode: 'request_response' as const,
      startRequestId: 'action-request-1',
    };
    await manager.start({ ...base, startRequestFingerprint: 'fingerprint-1' });

    await expect(manager.start({
      ...base,
      instructions: 'Different work.',
      startRequestFingerprint: 'fingerprint-2',
    })).rejects.toMatchObject({ code: 'execution_run_start_conflict' });
  });
});

function createReviewResumeBackend(): Readonly<{
  backend: AgentBackend;
  prompts: string[];
  loadSessionCalls: string[];
  vendorSessionId: string;
}> {
  let handler: AgentMessageHandler | null = null;
  const prompts: string[] = [];
  const loadSessionCalls: string[] = [];
  const vendorSessionId = 'vendor_review_1';

  const backend: AgentBackend = {
    async startSession(): Promise<{ sessionId: SessionId }> {
      return { sessionId: 'child_session_1' as SessionId };
    },
    async loadSession(sessionId: string): Promise<{ sessionId: SessionId }> {
      loadSessionCalls.push(sessionId);
      return { sessionId: 'child_session_resumed' as SessionId };
    },
    async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
      prompts.push(prompt);
      if (prompts.length === 1) {
        handler?.({ type: 'event', name: 'vendor_session_id', payload: { sessionId: vendorSessionId } } as AgentMessage);
        handler?.({
          type: 'model-output',
          fullText: JSON.stringify({
            summary: 'Initial summary.',
            overviewMarkdown: '## Overview\n\nInitial overview.',
            findings: [
              {
                id: 'f1',
                title: 'Example',
                severity: 'low',
                category: 'style',
                summary: 'One paragraph.',
              },
            ],
            questions: [],
            assumptions: [],
          }),
        } as AgentMessage);
        return;
      }

      handler?.({
        type: 'model-output',
        fullText: JSON.stringify({
          answerMarkdown: 'Clarified answer.',
          updatedFindings: [
            {
              id: 'f1',
              title: 'Example',
              severity: 'medium',
              category: 'correctness',
              summary: 'Updated summary.',
              whyItMatters: 'Now clearly broken.',
              evidence: 'Confirmed locally.',
              confidence: 0.9,
            },
          ],
          questions: [],
          assumptions: [],
        }),
      } as AgentMessage);
    },
    async cancel(_sessionId: SessionId): Promise<void> {},
    onMessage(next: AgentMessageHandler): void {
      handler = next;
    },
    async dispose(): Promise<void> {},
    async waitForResponseComplete(): Promise<void> {},
  };

  return { backend, prompts, loadSessionCalls, vendorSessionId };
}

describe('ExecutionRunManager (review intent)', () => {
  it('emits SubAgentRun tool-call, sidechain message, and tool-result with review_findings.v2 meta', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    let lastPrompt = '';
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: (_opts: { backendId: string; permissionMode: string }) =>
        ({
          async startSession() {
            return { sessionId: 'child_session_1' as SessionId };
          },
          async sendPrompt(_sessionId: SessionId, prompt: string) {
            lastPrompt = prompt;
            // Defer to keep the completion async (closer to real backends).
            await new Promise((r) => setTimeout(r, 5));
            (this as any)._handler?.({
              type: 'tool-call',
              toolName: 'read_file',
              callId: 't1',
              args: { path: 'README.md' },
            } satisfies any);
            (this as any)._handler?.({
              type: 'tool-result',
              toolName: 'read_file',
              callId: 't1',
              result: 'OK',
            } satisfies any);
            (this as any)._handler?.({
              type: 'model-output',
              fullText: JSON.stringify({
                findings: [
                  {
                    id: 'f1',
                    title: 'Example',
                    severity: 'low',
                    category: 'style',
                    summary: 'One paragraph.',
                  },
                ],
                summary: 'Summary.',
              }),
            } satisfies any);
          },
          async cancel(_sessionId: SessionId) {},
          onMessage(next: AgentMessageHandler) {
            (this as any)._handler = next;
          },
          async dispose() {},
          async waitForResponseComplete() {},
        } as any),
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      launchOrigin: { kind: 'session', sessionId: 'initiating_session_2' },
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      modelId: 'claude-opus-5',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 1,
        overrides: {
          reasoning_effort: { updatedAt: 1, value: 'high' },
          api_token: { updatedAt: 1, value: 'must-not-survive' },
        },
      },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(started.runId).toMatch(/^run_/);
    expect(started.callId).toMatch(/^subagent_run_/);
    expect(started.requestedConfiguration).toEqual({
      modelId: 'claude-opus-5',
      reasoningEffort: 'high',
    });

    // Wait for completion since the fake backend is async.
    await manager.waitForTerminal(started.runId);
    const final = manager.get(started.runId);
    expect(final?.status).toBe('succeeded');
    expect(manager.getPublic(started.runId)).toMatchObject({
      status: 'succeeded',
      launchOrigin: { kind: 'session', sessionId: 'initiating_session_2' },
      requestedConfiguration: {
        modelId: 'claude-opus-5',
        reasoningEffort: 'high',
      },
    });
    // Prompt contract: review runs must include a strict JSON output schema.
    expect(lastPrompt).toContain('"findings"');

    const toolCall = sent.find((m) => (m.body as any)?.type === 'tool-call');
    expect(toolCall).toBeTruthy();
    expect((toolCall?.body as any).name).toBe('SubAgentRun');
    expect((toolCall?.body as any)?.input?.runId).toBe(started.runId);
    expect((toolCall?.body as any)?.input?.launchOrigin).toEqual({
      kind: 'session',
      sessionId: 'initiating_session_2',
    });
    expect((toolCall?.body as any)?.input?.requestedConfiguration).toEqual({
      modelId: 'claude-opus-5',
      reasoningEffort: 'high',
    });
    expect(JSON.stringify(started)).not.toContain('must-not-survive');
    expect(JSON.stringify(manager.getPublic(started.runId))).not.toContain('must-not-survive');
    expect(JSON.stringify((toolCall?.body as any)?.input)).not.toContain('must-not-survive');

    const sidechainToolCall = sent.find((m) => (m.body as any)?.type === 'tool-call' && (m.body as any)?.name === 'read_file');
    expect(sidechainToolCall).toBeTruthy();
    expect((sidechainToolCall?.body as any)?.sidechainId).toBe(started.callId);
    expect((sidechainToolCall?.body as any)?.callId).toBe(`sc:${started.callId}:t1`);

    const sidechainToolResult = sent.find((m) => (m.body as any)?.type === 'tool-result' && (m.body as any)?.callId === `sc:${started.callId}:t1`);
    expect(sidechainToolResult).toBeTruthy();
    expect((sidechainToolResult?.body as any)?.sidechainId).toBe(started.callId);

    const sidechain = sent.find((m) => (m.body as any)?.type === 'message');
    expect((sidechain?.body as any)?.message).toContain('Summary.');
    // Sidechain message must not leak the strict JSON payload.
    expect(String((sidechain?.body as any)?.message ?? '')).not.toContain('"findings"');

    const toolResult = [...sent].reverse().find((m) => (m.body as any)?.type === 'tool-result');
    expect(toolResult).toBeTruthy();
    const meta = toolResult?.meta as any;
    expect(meta?.happier?.kind).toBe('review_findings.v2');
  });

  it('enqueues opted-in parent completion through Session input without replacing tool-result metadata', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];
    const parentInputs: Array<{ text: string; meta?: Record<string, unknown> }> = [];
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createDelayedJsonBackend(JSON.stringify({ findings: [], summary: 'done' }), 1),
      sendAcp: (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ body, meta: opts?.meta });
      },
      enqueueParentSessionInput: async (input) => {
        parentInputs.push(input);
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const silent = await manager.start({
      sessionId: 'parent_session_0',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    await manager.waitForTerminal(silent.runId);
    expect(parentInputs).toHaveLength(0);

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
      accountSettings: { executionRunsNotifyParentOnCompletionDefault: true },
    });
    await manager.waitForTerminal(started.runId);

    expect(parentInputs).toHaveLength(1);
    expect(parentInputs[0]?.text).toContain(started.runId);
    expect(parentInputs[0]?.text).toContain('Final result:\ndone');
    expect((parentInputs[0]?.meta as any)?.happierStructuredInputV1).toMatchObject({
      v: 1,
      executionRunCompletion: {
        v: 1,
        runId: started.runId,
        status: 'succeeded',
        canInspect: true,
        summary: 'done',
      },
    });
    const toolResult = [...sent].reverse().find((m) => (m.body as any)?.type === 'tool-result');
    expect((toolResult?.meta as any)?.happier?.kind).toBe('review_findings.v2');
  });

  it('prefers a per-run bounded timeout over the manager default for bounded review runs', async () => {
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createDelayedJsonBackend(JSON.stringify({ findings: [], summary: 'late' }), 30),
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
      boundedTimeoutMs: 10,
    });

    const startParams = {
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      boundedTimeoutMs: 100,
    } as const;

    const started = await manager.start(startParams);
    await manager.waitForTerminal(started.runId);

    expect(manager.get(started.runId)?.status).toBe('succeeded');
  });

  it('returns start() before backend session provisioning completes (UI can dismiss draft immediately)', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];

    let handler: AgentMessageHandler | null = null;
    let startSessionCalled = false;
    let startSessionResolved = false;
    let resolveStartSession!: (value: { sessionId: SessionId }) => void;
    const startSessionPromise: Promise<{ sessionId: SessionId }> = new Promise((resolve) => {
      resolveStartSession = (value) => {
        startSessionResolved = true;
        resolve(value);
      };
    });

    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        startSessionCalled = true;
        return await startSessionPromise;
      },
      async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
        handler?.({
          type: 'model-output',
          fullText: JSON.stringify({ summary: 'Ok', findings: [] }),
        } as any);
      },
      async cancel(_sessionId: SessionId): Promise<void> {},
      onMessage(next: AgentMessageHandler): void {
        handler = next;
      },
      async dispose(): Promise<void> {},
      async waitForResponseComplete(): Promise<void> {},
    };

    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const startPromise = manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    // Prevent deadlocks if start() ever regresses to awaiting backend.startSession().
    // The assertion below (startSessionResolved === false) proves start() returned before provisioning completed.
    const autoResolveStartSession = setTimeout(() => {
      resolveStartSession({ sessionId: 'child_session_1' as SessionId });
    }, 2_000);

    const started = await startPromise;
    clearTimeout(autoResolveStartSession);

    expect(startSessionCalled).toBe(true);
    expect(startSessionResolved).toBe(false);

    // Now allow the run to proceed and complete so the test doesn't leak background work.
    if (!startSessionResolved) {
      resolveStartSession({ sessionId: 'child_session_1' as SessionId });
    }
    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('succeeded');
  });

  it('reports complete execution-run contributions from the canonical run map and isolates sibling completion', async () => {
    const contribution = createRuntimeActivityContributionHarness();
    const completions: Array<() => void> = [];
    const createBackend = (): AgentBackend => {
      let handler: AgentMessageHandler | null = null;
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => {
        complete = () => {
          handler?.({
            type: 'model-output',
            fullText: JSON.stringify({ summary: 'Ok', findings: [] }),
          } as AgentMessage);
          resolve();
        };
      });
      completions.push(complete);
      return {
        async startSession() { return { sessionId: `child-${completions.length}` as SessionId }; },
        async sendPrompt() { await completed; },
        async cancel() { complete(); },
        onMessage(next) { handler = next; },
        async dispose() {},
        async waitForResponseComplete() {},
      };
    };
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend,
      sendAcp: () => {},
      getNowMs: () => 20_000,
      runtimeActivityContributionHandle: contribution.handle,
    });
    const start = async () => await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    const first = await start();
    const second = await start();
    expect(contribution.reports).toContainEqual({ state: 'active', activeCount: 1 });
    expect(contribution.reports.at(-1)).toEqual({ state: 'active', activeCount: 2 });

    completions[0]!();
    await manager.waitForTerminal(first.runId);
    expect(contribution.reports.at(-1)).toEqual({
      state: 'active', activeCount: 1,
    });

    completions[1]!();
    await manager.waitForTerminal(second.runId);
    expect(contribution.reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
  });

  it('rolls back only the exact provisional start when complete-contribution admission fails', async () => {
    const contribution = createRuntimeActivityContributionHarness();
    contribution.handle.report.mockRejectedValueOnce(new Error('activity report rejected'));
    const createBackend = vi.fn(() => createStaticJsonBackend('{"summary":"should not run","findings":[]}'));
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend,
      sendAcp: () => {},
      runtimeActivityContributionHandle: contribution.handle,
    });

    await expect(manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    })).rejects.toThrow('activity report rejected');

    expect(createBackend).not.toHaveBeenCalled();
    expect(manager.getRunningCount()).toBe(0);
    expect(contribution.reports).toEqual([{ state: 'idle', activeCount: 0 }]);
  });

  it('forwards terminal output + file edits into the run sidechain transcript', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];

    let handler: AgentMessageHandler | null = null;
    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        return { sessionId: 'child_session_1' as SessionId };
      },
      async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
        handler?.({ type: 'terminal-output', data: 'hello from terminal' } as any);
        handler?.({
          type: 'fs-edit',
          description: 'Edited README',
          path: 'README.md',
          diff: 'diff --git a/README.md b/README.md',
        } as any);
        handler?.({
          type: 'model-output',
          fullText: JSON.stringify({ summary: 'Ok', findings: [] }),
        } as any);
      },
      async cancel(_sessionId: SessionId): Promise<void> {},
      onMessage(next: AgentMessageHandler): void {
        handler = next;
      },
      async dispose(): Promise<void> {},
      async waitForResponseComplete(): Promise<void> {},
    };

    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await manager.waitForTerminal(started.runId);

    const terminal = sent.find((m) => (m.body as any)?.type === 'terminal-output')?.body as any;
    expect(terminal).toBeTruthy();
    expect(terminal.sidechainId).toBe(started.callId);
    expect(String(terminal.callId ?? '')).toBe(`sc:${started.callId}:happier:terminal-output`);
    expect(terminal.data).toBe('hello from terminal');

    const terminalToolCall = sent.find(
      (m) => (m.body as any)?.type === 'tool-call' && (m.body as any)?.callId === terminal.callId,
    )?.body as any;
    expect(terminalToolCall).toBeTruthy();
    expect(terminalToolCall.name).toBe('terminal-output');
    expect(terminalToolCall.sidechainId).toBe(started.callId);

    const fileEdit = sent.find((m) => (m.body as any)?.type === 'file-edit')?.body as any;
    expect(fileEdit).toBeTruthy();
    expect(fileEdit.sidechainId).toBe(started.callId);
    expect(fileEdit.filePath).toBe('README.md');
    expect(fileEdit.description).toBe('Edited README');
  });

  it('repairs non-json review output by requesting a strict JSON reformat once', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const prompts: string[] = [];

    let handler: AgentMessageHandler | null = null;
    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        return { sessionId: 'child_session_1' as SessionId };
      },
      async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
        prompts.push(prompt);
        // First attempt: model violates contract (no JSON).
        if (prompts.length === 1) {
          handler?.({ type: 'model-output', fullText: 'Not JSON, sorry.' } as any);
          return;
        }
        // Second attempt: obey strict JSON.
        handler?.({
          type: 'model-output',
          fullText: JSON.stringify({ summary: 'Ok', findings: [] }),
        } as any);
      },
      async cancel(_sessionId: SessionId): Promise<void> {},
      onMessage(next: AgentMessageHandler): void {
        handler = next;
      },
      async dispose(): Promise<void> {},
      async waitForResponseComplete(): Promise<void> {},
    };

    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('succeeded');
    expect(prompts.length).toBe(2);
    // Repair prompts must still require a bare JSON object as the final response.
    expect(prompts[1]).toContain('valid JSON');
    expect(prompts[1]).toContain('JSON.parse');
    expect(prompts[1]).toContain('Do not wrap it in markdown code fences');
  });

  it('can apply review triage and re-emit review_findings.v2 meta updates', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: (_opts: { backendId: string; permissionMode: string }) =>
        createStaticJsonBackend(
          JSON.stringify({
            findings: [
              {
                id: 'f1',
                title: 'Example',
                severity: 'low',
                category: 'style',
                summary: 'One paragraph.',
              },
            ],
            summary: 'Summary.',
          }),
        ),
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    await manager.waitForTerminal(started.runId);

    const result = await manager.applyAction(started.runId, {
      actionId: 'review.triage',
      input: {
        findings: [{ id: 'f1', status: 'accept', comment: 'Ship it.' }],
      },
    });
    expect(result.ok).toBe(true);

    const toolResult = [...sent].reverse().find((m) => (m.body as any)?.type === 'tool-result' && m.meta);
    expect(toolResult).toBeTruthy();
    const meta = toolResult?.meta as any;
    expect(meta?.happier?.kind).toBe('review_findings.v2');
    expect(meta?.happier?.payload?.triage?.findings?.[0]?.status).toBe('accept');
  });

  it('commits review triage tool-result meta updates durably when a transcript commit session is available', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const commits: Array<{ provider: string; body: unknown; localId: string; meta?: Record<string, unknown> }> = [];
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: (_opts: { backendId: string; permissionMode: string }) =>
        createStaticJsonBackend(
          JSON.stringify({
            findings: [
              {
                id: 'f1',
                title: 'Example',
                severity: 'low',
                category: 'style',
                summary: 'One paragraph.',
              },
            ],
            summary: 'Summary.',
          }),
        ),
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      streamedTranscriptSession: {
        sendAgentMessageCommitted: async (provider, body, opts) => {
          commits.push({ provider, body, localId: opts.localId, meta: opts.meta });
        },
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    await manager.waitForTerminal(started.runId);
    const sentBeforeAction = sent.length;
    const commitsBeforeAction = commits.length;

    const result = await manager.applyAction(started.runId, {
      actionId: 'review.triage',
      input: {
        findings: [{ id: 'f1', status: 'reject', comment: 'Ignore for now.' }],
      },
    });
    expect(result.ok).toBe(true);

    const committedToolResult = commits
      .slice(commitsBeforeAction)
      .reverse()
      .find((m) => (m.body as any)?.type === 'tool-result' && m.meta);
    expect(committedToolResult).toBeTruthy();
    const committedMeta = committedToolResult?.meta as any;
    expect(committedMeta?.happier?.kind).toBe('review_findings.v2');
    expect(committedMeta?.happier?.payload?.triage?.findings?.[0]?.status).toBe('reject');

    const bestEffortMetaToolResult = sent
      .slice(sentBeforeAction)
      .reverse()
      .find((m) => (m.body as any)?.type === 'tool-result' && m.meta);
    expect(bestEffortMetaToolResult).toBeUndefined();
  });

  it('falls back to best-effort review triage meta updates when the durable transcript commit fails', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const commits: Array<{ provider: string; body: unknown; localId: string; meta?: Record<string, unknown> }> = [];
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: (_opts: { backendId: string; permissionMode: string }) =>
        createStaticJsonBackend(
          JSON.stringify({
            findings: [
              {
                id: 'f1',
                title: 'Example',
                severity: 'low',
                category: 'style',
                summary: 'One paragraph.',
              },
            ],
            summary: 'Summary.',
          }),
        ),
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      streamedTranscriptSession: {
        sendAgentMessageCommitted: async (provider, body, opts) => {
          commits.push({ provider, body, localId: opts.localId, meta: opts.meta });
          throw new Error('commit failed');
        },
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    await manager.waitForTerminal(started.runId);
    const sentBeforeAction = sent.length;
    const commitsBeforeAction = commits.length;

    const result = await manager.applyAction(started.runId, {
      actionId: 'review.triage',
      input: {
        findings: [{ id: 'f1', status: 'needs_refinement', comment: 'Need more evidence.' }],
      },
    });
    expect(result.ok).toBe(true);
    expect(commits.slice(commitsBeforeAction)).toHaveLength(1);

    const fallbackToolResult = sent
      .slice(sentBeforeAction)
      .reverse()
      .find((m) => (m.body as any)?.type === 'tool-result' && m.meta);
    expect(fallbackToolResult).toBeTruthy();
    const fallbackMeta = fallbackToolResult?.meta as any;
    expect(fallbackMeta?.happier?.kind).toBe('review_findings.v2');
    expect(fallbackMeta?.happier?.payload?.triage?.findings?.[0]?.status).toBe('needs_refinement');
  });

  it('starts a resumable review follow-up child run that reuses the original vendor session', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const { backend, prompts, loadSessionCalls, vendorSessionId } = createReviewResumeBackend();
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'streaming',
    });
    await manager.waitForTerminal(started.runId);

    expect((manager.get(started.runId)?.resumeHandle as any)?.vendorSessionId).toBe(vendorSessionId);

    const followUp = await manager.applyAction(started.runId, {
      actionId: 'review.follow_up',
      input: {
        findingIds: ['f1'],
        messageMarkdown: 'Please clarify why this matters.',
      },
    });

    expect(followUp.ok).toBe(true);
    const followUpRunId = String((followUp as any).result?.runId ?? '');
    expect(followUpRunId).not.toBe('');
    await manager.waitForTerminal(followUpRunId);

    expect(loadSessionCalls).toEqual([vendorSessionId]);
    expect(prompts.at(-1)).toContain('Please clarify why this matters.');
    expect(manager.getStructuredMeta(followUpRunId)?.kind).toBe('review_follow_up.v1');
    expect((manager.getStructuredMeta(followUpRunId) as any)?.payload?.requestMarkdown).toBe('Please clarify why this matters.');
  });

  it('falls back to a linked child review run without resume support and reconstructs follow-up context', async () => {
    const prompts: string[] = [];
    let handler: AgentMessageHandler | null = null;
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () =>
        ({
          async startSession() {
            return { sessionId: `child_session_${prompts.length + 1}` as SessionId };
          },
          async sendPrompt(_sessionId: SessionId, prompt: string) {
            prompts.push(prompt);
            if (prompts.length === 1) {
              handler?.({
                type: 'model-output',
                fullText: JSON.stringify({
                  summary: 'Initial summary.',
                  overviewMarkdown: '## Overview\n\nInitial overview.',
                  findings: [
                    {
                      id: 'f1',
                      title: 'Example',
                      severity: 'low',
                      category: 'style',
                      summary: 'One paragraph.',
                    },
                  ],
                  questions: [],
                  assumptions: [],
                }),
              } as AgentMessage);
              return;
            }

            handler?.({
              type: 'model-output',
              fullText: JSON.stringify({
                answerMarkdown: 'Fallback answer.',
                questions: [],
                assumptions: [],
              }),
            } as AgentMessage);
          },
          async cancel(_sessionId: SessionId) {},
          onMessage(next: AgentMessageHandler) {
            handler = next;
          },
          async dispose() {},
          async waitForResponseComplete() {},
        } as any),
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });
    await manager.waitForTerminal(started.runId);

    const followUp = await manager.applyAction(started.runId, {
      actionId: 'review.follow_up',
      input: {
        findingIds: ['f1'],
        messageMarkdown: 'Please clarify the impact.',
      },
    });
    expect(followUp.ok).toBe(true);

    const followUpRunId = String((followUp as any).result?.runId ?? '');
    await manager.waitForTerminal(followUpRunId);

    expect(prompts.at(-1)).toContain('Current review summary:');
    expect(prompts.at(-1)).toContain('Please clarify the impact.');
    expect(prompts.at(-1)).toContain('"id": "f1"');
    expect(manager.getStructuredMeta(followUpRunId)?.kind).toBe('review_follow_up.v1');
  });

  it('does not synthesize a resumable handle for backends without resume support and rejects review follow-up', async () => {
    const prompts: string[] = [];
    let handler: AgentMessageHandler | null = null;
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () =>
        ({
          async startSession() {
            return { sessionId: `child_session_${prompts.length + 1}` as SessionId };
          },
          async sendPrompt(_sessionId: SessionId, prompt: string) {
            prompts.push(prompt);
            if (prompts.length === 1) {
              handler?.({
                type: 'model-output',
                fullText: JSON.stringify({
                  summary: 'Initial summary.',
                  overviewMarkdown: '## Overview\n\nInitial overview.',
                  findings: [
                    {
                      id: 'f1',
                      title: 'Example',
                      severity: 'low',
                      category: 'style',
                      summary: 'One paragraph.',
                    },
                  ],
                  questions: [],
                  assumptions: [],
                }),
              } as AgentMessage);
              return;
            }

            handler?.({
              type: 'model-output',
              fullText: JSON.stringify({
                answerMarkdown: 'Fallback answer.',
                questions: [],
                assumptions: [],
              }),
            } as AgentMessage);
          },
          async cancel(_sessionId: SessionId) {},
          onMessage(next: AgentMessageHandler) {
            handler = next;
          },
          async dispose() {},
          async waitForResponseComplete() {},
        } as any),
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'streaming',
    });
    await manager.waitForTerminal(started.runId);

    expect(manager.get(started.runId)?.resumeHandle ?? null).toBeNull();

    const followUp = await manager.applyAction(started.runId, {
      actionId: 'review.follow_up',
      input: {
        findingIds: ['f1'],
        messageMarkdown: 'Please clarify the impact.',
      },
    });
    expect(followUp.ok).toBe(false);
    expect((followUp as any).errorCode).toBe('execution_run_action_not_supported');
  });

  it('can stop a running execution run and emit a terminal tool-result', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: (_opts: { backendId: string; permissionMode: string }) =>
        createDelayedJsonBackend(JSON.stringify({ summary: 'late', findings: [] }), 50_000),
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    const stopped = await manager.stop(started.runId);
    expect(stopped.ok).toBe(true);
    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('cancelled');

    const toolResult = [...sent].reverse().find((m) => (m.body as any)?.type === 'tool-result');
    expect((toolResult?.body as any)?.output?.status).toBe('cancelled');
  });

  it('does not synthesize a resumable resumeHandle from vendor_session_id events when the backend cannot resume', async () => {
    const vendorSessionId: SessionId = '1433467f-ff14-4292-b5b2-2aac77a808f0' as SessionId;

    let handler: AgentMessageHandler | null = null;
    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        return { sessionId: 'placeholder_session' as SessionId };
      },
      async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
        handler?.({ type: 'event', name: 'vendor_session_id', payload: { sessionId: vendorSessionId } } as AgentMessage);
        handler?.({ type: 'model-output', fullText: JSON.stringify({ findings: [], summary: 'ok' }) } as AgentMessage);
      },
      async cancel(_sessionId: SessionId): Promise<void> {},
      onMessage(next: AgentMessageHandler): void {
        handler = next;
      },
      async dispose(): Promise<void> {},
      async waitForResponseComplete(): Promise<void> {},
    };

    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await manager.waitForTerminal(started.runId);

    const finished = manager.get(started.runId);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.resumeHandle ?? null).toBeNull();
  });
});

describe('ExecutionRunManager (memory_hints intent)', () => {
  it('does not materialize tool-call/tool-result or sidechain messages in the carrier transcript', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createStaticJsonBackend('{"ok":true}'),
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'memory_hints',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Return JSON only.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await manager.waitForTerminal(started.runId);
    const final = manager.get(started.runId);
    expect(final?.status).toBe('succeeded');
    expect(sent).toEqual([]);
  });
});

describe('ExecutionRunManager (streaming sidechain)', () => {
  it('emits streaming sidechain chunks for model-output when ioMode=streaming', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const commits: Array<{
      provider: string;
      body: unknown;
      localId: string;
      meta?: Record<string, unknown>;
    }> = [];

    let handler: AgentMessageHandler | null = null;
    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        return { sessionId: 'child_session_1' as SessionId };
      },
      async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
        handler?.({ type: 'model-output', fullText: 'Plan in progress.\n' } as any);
        handler?.({
          type: 'model-output',
          fullText:
            'Plan in progress.\n' +
            JSON.stringify({
              summary: 'Ok',
              sections: [{ title: 'One', items: ['A'] }],
              risks: [],
              milestones: [],
            }),
        } as any);
      },
      async cancel(_sessionId: SessionId): Promise<void> {},
      onMessage(next: AgentMessageHandler): void {
        handler = next;
      },
      async dispose(): Promise<void> {},
      async waitForResponseComplete(): Promise<void> {},
    };

    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      streamedTranscriptSession: {
        sendAgentMessageCommitted: async (provider, body, opts) => {
          commits.push({ provider, body, localId: opts.localId, meta: opts.meta });
        },
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'plan',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Make a plan.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });

    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('succeeded');

    const sidechainCommits = commits.filter(
      (row) => (row.body as any)?.type === 'message' && (row.body as any)?.sidechainId === started.sidechainId,
    );
    expect(sidechainCommits.length).toBeGreaterThanOrEqual(1);
    const concatenatedStreamingText = sidechainCommits.map((row) => String((row.body as any)?.message ?? '')).join('');
    expect(concatenatedStreamingText).toContain('Plan in progress');
    expect((sidechainCommits[0]?.meta as any)?.happierStreamSegmentV1?.segmentState).toBe('streaming');
    const finalCommit = sidechainCommits[sidechainCommits.length - 1]!;
    expect((finalCommit.meta as any)?.happierStreamSegmentV1?.segmentState).toBe('complete');

    // When streaming output is emitted, the bounded completion should not inject a duplicate
    // "final" sidechain message in addition to the streaming segment.
    const nonStreamingSidechainMessages = sent.filter((m) => (m.body as any)?.type === 'message' && (m.body as any)?.sidechainId === started.sidechainId);
    expect(nonStreamingSidechainMessages).toHaveLength(0);
  });

  it('streams review progress without leaking the trailing strict JSON payload', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const commits: Array<{
      provider: string;
      body: unknown;
      localId: string;
      meta?: Record<string, unknown>;
    }> = [];

    let handler: AgentMessageHandler | null = null;
    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        return { sessionId: 'child_session_1' as SessionId };
      },
      async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
        handler?.({
          type: 'model-output',
          fullText: 'Working...\n\n{ "summary": "Ok", ',
        } as any);
        handler?.({
          type: 'model-output',
          fullText:
            'Working...\n\n' +
            JSON.stringify({
              summary: 'Ok',
              findings: [],
            }),
        } as any);
      },
      async cancel(_sessionId: SessionId): Promise<void> {},
      onMessage(next: AgentMessageHandler): void {
        handler = next;
      },
      async dispose(): Promise<void> {},
      async waitForResponseComplete(): Promise<void> {},
    };

    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      streamedTranscriptSession: {
        sendAgentMessageCommitted: async (provider, body, opts) => {
          commits.push({ provider, body, localId: opts.localId, meta: opts.meta });
        },
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });

    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('succeeded');

    const sidechainCommits = commits.filter(
      (row) => (row.body as any)?.type === 'message' && (row.body as any)?.sidechainId === started.sidechainId,
    );
    expect(sidechainCommits.length).toBeGreaterThanOrEqual(1);

    const concatenatedStreamingText = sidechainCommits.map((row) => String((row.body as any)?.message ?? '')).join('');
    expect(concatenatedStreamingText).toContain('Working');
    expect(concatenatedStreamingText).not.toContain('"findings"');

    // A final summary message is still allowed so users get a clear terminal note.
    const finalNonStreaming = sent.find(
      (m) => (m.body as any)?.type === 'message' && (m.body as any)?.sidechainId === started.sidechainId,
    );
    expect(String((finalNonStreaming?.body as any)?.message ?? '')).toContain('Ok');
  });
});

describe('ExecutionRunManager (long-lived runs)', () => {
  it('reports current work while retaining idle handles across sibling turns and resume', async () => {
    const contribution = createRuntimeActivityContributionHarness();
    const completions: Array<() => void> = [];
    const observedTurns = new Map<string, boolean | undefined>();
    const createBackend = (): AgentBackend => {
      let complete: (() => void) | undefined;
      let response = Promise.resolve();
      return {
        async startSession() { return { sessionId: `child-${completions.length}` as SessionId }; },
        async loadSessionWithReplayCapture(sessionId) { return { sessionId, replay: [] }; },
        async sendPrompt() {
          response = new Promise<void>((resolve) => { complete = resolve; });
          completions.push(() => complete?.());
        },
        async waitForResponseComplete() { await response; },
        async cancel() { complete?.(); },
        onMessage() {},
        async dispose() {},
      };
    };
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend,
      sendAcp: () => {},
      runtimeActivityContributionHandle: contribution.handle,
      onPublicStateUpdated: (run) => { observedTurns.set(run.runId, run.turnInFlight); },
    });
    const start = () => manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Work on this turn.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });
    const first = await start();
    const second = await start();
    try {
      await expect.poll(() => completions.length).toBe(2);
      expect(contribution.reports.at(-1)).toEqual({ state: 'active', activeCount: 2 });

      completions[0]!();
      await expect.poll(() => manager.getPublic(first.runId)?.turnInFlight).toBe(false);
      await expect.poll(() => contribution.reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
      expect(observedTurns.get(first.runId)).toBe(false);
      expect(manager.getPublic(first.runId)?.status).toBe('running');

      completions[1]!();
      await expect.poll(() => contribution.reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
      expect(manager.listPublic().every((run) => run.status === 'running' && run.turnInFlight === false)).toBe(true);

      await expect(manager.send(first.runId, { message: 'Next turn.' })).resolves.toEqual({ ok: true });
      expect(contribution.reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
      expect(observedTurns.get(first.runId)).toBe(true);
      completions[2]!();
      await expect.poll(() => contribution.reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });

      await manager.stop(first.runId);
      await expect(manager.ensure(first.runId, { resume: true })).resolves.toEqual({ ok: true });
      await expect.poll(() => contribution.reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
      expect(manager.getPublic(first.runId)?.status).toBe('running');
      await expect(manager.send(first.runId, { message: 'Resumed turn.' })).resolves.toEqual({ ok: true });
      expect(contribution.reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
      await manager.stop(first.runId);
      await expect.poll(() => contribution.reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
    } finally {
      await manager.stop(first.runId);
      await manager.stop(second.runId);
    }
  });

  function createPromptEchoBackend(): AgentBackend {
    let handler: AgentMessageHandler | null = null;
    const sessionId: SessionId = 'child_session_1' as SessionId;
    return {
      async startSession(): Promise<{ sessionId: SessionId }> {
        return { sessionId };
      },
      async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
        handler?.({ type: 'model-output', fullText: `reply:${prompt}` } as AgentMessage);
      },
      async cancel(_sessionId: SessionId): Promise<void> {},
      onMessage(next: AgentMessageHandler): void {
        handler = next;
      },
      async dispose(): Promise<void> {},
      async waitForResponseComplete(): Promise<void> {},
    };
  }

  it('ACKs send() for long-lived runs without awaiting waitForResponseComplete (prevents UI timeouts)', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];

    let handler: AgentMessageHandler | null = null;
    let turn = 0;
    let wait: Promise<void> = Promise.resolve();
    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        return { sessionId: 'child_session_1' as SessionId };
      },
      async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
        turn += 1;
        handler?.({ type: 'model-output', fullText: `reply:${prompt}` } as AgentMessage);
        wait = turn === 1 ? Promise.resolve() : new Promise(() => {});
      },
      async cancel(_sessionId: SessionId): Promise<void> {},
      onMessage(next: AgentMessageHandler): void {
        handler = next;
      },
      async dispose(): Promise<void> {},
      async waitForResponseComplete(): Promise<void> {
        await wait;
      },
    };

    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'hello',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    expect(manager.get(started.runId)?.status).toBe('running');
    await expect.poll(
      () => sent.filter((m) => (m.body as any)?.type === 'message').length,
      { timeout: 1_000 },
    ).toBe(1);
    await expect.poll(() => manager.getPublic(started.runId)?.turnInFlight).toBe(false);

    const sendPromise = manager.send(started.runId, { message: 'next' });
    const raced = await Promise.race([
      sendPromise,
      new Promise<{ ok: false; errorCode: string; error: string }>((resolve) => {
        // Under load, the event loop can be briefly delayed; keep the threshold small but non-flaky.
        setTimeout(() => resolve({ ok: false, errorCode: 'timeout', error: 'timeout' }), 500);
      }),
    ]);

    expect(raced.ok).toBe(true);
  });

  it('keeps long-lived runs running, supports send(), and emits tool-result only when stopped', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createPromptEchoBackend(),
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'hello',
      display: { title: 'Global Voice', participantLabel: 'Voice', groupId: 'group_1' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    expect(manager.get(started.runId)?.status).toBe('running');
    expect((manager.getPublic(started.runId) as any)?.display?.groupId).toBe('group_1');
    expect(sent.filter((m) => (m.body as any)?.type === 'tool-result').length).toBe(0);
    await expect.poll(
      () => sent.filter((m) => (m.body as any)?.type === 'message').length,
      { timeout: 1_000 },
    ).toBe(1);
    await expect.poll(() => manager.getPublic(started.runId)?.turnInFlight).toBe(false);

    const sendResult = await manager.send(started.runId, { message: 'next' });
    expect(sendResult.ok).toBe(true);
    await expect
      .poll(() => sent.filter((m) => (m.body as any)?.type === 'message').length, { timeout: 1_000 })
      .toBe(2);
    expect(sent.filter((m) => (m.body as any)?.type === 'tool-result').length).toBe(0);

    const stopped = await manager.stop(started.runId);
    expect(stopped.ok).toBe(true);
    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('cancelled');
    // Under heavy parallel load, the last sendAcp callback can arrive on a later microtask.
    await expect
      .poll(() => sent.filter((m) => (m.body as any)?.type === 'tool-result').length, { timeout: 1_000 })
      .toBe(1);
  });

  it('publishes Voice current work independently of an unread completed stream', async () => {
    const contribution = createRuntimeActivityContributionHarness();
    let completeTurn: (() => void) | undefined;
    const backend = createPromptEchoBackend();
    const sendPrompt = backend.sendPrompt.bind(backend);
    let response = Promise.resolve();
    backend.sendPrompt = async (sessionId, prompt) => {
      await sendPrompt(sessionId, prompt);
      response = new Promise<void>((resolve) => { completeTurn = resolve; });
    };
    backend.waitForResponseComplete = async () => { await response; };
    backend.cancel = async () => { completeTurn?.(); };
    const observedTurns: Array<boolean | undefined> = [];
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: () => {},
      runtimeActivityContributionHandle: contribution.handle,
      onPublicStateUpdated: (run) => { observedTurns.push(run.turnInFlight); },
    });
    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });
    try {
      expect(manager.getPublic(started.runId)?.turnInFlight).toBe(false);
      expect(contribution.reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
      const stream = await manager.startTurnStream(started.runId, { message: 'Next Voice turn.' });
      expect(stream.ok).toBe(true);
      if (!stream.ok) throw new Error('Expected Voice stream admission');
      await expect.poll(() => contribution.reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
      expect(manager.getPublic(started.runId)?.turnInFlight).toBe(true);
      expect(observedTurns.at(-1)).toBe(true);
      await expect.poll(() => typeof completeTurn).toBe('function');
      completeTurn?.();
      await expect.poll(() => contribution.reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
      expect(manager.getPublic(started.runId)?.status).toBe('running');
      expect(observedTurns.at(-1)).toBe(false);
      await expect(manager.readTurnStream(started.runId, { streamId: stream.streamId, cursor: 0, maxEvents: 128 }))
        .resolves.toMatchObject({ ok: true, done: true });
      expect(contribution.reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
    } finally {
      await manager.stop(started.runId);
    }
  });

  it('surfaces transcript persistence in public state for voice_agent runs', async () => {
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createPromptEchoBackend(),
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      transcript: { persistenceMode: 'persistent', epoch: 3 },
    });

    expect((manager.getPublic(started.runId) as any)?.transcript).toMatchObject({
      persistenceMode: 'persistent',
      epoch: 3,
    });
  });

  it('builds voice-agent prompts from resolved account settings instead of local CLI settings', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const seenCalls: Array<{ settings?: unknown; profileId?: string | null; sessionId?: string | null; workingDirectory?: string | null }> = [];

    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createPromptEchoBackend(),
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      resolveAccountSettings: async () => ({ promptStacksSource: 'account-settings' }),
      resolveVoicePromptStackBlocks: async ({ settings, profileId, sessionId, workingDirectory }) => {
        seenCalls.push({ settings, profileId, sessionId, workingDirectory });
        return ['Voice stack block'];
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'initial context',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      profileId: 'work',
    });

    const streamStart = await manager.startTurnStream(started.runId, { message: 'hello' });
    expect(streamStart.ok).toBe(true);
    const read = await manager.readTurnStream(started.runId, {
      streamId: (streamStart as { streamId: string }).streamId,
      cursor: 0,
      maxEvents: 128,
    });
    expect(read.ok).toBe(true);
    expect(JSON.stringify((read as { events: unknown[] }).events)).toContain('Voice stack block');
    expect(seenCalls).toEqual([{
      settings: { promptStacksSource: 'account-settings' },
      profileId: 'work',
      sessionId: 'parent_session_1',
      workingDirectory: process.cwd(),
    }]);

    const stopped = await manager.stop(started.runId);
    expect(stopped.ok).toBe(true);
    await manager.waitForTerminal(started.runId);
  });

  it('surfaces turnInFlight in public state for running bounded runs', async () => {
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => createDelayedJsonBackend('{"ok":true}', 50_000),
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'hello',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    // Bounded kickoff is async (provisioning is bounded, QA2-F04); poll until the turn is in flight
    // instead of pinning microtask timing.
    await expect.poll(
      () => (manager.getPublic(started.runId) as any)?.turnInFlight,
      { timeout: 2_000 },
    ).toBe(true);

    const stopped = await manager.stop(started.runId);
    expect(stopped.ok).toBe(true);
    await manager.waitForTerminal(started.runId);
  });

  it('passes the voice_agent start intent through to the backend factory', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: (opts) => {
        seen.push(opts as Record<string, unknown>);
        return createPromptEchoBackend();
      },
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      transcript: { persistenceMode: 'ephemeral', epoch: 1 },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      backendId: 'codex',
      modelId: 'chat',
      permissionMode: 'read_only',
      start: { intent: 'voice_agent' },
    });
  });

  it('does not force literal default model ids for voice_agent runs when start params omit them', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: (opts) => {
        seen.push(opts as Record<string, unknown>);
        return createPromptEchoBackend();
      },
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      backendId: 'codex',
      modelId: '',
      permissionMode: 'read_only',
      start: { intent: 'voice_agent' },
    });
  });

  it('streams sidechain output for long-lived runs when ioMode=streaming and avoids emitting a duplicate non-streaming message', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const commits: Array<{
      provider: string;
      body: unknown;
      localId: string;
      meta?: Record<string, unknown>;
    }> = [];

    let handler: AgentMessageHandler | null = null;
    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        return { sessionId: 'child_session_1' as SessionId };
      },
      async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
        handler?.({ type: 'model-output', fullText: `Working: ${prompt}\n` } as any);
        handler?.({ type: 'model-output', fullText: `Working: ${prompt}\nDone.\n` } as any);
      },
      async cancel(_sessionId: SessionId): Promise<void> {},
      onMessage(next: AgentMessageHandler): void {
        handler = next;
      },
      async dispose(): Promise<void> {},
      async waitForResponseComplete(): Promise<void> {},
    };

    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      streamedTranscriptSession: {
        sendAgentMessageCommitted: async (provider, body, opts) => {
          commits.push({ provider, body, localId: opts.localId, meta: opts.meta });
        },
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    const sendResult = await manager.send(started.runId, { message: 'hi' });
    expect(sendResult.ok).toBe(true);

    await expect
      .poll(
        () => commits.filter(
          (row) => (row.body as any)?.type === 'message' && (row.body as any)?.sidechainId === started.sidechainId,
        ).length,
        { timeout: 1_000 },
      )
      .toBeGreaterThanOrEqual(1);

    const nonStreaming = sent.filter((m) => (m.body as any)?.type === 'message' && (m.body as any)?.sidechainId === started.sidechainId);
    expect(nonStreaming).toHaveLength(0);

    const sidechainCommits = commits.filter(
      (row) => (row.body as any)?.type === 'message' && (row.body as any)?.sidechainId === started.sidechainId,
    );
    expect(sidechainCommits.length).toBeGreaterThanOrEqual(1);
  });
});

describe('ExecutionRunManager (bounded external send)', () => {
  it('reports outcome unknown when adopted bounded steer admission rejects without pre-effect evidence', async () => {
    let resolveTurnComplete!: () => void;
    const turnComplete = new Promise<void>((resolve) => {
      resolveTurnComplete = resolve;
    });
    const sendSteerPrompt = vi.fn(async () => {
      throw new Error('provider connection closed after steer dispatch');
    });
    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        return { sessionId: 'child_session_1' as SessionId };
      },
      async sendPrompt(): Promise<void> {},
      sendSteerPrompt,
      async cancel(): Promise<void> {
        resolveTurnComplete();
      },
      onMessage(): void {},
      async dispose(): Promise<void> {},
      async waitForResponseComplete(): Promise<void> {
        await turnComplete;
      },
    };
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    await expect.poll(
      () => manager.getPublic(started.runId)?.turnInFlight,
      { timeout: 2_000 },
    ).toBe(true);

    await expect(manager.send(started.runId, {
      message: 'focus on transport handling',
      delivery: 'steer_if_supported',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_send_outcome_unknown',
    });
    expect(sendSteerPrompt).toHaveBeenCalledOnce();

    await expect(manager.send(started.runId, {
      message: 'must not duplicate an ambiguous steer',
      delivery: 'steer_if_supported',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_busy',
    });
    expect(sendSteerPrompt).toHaveBeenCalledOnce();

    await manager.stop(started.runId);
  });

  it('applies the ACK timeout only while a bounded external send remains queued', async () => {
    const previousAckTimeout = process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS;
    process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS = '20';
    vi.useFakeTimers();
    try {
      let resolveTurnComplete!: () => void;
      const turnComplete = new Promise<void>((resolve) => {
        resolveTurnComplete = resolve;
      });
      let resolveSteerAdmission!: () => void;
      const sendSteerPrompt = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveSteerAdmission = resolve;
        });
      });
      const backend: AgentBackend = {
        async startSession(): Promise<{ sessionId: SessionId }> {
          return { sessionId: 'child_session_1' as SessionId };
        },
        async sendPrompt(): Promise<void> {},
        sendSteerPrompt,
        async cancel(): Promise<void> {
          resolveTurnComplete();
        },
        onMessage(): void {},
        async dispose(): Promise<void> {},
        async waitForResponseComplete(): Promise<void> {
          await turnComplete;
        },
      };
      const manager = new ExecutionRunManager({
        parentProvider: 'claude',
        cwd: process.cwd(),
        createBackend: () => backend,
        sendAcp: () => {},
        getNowMs: () => 1_700_000_000_000,
      });

      const started = await manager.start({
        sessionId: 'parent_session_1',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      });
      for (
        let attempt = 0;
        attempt < 20 && manager.getPublic(started.runId)?.turnInFlight !== true;
        attempt += 1
      ) {
        await flushAsyncEffects();
      }
      expect(manager.getPublic(started.runId)?.turnInFlight).toBe(true);

      let adoptedSendOutcome: Awaited<ReturnType<ExecutionRunManager['send']>> | undefined;
      const adoptedSend = manager.send(started.runId, {
        message: 'first',
        delivery: 'steer_if_supported',
      });
      void adoptedSend.then((outcome) => {
        adoptedSendOutcome = outcome;
      });
      for (let attempt = 0; attempt < 20 && sendSteerPrompt.mock.calls.length === 0; attempt += 1) {
        await flushAsyncEffects();
      }
      expect(sendSteerPrompt).toHaveBeenCalledTimes(1);

      const stillQueuedSend = manager.send(started.runId, {
        message: 'second',
        delivery: 'steer_if_supported',
      });
      let stillQueuedSendOutcome: Awaited<ReturnType<ExecutionRunManager['send']>> | undefined;
      void stillQueuedSend.then((outcome) => {
        stillQueuedSendOutcome = outcome;
      });
      vi.advanceTimersByTime(20);
      await flushAsyncEffects();

      expect(adoptedSendOutcome).toBeUndefined();
      expect(stillQueuedSendOutcome).toMatchObject({
        ok: false,
        errorCode: 'execution_run_busy',
      });

      resolveSteerAdmission();
      await flushAsyncEffects();
      expect(adoptedSendOutcome).toEqual({ ok: true });
      await manager.stop(started.runId);
    } finally {
      vi.useRealTimers();
      if (previousAckTimeout === undefined) {
        delete process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS = previousAckTimeout;
      }
    }
  });

  it('rebuilds bounded interrupt prompts using the intent profile (preserves strict JSON guidance)', async () => {
    const prompts: string[] = [];
    let handler: AgentMessageHandler | null = null;
    let waitResolve: (() => void) | null = null;
    let currentWait: Promise<void> = new Promise(() => {});

    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        return { sessionId: 'child_session_1' as SessionId };
      },
      async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
        prompts.push(prompt);
        currentWait = new Promise<void>((resolve) => {
          waitResolve = resolve;
        });

        // First prompt intentionally never completes; we will interrupt it.
        if (prompts.length === 1) return;

        // Second prompt completes immediately with strict JSON.
        handler?.({
          type: 'model-output',
          fullText: JSON.stringify({ summary: 'ok', deliverables: [{ id: 'd1', title: 'done' }] }),
        } as any);
        waitResolve?.();
      },
      async cancel(_sessionId: SessionId): Promise<void> {},
      onMessage(next: AgentMessageHandler): void {
        handler = next;
      },
      async dispose(): Promise<void> {},
      async waitForResponseComplete(): Promise<void> {
        await currentWait;
      },
    };

    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: process.cwd(),
      createBackend: () => backend,
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'original instructions',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await expect.poll(() => prompts.length, { timeout: 1_000 }).toBe(1);

    const sendResult = await manager.send(started.runId, {
      message: 'User update: finish immediately.',
      delivery: 'interrupt',
    });
    expect(sendResult.ok).toBe(true);

    await expect.poll(() => prompts.length, { timeout: 1_000 }).toBe(2);
    expect(prompts[1]).toContain('deliverables');
    expect(prompts[1]).toContain('User update: finish immediately.');

    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('succeeded');
  });

});
