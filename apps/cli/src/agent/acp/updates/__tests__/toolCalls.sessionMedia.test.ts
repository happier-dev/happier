import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => {
  return { logger: { debug: vi.fn(), warn: vi.fn() } };
});

import type { AgentMessage } from '@/agent/core';
import type { TransportHandler } from '@/agent/transport';

import { handleToolCallUpdate } from '../toolCalls';
import type { HandlerContext } from '../types';

function createHandlerContext(): Readonly<{ ctx: HandlerContext; emitted: AgentMessage[] }> {
  const emitted: AgentMessage[] = [];
  const transport: TransportHandler = {
    agentName: 'test',
    getInitTimeout: () => 1_000,
    getToolPatterns: () => [],
  };
  const ctx: HandlerContext = {
    transport,
    activeToolCalls: new Set<string>(['tool-1']),
    finalizedToolCalls: new Set<string>(),
    toolCallLifecycleStates: new Map([['tool-1', 'running']]),
    toolCallStartTimes: new Map<string, number>(),
    toolCallTimeouts: new Map<string, NodeJS.Timeout>(),
    toolCallIdToNameMap: new Map<string, string>([['tool-1', 'mcp__images__generate']]),
    toolCallIdToInputMap: new Map<string, Record<string, unknown>>(),
    idleTimeout: null,
    toolCallCountSincePrompt: 1,
    emit: (msg) => emitted.push(msg),
    emitIdleStatus: () => {},
    clearIdleTimeout: () => {},
    setIdleTimeout: () => {},
  };

  return { ctx, emitted };
}

describe('ACP tool call session media mapping', () => {
  it('maps MCP image result blocks to mcp-content session media events', () => {
    const { ctx, emitted } = createHandlerContext();

    const result = handleToolCallUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        kind: 'mcp',
        status: 'completed',
        output: {
          content: [
            { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', name: 'mcp-image.png' },
          ],
        },
      },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'event',
      name: 'session_media',
      payload: expect.objectContaining({
        localId: 'acp-media-tool-1',
        role: 'output',
        category: 'tool-artifact',
        media: [
          expect.objectContaining({
            source: { kind: 'base64', data: 'iVBORw0KGgo=', mimeType: 'image/png', fileNameHint: 'mcp-image.png' },
            origin: {
              source: 'mcp-content',
              toolCallId: 'tool-1',
            },
          }),
        ],
      }),
    }));
  });
});
