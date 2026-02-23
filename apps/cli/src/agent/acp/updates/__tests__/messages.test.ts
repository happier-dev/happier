import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import type { TransportHandler } from '@/agent/transport';

import { handleAgentMessageChunk, handleAgentThoughtChunk } from '../messages';
import type { HandlerContext } from '../types';

function createHandlerContext(): Readonly<{
  ctx: HandlerContext;
  emitted: AgentMessage[];
}> {
  const emitted: AgentMessage[] = [];
  const transport: TransportHandler = {
    agentName: 'test',
    getInitTimeout: () => 1_000,
    getToolPatterns: () => [],
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
    toolCallCountSincePrompt: 0,
    emit: (msg) => emitted.push(msg),
    emitIdleStatus: () => {},
    clearIdleTimeout: () => {},
    setIdleTimeout: () => {},
  };

  return { ctx, emitted };
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
});
