import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import type { TransportHandler } from '@/agent/transport';

import { handleThinkingUpdate } from '../events';
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
    toolCallLifecycleStates: new Map(),
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

describe('handleThinkingUpdate', () => {
  it('normalizes string thinking payloads into a {text} object', () => {
    const { ctx, emitted } = createHandlerContext();
    const result = handleThinkingUpdate({ thinking: 'Hello' }, ctx);
    expect(result.handled).toBe(true);
    expect(emitted).toEqual([{ type: 'event', name: 'thinking', payload: { text: 'Hello' } }]);
  });

  it('normalizes object thinking payloads with message into text', () => {
    const { ctx, emitted } = createHandlerContext();
    const result = handleThinkingUpdate({ thinking: { message: 'Hello' } }, ctx);
    expect(result.handled).toBe(true);
    expect(emitted).toEqual([{ type: 'event', name: 'thinking', payload: { text: 'Hello' } }]);
  });
});
