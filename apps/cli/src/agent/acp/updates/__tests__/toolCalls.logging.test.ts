import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => {
  return { logger: { debug: vi.fn() } };
});

import { logger } from '@/ui/logger';
import type { AgentMessage } from '@/agent/core';
import type { TransportHandler } from '@/agent/transport';

import { startToolCall } from '../toolCalls';
import type { HandlerContext, SessionUpdate } from '../types';

function createHandlerContext(): HandlerContext {
  const transport: TransportHandler = {
    agentName: 'test',
    getInitTimeout: () => 1_000,
    getToolPatterns: () => [],
    isInvestigationTool: () => true,
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
    emit: (_msg: AgentMessage) => {},
    emitIdleStatus: () => {},
    clearIdleTimeout: () => {},
    setIdleTimeout: () => {},
  };

  return ctx;
}

describe('ACP tool call logging', () => {
  it('does not log investigation objectives verbatim', () => {
    const ctx = createHandlerContext();
    const update: SessionUpdate = {
      toolCallId: 't1',
      status: 'in_progress',
      kind: 'investigator',
      rawInput: { objective: 'SUPER_SECRET_OBJECTIVE' },
    } as any as SessionUpdate;

    startToolCall('t1', 'investigator', update, ctx, 'tool_call_update');

    expect(JSON.stringify((logger as any).debug.mock.calls)).not.toContain('SUPER_SECRET_OBJECTIVE');
  });
});

