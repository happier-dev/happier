import { describe, expect, it, vi } from 'vitest';

import { AgentSessionRuntimeEventV1Schema } from '@happier-dev/protocol/runtime';

import type { AntigravityLocalharnessClient } from '../client/nativeClient.js';
import { WEBSOCKET_FIXTURE } from '../__fixtures__/localharness-0.1.4.js';
import {
  createAntigravityLocalharnessSessionRuntime,
  type AntigravityLocalharnessRuntimeDeps,
} from './sessionRuntime.js';

function createFakeClient(): AntigravityLocalharnessClient & Readonly<{
  sent: unknown[];
  emit(message: unknown): void;
  emitExit(result?: Readonly<{ exitCode: number | null; signal: string | null }>): void;
}> {
  const listeners = new Set<(message: unknown) => void | Promise<void>>();
  const exitListeners = new Set<(result: { exitCode: number | null; signal: string | null }) => void>();
  const sent: unknown[] = [];
  return {
    sent,
    async send(message) { sent.push(message); },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => { exitListeners.delete(listener); };
    },
    emit(message) {
      for (const listener of listeners) void listener(message);
    },
    emitExit(result = { exitCode: 1, signal: null }) {
      for (const listener of exitListeners) listener(result);
    },
    async dispose() {},
  };
}

function createDeps(
  overrides: Partial<AntigravityLocalharnessRuntimeDeps> = {},
): AntigravityLocalharnessRuntimeDeps & Readonly<{ client: ReturnType<typeof createFakeClient> }> {
  const client = createFakeClient();
  return {
    client,
    sessionId: 'session-1',
    cwd: '/repo',
    openClient: vi.fn(async () => client),
    requestPermission: vi.fn(async () => ({ decision: 'denied' })),
    elicit: vi.fn(async () => ({ status: 'answered', answers: [{ multipleChoiceAnswer: { selectedChoiceIndices: [0] } }] })),
    resolveCredentials: vi.fn(async () => ({ mode: 'api_key', apiKey: 'gemini-key' })),
    resolveMcpServers: vi.fn(async () => []),
    now: () => 10,
    ...overrides,
  };
}

function sendRequest(text = 'hello') {
  return {
    inputIds: ['input-1'],
    input: { text },
    delivery: { kind: 'newTurn', turnId: 'turn-1' },
  } as const;
}

describe('Antigravity localharness native session runtime', () => {
  it('preflights credentials before opening localharness', async () => {
    const deps = createDeps({
      resolveCredentials: vi.fn(async () => ({ mode: 'api_key', apiKey: null })),
    });
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);

    await expect(runtime.send(sendRequest())).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: { message: expect.stringMatching(/api key/i) },
    });
    expect(deps.openClient).not.toHaveBeenCalled();
  });

  it('publishes custody before native provider identity, output, usage, and completion', async () => {
    const deps = createDeps();
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);
    const events: unknown[] = [];
    runtime.watch((event) => events.push(event));

    await expect(runtime.send(sendRequest())).resolves.toEqual({ status: 'admitted' });
    expect(deps.client.sent[1]).toEqual(WEBSOCKET_FIXTURE.startTurn);
    deps.client.emit(WEBSOCKET_FIXTURE.outputConversationStep);
    deps.client.emit(WEBSOCKET_FIXTURE.outputUsage);
    deps.client.emit(WEBSOCKET_FIXTURE.outputIdle);

    expect(events.map((event) => (event as { kind: string }).kind)).toEqual([
      'input-accepted',
      'turn-start',
      'provider-session-id',
      'message-delta',
      'message-delta',
      'usage-observed',
      'turn-complete',
    ]);
    for (const event of events) expect(AgentSessionRuntimeEventV1Schema.safeParse(event).success).toBe(true);
  });

  it('fails an idle-only turn without transcript evidence', async () => {
    const deps = createDeps();
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);
    const events: Array<{ kind: string; diagnostic?: { code: string } }> = [];
    runtime.watch((event) => events.push(event));
    await runtime.send(sendRequest());

    deps.client.emit(WEBSOCKET_FIXTURE.outputIdle);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-failed',
      diagnostic: expect.objectContaining({ code: 'antigravity_localharness_empty_response' }),
    }));
  });

  it('rejects unsupported MCP transports before launch', async () => {
    const deps = createDeps({
      resolveMcpServers: vi.fn(async () => [{
        id: 'stdio-id',
        name: 'stdio-server',
        transport: { kind: 'stdio' as const, command: 'server' },
      }]),
    });
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);

    await expect(runtime.send(sendRequest())).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: { message: expect.stringContaining('stdio-server') },
    });
    expect(deps.openClient).not.toHaveBeenCalled();
  });

  it('debounces duplicate permission and structured-question requests', async () => {
    const deps = createDeps();
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);
    await runtime.send(sendRequest());

    deps.client.emit(WEBSOCKET_FIXTURE.outputToolConfirmation);
    deps.client.emit(WEBSOCKET_FIXTURE.outputToolConfirmation);
    deps.client.emit(WEBSOCKET_FIXTURE.outputQuestions);
    deps.client.emit(WEBSOCKET_FIXTURE.outputQuestions);
    await vi.waitFor(() => {
      expect(deps.elicit).toHaveBeenCalledTimes(1);
      expect(deps.client.sent.filter((message) => (
        !!message && typeof message === 'object' && 'toolConfirmation' in message
      ))).toHaveLength(1);
    });
  });

  it('fails closed for unsupported client tools', async () => {
    const deps = createDeps();
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);
    const events: Array<{ kind: string; isError?: boolean }> = [];
    runtime.watch((event) => events.push(event));
    await runtime.send(sendRequest());

    deps.client.emit(WEBSOCKET_FIXTURE.outputCustomTool);
    await vi.waitFor(() => expect(deps.client.sent).toContainEqual({
      toolResponse: {
        id: 'call-1',
        responseJson: '{"error":"unsupported_client_tool","toolName":"client.custom"}',
      },
    }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-result', isError: true }));
  });

  it('tears down on cancellation without claiming a provider acknowledgement', async () => {
    const deps = createDeps();
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);
    await runtime.send(sendRequest());

    await expect(runtime.cancel?.({ turnId: 'turn-1', reason: 'user' })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'antigravity_cancel_unverified' },
    });
    expect(deps.client.sent).toContainEqual(WEBSOCKET_FIXTURE.cancel);
  });

  it('maps sidecar exit during an active turn to a native failure', async () => {
    const deps = createDeps();
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);
    const events: Array<{ kind: string; diagnostic?: { code: string } }> = [];
    runtime.watch((event) => events.push(event));
    await runtime.send(sendRequest());

    deps.client.emitExit({ exitCode: 9, signal: null });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-failed',
      diagnostic: expect.objectContaining({ code: 'sidecar_exited' }),
    }));
  });
});
