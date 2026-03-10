import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import type { TransportHandler } from '@/agent/transport';

import { handleAgentMessageChunk, handleAgentThoughtChunk } from '../messages';
import type { HandlerContext } from '../types';

function createHandlerContext(options?: Readonly<{
  transport?: Partial<TransportHandler>;
  toolCallCountSincePrompt?: number;
}>): Readonly<{
  ctx: HandlerContext;
  emitted: AgentMessage[];
  idleTimeoutMs: { current: number | null };
}> {
  const emitted: AgentMessage[] = [];
  const idleTimeoutMs = { current: null as number | null };
  const transport: TransportHandler = {
    agentName: 'test',
    getInitTimeout: () => 1_000,
    getToolPatterns: () => [],
    ...(options?.transport ?? {}),
  };

  const ctx: HandlerContext = {
    transport,
    activeToolCalls: new Set<string>(),
    finalizedToolCalls: new Set<string>(),
    toolCallStartTimes: new Map<string, number>(),
    toolCallTimeouts: new Map<string, NodeJS.Timeout>(),
    toolCallIdToNameMap: new Map<string, string>(),
    toolCallIdToInputMap: new Map<string, Record<string, unknown>>(),
    idleTimeout: null,
    toolCallCountSincePrompt: options?.toolCallCountSincePrompt ?? 0,
    emit: (msg) => emitted.push(msg),
    emitIdleStatus: () => {},
    clearIdleTimeout: () => {},
    setIdleTimeout: (_callback, ms) => {
      idleTimeoutMs.current = ms;
    },
  };

  return { ctx, emitted, idleTimeoutMs };
}

describe('ACP update message handlers', () => {
  it('treats bold-header message chunks as model output (not thinking events)', () => {
    const { ctx, emitted } = createHandlerContext();
    const text = '**Question**\nPlease choose an option to continue.';

    const result = handleAgentMessageChunk(
      { content: { text } },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([{ type: 'model-output', textDelta: text }]);
  });

  it('keeps explicit thought chunks mapped to thinking events', () => {
    const { ctx, emitted } = createHandlerContext();
    const text = 'reasoning content';

    const result = handleAgentThoughtChunk(
      { content: { text } },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([{ type: 'event', name: 'thinking', payload: { text } }]);
  });

  it('uses the pre-tool idle timeout before the first tool call has started', () => {
    const { ctx, idleTimeoutMs } = createHandlerContext({
      transport: {
        getIdleTimeout: () => 500,
        getPreToolCallIdleTimeoutMs: () => 1_000,
      },
      toolCallCountSincePrompt: 0,
    });

    const result = handleAgentMessageChunk({ content: { text: 'Planning...' } }, ctx);

    expect(result.handled).toBe(true);
    expect(idleTimeoutMs.current).toBe(1_000);
  });

  it('falls back to the regular idle timeout after a tool call has started', () => {
    const { ctx, idleTimeoutMs } = createHandlerContext({
      transport: {
        getIdleTimeout: () => 500,
        getPreToolCallIdleTimeoutMs: () => 1_000,
      },
      toolCallCountSincePrompt: 1,
    });

    const result = handleAgentMessageChunk({ content: { text: 'Done.' } }, ctx);

    expect(result.handled).toBe(true);
    expect(idleTimeoutMs.current).toBe(500);
  });
});
