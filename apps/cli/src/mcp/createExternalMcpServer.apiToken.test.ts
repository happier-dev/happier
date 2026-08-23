import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

const boundary = vi.hoisted(() => {
  const execute = vi.fn();
  return {
    createCliActionExecutorFromCredentials: vi.fn(() => ({ execute })),
    createCliActionExecutorHarness: vi.fn(() => {
      throw new Error('local_harness_used');
    }),
    execute,
    registeredTools: null as null | Record<string, unknown>,
  };
});

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class FakeMcpServer {
    registerResource() {}
    registerTool() {}
  },
}));

vi.mock('@/mcp/resources/registerHappierMcpResources', () => ({
  registerHappierMcpResources: () => {},
}));

vi.mock('@/mcp/server/registerHappierMcpBuiltInTools', () => ({
  registerHappierMcpBuiltInTools: (_server: unknown, params: Record<string, unknown>) => {
    boundary.registeredTools = params;
    return { toolNames: [] };
  },
}));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials: boundary.createCliActionExecutorFromCredentials,
}));

vi.mock('@/session/actions/createCliActionExecutorHarness', () => ({
  createCliActionExecutorHarness: boundary.createCliActionExecutorHarness,
}));

import { createExternalMcpServer } from './createExternalMcpServer';

function isExecuteActionByToolName(value: unknown): value is (
  toolName: string,
  toolArgs: unknown,
  defaultSessionId: string,
) => Promise<unknown> {
  return typeof value === 'function';
}

describe('createExternalMcpServer with an API token', () => {
  beforeEach(() => {
    boundary.createCliActionExecutorFromCredentials.mockClear();
    boundary.createCliActionExecutorHarness.mockClear();
    boundary.execute.mockReset();
    boundary.registeredTools = null;
  });

  it('routes a token-only MCP Session Action through the PAT adapter and excludes local plugin execution', async () => {
    const credentials = {
      token: 'hap_v1_pat_secret',
      encryption: null,
      credentialProvenance: 'api_token' as const,
    };
    boundary.execute.mockResolvedValueOnce({
      ok: true,
      result: { session: { id: 'session_e2ee_exact', active: true } },
    });

    const pluginToolCatalog = [{
      toolId: 'acme.review.plugin/review-tool',
      actionId: 'acme.review.plugin/review-start',
      name: 'acme_review_start',
      title: 'Acme Review Start',
      description: 'A local-only plugin Action',
      inputSchema: { type: 'object' },
      surfaces: ['mcp'],
    }] satisfies readonly ProjectedPluginToolCatalogEntry[];

    createExternalMcpServer({
      credentials,
      defaultSessionId: 'session_e2ee_exact',
      pluginToolCatalog,
    });

    expect(boundary.createCliActionExecutorFromCredentials).toHaveBeenCalledWith({ credentials });
    expect(boundary.createCliActionExecutorHarness).not.toHaveBeenCalled();
    expect(boundary.registeredTools).toEqual(expect.objectContaining({
      pluginToolCatalog: [],
    }));

    const executeActionByToolName = (boundary.registeredTools?.deps as {
      executeActionByToolName?: unknown;
    } | undefined)?.executeActionByToolName;
    expect(isExecuteActionByToolName(executeActionByToolName)).toBe(true);
    if (!isExecuteActionByToolName(executeActionByToolName)) {
      throw new Error('expected MCP Action bridge');
    }

    await expect(executeActionByToolName(
      'action_execute',
      { actionId: 'session.status.get', input: {} },
      'session_e2ee_exact',
    )).resolves.toEqual({
      ok: true,
      result: { session: { id: 'session_e2ee_exact', active: true } },
    });
    expect(boundary.execute).toHaveBeenCalledWith(
      'session.status.get',
      { sessionId: 'session_e2ee_exact' },
      expect.objectContaining({
        defaultSessionId: 'session_e2ee_exact',
        surface: 'mcp',
      }),
    );
  });
});
