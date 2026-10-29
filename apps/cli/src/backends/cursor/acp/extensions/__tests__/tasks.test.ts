import { withParsedAcpExtensionHandler } from '@/agent/acp/testkit/extensionHandlerHarness';
import { describe, expect, it, vi } from 'vitest';

import type { ClientApp } from '@agentclientprotocol/sdk';
import type { AcpExtensionHandlerContext } from '@/agent/acp/connection/types';
import { createAcpToolCallTracker } from '@/agent/acp/updates/toolCalls/AcpToolCallTracker';
import {
  emitAcpToolCallPublication,
  emitAcpToolResultPublication,
} from '@/agent/acp/updates/toolCalls/toolCallMessages';
import { createAcpAgentMessageForwarder } from '@/agent/acp/bridge/createAcpAgentMessageForwarder';
import { normalizeToolCallV2 } from '@/agent/tools/normalization';

import { createCursorTaskDescriptors } from '../tasks';

type ExtensionCallback = (context: Readonly<{
  params: Record<string, unknown>;
  signal: AbortSignal;
}>) => unknown | Promise<unknown>;

async function invokeTask(params: Readonly<{
  kind: 'request' | 'notification';
  payload: Record<string, unknown>;
  enrich: ReturnType<typeof vi.fn>;
}>): Promise<unknown> {
  const registration = createCursorTaskDescriptors().find((candidate) => (
    candidate.kind === params.kind && candidate.method === 'cursor/task'
  ));
  if (!registration) throw new Error(`Missing ${params.kind} Cursor task descriptor`);

  const captured: { callback: ExtensionCallback | null } = { callback: null };
  const app = {
    onRequest: (_method: string, parser: unknown, handler: unknown) => {
      captured.callback = withParsedAcpExtensionHandler(parser, handler as ExtensionCallback);
      return app;
    },
    onNotification: (_method: string, parser: unknown, handler: unknown) => {
      captured.callback = withParsedAcpExtensionHandler(parser, handler as ExtensionCallback);
      return app;
    },
  };
  const context = {
    method: 'cursor/task',
    sessionId: 'session-1',
    signal: new AbortController().signal,
    agentName: 'cursor',
    turnId: 'turn-1',
    toolCalls: { enrich: params.enrich },
  } as unknown as AcpExtensionHandlerContext;
  registration.register(app as unknown as ClientApp, () => context);
  if (!captured.callback) throw new Error('Cursor task descriptor did not register');
  return await captured.callback({ params: params.payload, signal: context.signal });
}

describe('Cursor native task projection', () => {
  it.each(['request', 'notification'] as const)(
    'projects %s delivery into the exact correlated generic tool lifecycle',
    async (kind) => {
      const enrich = vi.fn(() => 'applied');
      const result = await invokeTask({
        kind,
        enrich,
        payload: {
          toolCallId: 'opaque\n task ID ',
          description: 'Inspect the integration',
          prompt: 'Sanitized private prompt',
          subagentType: { custom: 'specialist' },
          model: 'cursor-model',
          agentId: 'cursor-agent-1',
          durationMs: 42,
        },
      });

      expect(result).toEqual(kind === 'request' ? {} : undefined);
      expect(enrich).toHaveBeenCalledTimes(1);
      expect(enrich).toHaveBeenCalledWith('opaque\n task ID ', {
        toolName: 'Task',
        title: 'Inspect the integration',
        rawInput: {
          operation: 'run',
          description: 'Inspect the integration',
          prompt: 'Sanitized private prompt',
          subagent_type: 'specialist',
          model: 'cursor-model',
          agent_id: 'cursor-agent-1',
          duration_ms: 42,
          _happier: {
            nativeSubagent: {
              v: 1,
              lifecycle: 'completion_only',
              type: 'custom',
              customType: 'specialist',
              model: 'cursor-model',
              agentId: 'cursor-agent-1',
              durationMs: 42,
            },
          },
        },
        metadata: {
          providerNativeTask: {
            v: 1,
            completionOnly: true,
          },
        },
      });
    },
  );

  it('preserves known, unspecified, and absent optional task metadata without inventing values', async () => {
    const enrich = vi.fn(() => 'queued');
    await invokeTask({
      kind: 'notification',
      enrich,
      payload: {
        toolCallId: 'task-minimal',
        description: 'Completed task',
        subagentType: 'unspecified',
      },
    });

    expect(enrich).toHaveBeenCalledWith('task-minimal', expect.objectContaining({
      rawInput: {
        operation: 'run',
        description: 'Completed task',
        subagent_type: 'unspecified',
        _happier: {
          nativeSubagent: {
            v: 1,
            lifecycle: 'completion_only',
            type: 'unspecified',
          },
        },
      },
    }));
  });

  it('preserves bounded prompt text exactly while normalizing semantic tokens', async () => {
    const enrich = vi.fn(() => 'applied');
    await invokeTask({
      kind: 'notification',
      enrich,
      payload: {
        toolCallId: 'task-exact-prompt',
        prompt: '  Preserve exact prompt text\n',
        subagentType: '  explore  ',
      },
    });

    expect(enrich).toHaveBeenCalledWith('task-exact-prompt', expect.objectContaining({
      rawInput: expect.objectContaining({
        prompt: '  Preserve exact prompt text\n',
        subagent_type: 'explore',
      }),
    }));
  });

  it('acknowledges a bounded payload without a correlation id but does not fabricate a tool call', async () => {
    const enrich = vi.fn();
    await expect(invokeTask({
      kind: 'request',
      enrich,
      payload: { description: 'Uncorrelated completion' },
    })).resolves.toEqual({});
    expect(enrich).not.toHaveBeenCalled();
  });

  it('revises the same durable call after a source-real terminal-result-then-extension sequence', async () => {
    const sent: Array<Readonly<{
      body: Record<string, unknown>;
      localId?: string;
    }>> = [];
    const forwarder = createAcpAgentMessageForwarder({
      provider: 'cursor',
      makeId: () => 'unused-random-id',
      sendAcp: (_provider, body, options) => {
        sent.push({
          body: body as unknown as Record<string, unknown>,
          ...(options?.localId ? { localId: options.localId } : {}),
        });
      },
    });
    const tracker = createAcpToolCallTracker({
      publishCall: (publication) => emitAcpToolCallPublication(publication, forwarder.forward),
      publishResult: (publication) => emitAcpToolResultPublication(publication, forwarder.forward),
    });

    tracker.observe({
      toolCallId: 'task-terminal-first',
      kind: 'other',
      status: 'in_progress',
      rawInput: { description: 'Initial description' },
    });
    tracker.observe(
      {
        toolCallId: 'task-terminal-first',
        status: 'completed',
        rawOutput: { content: 'Completed task' },
      },
      { terminalResult: { value: { content: 'Completed task' } } },
    );

    const enrich = vi.fn(tracker.enrich.bind(tracker));
    await invokeTask({
      kind: 'notification',
      enrich,
      payload: {
        toolCallId: 'task-terminal-first',
        description: 'Enriched completion',
        prompt: 'Sanitized prompt',
        subagentType: 'explore',
        durationMs: 250,
      },
    });

    expect(sent.map(({ body }) => body.type)).toEqual([
      'tool-call',
      'tool-call',
      'tool-result',
      'tool-call',
    ]);
    const callWrites = sent.filter(({ body }) => body.type === 'tool-call');
    expect(new Set(callWrites.map(({ localId }) => localId))).toHaveLength(1);
    expect(new Set(callWrites.map(({ body }) => body.id))).toHaveLength(1);
    const enriched = callWrites.at(-1)?.body;
    expect(enriched).toMatchObject({
      callId: 'task-terminal-first',
      name: 'Task',
      input: {
        description: 'Enriched completion',
        prompt: 'Sanitized prompt',
        subagent_type: 'explore',
        duration_ms: 250,
        _happier: {
          nativeSubagent: {
            v: 1,
            lifecycle: 'completion_only',
            type: 'explore',
            durationMs: 250,
          },
        },
      },
    });

    const normalized = normalizeToolCallV2({
      protocol: 'acp',
      provider: 'cursor',
      toolName: String(enriched?.name),
      rawInput: enriched?.input,
      callId: String(enriched?.callId),
    });
    expect(normalized).toMatchObject({
      canonicalToolName: 'SubAgent',
      input: {
        description: 'Enriched completion',
        _happier: {
          v: 2,
          protocol: 'acp',
          provider: 'cursor',
          rawToolName: 'Task',
          canonicalToolName: 'SubAgent',
          nativeSubagent: {
            lifecycle: 'completion_only',
          },
        },
      },
    });
    expect(sent.filter(({ body }) => body.type === 'tool-result')).toHaveLength(1);
  });

  it('keeps parallel completion, failure, cancellation, and duplicate task observations exactly once', async () => {
    const calls: Array<Readonly<{
      callId: string;
      toolName: string;
      revision: number;
      snapshot: { status?: unknown; rawInput?: unknown };
    }>> = [];
    const results: Array<Readonly<{ callId: string; isError?: boolean }>> = [];
    const tracker = createAcpToolCallTracker({
      publishCall: (call) => calls.push(call),
      publishResult: (result) => results.push(result),
    });
    const enrich = vi.fn(tracker.enrich.bind(tracker));

    for (const callId of ['parallel-success', 'parallel-failure', 'parallel-cancel']) {
      tracker.observe({ toolCallId: callId, kind: 'other', status: 'in_progress' });
    }

    await invokeTask({
      kind: 'notification',
      enrich,
      payload: {
        toolCallId: 'parallel-success',
        description: 'Succeeded task',
        subagentType: 'explore',
      },
    });
    tracker.observe(
      { toolCallId: 'parallel-success', status: 'completed' },
      { terminalResult: { value: { ok: true } } },
    );

    tracker.observe(
      { toolCallId: 'parallel-failure', status: 'failed' },
      { terminalResult: { value: { error: 'bounded failure' }, isError: true } },
    );
    const failedPayload = {
      toolCallId: 'parallel-failure',
      description: 'Failed task',
      subagentType: 'shell',
    };
    await invokeTask({ kind: 'notification', enrich, payload: failedPayload });
    await invokeTask({ kind: 'notification', enrich, payload: failedPayload });

    await invokeTask({
      kind: 'notification',
      enrich,
      payload: {
        toolCallId: 'parallel-cancel',
        description: 'Cancelled task',
        subagentType: 'browser',
      },
    });
    tracker.cancel('parallel-cancel');

    expect(results).toEqual([
      expect.objectContaining({ callId: 'parallel-success' }),
      expect.objectContaining({ callId: 'parallel-failure', isError: true }),
      expect.objectContaining({ callId: 'parallel-cancel', isError: true }),
    ]);
    expect(calls.filter((call) => call.callId === 'parallel-failure').at(-1)).toMatchObject({
      toolName: 'Task',
      snapshot: {
        status: 'failed',
        rawInput: expect.objectContaining({ description: 'Failed task' }),
      },
    });
    expect(calls.filter((call) => call.callId === 'parallel-cancel').at(-1)).toMatchObject({
      toolName: 'Task',
      snapshot: { status: 'cancelled' },
    });
    expect(tracker.activeSize).toBe(0);
    expect(tracker.finalizedSize).toBe(3);
  });
});
