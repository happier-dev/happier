import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => {
  return { logger: { debug: vi.fn(), warn: vi.fn() } };
});

import type { AgentMessage } from '@/agent/core/AgentMessage';
import { handleToolCallUpdate } from '../../toolCalls/legacy/handlers';
import { createLegacyHandlerContextFixture } from '../../__tests__/legacyToolRuntimeFixture';

function createHandlerContext() {
  const emitted: AgentMessage[] = [];
  const ctx = createLegacyHandlerContextFixture({ emit: (msg) => emitted.push(msg) });
  ctx.toolCalls.observePermission({ toolCallId: 'tool-1', toolName: 'mcp__images__generate', input: {} });

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
        localId: expect.stringMatching(/^acp-media-acp-result-v1:/u),
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
