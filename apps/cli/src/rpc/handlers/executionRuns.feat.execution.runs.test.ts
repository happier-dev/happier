import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { FeaturesResponseSchema, type ExecutionRunPublicState, type ExecutionRunStartResponse } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerExecutionRunHandlers as registerExecutionRunHandlersBase } from './executionRuns';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { runGit } from '@/scm/rpc/__tests__/testRpcHarness';
import { reloadConfiguration } from '@/configuration';

vi.mock('@/persistence', () => ({
  readCredentials: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: vi.fn(),
}));

vi.mock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
  fetchEncryptedTranscriptMessages: vi.fn(),
}));

vi.mock('@/session/replay/summary/runReplaySummaryForDialog', () => ({
  runReplaySummaryForDialog: vi.fn(),
}));

const voiceEnabledServerSnapshot = {
  status: 'ready',
  features: FeaturesResponseSchema.parse({
    features: {
      voice: { enabled: true },
    },
    capabilities: {},
  }),
} as const satisfies CliServerFeaturesSnapshot;

const registerExecutionRunHandlers: typeof registerExecutionRunHandlersBase = (rpc, ctx) =>
  registerExecutionRunHandlersBase(rpc, {
    ...ctx,
    getServerFeaturesSnapshot: ctx.getServerFeaturesSnapshot ?? (() => voiceEnabledServerSnapshot),
  });

beforeEach(async () => {
  const { readCredentials } = await import('@/persistence');
  const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
  const { fetchEncryptedTranscriptMessages } = await import('@/session/replay/fetchEncryptedTranscriptMessages');
  const { runReplaySummaryForDialog } = await import('@/session/replay/summary/runReplaySummaryForDialog');
  vi.mocked(readCredentials).mockReset();
  vi.mocked(fetchSessionById).mockReset();
  vi.mocked(fetchEncryptedTranscriptMessages).mockReset();
  vi.mocked(runReplaySummaryForDialog).mockReset();
});

function createStaticBackend(responseText: string): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_1' as SessionId;
  return {
    async startSession() {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string) {
      handler?.({ type: 'model-output', fullText: responseText } as AgentMessage);
    },
    async cancel(_sessionId: SessionId) {},
    onMessage(next) {
      handler = next;
    },
    async dispose() {},
    async waitForResponseComplete() {},
  };
}

function createDelayedBackend(responseText: string, delayMs: number): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_1' as SessionId;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done: Promise<void> | null = null;
  let resolveDone: (() => void) | null = null;
  return {
    async startSession() {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string) {
      done = new Promise((resolve) => {
        resolveDone = resolve;
        timer = setTimeout(() => {
          handler?.({ type: 'model-output', fullText: responseText } as AgentMessage);
          resolve();
        }, delayMs);
      });
    },
    async cancel(_sessionId: SessionId) {
      if (timer) clearTimeout(timer);
      resolveDone?.();
    },
    onMessage(next) {
      handler = next;
    },
    async dispose() {},
    async waitForResponseComplete() {
      await (done ?? Promise.resolve());
    },
  };
}

function createNeverResolvingBackend(): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_stuck' as SessionId;
  let done: Promise<void> | null = null;
  let sendCount = 0;

  return {
    async startSession() {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string) {
      sendCount += 1;
      // First prompt returns immediately but never completes, simulating a stuck in-flight turn.
      // The second prompt never resolves, simulating a backend that cannot acknowledge a cancel+send.
      if (sendCount >= 2) {
        await new Promise<void>(() => {
          // intentionally never resolve/reject
        });
        return;
      }
      done = new Promise<void>(() => {
        // intentionally never resolve/reject
      });
      handler?.({ type: 'model-output', fullText: '' } as AgentMessage);
    },
    async cancel(_sessionId: SessionId) {},
    onMessage(next) {
      handler = next;
    },
    async dispose() {},
    async waitForResponseComplete() {
      await (done ?? Promise.resolve());
    },
  };
}

function createThrowingBackend(params: { throwAtSendCount: number; message: string }): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_1' as SessionId;
  let sendCount = 0;
  return {
    async startSession() {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string) {
      sendCount += 1;
      if (sendCount >= params.throwAtSendCount) {
        throw new Error(params.message);
      }
      handler?.({ type: 'model-output', fullText: 'ok' } as AgentMessage);
    },
    async cancel(_sessionId: SessionId) {},
    onMessage(next) {
      handler = next;
    },
    async dispose() {},
    async waitForResponseComplete() {},
  };
}

function createResumableBackendFactory(responseText: string): () => AgentBackend {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_resumable' as SessionId;

  return () => ({
    async startSession() {
      return { sessionId };
    },
    async loadSession(_sessionId: SessionId) {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string) {
      handler?.({ type: 'model-output', fullText: responseText } as AgentMessage);
    },
    async cancel(_sessionId: SessionId) {},
    onMessage(next) {
      handler = next;
    },
    async dispose() {},
    async waitForResponseComplete() {},
  });
}

function createSequencedBackend(params: {
  responses: ReadonlyArray<{ text: string; delayMs: number }>;
  supportsSteer?: boolean;
  cancelRejects?: boolean;
  completionRejectMessage?: string;
}): { backend: AgentBackend; events: { sendPrompts: string[]; steerPrompts: string[]; cancelCount: number } } {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_1' as SessionId;
  const events = { sendPrompts: [] as string[], steerPrompts: [] as string[], cancelCount: 0 };

  let turnIndex = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done: Promise<void> | null = null;
  let resolveDone: (() => void) | null = null;
  let rejectDone: ((e: Error) => void) | null = null;

  const backend: AgentBackend = {
    async startSession() {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, prompt: string) {
      events.sendPrompts.push(prompt);
      const response = params.responses[Math.min(turnIndex, params.responses.length - 1)];
      turnIndex += 1;

      done = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = (e) => reject(e);
        timer = setTimeout(() => {
          if (typeof params.completionRejectMessage === 'string' && params.completionRejectMessage.trim().length > 0) {
            reject(new Error(params.completionRejectMessage));
            return;
          }
          handler?.({ type: 'model-output', fullText: response.text } as AgentMessage);
          resolve();
        }, response.delayMs);
      });
    },
    async cancel(_sessionId: SessionId) {
      events.cancelCount += 1;
      if (timer) clearTimeout(timer);
      if (params.cancelRejects) {
        rejectDone?.(new Error('Turn cancelled'));
      } else {
        resolveDone?.();
      }
    },
    ...(params.supportsSteer
      ? {
          async sendSteerPrompt(_sessionId: SessionId, prompt: string) {
            events.steerPrompts.push(prompt);
          },
        }
      : {}),
    onMessage(next) {
      handler = next;
    },
    async dispose() {},
    async waitForResponseComplete() {
      await (done ?? Promise.resolve());
    },
  };

  return { backend, events };
}

function createCancelRaceBackend(params: Readonly<{
  longDelayMs: number;
}>): { backend: AgentBackend; events: { sendPrompts: string[]; cancelCount: number } } {
  let handler: AgentMessageHandler | null = null;
  const sessionId: SessionId = 'child_session_1' as SessionId;
  const events = { sendPrompts: [] as string[], cancelCount: 0 };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let done: Promise<void> | null = null;
  let resolveDone: (() => void) | null = null;
  let rejectDone: ((e: Error) => void) | null = null;
  let rejectNextSendPrompts = 0;

  const backend: AgentBackend = {
    async startSession() {
      return { sessionId };
    },
    async sendPrompt(_sessionId: SessionId, prompt: string) {
      events.sendPrompts.push(prompt);
      if (rejectNextSendPrompts > 0) {
        rejectNextSendPrompts -= 1;
        throw new Error('Turn cancelled');
      }

      done = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
        timer = setTimeout(() => {
          handler?.({ type: 'model-output', fullText: `reply:${prompt}` } as AgentMessage);
          resolve();
        }, params.longDelayMs);
      });
    },
    async cancel(_sessionId: SessionId) {
      events.cancelCount += 1;
      rejectNextSendPrompts = 1;
      if (timer) clearTimeout(timer);
      rejectDone?.(new Error('Turn cancelled'));
    },
    onMessage(next) {
      handler = next;
    },
    async dispose() {},
    async waitForResponseComplete() {
      await (done ?? Promise.resolve());
    },
  };

  return { backend, events };
}

describe('executionRuns session RPC handlers', () => {
  it('passes resolved account settings into built-in backend creation', async () => {
    const createBackend = vi.fn(() => createStaticBackend('ok'));

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend,
          sendAcp: () => {},
          resolveAccountSettings: async () => ({ codexBackendMode: 'mcp' }),
        });
      },
    });

    await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Delegate.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(createBackend).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      accountSettings: { codexBackendMode: 'mcp' },
    }));
  });

  it('starts and lists a review run', async () => {
    const sent: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () =>
            createStaticBackend(
              JSON.stringify({
                findings: [
                  { id: 'f1', title: 'Example', severity: 'low', category: 'style', summary: 'One paragraph.' },
                ],
                summary: 'Summary.',
              }),
            ),
          sendAcp: (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) =>
            sent.push({ body, meta: opts?.meta }),
        });
      },
    });

    const started = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(started.runId).toMatch(/^run_/);

    // Bounded runs execute asynchronously; wait a tick so static backends can complete before GET assertions.
    await new Promise((r) => setTimeout(r, 5));

    const listed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {});
    expect(listed.runs?.length ?? 0).toBe(1);
    expect(listed.runs?.[0]?.retentionPolicy).toBe('resumable');
    expect(listed.runs?.[0]?.runClass).toBe('bounded');
    expect(listed.runs?.[0]?.ioMode).toBe('request_response');
    expect(listed.runs?.[0]?.permissionMode).toBe('read_only');

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.runId).toBe(started.runId);
    expect(got.run?.retentionPolicy).toBe('resumable');
    expect(got.run?.runClass).toBe('bounded');
    expect(got.run?.ioMode).toBe('request_response');
    expect(got.run?.permissionMode).toBe('read_only');
    expect(got.latestToolResult?.summary).toBe('Summary.');
    expect(got.latestToolResult?.findingsDigest?.total).toBe(1);

    // Transcript emission happened.
    expect(sent.some((m: any) => m?.body?.type === 'tool-call')).toBe(true);
    expect(sent.some((m: any) => m?.body?.type === 'tool-result')).toBe(true);
    const sidechainMsg = sent.find((m: any) => m?.body?.type === 'message' && typeof m?.body?.sidechainId === 'string');
    expect(sidechainMsg?.body?.sidechainId).toBe(started.callId);
  });

  it('publishes public state updates via onExecutionRunPublicStateUpdated', async () => {
    const updates: ExecutionRunPublicState[] = [];

	    const client = createEncryptedRpcTestClient({
	      scopePrefix: 'sess_1',
	      registerHandlers: (rpc) => {
	        registerExecutionRunHandlers(rpc, {
	          sessionId: 'sess_1',
	          cwd: process.cwd(),
	          parentProvider: 'claude',
	          createBackend: () =>
	            createStaticBackend(
	              JSON.stringify({
	                findings: [],
	                summary: 'Ok.',
	              }),
	            ),
	          sendAcp: () => {},
	          onExecutionRunPublicStateUpdated: (run: ExecutionRunPublicState) => {
	            updates.push(run);
	          },
	        });
	      },
	    });

    const started = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(updates.some((run) => run.runId === started.runId && run.status === 'running')).toBe(true);

    let terminalStatus: string | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
      if (got?.run?.status && got.run.status !== 'running') {
        terminalStatus = got.run.status;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(terminalStatus).not.toBeNull();
    expect(updates.some((run) => run.runId === started.runId && run.status === terminalStatus)).toBe(true);
  });

  it('applies execution.run.list filters on the canonical handler path', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: (opts) =>
            opts.backendId === 'claude'
              ? createDelayedBackend('running later', 50_000)
              : createStaticBackend(JSON.stringify({ findings: [], summary: 'done' })),
          sendAcp: () => {},
        });
      },
    });

    const running = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    const succeeded = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const listed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {
      status: 'running',
      backendId: 'claude',
      limit: 1,
    });

    expect(listed.runs).toEqual([
      expect.objectContaining({
        runId: running.runId,
        status: 'running',
      }),
    ]);
    expect(listed.runs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: succeeded.runId,
        }),
      ]),
    );
  });

  it('returns structured review meta when includeStructured is true and supports review actions', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () =>
            createStaticBackend(
              JSON.stringify({
                findings: [
                  { id: 'f1', title: 'Example', severity: 'low', category: 'style', summary: 'One paragraph.' },
                ],
                summary: 'Summary.',
              }),
            ),
          sendAcp: (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) =>
            sent.push({ body, meta: opts?.meta }),
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 5));

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, {
      runId: started.runId,
      includeStructured: true,
    });
    expect(got.run?.retentionPolicy).toBe('resumable');
    expect(got.run?.availableActionIds).toEqual(['review.triage', 'review.follow_up']);
    expect(got.structuredMeta?.kind).toBe('review_findings.v2');
    expect(got.structuredMeta?.payload?.runRef?.runId).toBe(started.runId);

    const acted = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, {
      runId: started.runId,
      actionId: 'review.triage',
      input: {
        findings: [{ id: 'f1', status: 'accept' }],
      },
    });
    expect(acted.ok).toBe(true);

    // The action should re-emit a tool-result meta update.
    const metaToolResult = [...sent].reverse().find((m) => (m.body as any)?.type === 'tool-result' && m.meta);
    expect((metaToolResult?.meta as any)?.happier?.kind).toBe('review_findings.v2');
  });

  it('can stop a running execution run via execution.run.stop', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () =>
            createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 50_000),
          sendAcp: (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) =>
            sent.push({ body, meta: opts?.meta }),
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    const stopped = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: started.runId });
    expect(stopped.ok).toBe(true);

    // Cancellation emits a tool-result with cancelled status.
    const toolResult = [...sent].reverse().find((m) => (m.body as any)?.type === 'tool-result');
    expect((toolResult?.body as any)?.output?.status).toBe('cancelled');
  });

  it('supports execution.run.send for long-lived runs', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('reply'),
          sendAcp: (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) =>
            sent.push({ body, meta: opts?.meta }),
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'hello',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    expect(sent.filter((m: any) => m?.body?.type === 'message').length).toBe(1);

    const sentReply = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'next',
    });
    expect(sentReply.ok).toBe(true);
    await expect
      .poll(() => sent.filter((m: any) => m?.body?.type === 'message').length, { timeout: 1_000 })
      .toBe(2);
  });

  it('returns execution_run_busy when delivery=prompt and a long-lived run already has a turn in flight', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];
    const { backend, events } = createSequencedBackend({
      responses: [
        { text: 'start', delayMs: 0 },
        { text: 'reply', delayMs: 50 },
      ],
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) =>
            sent.push({ body, meta: opts?.meta }),
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    // Long-lived runs execute their first turn asynchronously; wait a tick so subsequent send() calls
    // deterministically test in-flight behavior for a later turn.
    await new Promise((r) => setTimeout(r, 5));

    const p1 = client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'first',
      delivery: 'prompt',
    });
    await new Promise((r) => setTimeout(r, 5));

    const p2 = client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'second',
      delivery: 'prompt',
    });

    const busy = await p2;
    expect(busy.ok).toBe(false);
    expect(busy.errorCode).toBe('execution_run_busy');

    await p1;
    expect(events.sendPrompts.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps long-lived runs running when a turn is cancelled by the backend', async () => {
    const { backend } = createSequencedBackend({
      responses: [{ text: 'start', delayMs: 0 }],
      supportsSteer: false,
      completionRejectMessage: 'Turn cancelled',
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 15));

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('running');
    expect(got.run?.error).toBeUndefined();
  });

  it('does not terminalize long-lived runs when sendPrompt fails with an abort-like error', async () => {
    let handler: AgentMessageHandler | null = null;
    const backend: AgentBackend = {
      async startSession() {
        return { sessionId: 'child_session_1' as SessionId };
      },
      async sendPrompt() {
        throw new Error('Turn cancelled');
      },
      async cancel() {},
      onMessage(next) {
        handler = next;
      },
      async dispose() {},
      async waitForResponseComplete() {
        handler?.({ type: 'status', status: 'idle' } as any);
      },
    };

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 15));

    const sent = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'hi',
      delivery: 'prompt',
    });
    expect(sent.ok).toBe(false);

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('running');
    expect(got.run?.error).toBeUndefined();
  });

  it('steers an in-flight long-lived run when delivery=steer_if_supported and backend supports sendSteerPrompt', async () => {
    const { backend, events } = createSequencedBackend({
      responses: [
        { text: 'start', delayMs: 0 },
        { text: 'reply', delayMs: 50 },
      ],
      supportsSteer: true,
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 5));

    const p1 = client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'first',
      delivery: 'prompt',
    });
    await new Promise((r) => setTimeout(r, 5));

    const steered = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'steer text',
      delivery: 'steer_if_supported',
    });
    expect(steered.ok).toBe(true);
    expect(events.steerPrompts).toEqual(['steer text']);

    await p1;
  });

  it('interrupts an in-flight long-lived run when delivery=interrupt by cancelling then sending a new prompt', async () => {
    const { backend, events } = createSequencedBackend({
      responses: [
        { text: 'start', delayMs: 0 },
        { text: 'reply', delayMs: 50 },
        { text: 'after', delayMs: 0 },
      ],
      supportsSteer: false,
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 5));

    const p1 = client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'first',
      delivery: 'prompt',
    });
    await new Promise((r) => setTimeout(r, 5));

    const interrupted = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'second',
      delivery: 'interrupt',
    });
    expect(interrupted.ok).toBe(true);
    expect(events.cancelCount).toBe(1);
    expect(events.sendPrompts.some((p) => p === 'second')).toBe(true);

    await p1;
  });

	  it('retries cancel+send when the backend transiently rejects the next prompt after cancel', async () => {
	    const { backend, events } = createCancelRaceBackend({ longDelayMs: 200 });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: () => {},
        });
      },
    });

	    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
	      intent: 'delegate',
	      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
	      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
	      ioMode: 'request_response',
	    });

	    // Wait until the initial prompt is actually in-flight before issuing an interrupt.
	    // Under high CI load, a fixed sleep can race and cause the interrupt path to be exercised without a cancel.
	    for (let attempt = 0; attempt < 200; attempt += 1) {
	      if (events.sendPrompts.length > 0) break;
	      await new Promise((r) => setTimeout(r, 5));
	    }
	    expect(events.sendPrompts.length).toBeGreaterThan(0);

	    const interrupted = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
	      runId: started.runId,
	      message: 'second',
      delivery: 'interrupt',
    });
	    expect(interrupted.ok).toBe(true);
	    expect(events.cancelCount).toBe(1);

	    for (let attempt = 0; attempt < 200; attempt += 1) {
	      if (events.sendPrompts.some((p) => p === 'second')) break;
	      await new Promise((r) => setTimeout(r, 5));
	    }

	    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
	    expect(got.run?.status).toBe('running');
	    expect(events.sendPrompts.some((p) => p === 'second')).toBe(true);
	  });

  it('does not terminalize long-lived runs when multiple in-flight turns are cancelled for steering', async () => {
    const { backend } = createSequencedBackend({
      responses: [
        // Start turn: long enough that the first send interrupts it.
        { text: 'start', delayMs: 50 },
        // First user send: long enough that the second send interrupts it.
        { text: 'first', delayMs: 50 },
        // Second user send: completes quickly.
        { text: 'second', delayMs: 0 },
      ],
      supportsSteer: false,
      cancelRejects: true,
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 5));

    const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'first',
      delivery: 'interrupt',
    });
    expect(first.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 5));

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'second',
      delivery: 'interrupt',
    });
    expect(second.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 75));

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('running');
    expect(got.run?.error).toBeUndefined();
  });

  it('supports steering bounded runs while running (cancel+send fallback when steer is unavailable)', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];
    const { backend, events } = createSequencedBackend({
      responses: [
        // Initial bounded prompt output (will be cancelled before it emits)
        { text: JSON.stringify({ findings: [], summary: 'initial' }), delayMs: 50 },
        // After interrupt, emit valid output
        { text: JSON.stringify({ findings: [], summary: 'after' }), delayMs: 0 },
      ],
      supportsSteer: false,
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) =>
            sent.push({ body, meta: opts?.meta }),
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 5));

    const steered = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'please focus on X',
      delivery: 'steer_if_supported',
    });
    expect(steered.ok).toBe(true);
    expect(events.cancelCount).toBe(1);

    // Wait for bounded completion.
    await new Promise((r) => setTimeout(r, 30));
    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('succeeded');
    expect(got.latestToolResult?.summary).toBe('after');
  });

  it('acks bounded external sends once the replacement turn is adopted, even if the backend never completes it', async () => {
    const previousAckTimeout = process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS;
    process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS = '20';
    try {
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerExecutionRunHandlers(rpc, {
            sessionId: 'sess_1',
            cwd: process.cwd(),
            parentProvider: 'claude',
            createBackend: () => createNeverResolvingBackend(),
            sendAcp: () => {},
          });
        },
      });

      const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      });

      await new Promise((r) => setTimeout(r, 5));

      const sendResult = await Promise.race([
        client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
          runId: started.runId,
          message: 'ping',
          delivery: 'steer_if_supported',
        }),
        new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 250)),
      ]);

      expect(sendResult).not.toBe('__timeout__');
      expect((sendResult as any).ok).toBe(true);

      const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
      expect(got.run?.status).toBe('running');
    } finally {
      if (previousAckTimeout === undefined) {
        delete process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS = previousAckTimeout;
      }
    }
  });

  it('rejects bounded run sends after completion', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend(JSON.stringify({ findings: [], summary: 'ok' })),
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 10));

    const res = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'late',
      delivery: 'steer_if_supported',
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('execution_run_not_allowed');
  });

  it('streams voice_agent turns via execution.run.stream.*', async () => {
    const createdBackends: Array<{ backendId: string; permissionMode: string; modelId?: string }> = [];
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: (opts) => {
            createdBackends.push({ backendId: opts.backendId, permissionMode: opts.permissionMode, modelId: opts.modelId });
            return createStaticBackend(
              `Hello.\n\n<voice_actions>${JSON.stringify({ actions: [{ t: 'sendSessionMessage', args: { message: 'hi' } }] })}</voice_actions>`,
            );
          },
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
      // voice_agent-specific config (wired through execution-run start)
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'You are a helpful voice agent.',
      verbosity: 'short',
      transcript: { persistenceMode: 'ephemeral', epoch: 0 },
    });
    expect(started.runId).toMatch(/^run_/);
    // Start should propagate the chat model ID to the voice agent backend.
    expect(createdBackends.map((b) => b.modelId)).toEqual(expect.arrayContaining(['chat']));

    const streamStart = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Hi',
    });
    expect(streamStart.streamId).toMatch(/^stream_/);

    const read = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
      runId: started.runId,
      streamId: streamStart.streamId,
      cursor: 0,
      maxEvents: 128,
    });
    expect(read.done).toBe(true);
    const done = (read.events as any[]).find((e) => e.t === 'done') ?? null;
    expect(done?.assistantText).toBe('I sent that to the coding assistant and am waiting for its update.');
    expect(done?.actions?.[0]?.t).toBe('sendSessionMessage');
  });

  it('hydrates cached voice replay summaries on the daemon before the first streamed turn', async () => {
    const { readCredentials } = await import('@/persistence');
    const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
    const { fetchEncryptedTranscriptMessages } = await import('@/session/replay/fetchEncryptedTranscriptMessages');
    vi.mocked(readCredentials).mockResolvedValue({
      token: 'token_1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    } as any);
    vi.mocked(fetchSessionById).mockResolvedValue({
      id: 'sys_voice',
      seq: 3,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
      dataEncryptionKey: null,
    } as any);
    vi.mocked(fetchEncryptedTranscriptMessages).mockResolvedValue([
      {
        seq: 1,
        createdAt: 100,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'Old user turn' },
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'va_1', ts: 100 } } },
          },
        },
      },
      {
        seq: 2,
        createdAt: 200,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: { type: 'text', text: 'Old assistant turn' },
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'assistant', voiceAgentId: 'va_1', ts: 200 } } },
          },
        },
      },
      {
        seq: 3,
        createdAt: 300,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: { type: 'text', text: '[synopsis]' },
            meta: { happier: { kind: 'session_synopsis.v1', payload: { v: 1, seqTo: 2, updatedAtMs: 9, synopsis: 'Cached replay summary' } } },
          },
        },
      },
    ] as any);

    const { backend, events } = createSequencedBackend({
      responses: [{ text: 'Voice reply', delayMs: 0 }],
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<ExecutionRunStartResponse, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'Base context',
      verbosity: 'short',
      transcript: { persistenceMode: 'persistent', epoch: 3 },
      replay: {
        kind: 'voice_session.v1',
        previousSessionId: 'sys_voice',
        transcriptEpoch: 3,
        strategy: 'summary_plus_recent',
        recentMessagesCount: 2,
      },
    });

    await client.call(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'continue',
    });

    expect(events.sendPrompts[0]).toContain('Cached replay summary');
    expect(events.sendPrompts[0]).toContain('Old assistant turn');
  });

  it('falls back to on-demand replay summaries for voice runs when no cached synopsis exists', async () => {
    const { readCredentials } = await import('@/persistence');
    const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
    const { fetchEncryptedTranscriptMessages } = await import('@/session/replay/fetchEncryptedTranscriptMessages');
    const { runReplaySummaryForDialog } = await import('@/session/replay/summary/runReplaySummaryForDialog');
    vi.mocked(readCredentials).mockResolvedValue({
      token: 'token_1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    } as any);
    vi.mocked(fetchSessionById).mockResolvedValue({
      id: 'sys_voice',
      seq: 2,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
      dataEncryptionKey: null,
    } as any);
    vi.mocked(fetchEncryptedTranscriptMessages).mockResolvedValue([
      {
        seq: 1,
        createdAt: 100,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'User asked to continue' },
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 4, role: 'user', voiceAgentId: 'va_1', ts: 100 } } },
          },
        },
      },
      {
        seq: 2,
        createdAt: 200,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: { type: 'text', text: 'Assistant answered previously' },
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 4, role: 'assistant', voiceAgentId: 'va_1', ts: 200 } } },
          },
        },
      },
    ] as any);
    vi.mocked(runReplaySummaryForDialog).mockResolvedValue('Generated replay summary');

    const { backend, events } = createSequencedBackend({
      responses: [{ text: 'Voice reply', delayMs: 0 }],
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<ExecutionRunStartResponse, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'Base context',
      verbosity: 'short',
      transcript: { persistenceMode: 'persistent', epoch: 4 },
      replay: {
        kind: 'voice_session.v1',
        previousSessionId: 'sys_voice',
        transcriptEpoch: 4,
        strategy: 'summary_plus_recent',
        recentMessagesCount: 2,
        summaryRunner: {
          v: 1,
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          modelId: 'default',
          permissionMode: 'no_tools',
        },
      },
    });

    await client.call(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'continue',
    });

    expect(vi.mocked(runReplaySummaryForDialog)).toHaveBeenCalledTimes(1);
    expect(events.sendPrompts[0]).toContain('Generated replay summary');
    expect(events.sendPrompts[0]).toContain('Assistant answered previously');
  });

  it('defers replay seed delivery to the first turn when voice prewarm uses a READY handshake', async () => {
    const { readCredentials } = await import('@/persistence');
    const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
    const { fetchEncryptedTranscriptMessages } = await import('@/session/replay/fetchEncryptedTranscriptMessages');
    vi.mocked(readCredentials).mockResolvedValue({
      token: 'token_1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    } as any);
    vi.mocked(fetchSessionById).mockResolvedValue({
      id: 'sys_voice',
      seq: 3,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
      dataEncryptionKey: null,
    } as any);
    vi.mocked(fetchEncryptedTranscriptMessages).mockResolvedValue([
      {
        seq: 1,
        createdAt: 100,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'Old user turn' },
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 5, role: 'user', voiceAgentId: 'va_1', ts: 100 } } },
          },
        },
      },
      {
        seq: 2,
        createdAt: 200,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: { type: 'text', text: 'Old assistant turn' },
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 5, role: 'assistant', voiceAgentId: 'va_1', ts: 200 } } },
          },
        },
      },
      {
        seq: 3,
        createdAt: 300,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: { type: 'text', text: '[synopsis]' },
            meta: { happier: { kind: 'session_synopsis.v1', payload: { v: 1, seqTo: 2, updatedAtMs: 9, synopsis: 'Cached replay summary' } } },
          },
        },
      },
    ] as any);

    const { backend, events } = createSequencedBackend({
      responses: [{ text: 'READY', delayMs: 0 }, { text: 'Voice reply', delayMs: 0 }],
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<ExecutionRunStartResponse, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'Base context',
      verbosity: 'short',
      bootstrapMode: 'ready_handshake',
      transcript: { persistenceMode: 'persistent', epoch: 5 },
      replay: {
        kind: 'voice_session.v1',
        previousSessionId: 'sys_voice',
        transcriptEpoch: 5,
        strategy: 'summary_plus_recent',
        recentMessagesCount: 2,
      },
    });

    expect(events.sendPrompts[0]).toContain('Warm-up step: reply with exactly READY');
    expect(events.sendPrompts[0]).not.toContain('Cached replay summary');
    expect(events.sendPrompts[0]).not.toContain('Old assistant turn');

    await client.call(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'continue',
    });

    expect(events.sendPrompts[1]).toContain('Cached replay summary');
    expect(events.sendPrompts[1]).toContain('Old assistant turn');
  });

  it('commits persistent voice_agent transcript turns durably via the transcript port', async () => {
    const committedUserTurns: Array<{ text: string; meta: Record<string, unknown> }> = [];
    const committedAssistantTurns: Array<{ text: string; meta: Record<string, unknown> }> = [];
    const bestEffortUserTurns: string[] = [];
    const bestEffortAssistantTurns: string[] = [];

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('Committed reply'),
          sendAcp: () => {},
          transcriptWriter: {
            appendUserText: (text: string) => {
              bestEffortUserTurns.push(text);
            },
            appendAssistantText: (text: string) => {
              bestEffortAssistantTurns.push(text);
            },
            appendUserTextCommitted: async (text: string, meta: Record<string, unknown>) => {
              committedUserTurns.push({ text, meta });
            },
            appendAssistantTextCommitted: async (text: string, meta: Record<string, unknown>) => {
              committedAssistantTurns.push({ text, meta });
            },
          } as any,
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
      transcript: { persistenceMode: 'persistent', epoch: 4 },
    });

    const streamStart = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Persist this user turn',
      displayMessage: 'Persist only this clean user turn',
    });
    const read = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
      runId: started.runId,
      streamId: streamStart.streamId,
      cursor: 0,
      maxEvents: 128,
    });

    expect(read.done).toBe(true);
    expect(committedUserTurns).toHaveLength(1);
    expect(committedUserTurns[0]?.text).toBe('Persist only this clean user turn');
    expect(committedUserTurns[0]?.meta).toMatchObject({
      happier: { kind: 'voice_agent_turn.v1', payload: { epoch: 4, role: 'user' } },
    });
    expect(committedAssistantTurns).toHaveLength(1);
    expect(committedAssistantTurns[0]?.text).toBe('Committed reply');
    expect(committedAssistantTurns[0]?.meta).toMatchObject({
      happier: { kind: 'voice_agent_turn.v1', payload: { epoch: 4, role: 'assistant' } },
    });
    expect(bestEffortUserTurns).toHaveLength(0);
    expect(bestEffortAssistantTurns).toHaveLength(0);
  });

  it('supports voice_agent stream resume via execution.run.stream.start(resume=true) after stop when backend supports loadSession', async () => {
    const createBackend = createResumableBackendFactory(
      `Hello.\n\n<voice_actions>${JSON.stringify({ actions: [{ t: 'sendSessionMessage', args: { message: 'hi' } }] })}</voice_actions>`,
    );

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createBackend(),
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
      transcript: { persistenceMode: 'ephemeral', epoch: 0 },
    });

    const stream1 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Hi',
    });
    const read1 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
      runId: started.runId,
      streamId: stream1.streamId,
      cursor: 0,
      maxEvents: 128,
    });
    expect(read1.done).toBe(true);
    expect((read1.events as any[]).find((e) => e.t === 'done')?.assistantText).toBe(
      'I sent that to the coding assistant and am waiting for its update.',
    );

    const stopped = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: started.runId });
    expect(stopped.ok).toBe(true);

    const stream2 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Hi again',
      resume: true,
    });
    expect(stream2.streamId).toMatch(/^stream_/);
    const read2 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
      runId: started.runId,
      streamId: stream2.streamId,
      cursor: 0,
      maxEvents: 128,
    });
    expect(read2.done).toBe(true);
    expect((read2.events as any[]).find((e) => e.t === 'done')?.assistantText).toBe(
      'I sent that to the coding assistant and am waiting for its update.',
    );
  });

  it('resumes voice_agent streams after commit when the run stores a voice_agent_sessions resume handle', async () => {
    const loadCalls = { chat: [] as string[], commit: [] as string[] };
    const handlers: Record<string, AgentMessageHandler | null> = { chat: null, commit: null };

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ modelId }) => ({
            async startSession() {
              return { sessionId: (modelId === 'commit' ? 'commit_session_1' : 'chat_session_1') as SessionId };
            },
            async loadSession(sessionId: SessionId) {
              if (modelId === 'commit') loadCalls.commit.push(String(sessionId));
              else loadCalls.chat.push(String(sessionId));
              return { sessionId };
            },
            async sendPrompt(_sessionId: SessionId, _prompt: string) {
              const responseText =
                modelId === 'commit'
                  ? 'COMMIT_TEXT'
                  : `Hello.\n\n<voice_actions>${JSON.stringify({ actions: [{ t: 'sendSessionMessage', args: { message: 'hi' } }] })}</voice_actions>`;
              handlers[modelId === 'commit' ? 'commit' : 'chat']?.({ type: 'model-output', fullText: responseText } as AgentMessage);
            },
            async cancel(_sessionId: SessionId) {},
            onMessage(next) {
              handlers[modelId === 'commit' ? 'commit' : 'chat'] = next;
            },
            async dispose() {},
            async waitForResponseComplete() {},
          }),
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
      transcript: { persistenceMode: 'ephemeral', epoch: 0 },
    });

    const stream1 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Hi',
    });
    const read1 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
      runId: started.runId,
      streamId: stream1.streamId,
      cursor: 0,
      maxEvents: 128,
    });
    expect(read1.done).toBe(true);

    const committed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, {
      runId: started.runId,
      actionId: 'voice_agent.commit',
      input: { maxChars: 1000 },
    });
    expect(committed.ok).toBe(true);
    expect(committed.result?.commitText).toBe('COMMIT_TEXT');

    const beforeStop = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, {
      runId: started.runId,
      includeStructured: false,
    });
    expect(beforeStop?.run?.resumeHandle?.kind).toBe('voice_agent_sessions.v1');

    const stopped = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: started.runId });
    expect(stopped.ok).toBe(true);

    const stream2 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Hi again',
      resume: true,
    });
    expect(stream2.streamId).toMatch(/^stream_/);

    const read2 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
      runId: started.runId,
      streamId: stream2.streamId,
      cursor: 0,
      maxEvents: 128,
    });
    expect(read2.done).toBe(true);
    expect((read2.events as any[]).find((e) => e.t === 'done')?.assistantText).toBe(
      'I sent that to the coding assistant and am waiting for its update.',
    );
    expect(loadCalls.chat).toEqual(['chat_session_1']);
    expect(loadCalls.commit).toEqual(['commit_session_1']);
  });

  it('fails closed for long-lived resumable runs via execution.run.send(resume=true) when backend lacks loadSessionWithReplayCapture', async () => {
    const createBackend = createResumableBackendFactory('reply');

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createBackend(),
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    const stopped = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: started.runId });
    expect(stopped.ok).toBe(true);

    const resumed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'after',
      resume: true,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.errorCode).toBe('execution_run_not_allowed');
  });

  it('rejects voice_agent runs when voice feature is locally disabled', async () => {
    const prev = process.env.HAPPIER_FEATURE_VOICE__ENABLED;
    process.env.HAPPIER_FEATURE_VOICE__ENABLED = '0';
    try {
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerExecutionRunHandlers(rpc, {
            sessionId: 'sess_1',
            cwd: process.cwd(),
            parentProvider: 'claude',
            createBackend: () => createStaticBackend('Hello.'),
            sendAcp: () => {},
          });
        },
      });

      const res = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'long_lived',
        ioMode: 'streaming',
      });

      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe('execution_run_not_allowed');
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_FEATURE_VOICE__ENABLED;
      else process.env.HAPPIER_FEATURE_VOICE__ENABLED = prev;
    }
  });

  it('returns ok:false VOICE_AGENT_UNSUPPORTED when starting a voice_agent run with an unsupported backend', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ backendId }) => {
            if (backendId === 'codex') {
              throw new Error('codex missing');
            }
            return createStaticBackend('ok');
          },
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(started?.ok).toBe(false);
    expect(started?.errorCode).toBe('VOICE_AGENT_UNSUPPORTED');
    expect(String(started?.error ?? '')).toContain('codex');
  });

  it('returns ok:false VOICE_AGENT_UNSUPPORTED when starting a voice_agent run and backend initialization fails (claude)', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ backendId }) => {
            if (backendId === 'claude') {
              throw new Error('claude missing');
            }
            return createStaticBackend('ok');
          },
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(started?.ok).toBe(false);
    expect(started?.errorCode).toBe('VOICE_AGENT_UNSUPPORTED');
    expect(String(started?.error ?? '')).toContain('claude');
  });

  it('passes configured ACP backend targets through to the execution-run backend factory', async () => {
    const seenTargets: unknown[] = [];
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ backendId, backendTarget }) => {
            seenTargets.push(backendTarget);
            if (backendId !== 'customAcp') {
              throw new Error(`Unexpected backend: ${backendId}`);
            }
            if (backendTarget?.kind !== 'configuredAcpBackend' || backendTarget.backendId !== 'review-bot') {
              throw new Error('Missing configured ACP backend target');
            }
            return createStaticBackend('configured ok');
          },
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      instructions: 'Review the changes',
    });

    expect(started?.runId).toEqual(expect.any(String));
    expect(seenTargets).toEqual([{ kind: 'configuredAcpBackend', backendId: 'review-bot' }]);
  });

  it('returns voice_agent.commit results via execution.run.action', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ modelId }) => createStaticBackend(modelId === 'commit' ? 'COMMIT_TEXT' : 'Hello.'),
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
    });

    const acted = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, {
      runId: started.runId,
      actionId: 'voice_agent.commit',
      input: { maxChars: 1000 },
    });

    expect(acted.ok).toBe(true);
    expect(acted.result?.commitText).toBe('COMMIT_TEXT');

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, {
      runId: started.runId,
      includeStructured: false,
    });
    expect(got?.run?.availableActionIds).toEqual(['voice_agent.welcome', 'voice_agent.commit']);
    expect(got?.run?.resumeHandle?.kind).toBe('voice_agent_sessions.v1');
  });

  it('returns voice_agent.welcome results via execution.run.action', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('Hello! What are we working on today?'),
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
    });

    const acted = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, {
      runId: started.runId,
      actionId: 'voice_agent.welcome',
    });

    expect(acted.ok).toBe(true);
    expect(String(acted.result?.assistantText ?? '')).toContain('Hello');
  });

  it('does not materialize tool-call transcript messages for voice_agent runs', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('Hello.'),
          sendAcp: (_provider, body, opts) => sent.push({ body, meta: opts?.meta }),
        });
      },
    });

    await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
    });

    expect(sent.some((m) => (m.body as any)?.type === 'tool-call')).toBe(false);
  });

  it('releases execution budgets when voice_agent start fails', async () => {
    const budgetRegistry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: 1,
      maxConcurrentEphemeralTasks: 1,
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ backendId }) => {
            if (backendId === 'codex') throw new Error('codex missing');
            return createStaticBackend('ok');
          },
          sendAcp: () => {},
          budgetRegistry,
        });
      },
    });

    const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });
    expect(first?.ok).toBe(false);
    expect(first?.errorCode).toBe('VOICE_AGENT_UNSUPPORTED');

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });
    expect(second?.runId).toMatch(/^run_/);
  });

  it('returns canonical execution_run_invalid_action_input when review.triage receives an invalid payload', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend(JSON.stringify({ findings: [], summary: 'ok' })),
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 5));

    const acted = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, {
      runId: started.runId,
      actionId: 'review.triage',
      input: { findings: 'not-an-array' },
    });
    expect(acted.ok).toBe(false);
    expect(acted.errorCode).toBe('execution_run_invalid_action_input');
  });

  it('returns canonical execution_run_failed when execution.run.send fails mid-run', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createThrowingBackend({ throwAtSendCount: 2, message: 'boom' }),
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'hello',
      permissionMode: 'default',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    const res = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'next',
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('execution_run_failed');
  });

  it('returns permission_denied when starting a review run with an unsafe permissionMode', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend(JSON.stringify({ findings: [], summary: 'ok' })),
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'full',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(started.ok).toBe(false);
    expect(started.errorCode).toBe('permission_denied');
  });

  it('accepts canonical UI read-only permission tokens when starting a review run', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend(JSON.stringify({ findings: [], summary: 'ok' })),
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read-only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });

    expect(typeof started.runId).toBe('string');
    expect(typeof started.callId).toBe('string');
    expect(typeof started.sidechainId).toBe('string');
  });

  it('fails early when starting a CodeRabbit review with no reviewable files in the current session scope', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'happier-execution-run-coderabbit-remote-'));
    runGit(remote, ['init', '--bare', '--initial-branch=main']);

    const workspace = mkdtempSync(join(tmpdir(), 'happier-execution-run-coderabbit-workspace-'));
    runGit(workspace, ['init', '--initial-branch=main']);
    runGit(workspace, ['config', 'user.email', 'test@example.com']);
    runGit(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'a.txt'), 'base\n');
    runGit(workspace, ['add', 'a.txt']);
    runGit(workspace, ['commit', '-m', 'base']);
    runGit(workspace, ['remote', 'add', 'origin', remote]);
    runGit(workspace, ['push', '-u', 'origin', 'main']);

    let createBackendCalls = 0;
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: workspace,
          parentProvider: 'claude',
          createBackend: () => {
            createBackendCalls += 1;
            return createStaticBackend(JSON.stringify({ findings: [], summary: 'unexpected' }));
          },
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
      instructions: 'Review the current scope.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
      intentInput: {
        engineId: 'coderabbit',
        engineIds: ['coderabbit'],
        instructions: 'Review the current scope.',
        changeType: 'committed',
        base: { kind: 'none' },
      },
    });

    expect(started).toMatchObject({
      ok: false,
      errorCode: 'execution_run_not_allowed',
    });
    expect(String(started.error ?? '')).toContain('No reviewable files');
    expect(createBackendCalls).toBe(0);
  });

  it('returns a structured error when starting a CodeRabbit review without a resolvable default base branch', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-execution-run-coderabbit-no-base-'));
    runGit(workspace, ['init', '--initial-branch=main']);
    runGit(workspace, ['config', 'user.email', 'test@example.com']);
    runGit(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'a.txt'), 'base\n');
    runGit(workspace, ['add', 'a.txt']);
    runGit(workspace, ['commit', '-m', 'base']);
    writeFileSync(join(workspace, 'a.txt'), 'changed\n');
    runGit(workspace, ['add', 'a.txt']);
    runGit(workspace, ['commit', '-m', 'change']);

    let createBackendCalls = 0;
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: workspace,
          parentProvider: 'claude',
          createBackend: () => {
            createBackendCalls += 1;
            return createStaticBackend(JSON.stringify({ findings: [], summary: 'unexpected' }));
          },
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
      instructions: 'Review the current scope.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
      intentInput: {
        engineId: 'coderabbit',
        engineIds: ['coderabbit'],
        instructions: 'Review the current scope.',
        changeType: 'committed',
        base: { kind: 'none' },
      },
    });

    expect(started).toMatchObject({
      ok: false,
      errorCode: 'execution_run_not_allowed',
    });
    expect(String(started.error ?? '')).toContain('Unable to resolve a default base branch');
    expect(createBackendCalls).toBe(0);
  });

  it('fails early when starting a CodeRabbit review whose scope exceeds the configured file limit', async () => {
    const originalMaxEligibleFiles = process.env.HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES;
    process.env.HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES = '1';
    try {
      const remote = mkdtempSync(join(tmpdir(), 'happier-execution-run-coderabbit-remote-'));
      runGit(remote, ['init', '--bare', '--initial-branch=main']);

      const workspace = mkdtempSync(join(tmpdir(), 'happier-execution-run-coderabbit-workspace-'));
      runGit(workspace, ['init', '--initial-branch=main']);
      runGit(workspace, ['config', 'user.email', 'test@example.com']);
      runGit(workspace, ['config', 'user.name', 'Test User']);
      writeFileSync(join(workspace, 'a.txt'), 'base\n');
      writeFileSync(join(workspace, 'b.txt'), 'base\n');
      runGit(workspace, ['add', 'a.txt', 'b.txt']);
      runGit(workspace, ['commit', '-m', 'base']);
      runGit(workspace, ['remote', 'add', 'origin', remote]);
      runGit(workspace, ['push', '-u', 'origin', 'main']);
      writeFileSync(join(workspace, 'a.txt'), 'changed\n');
      writeFileSync(join(workspace, 'b.txt'), 'changed\n');
      runGit(workspace, ['add', 'a.txt', 'b.txt']);
      runGit(workspace, ['commit', '-m', 'change']);

      let createBackendCalls = 0;
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerExecutionRunHandlers(rpc, {
            sessionId: 'sess_1',
            cwd: workspace,
            parentProvider: 'claude',
            createBackend: () => {
              createBackendCalls += 1;
              return createStaticBackend(JSON.stringify({ findings: [], summary: 'unexpected' }));
            },
            sendAcp: () => {},
          });
        },
      });

      const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
        instructions: 'Review the current scope.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'streaming',
        intentInput: {
          engineId: 'coderabbit',
          engineIds: ['coderabbit'],
          instructions: 'Review the current scope.',
          changeType: 'committed',
          base: { kind: 'none' },
        },
      });

      expect(started).toMatchObject({
        ok: false,
        errorCode: 'execution_run_not_allowed',
      });
      expect(String(started.error ?? '')).toContain('Too many reviewable files');
      expect(createBackendCalls).toBe(0);
    } finally {
      if (originalMaxEligibleFiles === undefined) delete process.env.HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES;
      else process.env.HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES = originalMaxEligibleFiles;
    }
  });

  it('allows starting a bounded review run with streaming ioMode (sidechain transcript streaming)', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend(JSON.stringify({ findings: [], summary: 'ok' })),
          sendAcp: () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });

    expect(started.runId).toMatch(/^run_/);
    expect(started.callId).toMatch(/^subagent_run_/);
    expect(started.sidechainId).toBe(started.callId);
  });

  it('returns execution_run_budget_exceeded when max concurrent runs is reached', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 50_000),
          sendAcp: () => {},
          policy: { maxConcurrentRuns: 1, boundedTimeoutMs: 60_000 },
        });
      },
    });

    const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(first.runId).toMatch(/^run_/);

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review again.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(second.ok).toBe(false);
    expect(second.errorCode).toBe('execution_run_budget_exceeded');
  });

  it('does not enforce a fallback concurrent-run cap when maxConcurrentRuns is unset', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 50_000),
          sendAcp: () => {},
          policy: { maxConcurrentRuns: null as number | null, boundedTimeoutMs: null as number | null },
        });
      },
    });

    const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(first.runId).toMatch(/^run_/);

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review again.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(second.runId).toMatch(/^run_/);
  });

  it('uses centralized configuration defaults when no explicit policy override is provided', async () => {
    const previousMaxConcurrentRuns = process.env.HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION;
    process.env.HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION = '1';
    reloadConfiguration();

    try {
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerExecutionRunHandlers(rpc, {
            sessionId: 'sess_1',
            cwd: process.cwd(),
            parentProvider: 'claude',
            createBackend: () => createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 50_000),
            sendAcp: () => {},
          });
        },
      });

      const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      });
      expect(first.runId).toMatch(/^run_/);

      const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review again.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      });

      expect(second.ok).toBe(false);
      expect(second.errorCode).toBe('execution_run_budget_exceeded');
    } finally {
      if (previousMaxConcurrentRuns === undefined) delete process.env.HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION;
      else process.env.HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION = previousMaxConcurrentRuns;
      reloadConfiguration();
    }
  });

  it('enforces per-intent budget caps when a budget registry is provided', async () => {
    const budgetRegistry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: 10,
      maxConcurrentEphemeralTasks: 10,
      maxConcurrentByClass: { review: 1 },
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 50_000),
          sendAcp: () => {},
          policy: { maxConcurrentRuns: 50, boundedTimeoutMs: 60_000 },
          budgetRegistry,
        });
      },
    });

    const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(first.runId).toMatch(/^run_/);

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review again.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(second.ok).toBe(false);
    expect(second.errorCode).toBe('execution_run_budget_exceeded');

    const plan = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'plan',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Plan.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(plan.runId).toMatch(/^run_/);
  });

  it('returns run_depth_exceeded when maxDepth is exceeded via parentRunId nesting', async () => {
    const sent: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () =>
            createStaticBackend(
              JSON.stringify({
                findings: [],
                summary: 'Summary.',
              }),
            ),
          sendAcp: (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) =>
            sent.push({ body, meta: opts?.meta }),
          policy: {
            maxDepth: 0,
          },
        });
      },
    });

    const parent = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    const child = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Nested review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      parentRunId: parent.runId,
    });

    expect(child.ok).toBe(false);
    expect(child.errorCode).toBe('run_depth_exceeded');
  });

  it('times out bounded execution runs deterministically when boundedTimeoutMs elapses', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 50_000),
          sendAcp: () => {},
          policy: { maxConcurrentRuns: 5, boundedTimeoutMs: 10 },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 50));

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('timeout');
    expect(got.latestToolResult?.status).toBe('timeout');
  });

  it('uses the review-specific bounded timeout for review runs when provided by policy', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        const policy = {
          maxConcurrentRuns: 5,
          boundedTimeoutMs: 10,
          reviewBoundedTimeoutMs: 100,
        };
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 30),
          sendAcp: () => {},
          policy,
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 50));

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('succeeded');
    expect(got.latestToolResult?.status).toBe('succeeded');
  });

  it('enforces maxTurns for long-lived runs deterministically', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('reply'),
          sendAcp: () => {},
          policy: { maxConcurrentRuns: 5, boundedTimeoutMs: 60_000, maxTurns: 1 },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'hello',
      permissionMode: 'default',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    const sentReply = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'next',
    });

    expect(sentReply.ok).toBe(false);
    expect(sentReply.errorCode).toBe('execution_run_not_allowed');
  });

  it('supports resumable bounded runs via execution.run.send(resume=true) when backend supports loadSession', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];
    const createBackend = createResumableBackendFactory(JSON.stringify({ findings: [], summary: 'ok' }));

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createBackend(),
          sendAcp: (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) =>
            sent.push({ body, meta: opts?.meta }),
          policy: { maxConcurrentRuns: 5, boundedTimeoutMs: 60_000 },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 10));
    const completionToolResult = sent.find((m: any) => (m.body as any)?.type === 'tool-result' && m.meta);
    expect((completionToolResult?.meta as any)?.happierExecutionRun?.resumeHandle?.kind).toBe('vendor_session.v1');
    expect((completionToolResult?.meta as any)?.happierExecutionRun?.resumeHandle?.vendorSessionId).toBeTruthy();

    const resumed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'follow-up',
      resume: true,
    });
    expect(resumed.ok).toBe(true);
    expect(sent.filter((m: any) => (m.body as any)?.type === 'message').length).toBeGreaterThanOrEqual(2);
  });

  it('supports execution.run.ensure(resume=true) for resumable runs', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];
    const createBackend = createResumableBackendFactory(JSON.stringify({ findings: [], summary: 'ok' }));

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createBackend(),
          sendAcp: (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) =>
            sent.push({ body, meta: opts?.meta }),
          policy: { maxConcurrentRuns: 5, boundedTimeoutMs: 60_000 },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 10));

    const ensured = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, {
      runId: started.runId,
      resume: true,
    });
    expect(ensured.ok).toBe(true);

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('running');
  });

  it('supports execution.run.ensureOrStart to start when runId is missing and ensure when present', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('reply'),
          sendAcp: () => {},
          policy: { maxConcurrentRuns: 5, boundedTimeoutMs: 60_000 },
        });
      },
    });

    const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START, {
      runId: null,
      start: {
        intent: 'plan',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Plan.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'long_lived',
        ioMode: 'request_response',
      },
    });
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    expect(typeof first.runId).toBe('string');

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START, {
      runId: first.runId,
      start: {
        intent: 'plan',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'ignored',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'long_lived',
        ioMode: 'request_response',
      },
    });
    expect(second.ok).toBe(true);
    expect(second.created).toBe(false);
    expect(second.runId).toBe(first.runId);
  });

  it('supports execution.run.start with resumeHandle when backend supports loadSession', async () => {
    const calls: { startSession: number; loadSession: string[] } = { startSession: 0, loadSession: [] };

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => ({
            onMessage() {},
            async startSession() {
              calls.startSession += 1;
              return { sessionId: 'child_session_new' as SessionId };
            },
            async loadSession(vendorSessionId: SessionId) {
              calls.loadSession.push(String(vendorSessionId));
              return { sessionId: vendorSessionId };
            },
            async sendPrompt() {},
            async cancel() {},
            async dispose() {},
          }),
          sendAcp: () => {},
          policy: { maxConcurrentRuns: 5, boundedTimeoutMs: 60_000 },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      resumeHandle: { kind: 'vendor_session.v1', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, vendorSessionId: 'vendor_1' },
    });
    expect(started.runId).toMatch(/^run_/);
    expect(calls.loadSession).toEqual(['vendor_1']);
    expect(calls.startSession).toBe(0);
  });
});
