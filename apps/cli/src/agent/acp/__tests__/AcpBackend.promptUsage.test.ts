import { describe, it, expect } from 'vitest';

import type { TransportHandler } from '@/agent/transport';
import { AcpBackend } from '../AcpBackend';

type PromptConnection = {
  prompt: () => Promise<unknown>;
};

type PromptHarness = {
  acpSessionId: string;
  connection: PromptConnection;
  waitingForResponse: boolean;
};

function asPromptHarness(backend: AcpBackend): PromptHarness {
  return backend as unknown as PromptHarness;
}

function createInternalEmptyStreamError(): unknown {
  return {
    code: -32603,
    message: 'Internal error',
    data: { details: 'Model stream ended with empty response text.' },
  };
}

describe('AcpBackend sendPrompt usage telemetry', () => {
  it('emits a token-count message when ACP prompt response includes camelCase usage', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    const harness = asPromptHarness(backend);
    harness.acpSessionId = 'sess_1';
    harness.connection = {
      prompt: async () => ({
        stopReason: 'end_turn',
        modelId: 'openai/gpt-5',
        usage: {
          totalTokens: 10,
          inputTokens: 7,
          outputTokens: 3,
          cachedReadTokens: 2,
          cachedWriteTokens: 1,
          thoughtTokens: 4,
        },
      }),
    };

    await backend.sendPrompt('sess_1', 'hello');

    const tokenCount = emitted.find((m) => m?.type === 'token-count');
    expect(tokenCount).toBeTruthy();
    expect(tokenCount).toEqual({
      type: 'token-count',
      key: 'acp-prompt-usage',
      modelId: 'openai/gpt-5',
      source: 'acp-prompt-usage',
      scope: 'turn_delta',
      tokens: {
        total: 10,
        input: 7,
        output: 3,
        cache_read: 2,
        cache_creation: 1,
        thought: 4,
      },
    });
  });

  it('does not ignore provider-specific prompt errors from agentName alone', async () => {
    const backend = new AcpBackend({
      agentName: 'gemini',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    const harness = asPromptHarness(backend);
    harness.acpSessionId = 'sess_1';
    harness.connection = {
      prompt: async () => {
        harness.waitingForResponse = false;
        throw createInternalEmptyStreamError();
      },
    };

    await expect(backend.sendPrompt('sess_1', 'hello')).rejects.toMatchObject({ code: -32603 });
  });

  it('delegates provider-specific prompt error suppression to the transport hook', async () => {
    let observedContext: Parameters<NonNullable<TransportHandler['shouldIgnorePromptError']>>[1] | null = null;
    const transport: TransportHandler = {
      agentName: 'provider-with-hook',
      getInitTimeout: () => 1_000,
      getToolPatterns: () => [],
      shouldIgnorePromptError: (_error, context) => {
        observedContext = context;
        return context.activeToolCallCount === 0 && context.waitingForResponse === false;
      },
    };
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
      transportHandler: transport,
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    const harness = asPromptHarness(backend);
    harness.acpSessionId = 'sess_1';
    harness.connection = {
      prompt: async () => {
        harness.waitingForResponse = false;
        throw createInternalEmptyStreamError();
      },
    };

    await expect(backend.sendPrompt('sess_1', 'hello')).resolves.toBeUndefined();

    expect(observedContext).toEqual({
      activeToolCallCount: 0,
      sawSessionUpdateSincePrompt: false,
      waitingForResponse: false,
    });
    const errorStatuses = emitted.filter((m) => m?.type === 'status' && m?.status === 'error');
    expect(errorStatuses).toHaveLength(0);
  });
});
