import { describe, expect, it } from 'vitest';

import { createHappierMcpServer, HAPPIER_MCP_TOOL_NAMES } from '@/mcp/createHappierMcpServer';

describe('createHappierMcpServer', () => {
  it('returns toolNames aligned with HAPPIER_MCP_TOOL_NAMES', () => {
    const fakeClient = {
      sessionId: 'sess_mcp_tool_names_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendClaudeSessionMessage: () => {},
    } as any;

    const { toolNames } = createHappierMcpServer(fakeClient);
    expect(toolNames).toEqual([...HAPPIER_MCP_TOOL_NAMES]);
  });
});

