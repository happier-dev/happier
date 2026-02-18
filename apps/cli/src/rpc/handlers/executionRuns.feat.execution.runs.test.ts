import { describe, expect, it } from 'vitest';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { FeaturesResponseSchema, type ExecutionRunStartResponse } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerExecutionRunHandlers as registerExecutionRunHandlersBase } from './executionRuns';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';

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

describe('executionRuns session RPC handlers', () => {
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
      backendId: 'claude',
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(started.runId).toMatch(/^run_/);

    const listed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {});
    expect(listed.runs?.length ?? 0).toBe(1);
    expect(listed.runs?.[0]?.retentionPolicy).toBe('ephemeral');
    expect(listed.runs?.[0]?.runClass).toBe('bounded');
    expect(listed.runs?.[0]?.ioMode).toBe('request_response');
    expect(listed.runs?.[0]?.permissionMode).toBe('read_only');

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.runId).toBe(started.runId);
    expect(got.run?.retentionPolicy).toBe('ephemeral');
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

  it('returns structured meta when includeStructured is true and supports review.triage actions', async () => {
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
      backendId: 'claude',
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, {
      runId: started.runId,
      includeStructured: true,
    });
    expect(got.structuredMeta?.kind).toBe('review_findings.v1');
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
    expect((metaToolResult?.meta as any)?.happier?.kind).toBe('review_findings.v1');
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
      backendId: 'claude',
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
      backendId: 'claude',
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
    expect(sent.filter((m: any) => m?.body?.type === 'message').length).toBe(2);
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
      backendId: 'claude',
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
    expect(done?.assistantText).toBe('Hello.');
    expect(done?.actions?.[0]?.t).toBe('sendSessionMessage');
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
      backendId: 'claude',
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
    expect((read1.events as any[]).find((e) => e.t === 'done')?.assistantText).toBe('Hello.');

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
    expect((read2.events as any[]).find((e) => e.t === 'done')?.assistantText).toBe('Hello.');
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
      backendId: 'claude',
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
        backendId: 'claude',
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
      backendId: 'codex',
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
      backendId: 'claude',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(started?.ok).toBe(false);
    expect(started?.errorCode).toBe('VOICE_AGENT_UNSUPPORTED');
    expect(String(started?.error ?? '')).toContain('claude');
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
      backendId: 'claude',
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
      backendId: 'claude',
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
      backendId: 'claude',
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
      backendId: 'codex',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });
    expect(first?.ok).toBe(false);
    expect(first?.errorCode).toBe('VOICE_AGENT_UNSUPPORTED');

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      backendId: 'claude',
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
      backendId: 'claude',
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

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
      backendId: 'claude',
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
      backendId: 'claude',
      instructions: 'Review.',
      permissionMode: 'full',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(started.ok).toBe(false);
    expect(started.errorCode).toBe('permission_denied');
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
      backendId: 'claude',
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
      backendId: 'claude',
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(first.runId).toMatch(/^run_/);

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendId: 'claude',
      instructions: 'Review again.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(second.ok).toBe(false);
    expect(second.errorCode).toBe('execution_run_budget_exceeded');
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
      backendId: 'claude',
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(first.runId).toMatch(/^run_/);

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendId: 'claude',
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
      backendId: 'claude',
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
      backendId: 'claude',
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    const child = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendId: 'claude',
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
      backendId: 'claude',
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
      backendId: 'claude',
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
      backendId: 'claude',
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
      backendId: 'claude',
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
        backendId: 'claude',
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
        backendId: 'claude',
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
      backendId: 'claude',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vendor_1' },
    });
    expect(started.runId).toMatch(/^run_/);
    expect(calls.loadSession).toEqual(['vendor_1']);
    expect(calls.startSession).toBe(0);
  });
});
