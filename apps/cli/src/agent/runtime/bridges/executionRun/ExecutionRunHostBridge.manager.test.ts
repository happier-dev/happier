import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import {
  createTestExecutionRunHostRuntime,
  type TestExecutionRunHostRuntime,
  type TestExecutionRunHostRuntimeOptions,
} from '@/agent/runtime/bridges/executionRun/testkit';

type TestRuntimeFactoryInput = Readonly<{
  cwd: string;
  runId?: string;
  backendId: string;
  backendTarget?: unknown;
  modelId?: string;
  permissionMode: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  start?: unknown;
  happyHomeDir?: string | null;
  parentSessionStateTarget?: unknown;
}>;

type TestRuntimeFactory = (opts: TestRuntimeFactoryInput) => ExecutionRunHostRuntime;

const TEST_PRIMARY_BACKEND_ID = `${'primary'}.${'backend'}` as never;
const TEST_SECONDARY_BACKEND_ID = `${'secondary'}.${'backend'}` as never;

const {
  createExecutionRunRuntimeMock,
  dispatchBridgeLifecycleHookEvent,
  readCredentials,
  runtimeFactoryRef,
  resolveReplaySeedDraft,
} = vi.hoisted(() => {
  const runtimeFactoryRef: { current: TestRuntimeFactory | null } = { current: null };
  return {
    createExecutionRunRuntimeMock: vi.fn((opts: TestRuntimeFactoryInput): ExecutionRunHostRuntime => {
      const factory = runtimeFactoryRef.current;
      if (!factory) {
        throw new Error('Test execution-run runtime factory was not configured');
      }
      return factory(opts);
    }),
    dispatchBridgeLifecycleHookEvent: vi.fn().mockResolvedValue(undefined),
    readCredentials: vi.fn(),
    runtimeFactoryRef,
    resolveReplaySeedDraft: vi.fn(),
  };
});

vi.mock('./createExecutionRunBridgeRuntime', () => ({
  createExecutionRunBridgeRuntime: createExecutionRunRuntimeMock,
}));

vi.mock('../../../plugins/runtime/hooks/execution/dispatchBridgeLifecycleHookEvent', () => ({
  dispatchBridgeLifecycleHookEvent,
}));

vi.mock('@/persistence', () => ({
  readCredentials,
}));

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft,
}));

import { ExecutionRunHostBridge as ExecutionRunManager } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';

beforeEach(() => {
  runtimeFactoryRef.current = null;
  createExecutionRunRuntimeMock.mockClear();
});

function createExecutionRunManager(
  opts: ConstructorParameters<typeof ExecutionRunManager>[0] & Readonly<{ createRuntime: TestRuntimeFactory }>,
): ExecutionRunManager {
  const { createRuntime, ...bridgeOptions } = opts;
  runtimeFactoryRef.current = createRuntime;
  return new ExecutionRunManager(bridgeOptions);
}

async function readExecutionRunTurnStreamUntilDone(args: Readonly<{
  manager: ExecutionRunManager;
  runId: string;
  streamId: string;
  maxEvents?: number;
  maxReads?: number;
}>): Promise<Array<unknown>> {
  let lastEvents: Array<unknown> = [];

  for (let i = 0; i < (args.maxReads ?? 8); i += 1) {
    const read = await args.manager.readTurnStream(args.runId, {
      streamId: args.streamId,
      cursor: 0,
      ...(typeof args.maxEvents === 'number' ? { maxEvents: args.maxEvents } : {}),
    });
    expect(read.ok).toBe(true);
    lastEvents = (read as { events: Array<unknown> }).events;
    if ((read as { done?: boolean }).done === true) {
      return lastEvents;
    }
    await Promise.resolve();
  }

  return lastEvents;
}

type PromptRuntimeHandler = (
  runtime: TestExecutionRunHostRuntime,
  sessionId: string,
  prompt: string,
) => void | Promise<void>;

function createPromptRuntime(
  onSendPrompt: PromptRuntimeHandler,
  opts: Omit<TestExecutionRunHostRuntimeOptions, 'onSendPrompt'> = {},
): TestExecutionRunHostRuntime {
  let runtime: TestExecutionRunHostRuntime;
  runtime = createTestExecutionRunHostRuntime({
    onWaitForTurnCompletion: async () => {},
    ...opts,
    onSendPrompt: async (sessionId, prompt) => {
      await onSendPrompt(runtime, sessionId, prompt);
    },
  });
  return runtime;
}

function createStaticJsonRuntime(responseText: string): TestExecutionRunHostRuntime {
  return createPromptRuntime((runtime) => {
    runtime.emitMessage({ type: 'model-output', fullText: responseText });
  });
}

function createDelayedJsonRuntime(responseText: string, delayMs: number): TestExecutionRunHostRuntime {
  let done: Promise<void> | null = null;
  return createPromptRuntime(
    (runtime) => {
      done = new Promise((resolve) => {
        setTimeout(() => {
          runtime.emitMessage({ type: 'model-output', fullText: responseText });
          resolve();
        }, delayMs);
      });
    },
    {
      onWaitForTurnCompletion: async () => {
        await (done ?? Promise.resolve());
      },
    },
  );
}

function createReviewResumeRuntime(): Readonly<{
  runtime: TestExecutionRunHostRuntime;
  prompts: string[];
  loadSessionCalls: string[];
  providerSessionId: string;
}> {
  const prompts: string[] = [];
  const loadSessionCalls: string[] = [];
  const providerSessionId = 'vendor_review_1';

  const runtime = createPromptRuntime(
    (promptRuntime, _sessionId, prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        promptRuntime.emitMessage({ type: 'event', name: 'provider_session_id', payload: { sessionId: providerSessionId } } as AgentMessage);
        promptRuntime.emitMessage({
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
        });
        return;
      }

      promptRuntime.emitMessage({
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
      });
    },
    {
      resumeSupported: true,
      resumeSessionId: 'child_session_resumed',
      onProvisionSession: async (opts) => {
        if (opts?.resumeSessionId) {
          loadSessionCalls.push(opts.resumeSessionId);
        }
      },
    },
  );

  return { runtime, prompts, loadSessionCalls, providerSessionId };
}

describe('ExecutionRunManager (review intent)', () => {
  it('emits SubAgentRun tool-call, sidechain message, and tool-result with review_findings.v2 meta', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    let lastPrompt = '';
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (_opts: { backendId: string; permissionMode: string }) =>
        createPromptRuntime(async (runtime, _sessionId, prompt) => {
          lastPrompt = prompt;
          // Defer to keep the completion async (closer to real backends).
          await new Promise((r) => setTimeout(r, 5));
          runtime.emitMessage({
            type: 'tool-call',
            toolName: 'read_file',
            callId: 't1',
            args: { path: 'README.md' },
          } as AgentMessage);
          runtime.emitMessage({
            type: 'tool-result',
            toolName: 'read_file',
            callId: 't1',
            result: 'OK',
          } as AgentMessage);
          runtime.emitMessage({
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
          });
        }),
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(started.runId).toMatch(/^run_/);
    expect(started.callId).toMatch(/^subagent_run_/);

    // Wait for completion since the fake backend is async.
    await manager.waitForTerminal(started.runId);
    const final = manager.get(started.runId);
    expect(final?.status).toBe('succeeded');
    // Prompt contract: review runs must include a strict JSON output schema.
    expect(lastPrompt).toContain('"findings"');

    const toolCall = sent.find((m) => (m.body as any)?.type === 'tool-call');
    expect(toolCall).toBeTruthy();
    expect((toolCall?.body as any).name).toBe('SubAgentRun');
    expect((toolCall?.body as any)?.input?.runId).toBe(started.runId);

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

  it('prefers a per-run bounded timeout over the manager default for bounded review runs', async () => {
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createDelayedJsonRuntime(JSON.stringify({ findings: [], summary: 'late' }), 30),
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
      boundedTimeoutMs: 10,
    });

    const startParams = {
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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

    let startSessionCalled = false;
    let startSessionResolved = false;
    let resolveStartSession!: () => void;
    const startSessionPromise = new Promise<void>((resolve) => {
      resolveStartSession = () => {
        startSessionResolved = true;
        resolve();
      };
    });

    const runtime = createPromptRuntime(
      (promptRuntime) => {
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText: JSON.stringify({ summary: 'Ok', findings: [] }),
        });
      },
      {
        onProvisionSession: async () => {
          startSessionCalled = true;
          await startSessionPromise;
        },
      },
    );

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const startPromise = manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    // Prevent deadlocks if start() ever regresses to awaiting backend.startSession().
    // The assertion below (startSessionResolved === false) proves start() returned before provisioning completed.
    const autoResolveStartSession = setTimeout(() => {
      resolveStartSession();
    }, 2_000);

    const started = await startPromise;
    clearTimeout(autoResolveStartSession);

    expect(startSessionCalled).toBe(true);
    expect(startSessionResolved).toBe(false);

    // Now allow the run to proceed and complete so the test doesn't leak background work.
    if (!startSessionResolved) {
      resolveStartSession();
    }
    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('succeeded');
  });

  it('forwards terminal output + file edits into the run sidechain transcript', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];

    const runtime = createPromptRuntime((promptRuntime) => {
        promptRuntime.emitMessage({ type: 'terminal-output', data: 'hello from terminal' } as AgentMessage);
        promptRuntime.emitMessage({
          type: 'fs-edit',
          description: 'Edited README',
          path: 'README.md',
          diff: 'diff --git a/README.md b/README.md',
        } as AgentMessage);
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText: JSON.stringify({ summary: 'Ok', findings: [] }),
        });
      });

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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

    const runtime = createPromptRuntime((promptRuntime, _sessionId, prompt) => {
        prompts.push(prompt);
        // First attempt: model violates contract (no JSON).
        if (prompts.length === 1) {
          promptRuntime.emitMessage({ type: 'model-output', fullText: 'Not JSON, sorry.' });
          return;
        }
        // Second attempt: obey strict JSON.
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText: JSON.stringify({ summary: 'Ok', findings: [] }),
        });
      });

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (_opts: { backendId: string; permissionMode: string }) =>
        createStaticJsonRuntime(
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
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (_opts: { backendId: string; permissionMode: string }) =>
        createStaticJsonRuntime(
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
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (_opts: { backendId: string; permissionMode: string }) =>
        createStaticJsonRuntime(
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
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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
    const { runtime, prompts, loadSessionCalls, providerSessionId } = createReviewResumeRuntime();
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'streaming',
    });
    await manager.waitForTerminal(started.runId);

    expect((manager.get(started.runId)?.resumeHandle as any)?.providerSessionId).toBe(providerSessionId);

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

    expect(loadSessionCalls).toEqual([providerSessionId]);
    expect(prompts.at(-1)).toContain('Please clarify why this matters.');
    expect(manager.getStructuredMeta(followUpRunId)?.kind).toBe('review_follow_up.v1');
    expect((manager.getStructuredMeta(followUpRunId) as any)?.payload?.requestMarkdown).toBe('Please clarify why this matters.');
  });

  it('falls back to a linked child review run without resume support and reconstructs follow-up context', async () => {
    const prompts: string[] = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () =>
        createPromptRuntime(
          (runtime, _sessionId, prompt) => {
            prompts.push(prompt);
            if (prompts.length === 1) {
              runtime.emitMessage({
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
              });
              return;
            }

            runtime.emitMessage({
              type: 'model-output',
              fullText: JSON.stringify({
                answerMarkdown: 'Fallback answer.',
                questions: [],
                assumptions: [],
              }),
            });
          },
          { sessionId: `child_session_${prompts.length + 1}` },
        ),
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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

  it('falls back to a linked child review run for provider-specific backends without resume support', async () => {
    const prompts: string[] = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () =>
        createPromptRuntime(
          (runtime, _sessionId, prompt) => {
            prompts.push(prompt);
            if (prompts.length === 1) {
              runtime.emitMessage({
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
              });
              return;
            }

            runtime.emitMessage({
              type: 'model-output',
              fullText: JSON.stringify({
                answerMarkdown: 'Fallback answer.',
                questions: [],
                assumptions: [],
              }),
            });
          },
          { sessionId: `child_session_${prompts.length + 1}` },
        ),
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: ['code', 'rabbit'].join('') },
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
    expect(followUp.ok).toBe(true);
  });

  it('can stop a running execution run and emit a terminal tool-result', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (_opts: { backendId: string; permissionMode: string }) =>
        createDelayedJsonRuntime(JSON.stringify({ summary: 'late', findings: [] }), 50_000),
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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

  it('does not synthesize a resumable resumeHandle from provider_session_id events when the backend cannot resume', async () => {
    const providerSessionId = '1433467f-ff14-4292-b5b2-2aac77a808f0';
    const runtime = createPromptRuntime((promptRuntime) => {
      promptRuntime.emitMessage({ type: 'event', name: 'provider_session_id', payload: { sessionId: providerSessionId } } as AgentMessage);
      promptRuntime.emitMessage({ type: 'model-output', fullText: JSON.stringify({ findings: [], summary: 'ok' }) });
    }, { sessionId: 'placeholder_session' });

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createStaticJsonRuntime('{"ok":true}'),
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'memory_hints',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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

    const runtime = createPromptRuntime((promptRuntime) => {
        promptRuntime.emitMessage({ type: 'model-output', fullText: 'Plan in progress.\n' });
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText:
            'Plan in progress.\n' +
            JSON.stringify({
              summary: 'Ok',
              sections: [{ title: 'One', items: ['A'] }],
              risks: [],
              milestones: [],
            }),
        });
      });

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
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
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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

    const runtime = createPromptRuntime((promptRuntime) => {
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText: 'Working...\n\n{ "summary": "Ok", ',
        });
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText:
            'Working...\n\n' +
            JSON.stringify({
              summary: 'Ok',
              findings: [],
            }),
        });
      });

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
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
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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

    // A final prose message is allowed so users get a clear terminal note.
    const finalNonStreaming = sent.find(
      (m) => (m.body as any)?.type === 'message' && (m.body as any)?.sidechainId === started.sidechainId,
    );
    expect(String((finalNonStreaming?.body as any)?.message ?? '')).toContain('Working');
    expect(String((finalNonStreaming?.body as any)?.message ?? '')).not.toContain('"findings"');
  });
});

describe('ExecutionRunManager (long-lived runs)', () => {
  function createPromptEchoRuntime(): TestExecutionRunHostRuntime {
    return createPromptRuntime((runtime, _sessionId, prompt) => {
      runtime.emitMessage({ type: 'model-output', fullText: `reply:${prompt}` });
    });
  }

  it('disposes running backend resources and unregisters permission response handling idempotently', async () => {
    const unregisterPermissionHandler = vi.fn();
    const permissionStore = {
      registerResponseTargetHandler: vi.fn(() => unregisterPermissionHandler),
    };
    const disposeCalls: string[] = [];
    let runtimeIndex = 0;
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => {
        runtimeIndex += 1;
        const index = runtimeIndex;
        return createPromptRuntime(
          (runtime, _sessionId, prompt) => {
            runtime.emitMessage({ type: 'model-output', fullText: `reply:${prompt}` });
          },
          {
            sessionId: `child_session_${index}`,
            onDispose: async () => {
              disposeCalls.push(`runtime_${index}`);
            },
          },
        );
      },
      sendAcp: () => {},
      getPermissionRequestStore: () => permissionStore as never,
      getNowMs: () => 1_700_000_000_000,
    });

    await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'first',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });
    await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_SECONDARY_BACKEND_ID },
      instructions: 'second',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    expect(manager.getRunningCount()).toBe(2);

    await manager.dispose();
    await manager.dispose();

    expect(manager.getRunningCount()).toBe(0);
    expect(disposeCalls).toEqual(['runtime_1', 'runtime_2']);
    expect(permissionStore.registerResponseTargetHandler).toHaveBeenCalledTimes(1);
    expect(unregisterPermissionHandler).toHaveBeenCalledTimes(1);
  });

  function createPromptEchoResumeRuntime(): TestExecutionRunHostRuntime {
    return createPromptRuntime(
      (runtime, _sessionId, prompt) => {
        runtime.emitMessage({ type: 'model-output', fullText: `reply:${prompt}` });
      },
      { resumeSupported: true },
    );
  }

  function createReadyHandshakePromptEchoRuntime(): TestExecutionRunHostRuntime {
    let sendCount = 0;
    return createPromptRuntime(
      (runtime, _sessionId, prompt) => {
        sendCount += 1;
        runtime.emitMessage({
          type: 'model-output',
          fullText: sendCount === 1 ? 'READY' : `reply:${prompt}`,
        });
      },
      { sessionId: 'child_session_ready' },
    );
  }

  it('passes the parent session state target through to the execution-run runtime factory', async () => {
    const enqueueRegisteredSessionStateFieldMutation = vi.fn();
    const seen: Array<Record<string, unknown>> = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      parentSessionStateTarget: {
        sessionId: 'parent_session_1',
        enqueueRegisteredSessionStateFieldMutation,
      },
      createRuntime: (opts) => {
        seen.push(opts);
        return createPromptEchoRuntime();
      },
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_SECONDARY_BACKEND_ID },
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      runId: expect.stringMatching(/^run_/),
      backendId: TEST_SECONDARY_BACKEND_ID,
      permissionMode: 'read_only',
      parentSessionStateTarget: {
        sessionId: 'parent_session_1',
        enqueueRegisteredSessionStateFieldMutation,
      },
    });
  });

  it('ACKs send() for long-lived runs without awaiting waitForResponseComplete (prevents UI timeouts)', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];

    let turn = 0;
    let wait: Promise<void> = Promise.resolve();
    const runtime = createPromptRuntime(
      (promptRuntime, _sessionId, prompt) => {
        turn += 1;
        promptRuntime.emitMessage({ type: 'model-output', fullText: `reply:${prompt}` });
        wait = turn === 1 ? Promise.resolve() : new Promise(() => {});
      },
      {
        onWaitForTurnCompletion: async () => {
          await wait;
        },
      },
    );

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'hello',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    expect(manager.get(started.runId)?.status).toBe('running');
    expect(sent.filter((m) => (m.body as any)?.type === 'message')).toHaveLength(1);

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
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createPromptEchoRuntime(),
      sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ provider, body, meta: opts?.meta });
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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
    expect(sent.filter((m) => (m.body as any)?.type === 'message').length).toBe(1);

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

  it('surfaces transcript persistence in public state for voice_agent runs', async () => {
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createPromptEchoRuntime(),
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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

  it('applies voice_agent prepareStartParams before starting replay-backed runs', async () => {
    vi.mocked(readCredentials).mockResolvedValue({
      token: 'credential-token',
    } as never);
    vi.mocked(resolveReplaySeedDraft).mockResolvedValue({
      seedDraft: 'Replay seed summary',
    } as never);

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: '/tmp/voice-agent-manager',
      createRuntime: () => createReadyHandshakePromptEchoRuntime(),
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'Operator supplied context.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      bootstrapMode: 'ready_handshake',
      replay: {
        kind: 'voice_session.v1',
        previousSessionId: 'sess_voice',
        transcriptEpoch: 4,
      },
    } as any);

    expect(resolveReplaySeedDraft).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/voice-agent-manager',
      source: {
        kind: 'voice_session.v1',
        previousSessionId: 'sess_voice',
        transcriptEpoch: 4,
      },
    }));
    expect(manager.get(started.runId)?.voiceAgentConfig).toMatchObject({
      initialContextMode: 'first_turn',
    });
    expect(manager.get(started.runId)?.voiceAgentConfig?.initialContext).toContain('Replay seed summary');
  });

  it('emits a fresh public-state update when a resumable voice_agent run is ensured after stop', async () => {
    const publicStates: Array<Record<string, unknown>> = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createPromptEchoResumeRuntime(),
      sendAcp: () => {},
      onPublicStateUpdated: (run) => {
        publicStates.push(run as Record<string, unknown>);
      },
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      transcript: { persistenceMode: 'persistent', epoch: 11 },
    });

    await manager.stop(started.runId);
    const beforeEnsureUpdates = publicStates.length;

    const ensured = await manager.ensure(started.runId, { resume: true });

    expect(ensured.ok).toBe(true);
    expect(publicStates).toHaveLength(beforeEnsureUpdates + 1);
    expect(publicStates.at(-1)).toMatchObject({
      runId: started.runId,
      intent: 'voice_agent',
      status: 'running',
      transcript: { persistenceMode: 'persistent', epoch: 11 },
    });
  });

  it('builds voice-agent prompts from resolved account settings instead of local CLI settings', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const seenCalls: Array<{ settings?: unknown; profileId?: string | null; sessionId?: string | null; workingDirectory?: string | null }> = [];

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createPromptEchoRuntime(),
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
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
      instructions: 'initial context',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      profileId: 'work',
    });

    const streamStart = await manager.startTurnStream(started.runId, { message: 'hello' });
    expect(streamStart.ok).toBe(true);
    const events = await readExecutionRunTurnStreamUntilDone({
      manager,
      runId: started.runId,
      streamId: (streamStart as { streamId: string }).streamId,
      maxEvents: 128,
    });
    expect(JSON.stringify(events)).toContain('Voice stack block');
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
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => createDelayedJsonRuntime('{"ok":true}', 50_000),
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_SECONDARY_BACKEND_ID },
      instructions: 'hello',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect((manager.getPublic(started.runId) as any)?.turnInFlight).toBe(true);

    const stopped = await manager.stop(started.runId);
    expect(stopped.ok).toBe(true);
    await manager.waitForTerminal(started.runId);
  });

  it('passes the voice_agent start intent through to the backend factory', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (opts: { backendId: string; modelId?: string; permissionMode: string; start?: unknown }) => {
        seen.push(opts as Record<string, unknown>);
        return createPromptEchoRuntime();
      },
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_SECONDARY_BACKEND_ID },
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
      backendId: TEST_SECONDARY_BACKEND_ID,
      modelId: 'chat',
      permissionMode: 'read_only',
      start: { intent: 'voice_agent' },
    });
  });

  it('does not force literal default model ids for voice_agent runs when start params omit them', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: (opts: { backendId: string; modelId?: string; permissionMode: string; start?: unknown }) => {
        seen.push(opts as Record<string, unknown>);
        return createPromptEchoRuntime();
      },
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    await manager.start({
      sessionId: 'parent_session_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_SECONDARY_BACKEND_ID },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      backendId: TEST_SECONDARY_BACKEND_ID,
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

    const runtime = createPromptRuntime((promptRuntime, _sessionId, prompt) => {
      promptRuntime.emitMessage({ type: 'model-output', fullText: `Working: ${prompt}\n` });
      promptRuntime.emitMessage({ type: 'model-output', fullText: `Working: ${prompt}\nDone.\n` });
    });

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
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
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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
  it('rebuilds bounded interrupt prompts using the intent profile (preserves strict JSON guidance)', async () => {
    const prompts: string[] = [];
    let waitResolve: (() => void) | null = null;
    let currentWait: Promise<void> = new Promise(() => {});

    const runtime = createPromptRuntime(
      (promptRuntime, _sessionId, prompt) => {
        prompts.push(prompt);
        currentWait = new Promise<void>((resolve) => {
          waitResolve = resolve;
        });

        // First prompt intentionally never completes; we will interrupt it.
        if (prompts.length === 1) return;

        // Second prompt completes immediately with strict JSON.
        promptRuntime.emitMessage({
          type: 'model-output',
          fullText: JSON.stringify({ summary: 'ok', deliverables: [{ id: 'd1', title: 'done' }] }),
        });
        waitResolve?.();
      },
      {
        onWaitForTurnCompletion: async () => {
          await currentWait;
        },
      },
    );

    const manager = createExecutionRunManager({
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      cwd: process.cwd(),
      createRuntime: () => runtime,
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
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
