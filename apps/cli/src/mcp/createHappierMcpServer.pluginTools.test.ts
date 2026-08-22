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
  readDaemonPluginCatalog: vi.fn(),
}));

import { createHappierMcpServer } from './createHappierMcpServer';
import { filterPluginToolsForActiveAgentComposition } from './startHappyServer';

describe('createHappierMcpServer plugin tools', () => {
  it('dispatches a daemon-projected tool from the session-agent MCP source', async () => {
    const { toolNames } = createHappierMcpServer({
      sessionId: 'sess_agent_plugin_tool_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
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

  it('registers only selected tools for a composition-managed plugin', () => {
    const catalog = [{
      toolId: 'acme.composition/selected-tool',
      actionId: 'acme.composition/selected-action',
      name: 'acme_composition_selected',
      title: 'Acme selected tool',
      description: 'The selected composition tool.',
      inputSchema: { type: 'object', additionalProperties: false },
      safety: 'safe' as const,
      surfaces: ['agent'] as const,
    }, {
      toolId: 'acme.composition/unselected-tool',
      actionId: 'acme.composition/unselected-action',
      name: 'acme_composition_unselected',
      title: 'Acme unselected tool',
      description: 'The unselected composition tool.',
      inputSchema: { type: 'object', additionalProperties: false },
      safety: 'safe' as const,
      surfaces: ['agent'] as const,
    }, {
      toolId: 'acme.unmanaged/always-visible-tool',
      actionId: 'acme.unmanaged/always-visible-action',
      name: 'acme_unmanaged_visible',
      title: 'Acme unmanaged tool',
      description: 'A tool from a plugin without composition ownership.',
      inputSchema: { type: 'object', additionalProperties: false },
      safety: 'safe' as const,
      surfaces: ['agent'] as const,
    }] as const;
    const client = {
      sessionId: 'sess_agent_composition_tool_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any;

    const selected = createHappierMcpServer(client, {
      pluginToolCatalog: filterPluginToolsForActiveAgentComposition(catalog, {
        managedPluginIds: ['acme.composition'],
        selectedTools: [{
          pluginId: 'acme.composition',
          localId: 'selected-tool',
        }],
        selectedToolBindings: [{
          tool: catalog[0],
          expectedContributorImmutableGenerationId: 'generation-g',
        }],
      }),
    });
    expect(selected.toolNames).toEqual(expect.arrayContaining([
      'acme_composition_selected',
      'acme_unmanaged_visible',
    ]));
    expect(selected.toolNames).not.toContain('acme_composition_unselected');

    const empty = createHappierMcpServer(client, {
      pluginToolCatalog: filterPluginToolsForActiveAgentComposition(catalog, {
        managedPluginIds: ['acme.composition'],
        selectedTools: [],
        selectedToolBindings: [],
      }),
    });
    expect(empty.toolNames).not.toContain('acme_composition_selected');
    expect(empty.toolNames).not.toContain('acme_composition_unselected');
    expect(empty.toolNames).toContain('acme_unmanaged_visible');
  });
});
