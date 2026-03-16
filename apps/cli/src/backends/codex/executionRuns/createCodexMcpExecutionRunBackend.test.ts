import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { CodexSessionConfig, CodexToolResponse } from '@/backends/codex/types';

type FakeClientState = {
  continueCalls: Array<{ prompt: string; signal?: AbortSignal }>;
  emittedMessages: AgentMessage[];
  instances: FakeCodexMcpClient[];
  continueSessionImpl?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<CodexToolResponse>;
  exposeVendorSessionIdDuringStart?: boolean;
  startSessionImpl?: (config: CodexSessionConfig, options?: { signal?: AbortSignal }) => Promise<CodexToolResponse>;
  startCalls: Array<{ config: CodexSessionConfig; signal?: AbortSignal }>;
  vendorSessionId: SessionId;
};

class FakeCodexMcpClient {
  private handler: ((event: unknown) => void) | null = null;
  private readonly state: FakeClientState;
  private sessionId: SessionId | null = null;

  constructor(state: FakeClientState) {
    this.state = state;
    this.state.instances.push(this);
  }

  setHandler(handler: ((event: unknown) => void) | null): void {
    this.handler = handler;
  }

  emitEvent(event: unknown): void {
    this.handler?.(event);
  }

  async startSession(config: CodexSessionConfig, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
    this.state.startCalls.push({ config, signal: options?.signal });
    if (this.state.exposeVendorSessionIdDuringStart) {
      this.sessionId = this.state.vendorSessionId;
    }
    const response = this.state.startSessionImpl
      ? await this.state.startSessionImpl(config, options)
      : {
          content: [{ type: 'text' as const, text: 'started' }],
          structuredContent: { threadId: this.state.vendorSessionId },
        };
    this.sessionId = this.state.vendorSessionId;
    return response;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setThreadIdForResume(threadId: string): void {
    this.sessionId = threadId as SessionId;
  }

  clearSession(): void {
    this.sessionId = null;
  }

  async continueSession(prompt: string, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
    this.state.continueCalls.push({ prompt, signal: options?.signal });
    if (this.state.continueSessionImpl) {
      return await this.state.continueSessionImpl(prompt, options);
    }
    this.handler?.({ type: 'agent_message', message: `reply:${prompt}` });
    return { content: [{ type: 'text' as const, text: 'continued' }] };
  }

  async forceCloseSession(): Promise<void> {}
}

async function loadBackendWithFakeClient(state: FakeClientState) {
  vi.doMock('@/backends/codex/codexMcpClient', () => ({
    CodexMcpClient: class extends FakeCodexMcpClient {
      constructor() {
        super(state);
      }
    },
  }));

  const mod = await import('./createCodexMcpExecutionRunBackend');
  return mod.createCodexMcpExecutionRunBackend({
    cwd: process.cwd(),
    permissionMode: 'read-only',
  });
}

describe('createCodexMcpExecutionRunBackend', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('does not apply a default response timeout when timeoutMs is omitted', async () => {
    vi.useFakeTimers();

    const state: FakeClientState = {
      vendorSessionId: 'vendor_session_timeout' as SessionId,
      startCalls: [],
      continueCalls: [],
      emittedMessages: [],
      instances: [],
    };
    const backend = await loadBackendWithFakeClient(state);

    const started = await backend.startSession();
    await backend.sendPrompt(started.sessionId, 'first prompt');

    if (!backend.waitForResponseComplete) {
      throw new Error('Expected waitForResponseComplete to be defined');
    }
    const waiting = backend.waitForResponseComplete();
    // Avoid unhandled rejection warnings if a default timeout is still applied.
    void waiting.catch(() => {});

    // If a default timeout is still applied, this would reject once the timer elapses.
    await vi.advanceTimersByTimeAsync(121_000);

    const marker = new Promise<'marker'>((resolve) => setTimeout(() => resolve('marker'), 0));
    await vi.advanceTimersByTimeAsync(0);

    await expect(
      Promise.race([
        waiting.then(() => 'completed' as const),
        marker,
      ]),
    ).resolves.toBe('marker');

    await backend.cancel(started.sessionId);
    await expect(waiting).resolves.toBeUndefined();

    vi.useRealTimers();
  });

  it('defers vendor session creation until the first prompt when startSession has no initial prompt', async () => {
    const state: FakeClientState = {
      vendorSessionId: 'vendor_session_1' as SessionId,
      startCalls: [],
      continueCalls: [],
      emittedMessages: [],
      instances: [],
    };
    const backend = await loadBackendWithFakeClient(state);
    const onMessage: AgentMessageHandler = (message) => {
      state.emittedMessages.push(message);
    };
    backend.onMessage(onMessage);

    const started = await backend.startSession();

    expect(started.sessionId).not.toBe(state.vendorSessionId);
    expect(started.sessionId).toMatch(/^codex_mcp_execution_run_/);
    expect(state.startCalls).toHaveLength(0);

    await backend.sendPrompt(started.sessionId, 'first prompt');

    expect(state.startCalls).toHaveLength(1);
    expect(state.startCalls[0]?.config.prompt).toBe('first prompt');
    expect(state.continueCalls).toHaveLength(0);
    expect(state.emittedMessages).toContainEqual({
      type: 'event',
      name: 'vendor_session_id',
      payload: { sessionId: state.vendorSessionId },
    });
  });

  it('switches to continueSession after the first prompt establishes the vendor session', async () => {
    const state: FakeClientState = {
      vendorSessionId: 'vendor_session_2' as SessionId,
      startCalls: [],
      continueCalls: [],
      emittedMessages: [],
      instances: [],
    };
    const backend = await loadBackendWithFakeClient(state);

    const started = await backend.startSession();
    await backend.sendPrompt(started.sessionId, 'first prompt');
    await backend.sendPrompt(started.sessionId, 'second prompt');

    expect(state.startCalls).toHaveLength(1);
    expect(state.startCalls[0]?.config.prompt).toBe('first prompt');
    expect(state.continueCalls).toEqual([{ prompt: 'second prompt', signal: expect.any(AbortSignal) }]);
  });

  it('includes the execution-run cwd in the first MCP start config', async () => {
    const state: FakeClientState = {
      vendorSessionId: 'vendor_session_cwd' as SessionId,
      startCalls: [],
      continueCalls: [],
      emittedMessages: [],
      instances: [],
    };

    vi.doMock('@/backends/codex/codexMcpClient', () => ({
      CodexMcpClient: class extends FakeCodexMcpClient {
        constructor() {
          super(state);
        }
      },
    }));

    const { createCodexMcpExecutionRunBackend } = await import('./createCodexMcpExecutionRunBackend');
    const backend = createCodexMcpExecutionRunBackend({
      cwd: '/tmp/happier-review-worktree',
      permissionMode: 'read-only',
    });

    const started = await backend.startSession();
    await backend.sendPrompt(started.sessionId, 'review this');

    expect(state.startCalls).toHaveLength(1);
    expect(state.startCalls[0]?.config).toMatchObject({
      prompt: 'review this',
      cwd: '/tmp/happier-review-worktree',
    });
  });

  it('queues a replacement prompt until the in-flight start settles and then restarts the session after cancel', async () => {
    let resolveFirstStart!: (value: CodexToolResponse) => void;
    const firstStartPromise = new Promise<CodexToolResponse>((resolve) => {
      resolveFirstStart = resolve;
    });
    const state: FakeClientState = {
      vendorSessionId: 'vendor_session_3' as SessionId,
      startCalls: [],
      continueCalls: [],
      emittedMessages: [],
      instances: [],
      exposeVendorSessionIdDuringStart: true,
      startSessionImpl: async () => await firstStartPromise,
    };
    const backend = await loadBackendWithFakeClient(state);

    const started = await backend.startSession();
    const firstSendPromise = backend.sendPrompt(started.sessionId, 'first prompt');
    await Promise.resolve();
    expect(state.startCalls).toHaveLength(1);

    await backend.cancel(started.sessionId);
    const replacementPromise = backend.sendPrompt(started.sessionId, 'replacement prompt');
    await Promise.resolve();

    expect(state.startCalls).toHaveLength(1);
    expect(state.continueCalls).toHaveLength(0);

    resolveFirstStart({
      content: [{ type: 'text' as const, text: 'started' }],
      structuredContent: { threadId: state.vendorSessionId },
    });

    await expect(firstSendPromise).resolves.toBeUndefined();
    await expect(replacementPromise).resolves.toBeUndefined();

    expect(state.startCalls).toHaveLength(2);
    expect(state.startCalls[1]?.config.prompt).toBe('replacement prompt');
    expect(state.continueCalls).toHaveLength(0);
  });

  it('correlates missing exec_command call ids across begin and end events', async () => {
    const state: FakeClientState = {
      vendorSessionId: 'vendor_session_4' as SessionId,
      startCalls: [],
      continueCalls: [],
      emittedMessages: [],
      instances: [],
    };
    const backend = await loadBackendWithFakeClient(state);

    backend.onMessage((message) => {
      state.emittedMessages.push(message);
    });

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1).mockReturnValueOnce(2);

    state.instances[0]?.emitEvent({ type: 'exec_command_begin', command: 'pwd' });
    state.instances[0]?.emitEvent({ type: 'exec_command_end', exit_code: 0 });

    nowSpy.mockRestore();

    expect(state.emittedMessages).toContainEqual({
      type: 'tool-call',
      toolName: 'CodexBash',
      args: { type: 'exec_command_begin', command: 'pwd' },
      callId: 'codex_tool_1',
    });
    expect(state.emittedMessages).toContainEqual({
      type: 'tool-result',
      toolName: 'CodexBash',
      result: { type: 'exec_command_end', exit_code: 0 },
      callId: 'codex_tool_1',
      isError: false,
    });
  });
});
