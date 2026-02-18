import { describe, expect, it } from 'vitest';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';

import { ExecutionRunManager } from './ExecutionRunManager';

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

describe('ExecutionRunManager (review intent)', () => {
  it('emits SubAgentRun tool-call, sidechain message, and tool-result with review_findings.v1 meta', async () => {
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
      intent: 'review',
      backendId: 'claude',
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
    expect(meta?.happier?.kind).toBe('review_findings.v1');
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
      backendId: 'claude',
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
      backendId: 'claude',
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
      backendId: 'claude',
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('succeeded');
    expect(prompts.length).toBe(2);
    // Second prompt must demand strict JSON (repair pass).
    expect(prompts[1]).toContain('Return ONLY valid JSON');
  });

  it('can apply review triage and re-emit review_findings.v1 meta updates', async () => {
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
      backendId: 'claude',
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
    expect(meta?.happier?.kind).toBe('review_findings.v1');
    expect(meta?.happier?.payload?.triage?.findings?.[0]?.status).toBe('accept');
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
      backendId: 'claude',
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

  it('uses vendor_session_id events to populate resumable resumeHandle', async () => {
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
      backendId: 'claude',
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await manager.waitForTerminal(started.runId);

    const finished = manager.get(started.runId);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.resumeHandle?.kind).toBe('vendor_session.v1');
    expect((finished?.resumeHandle as any)?.vendorSessionId).toBe(vendorSessionId);
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
      backendId: 'claude',
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
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'plan',
      backendId: 'claude',
      instructions: 'Make a plan.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });

    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('succeeded');

    const sidechainChunks = sent.filter(
      (m) => (m.body as any)?.type === 'message' && typeof (m.meta as any)?.happierSidechainStreamKey === 'string',
    );
    expect(sidechainChunks.length).toBeGreaterThanOrEqual(1);
    const concatenated = sidechainChunks.map((m) => String((m.body as any)?.message ?? '')).join('');
    expect(concatenated).toContain('Plan in progress');

    // When streaming output is emitted, the bounded completion should not inject a duplicate
    // "final" sidechain message without the stream key.
    const nonStreamingSidechainMessages = sent.filter(
      (m) => (m.body as any)?.type === 'message' && typeof (m.meta as any)?.happierSidechainStreamKey !== 'string',
    );
    expect(nonStreamingSidechainMessages).toHaveLength(0);
  });

  it('streams review progress without leaking the trailing strict JSON payload', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];

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
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'review',
      backendId: 'claude',
      instructions: 'Review this repo.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });

    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('succeeded');

    const sidechainChunks = sent.filter(
      (m) => (m.body as any)?.type === 'message' && typeof (m.meta as any)?.happierSidechainStreamKey === 'string',
    );
    expect(sidechainChunks.length).toBeGreaterThanOrEqual(1);

    const concatenated = sidechainChunks.map((m) => String((m.body as any)?.message ?? '')).join('');
    expect(concatenated).toContain('Working');
    expect(concatenated).not.toContain('"findings"');

    // A final summary message is still allowed so users get a clear terminal note.
    const finalNonStreaming = sent.find(
      (m) => (m.body as any)?.type === 'message' && typeof (m.meta as any)?.happierSidechainStreamKey !== 'string',
    );
    expect(String((finalNonStreaming?.body as any)?.message ?? '')).toContain('Ok');
  });
});

describe('ExecutionRunManager (long-lived runs)', () => {
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
      backendId: 'claude',
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
    expect(sent.filter((m) => (m.body as any)?.type === 'message').length).toBe(2);
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

  it('streams sidechain output for long-lived runs when ioMode=streaming and avoids emitting a duplicate non-streaming message', async () => {
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];

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
      getNowMs: () => 1_700_000_000_000,
    });

    const started = await manager.start({
      sessionId: 'parent_session_1',
      intent: 'delegate',
      backendId: 'claude',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    const sendResult = await manager.send(started.runId, { message: 'hi' });
    expect(sendResult.ok).toBe(true);

    const streaming = sent.filter(
      (m) => (m.body as any)?.type === 'message' && typeof (m.meta as any)?.happierSidechainStreamKey === 'string',
    );
    expect(streaming.length).toBeGreaterThanOrEqual(1);

    const nonStreaming = sent.filter(
      (m) => (m.body as any)?.type === 'message' && typeof (m.meta as any)?.happierSidechainStreamKey !== 'string',
    );
    expect(nonStreaming).toHaveLength(0);
  });
});
