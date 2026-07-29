import { describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  handlers: {} as Record<string, (args: unknown) => Promise<any>>,
  requestDaemonPluginActionExecution: vi.fn(async () => ({
    matched: true as const,
    result: {
      ok: true as const,
      result: { completed: true },
    },
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class FakeMcpServer {
    registerResource() {}
    registerTool(name: string, _meta: unknown, handler: (args: unknown) => Promise<any>) {
      boundary.handlers[name] = handler;
    }
  },
}));

vi.mock('@/daemon/controlClient', () => ({
  requestDaemonPluginActionExecution: boundary.requestDaemonPluginActionExecution,
}));

import { createHappierMcpServer } from './createHappierMcpServer';

describe('createHappierMcpServer plugin tools', () => {
  it('dispatches a daemon-projected tool from the session-agent MCP source', async () => {
    const { toolNames } = createHappierMcpServer({
      sessionId: 'sess_agent_plugin_tool_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      sendProviderMessage: () => {},
      updateMetadata: () => {},
    } as any, {
      pluginToolCatalog: [{
        toolId: 'acme.review.plugin/review-tool',
        actionId: 'acme.review.plugin/review-start',
        name: 'acme_review_start',
        title: 'Acme Review Start',
        description: 'Start a plugin-defined review workflow',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string' },
          },
          additionalProperties: false,
        },
        surfaces: ['agent', 'mcp', 'cli'],
      }],
    });

    expect(toolNames).toContain('acme_review_start');
    await expect(boundary.handlers.acme_review_start?.({ scope: 'diff' })).resolves.toEqual({
      content: [{ type: 'text', text: '{"completed":true}' }],
      isError: false,
    });
    expect(boundary.requestDaemonPluginActionExecution).toHaveBeenCalledWith({
      actionId: 'acme.review.plugin/review-start',
      input: { scope: 'diff' },
      surface: 'agent',
      defaultSessionId: 'sess_agent_plugin_tool_1',
    });
  });
});
